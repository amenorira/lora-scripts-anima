#!/usr/bin/env python3
"""Caption images for MOSS-Image training with a VLM through an OpenAI-compatible chat API.

MOSS-Image is trained with several captions per image (the original caption plus LLM-written
long / medium / short recaptions) and one of them is picked at random for each training step.
This script reproduces that data format for sd-scripts:

* Each image is sent to a vision-language model (local vLLM / SGLang / LM Studio / llama.cpp server,
  or any OpenAI-compatible endpoint) with the captioning prompt published in the MOSS-Image user guide
  (https://github.com/OpenMOSS/MOSS-Image/blob/main/USERGUIDE.md#image-captioning).
* The model returns one JSON object: ``caption.long`` / ``caption.medium`` / ``caption.short``,
  ``watermark`` boxes and ``borders``. The whole response is stored next to the image as a sidecar
  JSON file (``<image>_caption.json`` by default), so the caption files can be rebuilt later without
  calling the API again.
* A caption file (``<image>.txt`` by default) is written with the candidates separated by
  ``---===---`` lines, the format read by sd-scripts when ``enable_multiline_caption = true`` is set
  for the subset. Line breaks inside a caption (visible text in the image) are preserved as they are.

Example::

    python caption_images_moss.py /path/to/images --model Qwen3.5-27B --base_url http://localhost:8000/v1 \\
        --reference_extension .tags --knowledge "The character is Foo from Bar." --max_workers 4

The resulting dataset config for sd-scripts::

    [[datasets.subsets]]
      image_dir = "/path/to/images"
      caption_extension = ".txt"
      enable_multiline_caption = true

Requirements: Python 3.9+, Pillow (only for resizing; with ``--max_image_size 0`` the files are sent as
they are). No other third-party package is needed.

World knowledge (names of characters, series, artists, styles ...) can be given to the VLM so that it
identifies what is in the image and uses the names in the captions, which makes them natural trigger
words. Three layers are supported and concatenated in this order:

1. ``--knowledge`` / ``--knowledge_file``: common to all images
2. ``_knowledge.txt`` (``--dir_knowledge_name``) in the image directory and its parent directories up to
   the root directory given on the command line
3. ``<image stem>_knowledge.txt`` (``--knowledge_suffix``) next to the image

The prompt can be replaced with ``--prompt_file``. The placeholders ``{{reference}}`` (existing caption)
and ``{{knowledge}}`` are substituted, and a block ``{{#knowledge}} ... {{/knowledge}}`` is removed when
no knowledge is available for the image.

An existing caption file is never overwritten unless ``--overwrite`` is given. Re-running the script
writes only the missing caption files, reusing the existing sidecar files (API calls only for images
without a sidecar). ``--from_sidecar`` never calls the API: it writes the missing caption files from the
sidecars, or all of them with ``--overwrite`` (e.g. after changing ``--candidates``). ``--overwrite``
without ``--from_sidecar`` regenerates the sidecars with new API calls as well.

--------------------------------------------------------------------------------
MOSS-Image 学習用のキャプションを、OpenAI 互換 API 経由の VLM で生成するスクリプトです。
公式ユーザーガイドのキャプション用プロンプトを用い、long / medium / short の 3 つの再キャプションと
既存のキャプション（``--reference_extension``）を候補として、sd-scripts の ``enable_multiline_caption``
形式（区切り行 ``---===---``）のキャプションファイルを書き出します。VLM の応答全体は sidecar の JSON に
保存されるので、API を呼び直さずにキャプションファイルだけ作り直せます。
"""

import argparse
import base64
import concurrent.futures
import datetime
import io
import json
import logging
import mimetypes
import os
import re
import sys
import threading
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger("caption_images_moss")

IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tif", ".tiff"}
PASSTHROUGH_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp"}  # sent without re-encoding when no resize is needed
CAPTION_KEYS = ("long", "medium", "short")
SIDECAR_VERSION = 1

