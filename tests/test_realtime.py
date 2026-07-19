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
