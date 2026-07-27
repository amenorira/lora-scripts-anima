import asyncio
import json
import shutil
import subprocess
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.core.realtime import RealtimeHub, RealtimeTaskRegistry, task_topic
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

    async def test_task_registry_keeps_task_logs_bounded_for_realtime(self):
        hub = RealtimeHub()
        registry = RealtimeTaskRegistry(hub)
        await registry.register(
            "install-1",
            "install",
            lambda: {
                "status": "running",
                "lines": [f"line-{index}:" + "x" * 100 for index in range(120)],
            },
        )

        await registry.poll()
        _, replay, _ = await hub.subscribe(task_topic("install-1"), resume_seq=0)
        progress = next(event for event in reversed(replay) if event["type"] == "task.progress")
        data = progress["payload"]["data"]

        self.assertEqual(len(data["lines"]), 100)
        self.assertTrue(data["realtime_truncated"])
        self.assertLess(len(json.dumps(progress, ensure_ascii=False).encode("utf-8")), 64 * 1024)

    async def test_task_registry_discards_unbounded_nested_provider_data(self):
        hub = RealtimeHub()
        registry = RealtimeTaskRegistry(hub)
        await registry.register(
            "download-1",
            "download",
            lambda: {
                "status": "running",
                "phase": "copying",
                "diagnostics": {"raw": "x" * (128 * 1024)},
            },
        )

        await registry.poll()
        _, replay, _ = await hub.subscribe(task_topic("download-1"), resume_seq=0)
        progress = next(event for event in reversed(replay) if event["type"] == "task.progress")
        data = progress["payload"]["data"]

        self.assertEqual(data["phase"], "copying")
        self.assertNotIn("diagnostics", data)
        self.assertTrue(data["realtime_truncated"])
        self.assertLess(len(json.dumps(progress, ensure_ascii=False).encode("utf-8")), 64 * 1024)


class RealtimeRouteTests(unittest.TestCase):
    def test_snapshot_contains_server_instance_and_sample_time(self):
        async def tracked_snapshot():
            return []

        with (
            patch.object(realtime_route, "gpu_info", return_value={"name": "GPU"}),
            patch.object(realtime_route, "system_info", return_value={"cpu_name": "CPU"}),
            patch.object(realtime_route.tm, "dump", return_value=[]),
            patch.object(realtime_route.realtime_tasks, "snapshot", new=AsyncMock(side_effect=tracked_snapshot)),
        ):
            response = asyncio.run(realtime_route.realtime_snapshot())

        data = response["data"]
        self.assertEqual(response["status"], "success")
        self.assertEqual(data["server_instance_id"], realtime_route.SERVER_INSTANCE_ID)
        self.assertEqual(data["server"]["started_at"], realtime_route.SERVER_STARTED_AT)
        self.assertIsInstance(data["hardware"]["sampled_at"], float)

    def test_snapshot_forwards_compact_and_detail_modes(self):
        payload = {"server_instance_id": "instance"}
        with patch.object(realtime_route, "_snapshot_payload", new=AsyncMock(return_value=payload)) as snapshot:
            compact = asyncio.run(realtime_route.realtime_snapshot())
            detail = asyncio.run(realtime_route.realtime_snapshot(detail=True, preview_limit=12))

        self.assertEqual(compact["data"], payload)
        self.assertEqual(detail["data"], payload)
        self.assertEqual(
            snapshot.await_args_list,
            [
                unittest.mock.call(monitor_detail=False, preview_limit=36),
                unittest.mock.call(monitor_detail=True, preview_limit=12),
            ],
        )

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

    def test_websocket_replies_to_a_browser_ping(self):
        app = FastAPI()
        app.include_router(realtime_route.router)

        with TestClient(app) as client:
            with client.websocket_connect("/ws/realtime") as websocket:
                websocket.send_json({"op": "hello", "protocol": 1})
                self.assertEqual(websocket.receive_json()["op"], "ready")
                websocket.send_json({"op": "ping"})
                pong = websocket.receive_json()

        self.assertEqual(pong["op"], "pong")
        self.assertEqual(pong["server_instance_id"], realtime_route.SERVER_INSTANCE_ID)
        self.assertIsInstance(pong["emitted_at"], float)

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
    @classmethod
    def setUpClass(cls):
        cls.client_source = Path("frontend/js/realtime.js").read_text(encoding="utf-8")
        cls.monitor_source = Path("frontend/js/monitor-core.js").read_text(encoding="utf-8")
        cls.tagger_source = Path("frontend/js/tagger.js").read_text(encoding="utf-8")
        cls.environment_source = Path("frontend/js/environment-core.js").read_text(encoding="utf-8")

    def test_restart_resets_state_and_retries_a_failed_snapshot(self):
        self.assertIn("server_instance_id", self.client_source)
        self.assertIn("_handleRealtimeServerRestart()", self.client_source)
        self.assertIn("_scheduleRealtimeSnapshotRetry", self.client_source)
        self.assertIn("resetRealtimeMonitorState", self.client_source)
        self.assertIn("this._realtimeCursors = {};", self.client_source)
        self.assertIn("this.realtimeSnapshot = null;", self.client_source)
        self.assertIn("this.taskId = null;", self.monitor_source)
        self.assertIn("this.gpuInfo = null;", self.monitor_source)

    def test_monitor_detail_is_invalidated_when_leaving_the_dashboard(self):
        self.assertIn("monitorDetailGeneration", self.client_source)
        self.assertIn("applyMonitor", self.client_source)
        self.assertIn("_monitorRealtimeDetailGeneration", self.monitor_source)
        self.assertIn("this._monitorRealtimeDetailGeneration++;", self.monitor_source)
        self.assertIn("void this.refreshMonitorRealtimeDetail();", self.monitor_source)

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
        self.assertIn("preserveSubscribedCursors: true", self.monitor_source)

    @unittest.skipUnless(shutil.which("node"), "Node.js is required for frontend monitor checks")
    def test_same_task_reuses_log_page_but_transport_resync_forces_reload(self):
        script = r"""
global.window = {};
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
    def test_new_task_discards_previous_full_log_buffer(self):
        script = r"""
