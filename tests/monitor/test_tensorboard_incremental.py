import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from tensorboard.compat.proto.event_pb2 import Event
from tensorboard.compat.proto.summary_pb2 import Summary
from tensorboard.summary.writer.event_file_writer import EventFileWriter

from backend.monitor import training


class TensorboardIncrementalTests(unittest.TestCase):
    def test_append_rotation_and_history_are_independent(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(training, "_tb_live_cache", {}), patch.object(training, "_tb_cache", {}):
            log = Path(directory) / "log"
            writer = EventFileWriter(str(log))
            def write(step, value):
                writer.add_event(Event(step=step, summary=Summary(value=[Summary.Value(tag="loss/current", simple_value=value)])))
                writer.flush()
            try:
                for step in range(1000):
                    write(step, float(step))
                first = training.read_tensorboard_incremental(directory)
                self.assertEqual(len(first["loss/current"]), 1000)
                ea = training._tb_live_cache[str(log)][3]
                self.assertEqual(ea.scalars.Keys(), [])
                self.assertEqual(ea.pending, {})
                with patch.object(ea, "Scalars", side_effect=AssertionError("live reads must not copy history")):
                    self.assertEqual(training.read_tensorboard_incremental(directory), {})
                    write(1000, 0.25)
                    self.assertEqual(training.read_tensorboard_incremental(directory), {"loss/current": [{"step": 1000, "value": 0.25}]})
                    writer.close()
                    writer = EventFileWriter(str(log))
                    write(1001, 0.125)
                    self.assertEqual(training.read_tensorboard_incremental(directory), {"loss/current": [{"step": 1001, "value": 0.125}]})
                full = training.read_tensorboard_loss(run_dir=directory)
                series = next(item for item in full if item["tag"] == "loss/current")
                self.assertEqual(len(series["points"]), 1002)
                self.assertEqual(series["latest"], 0.125)
                self.assertEqual(series["min_step"], 0)
                self.assertEqual(len(series["diagnostic_points"]), 160)
            finally:
                writer.close()
