"""Exercise startup hooks in real, concurrent Python workers."""
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from backend.training.supervisor import _build_train_env


class TrainingLoggingTests(unittest.TestCase):
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

    def test_print_tqdm_and_custom_rich_stream_are_untouched(self):
        with tempfile.TemporaryDirectory() as directory:
            env = _build_train_env(directory, "test")
            env.pop("ANIMA_TRAIN_LOG_LOCK")
            result = subprocess.run([sys.executable, "-c", '''
import io
import logging
import sys
from rich.console import Console
from rich.logging import RichHandler
from tqdm import tqdm
from tools.python_startup.training_logging import install

stdout, stderr = sys.stdout, sys.stderr
install(sys.argv[1])
patched_emit = RichHandler.emit
install(sys.argv[1])
assert RichHandler.emit is patched_emit
assert sys.stdout is stdout and sys.stderr is stderr
print("PRINT", "unchanged")
sys.stdout.write("partial")
sys.stdout.flush()
with tqdm(total=2, file=sys.stderr, ascii=True, mininterval=0) as progress:
    progress.update(2)

buffer = io.StringIO()
handler = RichHandler(console=Console(file=buffer, width=30))
handler.emit(logging.LogRecord("test", logging.INFO, "dataset.py", 464,
                              "word " * 40, (), None))
assert len(buffer.getvalue().splitlines()) > 1
''', str(Path(directory) / ".train-log.lock")], env=env,
                capture_output=True, check=True)
            self.assertEqual(result.stdout.replace(b"\r\n", b"\n"), b"PRINT unchanged\npartial")
            self.assertIn(b"\r", result.stderr.replace(b"\r\n", b"\n"))
            self.assertIn(b"2/2", result.stderr)


if __name__ == "__main__":
    unittest.main()
