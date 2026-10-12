import asyncio
import unittest
from unittest.mock import AsyncMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.core.realtime import RealtimeHub
from backend.server.routes import realtime as realtime_route
from backend.server.routes import system as system_route
from backend.tasks import TaskManager


class RealtimeHubTests(unittest.IsolatedAsyncioTestCase):
    async def test_slow_subscriber_queue_is_bounded_and_keeps_newest_events(self):
        hub = RealtimeHub()
        queue, _, _ = await hub.subscribe("hardware")
        for index in range(300):
            await hub.publish("hardware", "hardware.sample", {"index": index})

        self.assertLessEqual(queue.qsize(), queue.maxsize)
        retained = []
        while not queue.empty():
            retained.append(queue.get_nowait())
        markers = [item for item in retained if item.get("op") == "resync_required"]
        events = [item for item in retained if item.get("op") == "event"]
        self.assertTrue(markers)
        self.assertEqual(markers[-1]["reason"], "slow_consumer")
        self.assertEqual(events[-1]["seq"], 300)
        self.assertGreater(events[0]["seq"], 1)


class RealtimeRouteTests(unittest.TestCase):
    def test_generation_activity_is_global_without_becoming_training(self):
        manager = TaskManager()
        task = manager.reserve_task()
        task.kind = "regularization"
        app = FastAPI()
        app.include_router(realtime_route.router)
        app.include_router(system_route.router, prefix="/api")
        with patch.object(realtime_route, "tm", manager), patch.object(system_route, "tm", manager), patch.object(
            realtime_route, "gpu_info", return_value={}
        ), patch.object(realtime_route, "system_info", return_value={}), patch.object(
            realtime_route, "build_live_monitor_snapshot", new=AsyncMock(return_value={})
        ), TestClient(app) as client:
            for active in (True, False):
                with self.subTest(active=active):
                    health = client.get("/api/health").json()
                    snapshot = client.get("/api/realtime/snapshot").json()["data"]
                    self.assertEqual(health["regularization_active"], active)
                    self.assertEqual(snapshot["server"]["regularization_active"], active)
                    self.assertFalse(health["training_active"])
                    self.assertFalse(snapshot["server"]["training_active"])
                    self.assertEqual(snapshot["tasks"]["managed"], [])
                if active:
                    manager.release_reserved(task)


    def test_websocket_hello_ready_subscribe_and_replay(self):
        hub = RealtimeHub()
        asyncio.run(hub.publish("server", "server.tasks", {"training_active": True}))
        app = FastAPI()
        app.include_router(realtime_route.router)

        with patch.object(realtime_route, "realtime_hub", hub), TestClient(app) as client:
            with client.websocket_connect("/ws/realtime") as websocket:
                websocket.send_json({"op": "hello", "protocol": 1})
                ready = websocket.receive_json()
                self.assertEqual(ready["op"], "ready")
                self.assertEqual(ready["server_instance_id"], realtime_route.SERVER_INSTANCE_ID)

                websocket.send_json({"op": "subscribe", "topics": ["server"], "resume": {"server": 0}})
                event = None
                for _ in range(4):
                    candidate = websocket.receive_json()
                    if candidate.get("op") == "event":
                        event = candidate
                        break
                self.assertIsNotNone(event)
                self.assertEqual(event["op"], "event")
                self.assertEqual(event["topic"], "server")
                self.assertEqual(event["type"], "server.tasks")
                self.assertIn("seq", event)
                self.assertIn("emitted_at", event)


    def test_websocket_expired_cursor_forces_resync(self):
        hub = RealtimeHub()
        for index in range(258):
            asyncio.run(hub.publish("server", "server.tasks", {"index": index}))
        app = FastAPI()
        app.include_router(realtime_route.router)

        with patch.object(realtime_route, "realtime_hub", hub), TestClient(app) as client:
            with client.websocket_connect("/ws/realtime") as websocket:
                websocket.send_json({"op": "hello", "protocol": 1})
                self.assertEqual(websocket.receive_json()["op"], "ready")
                websocket.send_json({"op": "subscribe", "topics": ["server"], "resume": {"server": 1}})
                resync = websocket.receive_json()

        self.assertEqual(resync["op"], "resync_required")
        self.assertEqual(resync["topics"], ["server"])


if __name__ == "__main__":
    unittest.main()
