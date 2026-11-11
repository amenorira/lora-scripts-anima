import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from tensorboard.compat.proto.event_pb2 import Event
from tensorboard.compat.proto.summary_pb2 import Summary
from tensorboard.summary.writer.event_file_writer import EventFileWriter

from backend.monitor import training


class MainLearningRateTests(unittest.IsolatedAsyncioTestCase):
    async def test_incremental_component_tags_cannot_replace_measured_backbone_lr(self):
        from backend.monitor.monitor import TaskMonitor

        monitor = TaskMonitor()
        updates = [
            {'lr/d*eff_lr/unet': [{'step': 1, 'value': 0.001}], 'lr/unet': [{'step': 1, 'value': 1.0}]},
            {'lr/backbone': [{'step': 1, 'value': 0.0}]},
            {'lr/unet': [{'step': 2, 'value': 0.5}]},
        ]
        with patch('backend.monitor.monitor.read_tensorboard_incremental', side_effect=updates), \
                patch('backend.monitor.monitor.realtime_hub.publish', new_callable=AsyncMock), \
                patch.object(monitor, '_update_console_progress'):
            await monitor._collect_tb_incremental('task', 'run')
            self.assertEqual(float(monitor._last_progress['task']['lr']), 0.001)
            await monitor._collect_tb_incremental('task', 'run')
            self.assertEqual(float(monitor._last_progress['task']['lr']), 0.0)
            await monitor._collect_tb_incremental('task', 'run')
            self.assertEqual(float(monitor._last_progress['task']['lr']), 0.0)
        monitor._cleanup_task('task')
        self.assertNotIn('task', monitor._primary_lr_tag)


class TensorboardIncrementalTests(unittest.TestCase):
    def test_backbone_and_legacy_ppsf_effective_lr_survive_both_readers(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(training, "_tb_live_cache", {}), patch.object(training, "_tb_cache", {}):
            writer = EventFileWriter(str(Path(directory) / "log"))
            try:
                writer.add_event(Event(step=1, summary=Summary(value=[
                    Summary.Value(tag="lr/backbone", simple_value=0.0),
                    Summary.Value(tag="lr/d*eff_lr/unet", simple_value=0.0001),
                    Summary.Value(tag="lr/unet", simple_value=1.0),
                ])))
                writer.flush()
                live = training.read_tensorboard_incremental(directory)
                snapshot = {series['tag']: series['latest'] for series in training.read_tensorboard_loss(run_dir=directory)}
                self.assertEqual(set(live), set(snapshot))
                self.assertEqual(snapshot['lr/backbone'], 0.0)
                self.assertAlmostEqual(snapshot['lr/d*eff_lr/unet'], 0.0001)
            finally:
                writer.close()

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
