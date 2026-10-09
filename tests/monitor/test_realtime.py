import asyncio
import json
import shutil
import subprocess
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.core.realtime import RealtimeHub, _compact_task_snapshot
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

    def test_structured_logs_keep_their_level_in_realtime_snapshots(self):
        entry = {"time": "21:00:21", "event": "done", "level": "success", "failed": 0}
        self.assertEqual(_compact_task_snapshot({"logs": ["legacy", entry]})["logs"], ["legacy", entry])

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


class RealtimeFrontendContractTests(unittest.TestCase):
    @staticmethod
    def _eval_frontend_mixins():
        """按 index.html 的加载顺序合并实时 mixins，与生产组合保持一致。"""
        return (
            "global.window = {};\n"
            "global.document = {getElementById: () => null};\n"
            "global.requestAnimationFrame = callback => callback();\n"
            "for (const file of ['frontend/js/realtime.js', 'frontend/js/monitor-core.js', 'frontend/js/training-toml.js']) {\n"
            "  eval(require('fs').readFileSync(file, 'utf8'));\n"
            "}\n"
            "const app = Object.assign({}, window.realtimeMixin, window.monitorCoreMixin, window.trainingTomlMixin, {\n"
            "  t: key => key,\n"
            "  currentRoute: '',\n"
            "});\n"
        )

    @unittest.skipUnless(shutil.which("node"), "Node.js is required for frontend training checks")
    def test_poll_response_older_than_ownership_boundary_is_ignored(self):
        """请求发出早于所有权变更的轮询响应不得结算/认领任务。"""
        script = self._eval_frontend_mixins() + r"""
const outcomes = {};
// 场景一：刚认领新任务，早于认领发出的旧响应声称"无任务"。
app.beginLiveMonitorTask('train-2', 'RUNNING');
app._applyTaskView('RUNNING');
app._applyManagedTrainingState({tasks: {managed: []}}, app.liveTaskBoundaryAt - 1);
outcomes.afterStaleRelease = {
  liveTaskId: app.liveTaskId,
  isTraining: app.isTraining,
  statusText: app.statusText,
};
// 场景二：刚终止并释放，早于释放发出的旧响应声称"旧任务仍在运行"。
app.releaseLiveTask();
app._applyManagedTrainingState({tasks: {managed: [{id: 'train-2', status: 'RUNNING'}]}}, app.liveTaskBoundaryAt - 1);
outcomes.afterStaleAdopt = {
  liveTaskId: app.liveTaskId,
  isTraining: app.isTraining,
  statusText: app.statusText,
};
// 对照：晚于边界的响应正常生效。
app._applyManagedTrainingState({tasks: {managed: []}}, app.liveTaskBoundaryAt + 1);
outcomes.afterFresh = { isTraining: app.isTraining, statusText: app.statusText };
process.stdout.write(JSON.stringify(outcomes));
"""
        result = subprocess.run(
            ["node", "-e", script], cwd=Path.cwd(), check=True,
            capture_output=True, text=True, encoding="utf-8",
        )
        state = json.loads(result.stdout)

        self.assertEqual(state["afterStaleRelease"]["liveTaskId"], "train-2")
        self.assertTrue(state["afterStaleRelease"]["isTraining"])
        self.assertEqual(state["afterStaleRelease"]["statusText"], "monitor.training")
        # 旧响应没有把已释放的任务重新认领回来（视图字段仍是释放前的残留）。
        self.assertIsNone(state["afterStaleAdopt"]["liveTaskId"])
        self.assertEqual(state["afterStaleAdopt"]["statusText"], "monitor.training")
        self.assertFalse(state["afterFresh"]["isTraining"])
        self.assertEqual(state["afterFresh"]["statusText"], "monitor.idle")

    @unittest.skipUnless(shutil.which("node"), "Node.js is required for frontend cursor checks")
    def test_monitor_detail_snapshot_does_not_skip_queued_task_replay(self):
        script = r"""
global.window = {};
eval(require('fs').readFileSync('frontend/js/realtime.js', 'utf8'));
const app = Object.assign({}, window.realtimeMixin, {
  _realtimeCursors: {'task:train-1': 10, server: 3},
  _realtimeTopics: new Set(['server', 'task:train-1']),
});
app._applyRealtimeSnapshotCursors(
  {'task:train-1': 40, server: 8, hardware: 7},
  {preserveSubscribedCursors: true},
);
process.stdout.write(JSON.stringify(app._realtimeCursors));
"""
        result = subprocess.run(
            ["node", "-e", script],
            cwd=Path.cwd(),
            check=True,
            capture_output=True,
            text=True,
            encoding="utf-8",
        )
        cursors = json.loads(result.stdout)

        self.assertEqual(cursors["task:train-1"], 10)
        self.assertEqual(cursors["server"], 3)
        self.assertEqual(cursors["hardware"], 7)


if __name__ == "__main__":
    unittest.main()
