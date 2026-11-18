import asyncio
import unittest
from unittest.mock import AsyncMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.core.realtime import RealtimeHub, offer_realtime
from backend.monitor import monitor
from backend.server.routes import realtime


class RealtimeReplayTests(unittest.TestCase):
    def test_publish_during_subscribe_has_no_replay_gap_or_duplicate(self):
        async def scenario():
            hub = RealtimeHub()

            async def publish():
                for tick in range(24):
                    await hub.publish("task:train", "task.log", {"tick": tick})
                    await asyncio.sleep(0)

            async def subscribe():
                await asyncio.sleep(0)
                return await hub.subscribe("task:train")

            _, (queue, replay, resync) = await asyncio.gather(publish(), subscribe())
            events = replay + [queue.get_nowait() for _ in range(queue.qsize())]
            self.assertFalse(resync)
            self.assertEqual([event["seq"] for event in events], list(range(1, 25)))

        asyncio.run(scenario())

    def test_hardware_resume_uses_latest_sample_and_large_log_replay_resyncs_only_its_topic(self):
        hub = RealtimeHub()

        async def seed():
            for tick in range(90):
                await hub.publish("hardware", "hardware.sample", {"tick": tick})
                await hub.publish("task:train", "task.log", {"tick": tick})

        asyncio.run(seed())
        self.assertEqual(len(hub._history["hardware"]), 1)
        app = FastAPI()
        app.include_router(realtime.router)
        with patch.object(realtime, "realtime_hub", hub), TestClient(app) as client:
            with client.websocket_connect("/ws/realtime") as socket:
                socket.send_json({"op": "hello"})
                self.assertEqual(socket.receive_json()["op"], "ready")
                socket.send_json({"op": "subscribe", "topics": ["hardware"], "resume": {"hardware": 1}})
                sample = socket.receive_json()
                self.assertEqual((sample["topic"], sample["seq"]), ("hardware", 90))
                socket.send_json({"op": "subscribe", "topics": ["task:train"], "resume": {"task:train": 1}})
                marker = socket.receive_json()
                self.assertEqual(marker["op"], "resync_required")
                self.assertEqual(marker["topics"], ["task:train"])

    def test_connection_overflow_preserves_all_discarded_topics(self):
        queue = asyncio.Queue(maxsize=3)
        queue.put_nowait({"op": "event", "topic": "task:a"})
        queue.put_nowait({"op": "event", "topic": "task:b"})
        queue.put_nowait({"op": "resync_required", "topics": ["artifacts"]})
        offer_realtime(queue, {"op": "event", "topic": "hardware"})
        marker = queue.get_nowait()
        self.assertEqual(marker["topics"], ["artifacts", "task:a", "task:b"])
        self.assertEqual(queue.get_nowait()["topic"], "hardware")


class MonitorSamplingTests(unittest.IsolatedAsyncioTestCase):
    async def test_slow_training_read_does_not_delay_other_sampling_or_overlap(self):
        instance = monitor.TaskMonitor()
        instance._sample_interval = 0.01
        training_started, hardware_sampled, tracked_sampled = asyncio.Event(), asyncio.Event(), asyncio.Event()

        async def slow_read(_task_id):
            training_started.set()
            await asyncio.Event().wait()

        with (patch.object(monitor.tm, "training_dump", return_value=[{"id": "train", "status": "RUNNING"}]),
              patch.object(monitor.realtime_hub, "publish", new_callable=AsyncMock),
              patch.object(monitor.realtime_hub, "prune", new_callable=AsyncMock),
              patch.object(monitor.realtime_tasks, "poll", new_callable=AsyncMock, side_effect=tracked_sampled.set),
              patch.object(instance, "_collect_hardware", new_callable=AsyncMock, side_effect=hardware_sampled.set),
              patch.object(instance, "_collect_task_data", new_callable=AsyncMock, side_effect=slow_read) as read):
            await instance.start()
            tasks = list(instance._tasks)
            try:
                await asyncio.wait_for(training_started.wait(), 1)
                await asyncio.wait_for(hardware_sampled.wait(), 1)
                await asyncio.wait_for(tracked_sampled.wait(), 1)
                await asyncio.sleep(0.03)
                self.assertEqual(read.await_count, 1)
            finally:
                await instance.stop()
            self.assertTrue(all(task.done() for task in tasks))

    async def test_monitor_detail_does_not_read_the_tracked_task_snapshot(self):
        detail = {"detail": True}
        with (patch.object(realtime.tm, "training_dump", return_value=[]),
              patch.object(realtime, "build_live_monitor_snapshot", new_callable=AsyncMock, return_value=detail),
              patch.object(realtime.realtime_tasks, "snapshot", new_callable=AsyncMock) as tracked):
            result = await realtime.realtime_monitor_detail()
        self.assertEqual(result["data"]["monitor"], detail)
        tracked.assert_not_awaited()

    async def test_training_terminal_status_follows_the_final_data_read(self):
        instance = monitor.TaskMonitor()
        order = []

        async def collect(_task_id):
            order.append("final-data")

        async def publish(_topic, event_type, _payload):
            order.append(event_type)

        with (patch.object(monitor.tm, "training_dump", return_value=[{"id": "train", "status": "FINISHED"}]),
              patch.object(instance, "_collect_task_data", side_effect=collect),
              patch.object(monitor.realtime_hub, "publish", side_effect=publish)):
            await instance._check_all_tasks()
            await instance._check_all_tasks()
        self.assertEqual(order, ["final-data", "task.status", "server.tasks", "task.result"])