# The captioning prompt from the MOSS-Image user guide, with a paragraph for world knowledge added.
# The block between {{#knowledge}} and {{/knowledge}} is removed when there is no knowledge for the image.
DEFAULT_PROMPT = """You are an image recaptioner. Return exactly one JSON object with this schema:
{
  "caption": {
    "long": "a detailed image description, including all non-watermark visible text",
    "medium": "a one-paragraph image description",
    "short": "a one-sentence image description"
  },
  "watermark": [
    {"box_2d": [y_min, x_min, y_max, x_max], "label": "watermark text"}
  ],
  "borders": ["none"]
}

Rules:
- caption.long:
    - Describe the composition, key subjects, actions, setting, colors, lighting, and artistic style in detail. Include only information visible in the image.
    - Preserve visible text exactly, excluding watermarks. Do not translate, paraphrase, romanize, or normalize image text.
    - Describe text layout as much as possible: line breaks, ordering, relative position, alignment, size hierarchy, font/style, color, spacing, and how text blocks are arranged.
- caption.medium: compress long into one paragraph.
- caption.short: summarize the main subject, action, or relationship in one sentence.
- Do not describe watermarks in any caption field. Record them only in watermark.
- watermark:
    - Use normalized 0–1000 [y_min, x_min, y_max, x_max] coordinates relative to the full image.
    - Set label to the visible watermark text, or a short description if unreadable.
    - Use [] if there are no watermarks.
- borders:
    - Record evident borders or margins using one or more of "left", "right", "up", and "down".
    - Use ["none"] if there are no evident borders or margins. Do not combine "none" with other directions.
- All three caption fields must be non-empty strings.
- Treat the original caption as a reference. Correct any claims that are not supported by the image.
- Return only the JSON object, without Markdown or explanations.
{{#knowledge}}
Here is additional knowledge about the image (names of characters, series, artists, styles, products, or places). Use it only to identify what is visible and to refer to it by these names in all three captions. Do not copy statements that are not supported by the image:
{{knowledge}}
{{/knowledge}}
Here is the original caption reference:
{{reference}}
"""


# ----------------------------------------------------------------------------------------------------
# Arguments
# ----------------------------------------------------------------------------------------------------


def parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Caption images for MOSS-Image training with a VLM through an OpenAI-compatible API.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("image_dir", type=Path, help="directory containing the images")
    parser.add_argument("--recursive", action="store_true", help="search images in subdirectories as well")

    g = parser.add_argument_group("API")
    g.add_argument("--base_url", default="http://localhost:8000/v1", help="OpenAI-compatible API base URL (default: %(default)s)")
    g.add_argument("--api_key", default=None, help="API key. Default: environment variable OPENAI_API_KEY, or 'none'")
    g.add_argument("--model", required=True, help="model name passed to the API")
    g.add_argument("--max_tokens", type=int, default=16384, help="max_tokens of the request (default: %(default)s)")
    g.add_argument("--temperature", type=float, default=1.0, help="(default: %(default)s)")
    g.add_argument("--top_p", type=float, default=0.95, help="(default: %(default)s)")
    g.add_argument(
        "--extra_body",
        default='{"chat_template_kwargs": {"enable_thinking": true}}',
        help="JSON object merged into the request body. The default enables thinking mode on vLLM / SGLang; "
        "pass '{}' for servers which do not accept it (default: %(default)s)",
    )
    g.add_argument("--timeout", type=float, default=600.0, help="request timeout in seconds (default: %(default)s)")
    g.add_argument("--max_retries", type=int, default=3, help="retries per image for API errors and invalid JSON (default: %(default)s)")
    g.add_argument("--max_workers", type=int, default=1, help="number of parallel requests (default: %(default)s)")

    g = parser.add_argument_group("image")
    g.add_argument(
        "--max_image_size", type=int, default=1536, help="resize so that the longer side is at most this many pixels; 0 to send the file as is (default: %(default)s)"
    )
    g.add_argument(
        "--jpeg_quality", type=int, default=None, help="encode the (resized) image as JPEG with this quality instead of PNG; PNG keeps text in the image sharp"
    )

    g = parser.add_argument_group("prompt and knowledge")
    g.add_argument("--prompt_file", type=Path, default=None, help="text file replacing the built-in prompt (placeholders: {{reference}}, {{knowledge}}, {{#knowledge}}...{{/knowledge}})")
    g.add_argument("--knowledge", default=None, help="world knowledge common to all images")
    g.add_argument("--knowledge_file", type=Path, default=None, help="text file with world knowledge common to all images (appended to --knowledge)")
    g.add_argument("--dir_knowledge_name", default="_knowledge.txt", help="per-directory knowledge file name, looked up from the image directory up to image_dir (default: %(default)s)")
    g.add_argument("--knowledge_suffix", default="_knowledge.txt", help="per-image knowledge file: <image stem> + this suffix (default: %(default)s)")

    g = parser.add_argument_group("input and output files")
    g.add_argument("--reference_extension", default=None, help="extension of existing captions used as the reference and as the 'original' candidate, e.g. .txt or .tags (default: none)")
    g.add_argument("--caption_extension", default=".txt", help="extension of the caption files to write (default: %(default)s)")
    g.add_argument("--sidecar_suffix", default="_caption.json", help="suffix of the sidecar JSON with the full VLM response: <image stem> + suffix (default: %(default)s)")
    g.add_argument(
        "--candidates",
        default="original,long,medium,short",
        help="comma-separated candidates written to the caption file, in this order. 'original' is the reference caption and is skipped when there is none (default: %(default)s)",
    )
    g.add_argument("--separator", default="---===---", help="candidate separator line, must match multiline_caption_separator of sd-scripts (default: %(default)s)")
    g.add_argument(
        "--overwrite",
        action="store_true",
        help="overwrite existing caption files. Without this option an existing caption file is never touched. "
        "With API calls (no --from_sidecar) the sidecars are regenerated as well",
    )
    g.add_argument(
        "--from_sidecar",
        action="store_true",
        help="do not call the API: write the caption files from the existing sidecars (missing caption files only, all of them with --overwrite)",
    )
    g.add_argument("--dry_run", action="store_true", help="list the images and print the prompt of the first one without calling the API")
    g.add_argument("--verbose", action="store_true")
    return parser.parse_args(argv)


# ----------------------------------------------------------------------------------------------------
# Files and prompt
# ----------------------------------------------------------------------------------------------------


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8-sig").replace("\r\n", "\n").replace("\r", "\n").strip()


def list_images(root: Path, recursive: bool) -> List[Path]:
    it = root.rglob("*") if recursive else root.glob("*")
    return sorted(p for p in it if p.is_file() and p.suffix.lower() in IMAGE_EXTENSIONS)


def is_separator_line(line: str, separator: str) -> bool:
    return line.strip().startswith(separator)


class KnowledgeLoader:
    """Collects the three layers of world knowledge for an image (common, per-directory, per-image)."""

    def __init__(self, root: Path, common: str, dir_name: str, suffix: str):
        self.root = root.resolve()
        self.common = common.strip()
        self.dir_name = dir_name
        self.suffix = suffix
        self._dir_cache: Dict[Path, str] = {}
        self._lock = threading.Lock()

    def _dir_knowledge(self, directory: Path) -> str:
        with self._lock:
            if directory in self._dir_cache:
                return self._dir_cache[directory]
        path = directory / self.dir_name
        text = read_text(path) if self.dir_name and path.is_file() else ""
        with self._lock:
            self._dir_cache[directory] = text
        return text

    def for_image(self, image: Path) -> str:
        parts = [self.common]
        # directory files from the root down to the image directory
        directory = image.resolve().parent
        chain: List[Path] = []
        while True:
            chain.append(directory)
            if directory == self.root or directory.parent == directory:
                break
            directory = directory.parent
        for d in reversed(chain):
            parts.append(self._dir_knowledge(d))
        if self.suffix:
            per_image = image.with_name(image.stem + self.suffix)
            if per_image.is_file():
                parts.append(read_text(per_image))
        return "\n\n".join(p for p in parts if p)


