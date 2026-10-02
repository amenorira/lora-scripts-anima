"""Exercise startup hooks in real, concurrent Python workers."""
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from backend.training.supervisor import _build_train_env


class TrainingLoggingTests(unittest.TestCase):
    def test_every_refresh_is_saved_and_terminal_still_refreshes(self):
        with tempfile.TemporaryDirectory() as directory:
            script = Path(directory) / 'steps.py'
            script.write_text('''
import io
import sys
from tqdm import tqdm

# Preserve both loss updates and identical explicit refreshes of the same step.
bar = tqdm(total=3, desc='steps', mininterval=999)
for n in range(1, 4):
    bar.update()
    bar.set_postfix(avr_loss=n / 10)
    bar.set_postfix(avr_loss=n / 20)
    bar.refresh()
bar.close()

class Terminal(io.StringIO):
    def isatty(self): return True
terminal = Terminal()
with tqdm(total=1, desc='steps', file=terminal, mininterval=0) as bar:
    bar.update()
    bar.set_postfix(avr_loss=.4)
assert '\\r' in terminal.getvalue()
with tqdm(total=1, desc='cache', file=terminal, mininterval=0) as bar:
    bar.update()
assert 'cache:' in terminal.getvalue()
with tqdm(total=1, desc='steps', disable=True) as bar:
    bar.update()
    bar.set_postfix(avr_loss=.5)
''', encoding='utf-8')
            result = subprocess.run([sys.executable, str(script)], env=_build_train_env(directory, 'test'),
                                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=30)
            self.assertEqual(result.returncode, 0, result.stdout.decode('utf-8'))
            self.assertNotIn(b'\r', result.stdout.replace(b'\r\n', b'\n'))
            lines = [line for line in result.stdout.decode('utf-8').splitlines() if line.startswith('steps:')]
            self.assertEqual(len(lines), 11, lines)  # initial + 3 * 3 + close
            self.assertIn('0/3', lines[0])
            for n in range(1, 4):
                frames = [line for line in lines if f'{n}/3' in line]
                self.assertEqual(len(frames), 4 if n == 3 else 3)
                self.assertIn(f'avr_loss={n / 10}', frames[0])
                for line in frames[1:]:
                    self.assertIn(f'avr_loss={n / 20}', line)

    def test_workers_write_whole_records_without_terminal_wrapping(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            script = root / "worker.py"
            script.write_text('''
import logging
import sys
import time
from rich.console import Console
from rich.logging import RichHandler

# Force each underlying write to fragment, so a missing interprocess lock
# cannot pass merely because short writes happened to be atomic on this OS.
class SlowWriter:
    def __init__(self, stream): self.stream = stream
    def __getattr__(self, name): return getattr(self.stream, name)
    def write(self, text):
        for offset in range(0, len(text), 128):
            self.stream.write(text[offset:offset + 128])
            self.stream.flush()
            time.sleep(0.0001)
        return len(text)
sys.stderr = SlowWriter(sys.stderr)

# A very narrow terminal must not introduce hard line breaks in the file.
logging.basicConfig(level=logging.INFO, format="%(message)s",
                    handlers=[RichHandler(console=Console(stderr=True, width=30))])
worker = sys.argv[1]
for index in range(30):
    payload = f"worker={worker} record={index} " + "模型路径/model_with_a_long_name.safetensors " * 25
    logging.info(payload)
logging.info("Dataset settings:\\n  batch_size: 2\\n  resolution: (1024, 1024)")
try:
    raise ValueError("traceback survives")
except ValueError:
    logging.exception("worker failed")
''', encoding="utf-8")
            env = _build_train_env(directory, "test")
            env.update({"COLUMNS": "30", "FORCE_COLOR": "1", "TERM": "dumb"})
            output = root / "train.log"
            processes = []
            try:
                with output.open("wb") as handle:
                    for worker in range(6):
                        processes.append(subprocess.Popen(
                            [sys.executable, str(script), str(worker)],
                            env=env, stdout=handle, stderr=subprocess.STDOUT,
                        ))
                    for process in processes:
                        self.assertEqual(process.wait(timeout=30), 0)
            finally:
                for process in processes:
                    if process.poll() is None:
                        process.kill()
                        process.wait()
            raw = output.read_bytes()
            self.assertNotIn(b"\r", raw.replace(b"\r\n", b"\n"))
            lines = raw.decode("utf-8").splitlines()
            records = [line for line in lines if "INFO     worker=" in line]
            self.assertEqual(len(records), 180)
            for worker in range(6):
                for index in range(30):
                    expected = f"worker={worker} record={index} " + "模型路径/model_with_a_long_name.safetensors " * 25
                    matches = [line for line in records if expected in line]
                    self.assertEqual(len(matches), 1)
                    self.assertRegex(matches[0], r"worker\.py:\d+$")
            self.assertEqual(sum(line.strip() == "batch_size: 2" for line in lines), 6)
            self.assertEqual(sum(line.strip() == "ValueError: traceback survives" for line in lines), 6)
            self.assertFalse(any("Logging error" in line or "sitecustomize" in line for line in lines))


if __name__ == "__main__":
    unittest.main()
