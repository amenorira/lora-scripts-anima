"""Recover historical sample display details from explicit sampling log entries."""
from __future__ import annotations

from collections import OrderedDict
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
import os
import re
import threading

from backend.monitor.log_files import find_run_log_path
from backend.monitor.log_parser import record_frames
from backend.monitor.sample_metadata import parse_sample_filename


_EPOCH = re.compile(r"^\s*epoch\s+(\d+)\s*/\s*\d+\s*$", re.I)
_SAMPLE_STEP = re.compile(r"\bGenerating sample images at step\s+(\d+)\b", re.I)
# tqdm can leave the next log timestamp directly after its closing bracket.
_TIME = re.compile(r"(?:^|\])\s*(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})(?:[.,]\d+)?\s")
_PROMPT_START = re.compile(r"^INFO\s+prompt: (.*)$")
# Anima logs the prompt after parsing/replacement, followed by this fixed
# metadata suffix. Raw prompt-file lines and other trainers are not evidence.
_NUMBER = r"[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?"
_ANIMA_PROMPT = re.compile(
    rf"^(?P<prompt>.+), size: \d+x\d+, steps: \d+, scale: {_NUMBER}, "
    rf"flow_shift: {_NUMBER}, seed: (?P<seed>\d+)(?:\s+anima_train_utils\.py:\d+)?\s*$")
_CACHE_MAX_RUNS = 8
_cache_lock = threading.Lock()
_cache: OrderedDict[str, _LogEntry] = OrderedDict()


@dataclass(frozen=True)
class _SamplingCall:
    epoch: int | None
    step: int
    start: datetime | None
    end: datetime | None = None
    final: bool = False
    prompt: tuple[str, int, datetime] | None = None


@dataclass
class _ParseState:
    offset: int = 0
    epoch: int | None = None
    last_time: datetime | None = None
    calls: list[_SamplingCall] = field(default_factory=list)
    prompts: list[list] = field(default_factory=list)


@dataclass
class _LogEntry:
    stamp: tuple = ()
    tail: bytes = b""
    state: _ParseState = field(default_factory=_ParseState)
    result: tuple[_SamplingCall, ...] = ()
    lock: object = field(default_factory=threading.Lock)


def _parse_calls(stream, state: _ParseState, size: int) -> tuple[_SamplingCall, ...]:
    """Consume complete appended records and retain timestamped sampling calls."""
    calls, prompts = state.calls, state.prompts
    stream.seek(state.offset)
    while state.offset < size:
        raw = stream.readline(size - state.offset)
        if not raw or not raw.endswith(b"\n"):
            break  # Re-read this incomplete record when more bytes arrive.
        state.offset += len(raw)
        for _, line in record_frames(raw):
            timestamp = _TIME.search(line)
            current_time = None
            if timestamp:
                try:
                    current_time = datetime.fromisoformat(timestamp[1])
                    state.last_time = current_time
                except ValueError:
                    pass
            marker = _EPOCH.fullmatch(line)
            if marker:
                state.epoch = int(marker[1]) or None
            sample = _SAMPLE_STEP.search(line)
            if sample:
                calls.append(_SamplingCall(state.epoch, int(sample[1]), current_time))
                prompts.append([])
            elif calls:
                prompt_line = _PROMPT_START.fullmatch(line[timestamp.end():] if timestamp else line)
                if prompt_line:
                    actual = _ANIMA_PROMPT.fullmatch(prompt_line[1])
                    # A raw " --n ... --w ..." protocol is not an actual
                    # positive prompt; do not infer its origin or meaning.
                    evidence = ((actual["prompt"], int(actual["seed"]), current_time)
                                if actual and current_time and actual["prompt"].strip()
                                and " --" not in actual["prompt"] else None)
                    # Two entries already establish ambiguity; retain no more.
                    if len(prompts[-1]) < 2:
                        prompts[-1].append(evidence)

    # Clock reversals make filename timestamps unsuitable for disambiguation.
    timed = [call.start for call in calls if call.start is not None]
    if any(right < left for left, right in zip(timed, timed[1:])):
        return ()
    result = []
    for index, call in enumerate(calls):
        if call.start is None or call.epoch is None:
            continue
        following = index + 1
        while following < len(calls) and calls[following].start == call.start:
            following += 1
        final = following == len(calls)
        end = state.last_time if final else calls[following].start
        if end is not None and end >= call.start:
            prompt = prompts[index][0] if len(prompts[index]) == 1 else None
            result.append(_SamplingCall(call.epoch, call.step, call.start, end, final, prompt))
    return tuple(result)


