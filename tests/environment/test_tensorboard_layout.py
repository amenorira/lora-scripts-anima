"""Exercise the startup hook with real Accelerate/TensorBoard event writers."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]


class TensorBoardLayoutTests(unittest.TestCase):
    def test_managed_and_standalone_event_paths(self):
        for managed in (True, False):
            with self.subTest(managed=managed), tempfile.TemporaryDirectory() as tmp:
                run = Path(tmp) / "output" / "tinkle_20260913-174329"
                env = os.environ.copy()
                env["PYTHONPATH"] = os.pathsep.join((str(ROOT / "tools/python_startup"), str(ROOT)))
                env.pop("ANIMA_TENSORBOARD_DIR", None)
                env["LORA_SCRIPTS_TRUE_LR_LOGGING"] = "1"
                if managed:
                    env["ANIMA_TENSORBOARD_DIR"] = str(run / "log")
                script = '''
import sys
from accelerate import Accelerator
from pathlib import Path
from tensorboard.backend.event_processing.event_accumulator import EventAccumulator
from tensorboard.backend.event_processing.event_multiplexer import EventMultiplexer
from backend.monitor.training import read_tensorboard_loss
run = Path(sys.argv[1])
managed = sys.argv[2] == 'True'
accelerator = Accelerator(cpu=True, log_with='tensorboard', project_dir=str(run / 'log' / '20260913174335'))
accelerator.init_trackers('network_train')
accelerator.log({'loss/current': 0.25}, step=1)
accelerator.end_training()
expected = run / 'log' if managed else run / 'log' / '20260913174335' / 'network_train'
events = list(run.rglob('events.out.tfevents.*'))
assert events and all(p.parent == expected for p in events), events
ea = EventAccumulator(str(expected)).Reload()
assert ea.Scalars('loss/current')[0].value == 0.25
series = read_tensorboard_loss(run_dir=str(run))
assert series[0]['points'] == [{'step': 1, 'value': 0.25}], series
mux = EventMultiplexer().AddRunsFromDirectory(str(run.parent)).Reload()
expected_name = run.name + '/log' + ('' if managed else '/20260913174335/network_train')
assert [name.replace(chr(92), '/') for name in mux.Runs()] == [expected_name], mux.Runs()
'''
                result = subprocess.run(
                    [sys.executable, "-c", script, str(run), str(managed)],
                    cwd=ROOT, env=env, capture_output=True, text=True, timeout=90,
                )
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