global.window = {};
eval(require('fs').readFileSync('frontend/js/monitor-core.js', 'utf8'));
const mixin = window.monitorCoreMixin;
const app = Object.assign(Object.create(mixin), {
  selectedRunDir: null,
  realtimeTaskStateUnknown: false,
  _logFullSourceKey: 'task:train-1',
  _logFullLoaded: true,
  _logFullNeedsResync: false,
  _logSliceRequestSeq: 0,
  logFullLines: ['old-task'],
  logFullOffset: 0,
  logFullTotal: 1,
  logFullMatches: [0],
  logFullMatchIdx: 0,
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
app.applyRealtimeMonitorSnapshot({
  tasks: {managed: [{id: 'train-2', status: 'RUNNING'}]},
  monitor: {
    detail: true,
    state: 'RUNNING',
    active_task: {id: 'train-2', status: 'RUNNING'},
    log_lines: ['new-task-tail'],
  },
});
process.stdout.write(JSON.stringify({
  source: app._logFullSourceKey,
  lines: app.logFullLines,
  total: app.logFullTotal,
  loaded: app._logFullLoaded,
  needsResync: app._logFullNeedsResync,
}));
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

        self.assertEqual(state["source"], "task:train-2")
        self.assertEqual(state["lines"], [])
        self.assertEqual(state["total"], 0)
        self.assertFalse(state["loaded"])
        self.assertTrue(state["needsResync"])

    def test_leaving_tail_mode_requires_a_fresh_full_log_page(self):
        stop_body = self.monitor_source.split("stopMonitorRealtime() {", 1)[1].split("\n  },", 1)[0]

        self.assertIn("const wasTailMode = this.logMode === 'tail';", stop_body)
        self.assertIn("this._logFullLoaded = false;", stop_body)
        self.assertIn("this._logFullNeedsResync = true;", stop_body)

    def test_realtime_uses_two_second_freshness_and_no_sse_or_progress_polling(self):
        combined = "\n".join((
            self.client_source,
            self.monitor_source,
            self.tagger_source,
            self.environment_source,
        ))
        self.assertIn("age > 2000", self.client_source)
        self.assertNotIn("Event" + "Source", combined)
        self.assertNotIn("connectMonitor" + "S" + "SE", combined)
        self.assertNotIn("pollTaggerProgress", combined)
        self.assertNotIn("_startProgressPolling", combined)

    def test_environment_cold_start_is_throttled_and_shows_progress(self):
        render_source = Path("frontend/js/environment-render.js").read_text(encoding="utf-8")
        self.assertIn("_runEnvironmentLoadQueue(loaders, 2)", self.environment_source)
        self.assertIn("_commitEnvironmentLoad", self.environment_source)
        self.assertIn("_waitForEnvironmentPaint", self.environment_source)
        self.assertIn("environmentLoadCompleted", self.environment_source)
        self.assertIn("scheduleEnvironmentRender", self.environment_source)
        self.assertIn('class="env-load-status"', render_source)

    @unittest.skipUnless(shutil.which("node"), "Node.js is required for frontend state-machine checks")
    def test_environment_results_commit_one_painted_step_at_a_time(self):
        script = r"""
global.window = {};
global.requestAnimationFrame = callback => setTimeout(callback, 0);
eval(require('fs').readFileSync('frontend/js/environment-core.js', 'utf8'));
const mixin = window.environmentCoreMixin;
const frames = [];
const applied = [];
const app = Object.assign({}, mixin, {
  currentRoute: 'environment',
  environmentLoadCompleted: 0,
  _environmentCommitChain: Promise.resolve(),
  renderEnvironment() { frames.push(this.environmentLoadCompleted); },
});
const delays = [30, 5, 20, 0, 10, 0];
const loaders = delays.map((delay, index) => ({
  load: () => new Promise(resolve => setTimeout(() => resolve(index), delay)),
  apply: value => applied.push(value),
}));
(async () => {
  await app._runEnvironmentLoadQueue(loaders, 2);
  process.stdout.write(JSON.stringify({frames, applied}));
})().catch(error => { console.error(error); process.exit(1); });
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

        self.assertEqual(state["frames"], [1, 2, 3, 4, 5, 6])
        self.assertEqual(state["applied"][0], 1)
        self.assertEqual(sorted(state["applied"]), list(range(6)))

    def test_weak_network_media_queue_and_explicit_original_are_present(self):
        render_source = Path("frontend/js/monitor-render.js").read_text(encoding="utf-8")
        app_source = Path("frontend/js/app.js").read_text(encoding="utf-8")
        preset_source = Path("frontend/js/training-presets.js").read_text(encoding="utf-8")
        index_source = Path("frontend/index.html").read_text(encoding="utf-8")
        self.assertIn("weakNetworkMode: true", self.monitor_source)
        self.assertIn("_previewMediaPaused", self.monitor_source)
        self.assertIn("_previewMediaQueue", self.monitor_source)
        self.assertNotIn("showMorePreviews", self.monitor_source)
        self.assertIn("requestWeakNetworkModeChange", app_source)
        self.assertIn("this.openConfirm(", app_source)
        self.assertIn("weakNetworkMode: this.weakNetworkMode", app_source)
        self.assertIn("confirmActionLabel", preset_source)
        self.assertIn("settings.slowConnectionMode", index_source)
        self.assertNotIn("toggleWeakNetworkMode", render_source)
        self.assertNotIn("visiblePreviews", render_source)
        self.assertIn("this.previews.forEach", render_source)
        self.assertIn("query.set('preview_limit', String(0))", self.client_source)
        self.assertIn("/api/monitor/previews?refresh=1&limit=0", self.monitor_source)
        self.assertIn("inspect_url || p.url", render_source)
        self.assertIn("previewLightboxOriginal", render_source)
        self.assertIn("thumb_url || preview.url", render_source)

    def test_no_legacy_realtime_http_routes_or_transport_remain(self):
        backend_sources = "\n".join((
            Path("backend/server/api.py").read_text(encoding="utf-8"),
            Path("backend/monitor/routes.py").read_text(encoding="utf-8"),
        ))
        for path in (
            "/interrogate/progress",
            "/install-log/",
            "/anima-model/progress/",
            "/flash-attention/progress/",
            "/monitor/status",
            "/monitor/is-active",
            "/monitor/stream",
        ):
            self.assertNotIn(path, backend_sources)

    def test_preview_cache_headers_are_not_overridden_by_api_middleware(self):
        application_source = Path("backend/server/application.py").read_text(encoding="utf-8")
        monitor_routes = Path("backend/monitor/routes.py").read_text(encoding="utf-8")

        self.assertIn('"/api/monitor/preview-image", "/api/monitor/preview-metadata"', application_source)
        self.assertIn('"Cache-Control": "private, max-age=86400, immutable"', monitor_routes)
        self.assertIn('"ETag":', monitor_routes)

    @unittest.skipUnless(shutil.which("node"), "Node.js is required for frontend state-machine checks")
    def test_offline_state_stays_offline_until_realtime_bootstrap_succeeds(self):
        script = r"""
global.window = {};
eval(require('fs').readFileSync('frontend/js/realtime.js', 'utf8'));
const mixin = window.realtimeMixin;
const notices = [];
const app = Object.assign({}, mixin, {
  realtimeState: 'online',
  backendConnected: true,
  backendDisconnectedAt: null,
  backendDisconnectedDuration: '',
  _disconnectedTimer: null,
  _realtimeHealthTimer: null,
  t: (key, fallback) => fallback || key,
  toast: (message, type) => notices.push({message, type}),
  setPreviewMediaPaused: () => {},
  _updateDisconnectedDuration: () => {},
});
app._setRealtimeState('offline');
const afterOffline = {state: app.realtimeState, connected: app.backendConnected, notices: notices.length};
app._setRealtimeState('connecting');
app._setRealtimeState('degraded');
app._setRealtimeState('offline');
const afterRetry = {state: app.realtimeState, connected: app.backendConnected, notices: notices.length};
app._setRealtimeState('online');
const afterBootstrap = {state: app.realtimeState, connected: app.backendConnected, notices: notices.length, lastType: notices.at(-1).type};
process.stdout.write(JSON.stringify({afterOffline, afterRetry, afterBootstrap}));
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

        self.assertEqual(state["afterOffline"], {"state": "offline", "connected": False, "notices": 1})
        self.assertEqual(state["afterRetry"], {"state": "offline", "connected": False, "notices": 1})
        self.assertEqual(state["afterBootstrap"], {"state": "online", "connected": True, "notices": 2, "lastType": "success"})


if __name__ == "__main__":
    unittest.main()