def build_prompt(template: str, reference: str, knowledge: str) -> str:
    """Substitute the placeholders. The {{#knowledge}} block is removed when there is no knowledge."""

    def knowledge_block(m: "re.Match[str]") -> str:
        return m.group(1) if knowledge else ""

    prompt = re.sub(r"\{\{#knowledge\}\}\n?(.*?)\{\{/knowledge\}\}\n?", knowledge_block, template, flags=re.DOTALL)
    prompt = prompt.replace("{{knowledge}}", knowledge if knowledge else "None.")
    prompt = prompt.replace("{{reference}}", reference if reference else "None.")
    return prompt


# ----------------------------------------------------------------------------------------------------
# Image encoding
# ----------------------------------------------------------------------------------------------------


def encode_image(path: Path, max_size: int, jpeg_quality: Optional[int]) -> str:
    """Return a data URL of the image, resized so that the longer side is at most max_size (0 = no resize)."""
    suffix = path.suffix.lower()
    if max_size <= 0 and jpeg_quality is None and suffix in PASSTHROUGH_EXTENSIONS:
        mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        return f"data:{mime};base64," + base64.b64encode(path.read_bytes()).decode("ascii")

    try:
        from PIL import Image, ImageOps
    except ImportError as e:
        raise RuntimeError("Pillow is required for resizing / re-encoding images (pip install Pillow), or use --max_image_size 0") from e

    with Image.open(path) as im:
        im = ImageOps.exif_transpose(im)
        w, h = im.size
        resized = False
        if max_size > 0 and max(w, h) > max_size:
            scale = max_size / max(w, h)
            im = im.resize((max(1, round(w * scale)), max(1, round(h * scale))), Image.LANCZOS)
            resized = True

        if not resized and jpeg_quality is None and suffix in PASSTHROUGH_EXTENSIONS:
            mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
            return f"data:{mime};base64," + base64.b64encode(path.read_bytes()).decode("ascii")

        buf = io.BytesIO()
        if jpeg_quality is not None:
            if im.mode in ("RGBA", "LA") or (im.mode == "P" and "transparency" in im.info):
                im = im.convert("RGBA")
                bg = Image.new("RGB", im.size, (255, 255, 255))
                bg.paste(im, mask=im.split()[-1])
                im = bg
            elif im.mode != "RGB":
                im = im.convert("RGB")
            im.save(buf, format="JPEG", quality=jpeg_quality)
            mime = "image/jpeg"
        else:
            if im.mode not in ("RGB", "RGBA", "L"):
                im = im.convert("RGBA" if "A" in im.mode or (im.mode == "P" and "transparency" in im.info) else "RGB")
            im.save(buf, format="PNG")
            mime = "image/png"
    return f"data:{mime};base64," + base64.b64encode(buf.getvalue()).decode("ascii")


# ----------------------------------------------------------------------------------------------------
# API
# ----------------------------------------------------------------------------------------------------