def _read_calls(run_paths: tuple[Path, ...]) -> tuple[_SamplingCall, ...]:
    path = next((found for root in run_paths if (found := find_run_log_path(root)) is not None), None)
    if path is None:
        return ()
    try:
        key = str(path.resolve())
        with _cache_lock:
            entry = _cache.setdefault(key, _LogEntry())
            _cache.move_to_end(key)
            while len(_cache) > _CACHE_MAX_RUNS:
                _cache.popitem(last=False)
        # Serialize readers of this log only; a large history must not block
        # unrelated runs while parsing or reading the filesystem.
        with entry.lock, path.open("rb") as stream:
            stat = os.fstat(stream.fileno())
            stamp = (stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns)
            if entry.stamp != stamp:
                previous = entry.stamp
                append = previous and previous[:2] == stamp[:2] and stamp[2] > previous[2]
                if append:
                    stream.seek(previous[2] - len(entry.tail))
                    append = stream.read(len(entry.tail)) == entry.tail
                if not append:
                    entry.state = _ParseState()
                entry.result = _parse_calls(stream, entry.state, stat.st_size)
                stream.seek(max(0, stat.st_size - 128))
                entry.tail = stream.read(128)
                entry.stamp = stamp
            return entry.result
    except OSError:
        return ()


def enrich_legacy_sample_steps(previews: list[dict], *run_paths: Path, calls=None) -> None:
    """Fill epoch-sample display details without changing pairing eligibility.

    Filename timestamps must fall in one explicit sampling-call interval for
    that epoch. Repeated epochs, resumes and same-second calls are accepted
    only when every matching log entry agrees on the actual global step.
    """
    pending = []
    for preview in previews:
        sample = preview.get("sample") or {}
        prompt_missing = sample.get("metadata_source") == "filename" and "prompt" not in sample.get("params", {})
        if sample.get("stage_kind") != "epoch" or (sample.get("step") is not None and not prompt_missing):
            continue
        parsed = parse_sample_filename(preview.get("name", ""))
        if not parsed or parsed["stage_kind"] != "epoch" or parsed["stage_value"] != sample.get("epoch"):
            continue
        try:
            timestamp = datetime.strptime(parsed["timestamp"], "%Y%m%d%H%M%S")
        except ValueError:
            continue
        pending.append((sample, parsed, timestamp))
    if not pending:
        return
    if calls is None:
        calls = _read_calls(tuple(dict.fromkeys(run_paths)))
    by_epoch = {}
    for call in calls:
        by_epoch.setdefault(call.epoch, []).append(call)
    for sample, parsed, timestamp in pending:
        matching = [call for call in by_epoch.get(sample["epoch"], ())
                    if call.start <= timestamp and (timestamp <= call.end if call.final else timestamp < call.end)]
        steps = {call.step for call in matching}
        if sample.get("step") is None and len(steps) == 1:
            sample["step"] = steps.pop()
            sample["step_source"] = "log"
            sample["batch_label"] = f"Epoch {sample['epoch']} · Step {sample['step']}"
        if sample.get("metadata_source") == "filename" and len(matching) == 1 and matching[0].step == sample.get("step"):
            call = matching[0]
            # A call may save images at different times. Use its start time to
            # group those images and distinguish resumed runs.
            sample["batch_id"] = f"legacy:{parsed['prefix']}:epoch:{sample['epoch']}:call:{call.start.isoformat()}:{call.step}"
        if (sample.get("metadata_source") != "filename" or "prompt" in sample.get("params", {})
                or parsed["prompt_index"] != 0 or sample.get("prompt_index") != 0 or len(matching) != 1):
            continue
        call = matching[0]
        if call.prompt is None or call.step != sample.get("step"):
            continue
        prompt, seed, prompt_time = call.prompt
        if parsed["seed"] != seed or str(sample.get("seed")) != str(seed) or not call.start <= prompt_time <= timestamp:
            continue
        sample.setdefault("params", {})["prompt"] = prompt
        sample["prompt_label"] = prompt.strip()[:128]
