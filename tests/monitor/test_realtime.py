import asyncio
import json
import shutil
import subprocess
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.core.realtime import RealtimeHub
from backend.server.routes import realtime as realtime_route


class RealtimeHubTests(unittest.IsolatedAsyncioTestCase):
    async def test_replays_events_after_the_saved_cursor(self):
        hub = RealtimeHub()
        await hub.publish("server", "server.tasks", {"training_active": False})
        await hub.publish("server", "server.tasks", {"training_active": True})

        queue, replay, resync_required = await hub.subscribe("server", resume_seq=1)

        self.assertFalse(resync_required)
        self.assertEqual([event["seq"] for event in replay], [2])
        self.assertTrue(queue.empty())

    async def test_expired_cursor_requires_a_snapshot_resync(self):
        hub = RealtimeHub()
        for index in range(258):
            await hub.publish("server", "server.tasks", {"index": index})

        _, replay, resync_required = await hub.subscribe("server", resume_seq=1)

        self.assertTrue(resync_required)
        self.assertEqual(replay, [])

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

    def test_websocket_previous_instance_forces_fresh_snapshot(self):
        app = FastAPI()
        app.include_router(realtime_route.router)

        with TestClient(app) as client:
            with client.websocket_connect("/ws/realtime") as websocket:
                websocket.send_json({
                    "op": "hello",
                    "protocol": 1,
                    "server_instance_id": "old-instance",
                })
                ready = websocket.receive_json()
                resync = websocket.receive_json()

        self.assertEqual(ready["op"], "ready")
        self.assertEqual(resync["op"], "resync_required")
        self.assertEqual(resync["reason"], "server_instance_changed")
        self.assertEqual(resync["server_instance_id"], realtime_route.SERVER_INSTANCE_ID)

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

    @unittest.skipUnless(shutil.which("node"), "Node.js is required for frontend monitor checks")
    def test_same_task_reuses_log_page_but_transport_resync_forces_reload(self):
        script = r"""
global.window = {};
eval(require('fs').readFileSync('frontend/js/monitor-logs.js', 'utf8'));
eval(require('fs').readFileSync('frontend/js/monitor-core.js', 'utf8'));
const mixin = window.monitorCoreMixin;
const app = Object.assign(Object.create(mixin), {
  selectedRunDir: null,
  realtimeTaskStateUnknown: false,
  _logFullSourceKey: 'task:train-1',
  _logFullLoaded: true,
  _logFullNeedsResync: false,
  logFullLines: ['old-page'],
  logFullOffset: 0,
  logFullTotal: 1,
  logFullMatches: [],
  previews: [],
  previewStep: 0,
  lossSeries: [],
  trainParams: [],
  monitorData: {},
  currentRoute: 'settings',
  _outputFilesRunDir: '',
  t: (_key, fallback) => fallback,
  handleRealtimeHardware: () => {},
  _followLatestPreview: () => {},
  _setMonitorRealtimeTask: () => {},
});
const snapshot = {
  tasks: {managed: [{id: 'train-1', status: 'RUNNING'}]},
  monitor: {
    detail: true,
    state: 'RUNNING',
    active_task: {id: 'train-1', status: 'RUNNING'},
    log_lines: ['disk-tail'],
  },
};
app.applyRealtimeMonitorSnapshot(snapshot);
const reused = {
  lines: app.logFullLines.slice(),
  needsResync: app._logFullNeedsResync,
};
app._monitorRealtimeTopic = 'task:train-1';
app.handleRealtimeResyncRequired(['task:train-1']);
process.stdout.write(JSON.stringify({reused, afterResync: app._logFullNeedsResync}));
"""
        result = subprocess.run(
            ["node", "-e", script],
            cwd=Path.cwd(),
            check=True,
            capture_output=True,
            text=True,
            encoding="utf-8",
        )
        state = json.loads(result.stdout)

        self.assertEqual(state["reused"]["lines"], ["old-page"])
        self.assertFalse(state["reused"]["needsResync"])
        self.assertTrue(state["afterResync"])

    @unittest.skipUnless(shutil.which("node"), "Node.js is required for frontend monitor checks")
    def test_realtime_log_source_change_releases_stale_loading_state(self):
        script = r"""
global.window = {};
eval(require('fs').readFileSync('frontend/js/monitor-logs.js', 'utf8'));
eval(require('fs').readFileSync('frontend/js/monitor-core.js', 'utf8'));
const mixin = window.monitorCoreMixin;
const app = Object.assign(Object.create(mixin), {
  selectedRunDir: null,
  _monitorRealtimeTopic: 'task:train-2',
  _logFullSourceKey: 'task:train-1',
  _logSliceRequestSeq: 3,
  logFullLoading: true,
  logFullLines: ['old-task'],
  logFullOffset: 10,
  logFullTotal: 11,
  logFullMatches: [10],
  logFullMatchIdx: 0,
  _logFullLoaded: true,
  _logFullNeedsResync: false,
  logLines: [],
  logMode: 'full',
  currentRoute: 'settings',
});
app.handleRealtimeTaskLog({data: {lines: []}});
process.stdout.write(JSON.stringify({
  source: app._logFullSourceKey,
  requestSeq: app._logSliceRequestSeq,
  loading: app.logFullLoading,
  loaded: app._logFullLoaded,
  needsResync: app._logFullNeedsResync,
}));
"""
        result = subprocess.run(
            ["node", "-e", script], cwd=Path.cwd(), check=True,
            capture_output=True, text=True, encoding="utf-8",
        )
        state = json.loads(result.stdout)

        self.assertEqual(state["source"], "task:train-2")
        self.assertEqual(state["requestSeq"], 4)
        self.assertFalse(state["loading"])
        self.assertFalse(state["loaded"])
        self.assertTrue(state["needsResync"])

    @unittest.skipUnless(shutil.which("node"), "Node.js is required for environment finalize checks")
    def test_environment_finalize_keeps_failure_reason_after_silent_refresh(self):
        script = r"""
global.window = {};
global.requestAnimationFrame = callback => setTimeout(callback, 0);
eval(require('fs').readFileSync('frontend/js/environment-core.js', 'utf8'));
const mixin = window.environmentCoreMixin;
const renders = [];
global.fetch = async () => ({ok: true, json: async () => ({installed: false})});
const app = Object.assign({}, mixin, {
  currentRoute: 'environment',
  t: (key, fallback) => fallback || key,
  toast: () => {},
  startProgress() {}, finishProgress() {},
  scheduleEnvironmentRender() { renders.push(1); },
  renderEnvironment() {},
  realtimeSubscribe() {}, realtimeUnsubscribe() {},
});
app._setEnvironmentRealtimeTask('fa', 'job-1');
app._setEnvironmentRealtimeTask('triton', 'job-2');
(async () => {
  await app._finalizeEnvironmentRealtimeTask(
    'fa', {progress: {error: 'wheel 404'}, log: ['line1', 'wheel 404']}, true);
  await app._finalizeEnvironmentRealtimeTask(
    'triton', {lines: 'pip exit code 1'}, true);
  process.stdout.write(JSON.stringify({
    faError: app.faError, tritonError: app.tritonError,
    faBusy: app.faBusy, tritonBusy: app.tritonBusy,
    renders: renders.length,
  }));
})().catch(error => { console.error(error); process.exit(1); });
"""
        result = subprocess.run(
            ["node", "-e", script], cwd=Path.cwd(), check=True,
            capture_output=True, text=True, encoding="utf-8",
        )
        state = json.loads(result.stdout)

        # silent refresh 会清掉 error 字段；finalize 必须在 refresh 之后写回失败原因
        self.assertEqual(state["faError"], "wheel 404")
        self.assertEqual(state["tritonError"], "pip exit code 1")
        self.assertFalse(state["faBusy"])
        self.assertFalse(state["tritonBusy"])
        self.assertGreaterEqual(state["renders"], 2)


if __name__ == "__main__":
    unittest.main()