def call_chat_api(args: argparse.Namespace, extra_body: Dict[str, Any], prompt: str, image_data_url: str) -> Dict[str, Any]:
    body: Dict[str, Any] = {
        "model": args.model,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {"type": "image_url", "image_url": {"url": image_data_url}},
                ],
            }
        ],
        "n": 1,
        "stream": False,
        "max_tokens": args.max_tokens,
        "temperature": args.temperature,
        "top_p": args.top_p,
    }
    body.update(extra_body)

    api_key = args.api_key or os.environ.get("OPENAI_API_KEY") or "none"
    req = urllib.request.Request(
        args.base_url.rstrip("/") + "/chat/completions",
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=args.timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")[:2000]
        raise RuntimeError(f"HTTP {e.code}: {detail}") from e


def extract_json_object(content: str) -> Dict[str, Any]:
    """Parse the JSON object in the model output, tolerating <think> blocks, code fences and surrounding text."""
    text = re.sub(r"<think>.*?</think>", "", content, flags=re.DOTALL)
    text = re.sub(r"^\s*```(?:json)?\s*|\s*```\s*$", "", text.strip(), flags=re.DOTALL)
    start = text.find("{")
    end = text.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("no JSON object in the response")
    try:
        obj = json.loads(text[start : end + 1])
    except json.JSONDecodeError:
        # the model may have written more than one object or trailing text: take the first complete object
        decoder = json.JSONDecoder()
        obj, _ = decoder.raw_decode(text[start:])
    if not isinstance(obj, dict):
        raise ValueError("the response is not a JSON object")
    return obj


def validate_response(obj: Dict[str, Any]) -> None:
    caption = obj.get("caption")
    if not isinstance(caption, dict):
        raise ValueError("'caption' is missing or not an object")
    for key in CAPTION_KEYS:
        value = caption.get(key)
        if not isinstance(value, str) or not value.strip():
            raise ValueError(f"'caption.{key}' is missing or empty")
    if "watermark" in obj and not isinstance(obj["watermark"], list):
        raise ValueError("'watermark' is not a list")
    if "borders" in obj and not isinstance(obj["borders"], list):
        raise ValueError("'borders' is not a list")


def caption_with_api(args: argparse.Namespace, extra_body: Dict[str, Any], image: Path, prompt: str) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    """Call the API with retries. Returns (parsed response object, info about the request)."""
    data_url = encode_image(image, args.max_image_size, args.jpeg_quality)
    last_error: Optional[Exception] = None
    for attempt in range(1, args.max_retries + 2):
        try:
            response = call_chat_api(args, extra_body, prompt, data_url)
            choice = response["choices"][0]
            message = choice.get("message", {})
            content = message.get("content")
            if not content:
                raise ValueError(f"empty content (finish_reason={choice.get('finish_reason')}); the thinking may have used up max_tokens")
            if choice.get("finish_reason") == "length":
                logger.warning(f"{image.name}: the response was truncated (finish_reason=length); consider increasing --max_tokens")
            obj = extract_json_object(content)
            validate_response(obj)
            info = {
                "finish_reason": choice.get("finish_reason"),
                "usage": response.get("usage"),
                "attempts": attempt,
                "raw_content": content,
            }
            return obj, info
        except Exception as e:  # noqa: BLE001 - any API / parsing error is retried
            last_error = e
            if attempt <= args.max_retries:
                logger.warning(f"{image.name}: attempt {attempt} failed: {e}; retrying")
    raise RuntimeError(f"giving up after {args.max_retries + 1} attempts: {last_error}")


# ----------------------------------------------------------------------------------------------------
# Caption file
# ----------------------------------------------------------------------------------------------------


def build_caption_text(candidates: List[Tuple[str, str]], separator: str) -> str:
    """Join (name, text) candidates with separator lines. Each candidate is preceded by `<separator> # <name>`."""
    parts = []
    for name, text in candidates:
        text = text.strip()
        lines = text.split("\n")
        if any(is_separator_line(line, separator) for line in lines):
            logger.warning(f"candidate '{name}' contains a line starting with the separator {separator!r}; the line is removed")
            text = "\n".join(line for line in lines if not is_separator_line(line, separator)).strip()
        if not text:
            continue
        parts.append(f"{separator} # {name}\n{text}")
    return "\n".join(parts) + "\n"


def collect_candidates(names: List[str], response: Dict[str, Any], reference: str) -> List[Tuple[str, str]]:
    result = []
    for name in names:
        if name == "original":
            if reference:
                result.append((name, reference))
        else:
            result.append((name, response["caption"][name]))
    return result


def write_atomic(path: Path, text: str) -> None:
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text, encoding="utf-8", newline="\n")
    os.replace(tmp, path)


