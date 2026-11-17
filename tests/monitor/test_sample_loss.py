import tempfile
import unittest
from pathlib import Path

from tensorboard.compat.proto.event_pb2 import Event
from tensorboard.compat.proto.summary_pb2 import Summary
from tensorboard.summary.writer.event_file_writer import EventFileWriter

from backend.monitor import training


class SampleEpochLossTests(unittest.TestCase):
    def test_epoch_partitions_survive_downsampling_and_incremental_reads(self):
        with tempfile.TemporaryDirectory() as directory:
            run = Path(directory)
            writer = EventFileWriter(str(run / "log"))
            tags = ("loss/epoch", "loss/timestep/epoch/low", "loss/timestep/epoch/mid", "loss/timestep/epoch/high")

            def record(epoch):
                writer.add_event(Event(wall_time=epoch, step=epoch, summary=Summary(value=[
                    Summary.Value(tag=tag, simple_value=.1 / epoch) for tag in tags
                ])))
                writer.flush()

            try:
                for epoch in range(1, 8):
                    record(epoch)
                snapshot = training.read_tensorboard_loss(run_dir=str(run), downsample_to=3)
                self.assertEqual({series["tag"] for series in snapshot}, set(tags))
                for series in snapshot:
                    self.assertEqual([point["step"] for point in series["points"]], list(range(1, 8)))
                initial = training.read_tensorboard_incremental(run_dir=str(run))
                self.assertEqual(set(initial), set(tags))
                record(8)
                incremental = training.read_tensorboard_incremental(run_dir=str(run))
                for tag in tags:
                    self.assertEqual([point["step"] for point in incremental[tag]], [8])
                self.assertEqual(training.read_tensorboard_incremental(run_dir=str(run)), {})
            finally:
                writer.close()
                training._tb_cache.pop(str(run / "log"), None)
                training._tb_live_cache.pop(str(run / "log"), None)