# ----------------------------------------------------------------------------------------------------
# Main
# ----------------------------------------------------------------------------------------------------


class Job:
    def __init__(self, args: argparse.Namespace, extra_body: Dict[str, Any], template: str, knowledge: KnowledgeLoader, candidate_names: List[str]):
        self.args = args
        self.extra_body = extra_body
        self.template = template
        self.knowledge = knowledge
        self.candidate_names = candidate_names
        self.stats = {"captioned": 0, "reused": 0, "skipped": 0, "failed": 0}
        self._lock = threading.Lock()

    def _count(self, key: str) -> None:
        with self._lock:
            self.stats[key] += 1

    def _read_reference(self, image: Path, sidecar_data: Optional[Dict[str, Any]]) -> str:
        args = self.args
        if not args.reference_extension:
            return ""
        path = image.with_suffix(args.reference_extension)
        if not path.is_file():
            return ""
        text = read_text(path)
        if any(is_separator_line(line, args.separator) for line in text.split("\n")):
            # the reference file is an output of a previous run: take the original from the sidecar (None if there was none)
            if sidecar_data is not None:
                logger.info(f"{image.name}: the reference file contains separator lines; using the reference stored in the sidecar")
                return sidecar_data.get("reference") or ""
            raise RuntimeError(
                f"the reference file {path.name} contains separator lines (an output of a previous run?) and no sidecar with the original reference exists"
            )
        return text

    def process(self, image: Path) -> None:
        args = self.args
        sidecar = image.with_name(image.stem + args.sidecar_suffix)
        caption_path = image.with_suffix(args.caption_extension)
        try:
            # the existing sidecar is always read: even with --overwrite it holds the original reference
            sidecar_data: Optional[Dict[str, Any]] = None
            if sidecar.is_file():
                sidecar_data = json.loads(sidecar.read_text(encoding="utf-8"))
            reuse_sidecar = sidecar_data is not None and (args.from_sidecar or not args.overwrite)

            # an existing caption file is never overwritten without --overwrite, whatever its origin
            if caption_path.is_file() and not args.overwrite:
                logger.info(f"{image.name}: {caption_path.name} exists, skipped (--overwrite to regenerate)")
                self._count("skipped")
                return

            if args.from_sidecar:
                if sidecar_data is None:
                    logger.warning(f"{image.name}: no sidecar, skipped")
                    self._count("skipped")
                    return
                response = sidecar_data["response"]
                reference = sidecar_data.get("reference") or ""
                self._count("reused")
            else:
                reference = self._read_reference(image, sidecar_data)
                if reuse_sidecar:
                    response = sidecar_data["response"]
                    reference = sidecar_data.get("reference") or reference
                    logger.info(f"{image.name}: reusing the sidecar")
                    self._count("reused")
                else:
                    knowledge = self.knowledge.for_image(image)
                    prompt = build_prompt(self.template, reference, knowledge)
                    response, info = caption_with_api(args, self.extra_body, image, prompt)
                    sidecar_data = {
                        "version": SIDECAR_VERSION,
                        "image": image.name,
                        "model": args.model,
                        "created_at": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
                        "reference": reference or None,
                        "knowledge": knowledge or None,
                        "prompt": prompt,
                        "response": response,
                        "finish_reason": info["finish_reason"],
                        "usage": info["usage"],
                        "attempts": info["attempts"],
                        "raw_content": info["raw_content"],
                    }
                    write_atomic(sidecar, json.dumps(sidecar_data, ensure_ascii=False, indent=2) + "\n")
                    self._count("captioned")

            candidates = collect_candidates(self.candidate_names, response, reference)
            write_atomic(caption_path, build_caption_text(candidates, args.separator))
            lengths = ", ".join(f"{n} {len(t)}" for n, t in candidates)
            logger.info(f"{image.name}: wrote {caption_path.name} ({lengths} chars)")
        except Exception as e:  # noqa: BLE001
            logger.error(f"{image.name}: FAILED: {e}")
            if args.verbose:
                logger.exception(e)
            self._count("failed")


def main(argv: Optional[List[str]] = None) -> int:
    args = parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO, format="%(asctime)s %(levelname)s %(message)s", datefmt="%H:%M:%S")

    if not args.image_dir.is_dir():
        logger.error(f"image_dir is not a directory: {args.image_dir}")
        return 2
    for name in ("caption_extension", "reference_extension"):
        value = getattr(args, name)
        if value and not value.startswith("."):
            setattr(args, name, "." + value)
    if not args.separator.strip():
        logger.error("--separator must not be empty")
        return 2
    if args.reference_extension and args.reference_extension == args.caption_extension and not (args.overwrite or args.from_sidecar):
        logger.error(
            "--reference_extension is the same as --caption_extension: the reference files would be overwritten. "
            "Specify --overwrite to allow it (the original reference is kept in the sidecar JSON), or use a different --caption_extension."
        )
        return 2
    candidate_names = [c.strip() for c in args.candidates.split(",") if c.strip()]
    unknown = [c for c in candidate_names if c != "original" and c not in CAPTION_KEYS]
    if unknown or not candidate_names:
        logger.error(f"--candidates must be a subset of original,{','.join(CAPTION_KEYS)}: {args.candidates!r}")
        return 2
    try:
        extra_body = json.loads(args.extra_body) if args.extra_body else {}
        if not isinstance(extra_body, dict):
            raise ValueError("not a JSON object")
    except ValueError as e:
        logger.error(f"--extra_body is not a JSON object: {e}")
        return 2

    template = read_text(args.prompt_file) + "\n" if args.prompt_file else DEFAULT_PROMPT
    common_knowledge = "\n\n".join(t for t in [args.knowledge or "", read_text(args.knowledge_file) if args.knowledge_file else ""] if t)
    knowledge = KnowledgeLoader(args.image_dir, common_knowledge, args.dir_knowledge_name, args.knowledge_suffix)

    images = list_images(args.image_dir, args.recursive)
    if not images:
        logger.error(f"no images found in {args.image_dir}")
        return 2
    logger.info(f"{len(images)} images found in {args.image_dir}")

    if args.dry_run:
        for image in images:
            k = knowledge.for_image(image)
            ref = image.with_suffix(args.reference_extension) if args.reference_extension else None
            logger.info(f"{image.relative_to(args.image_dir)}: reference={'yes' if ref and ref.is_file() else 'no'}, knowledge={len(k)} chars")
        first = images[0]
        ref_path = first.with_suffix(args.reference_extension) if args.reference_extension else None
        reference = read_text(ref_path) if ref_path and ref_path.is_file() else ""
        print("\n===== prompt for", first.name, "=====\n" + build_prompt(template, reference, knowledge.for_image(first)))
        return 0

    job = Job(args, extra_body, template, knowledge, candidate_names)
    if args.max_workers <= 1:
        for i, image in enumerate(images, 1):
            logger.info(f"[{i}/{len(images)}] {image.name}")
            job.process(image)
    else:
        with concurrent.futures.ThreadPoolExecutor(max_workers=args.max_workers) as pool:
            futures = {pool.submit(job.process, image): image for image in images}
            for i, future in enumerate(concurrent.futures.as_completed(futures), 1):
                future.result()  # exceptions are handled inside process()
                if i % 10 == 0 or i == len(images):
                    logger.info(f"[{i}/{len(images)}] done")

    s = job.stats
    logger.info(f"finished: captioned {s['captioned']}, reused sidecar {s['reused']}, skipped {s['skipped']}, failed {s['failed']}")
    return 1 if s["failed"] else 0


if __name__ == "__main__":
    sys.exit(main())
