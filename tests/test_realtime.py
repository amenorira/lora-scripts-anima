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
        cls.training_source = Path("frontend/js/training-toml.js").read_text(encoding="utf-8")
        cls.tagger_source = Path("frontend/js/tagger.js").read_text(encoding="utf-8")
        cls.environment_source = Path("frontend/js/environment-core.js").read_text(encoding="utf-8")

    @unittest.skipUnless(shutil.which("node"), "Node.js is required for frontend monitor checks")
    def test_monitor_helpers_merge_logs_and_filter_outputs_without_mutating_sources(self):
        script = r"""
global.window = {};
global.requestAnimationFrame = callback => callback();
eval(require('fs').readFileSync('frontend/js/monitor-core.js', 'utf8'));
const mixin = window.monitorCoreMixin;
const app = Object.assign(Object.create(mixin), {
  previews: [{name:'one'}, {name:'two'}, {name:'three'}],
  previewSortDir: 'asc',
  outputFiles: [
    {path:'m2', name:'epoch-2.safetensors', category:'model', ckpt_loss:0.2, size:20, mtime:2},
    {path:'m1', name:'epoch-1.safetensors', category:'model', ckpt_loss:0.1, size:10, mtime:1},
    {path:'cfg', name:'config.toml', category:'config', size:3, mtime:3},
  ],
  outputFilesSelected: {}, outputSearch: 'epoch', outputFilter: 'models',
  outputModelSortKey: 'loss', outputModelSortDir: 'asc',
  outputOtherSortKey: 'time', outputOtherSortDir: 'desc',
  renderDashboard() {},
});
const exact = ['a', 'b'];
const exactResult = app._mergeRealtimeLogLines(exact, ['b', 'c']);
const progress = ['steps: 64%|######----| 513/800 [loss=0.1]'];
const progressResult = app._mergeRealtimeLogLines(progress, ['steps: 64%|######----| 513/800 [loss=0.2]']);
const ordinary = ['status alpha'];
app._mergeRealtimeLogLines(ordinary, ['status beta']);
app.selectAllOutputFiles();
const asc = app._previewDisplayIndices();
app.previewSortDir = 'desc';
const desc = app._previewDisplayIndices();
process.stdout.write(JSON.stringify({
  exact, exactResult, progress, progressResult, ordinary,
  selected: Object.keys(app.outputFilesSelected),
  sorted: app._sortedOutputs().models.map(file => file.path),
  source: app.outputFiles.map(file => file.path), asc, desc,
}));
"""
        result = subprocess.run(
            ["node", "-e", script], cwd=Path.cwd(), check=True,
            capture_output=True, text=True, encoding="utf-8",
        )
        state = json.loads(result.stdout)

        self.assertEqual(state["exact"], ["a", "b", "c"])
        self.assertEqual(state["exactResult"]["overlap"], 1)
        self.assertEqual(state["progress"], ["steps: 64%|######----| 513/800 [loss=0.2]"])
        self.assertEqual(state["progressResult"]["appended"], 0)
        self.assertEqual(state["progressResult"]["replaced"], 1)
        self.assertEqual(state["ordinary"], ["status alpha", "status beta"])
        self.assertEqual(state["selected"], ["m2", "m1"])
        self.assertEqual(state["sorted"], ["m1", "m2"])
        self.assertEqual(state["source"], ["m2", "m1", "cfg"])
        self.assertEqual(state["asc"], [0, 1, 2])
        self.assertEqual(state["desc"], [2, 1, 0])

    def test_restart_resets_state_and_retries_a_failed_snapshot(self):
        self.assertIn("server_instance_id", self.client_source)
        self.assertIn("_handleRealtimeServerRestart()", self.client_source)
        self.assertIn("_scheduleRealtimeSnapshotRetry", self.client_source)
        self.assertIn("resetRealtimeMonitorState", self.client_source)
        self.assertIn("this._realtimeCursors = {};", self.client_source)
        self.assertIn("this.realtimeSnapshot = null;", self.client_source)
        self.assertIn("this.taskId = null;", self.monitor_source)
        self.assertIn("this.gpuInfo = null;", self.monitor_source)

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
    def test_training_start_claims_task_and_paints_created_view(self):
        script = self._eval_frontend_mixins() + r"""
const accepted = app._acceptTrainingStart({task_id: 'train-42'});
process.stdout.write(JSON.stringify({
  accepted,
  liveTaskId: app.liveTaskId,
  taskId: app.taskId,
  activeTaskId: app.activeTaskId,
  trainingActive: app.trainingActive,
  trainingBlocked: app.trainingBlocked,
  isTraining: app.isTraining,
  isIdle: app.isIdle,
  statusText: app.statusText,
  unknown: app.realtimeTaskStateUnknown,
  state: app.monitorData.state,
  activeTask: app.monitorData.active_task,
  topic: app._monitorRealtimeTopic,
  subscribed: Array.from(app._realtimeTopics || []),
}));
"""
        result = subprocess.run(
            ["node", "-e", script], cwd=Path.cwd(), check=True,
            capture_output=True, text=True, encoding="utf-8",
        )
        state = json.loads(result.stdout)

        self.assertTrue(state["accepted"])
        self.assertEqual(state["liveTaskId"], "train-42")
        self.assertEqual(state["taskId"], "train-42")
        self.assertEqual(state["activeTaskId"], "train-42")
        self.assertTrue(state["trainingActive"])
        self.assertTrue(state["trainingBlocked"])
        self.assertTrue(state["isTraining"])
        self.assertFalse(state["isIdle"])
        self.assertEqual(state["statusText"], "monitor.created")
        self.assertFalse(state["unknown"])
        self.assertEqual(state["state"], "CREATED")
        self.assertEqual(state["activeTask"], {"id": "train-42", "status": "CREATED"})
        self.assertEqual(state["topic"], "task:train-42")
        self.assertIn("task:train-42", state["subscribed"])

    @unittest.skipUnless(shutil.which("node"), "Node.js is required for frontend training checks")
    def test_training_start_without_task_id_returns_to_idle(self):
        script = self._eval_frontend_mixins() + r"""
app.isTraining = true;
app.isIdle = false;
app.statusText = 'monitor.training';
const accepted = app._acceptTrainingStart({});
process.stdout.write(JSON.stringify({
  accepted,
  isTraining: app.isTraining,
  isIdle: app.isIdle,
  statusText: app.statusText,
  liveTaskId: app.liveTaskId,
}));
"""
        result = subprocess.run(
            ["node", "-e", script], cwd=Path.cwd(), check=True,
            capture_output=True, text=True, encoding="utf-8",
        )
        state = json.loads(result.stdout)

        self.assertFalse(state["accepted"])
        self.assertFalse(state["isTraining"])
        self.assertTrue(state["isIdle"])
        self.assertEqual(state["statusText"], "monitor.idle")
        self.assertIsNone(state["liveTaskId"])

    @unittest.skipUnless(shutil.which("node"), "Node.js is required for frontend training checks")
    def test_poll_settles_terminal_state_and_fires_completion(self):
        """轮询发现拥有任务已到终态：绘制终态、释放所有权并触发完成提示。"""
        script = self._eval_frontend_mixins() + r"""
const completions = [];
app.handleTaskCompletion = (prev, next) => completions.push([prev, next]);
app.beginLiveMonitorTask('train-1', 'RUNNING');
app._applyTaskView('RUNNING');
app._applyManagedTrainingState({tasks: {managed: [{id: 'train-1', status: 'TERMINATED'}]}}, Date.now());
process.stdout.write(JSON.stringify({
  completions,
  liveTaskId: app.liveTaskId,
  isTraining: app.isTraining,
  isIdle: app.isIdle,
  trainingActive: app.trainingActive,
  statusText: app.statusText,
  state: app.monitorData.state,
}));
"""
        result = subprocess.run(
            ["node", "-e", script], cwd=Path.cwd(), check=True,
            capture_output=True, text=True, encoding="utf-8",
        )
        state = json.loads(result.stdout)

        self.assertEqual(state["completions"], [["RUNNING", "TERMINATED"]])
        self.assertIsNone(state["liveTaskId"])
        self.assertFalse(state["isTraining"])
        self.assertTrue(state["isIdle"])
        self.assertFalse(state["trainingActive"])
        self.assertEqual(state["statusText"], "monitor.terminated")
        self.assertEqual(state["state"], "TERMINATED")

    @unittest.skipUnless(shutil.which("node"), "Node.js is required for frontend training checks")
    def test_poll_missing_owned_task_settles_to_idle_without_completion(self):
        """任务被注册表驱逐（终态事件丢失）：结算为空闲而不是永远卡在训练中。"""
        script = self._eval_frontend_mixins() + r"""
const completions = [];
app.handleTaskCompletion = (prev, next) => completions.push([prev, next]);
app.beginLiveMonitorTask('train-1', 'RUNNING');
app._applyManagedTrainingState({tasks: {managed: []}}, Date.now());
process.stdout.write(JSON.stringify({
  completions,
  liveTaskId: app.liveTaskId,
  isTraining: app.isTraining,
  statusText: app.statusText,
  state: app.monitorData.state,
}));
"""
        result = subprocess.run(
            ["node", "-e", script], cwd=Path.cwd(), check=True,
            capture_output=True, text=True, encoding="utf-8",
        )
        state = json.loads(result.stdout)

        self.assertEqual(state["completions"], [])
        self.assertIsNone(state["liveTaskId"])
        self.assertFalse(state["isTraining"])
        self.assertEqual(state["statusText"], "monitor.idle")
        self.assertEqual(state["state"], "IDLE")

    @unittest.skipUnless(shutil.which("node"), "Node.js is required for frontend training checks")
    def test_poll_adopts_active_task_after_page_load(self):
        """页面刷新/他处启动后首次轮询：认领运行中任务并建立任务边界。"""
        script = self._eval_frontend_mixins() + r"""
app._applyManagedTrainingState({tasks: {managed: [
  {id: 'finished-old', status: 'TERMINATED'},
  {id: 'train-9', status: 'RUNNING'},
]}}, Date.now());
process.stdout.write(JSON.stringify({
  liveTaskId: app.liveTaskId,
  isTraining: app.isTraining,
  statusText: app.statusText,
  state: app.monitorData.state,
  activeTask: app.monitorData.active_task,
  topic: app._monitorRealtimeTopic,
}));
"""
        result = subprocess.run(
            ["node", "-e", script], cwd=Path.cwd(), check=True,
            capture_output=True, text=True, encoding="utf-8",
        )
        state = json.loads(result.stdout)

        self.assertEqual(state["liveTaskId"], "train-9")
        self.assertTrue(state["isTraining"])
        self.assertEqual(state["statusText"], "monitor.training")
        self.assertEqual(state["state"], "RUNNING")
        self.assertEqual(state["activeTask"], {"id": "train-9", "status": "RUNNING"})
        self.assertEqual(state["topic"], "task:train-9")

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

    @unittest.skipUnless(shutil.which("node"), "Node.js is required for frontend realtime checks")
    def test_late_ws_task_status_event_never_writes_state(self):
        """WS 只承载流式数据：任何 task.status 事件（迟到与否）都不改写状态。"""
        script = self._eval_frontend_mixins() + r"""
app.beginLiveMonitorTask('train-2', 'RUNNING');
app._applyTaskView('RUNNING');
const before = {isTraining: app.isTraining, statusText: app.statusText, state: app.monitorData.state};
// 旧任务的迟到终态（topic 已不是当前订阅）。
app.handleRealtimeMonitorEvent({topic: 'task:train-1', type: 'task.status', payload: {task_id: 'train-1', status: 'TERMINATED'}});
const afterForeign = {isTraining: app.isTraining, statusText: app.statusText, state: app.monitorData.state};
// 即便是当前任务自己的 status 事件也不做状态写入（终态由轮询结算）。
app.handleRealtimeMonitorEvent({topic: 'task:train-2', type: 'task.status', payload: {task_id: 'train-2', status: 'TERMINATED'}});
const afterOwn = {isTraining: app.isTraining, statusText: app.statusText, state: app.monitorData.state};
process.stdout.write(JSON.stringify({before, afterForeign, afterOwn}));
"""
        result = subprocess.run(
            ["node", "-e", script], cwd=Path.cwd(), check=True,
            capture_output=True, text=True, encoding="utf-8",
        )
        state = json.loads(result.stdout)

        for key in ("afterForeign", "afterOwn"):
            self.assertTrue(state[key]["isTraining"])
            self.assertEqual(state[key]["statusText"], "monitor.training")
            self.assertEqual(state[key]["state"], "RUNNING")

    @unittest.skipUnless(shutil.which("node"), "Node.js is required for frontend training checks")
    def test_stop_terminate_triggers_immediate_reconcile(self):
        """终止请求成功后立刻对账一次，终态绘制交给轮询写入方。"""
        script = self._eval_frontend_mixins() + r"""
global.fetch = async () => ({ok: true});
let polls = 0;
app._pollTrainingState = () => { polls++; return Promise.resolve(); };
app.beginLiveMonitorTask('train-3', 'RUNNING');
app._applyTaskView('RUNNING');
(async () => {
  await app.stopTraining();
  process.stdout.write(JSON.stringify({polls}));
})().catch(error => { console.error(error); process.exit(1); });
"""
        result = subprocess.run(
            ["node", "-e", script], cwd=Path.cwd(), check=True,
            capture_output=True, text=True, encoding="utf-8",
        )
        state = json.loads(result.stdout)

        self.assertEqual(state["polls"], 1)

    def test_monitor_detail_is_invalidated_when_leaving_the_dashboard(self):
        self.assertIn("monitorDetailGeneration", self.client_source)
        self.assertIn("applyMonitor", self.client_source)
        self.assertIn("_monitorRealtimeDetailGeneration", self.monitor_source)
        self.assertIn("this._monitorRealtimeDetailGeneration++;", self.monitor_source)
        self.assertIn("void this.refreshMonitorRealtimeDetail();", self.monitor_source)

    def test_backend_snapshot_captures_cursors_before_reading_task_list(self):
        """快照先取游标再读任务列表：任务列表必然包含截至该游标的全部状态变更。"""
        source = Path("backend/server/routes/realtime.py").read_text(encoding="utf-8")
        body = source.split("async def _snapshot_payload", 1)[1]
        cursors_pos = body.index("cursors = await realtime_hub.cursors()")
        dump_pos = body.index("managed_tasks = tm.dump()")
        self.assertLess(cursors_pos, dump_pos)

    @unittest.skipUnless(shutil.which("node"), "Node.js is required for frontend monitor checks")
    def test_statusbar_treats_created_as_active_state(self):
        """等待启动（CREATED）也要显示终止按钮且不显示待命文案。"""
        script = r"""
global.window = {};
eval(require('fs').readFileSync('frontend/js/monitor-render.js', 'utf8'));
const app = Object.assign({}, window.monitorRenderMixin, {
  esc: value => String(value),
  t: key => key,
  realtimeTaskStateUnknown: false,
  trainingStarting: false,
});
const created = app._statusbarHtml({state: 'CREATED'}, app.t);
const running = app._statusbarHtml({state: 'RUNNING'}, app.t);
const idle = app._statusbarHtml({state: 'IDLE'}, app.t);
const actionsVisible = html => !/data-role="actions"[^>]*hidden/.test(html);
const idleCopyVisible = html => !/data-role="idle-copy"[^>]*hidden/.test(html);
process.stdout.write(JSON.stringify({
  created: {actions: actionsVisible(created), idleCopy: idleCopyVisible(created)},
  running: {actions: actionsVisible(running), idleCopy: idleCopyVisible(running)},
  idle: {actions: actionsVisible(idle), idleCopy: idleCopyVisible(idle)},
}));
"""
        result = subprocess.run(
            ["node", "-e", script], cwd=Path.cwd(), check=True,
            capture_output=True, text=True, encoding="utf-8",
        )
        state = json.loads(result.stdout)

        self.assertTrue(state["created"]["actions"])
        self.assertFalse(state["created"]["idleCopy"])
        self.assertTrue(state["running"]["actions"])
        self.assertFalse(state["running"]["idleCopy"])
        self.assertFalse(state["idle"]["actions"])
        self.assertTrue(state["idle"]["idleCopy"])

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
  logFullLoading: true,
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
  loading: app.logFullLoading,
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
        self.assertFalse(state["loading"])
        self.assertTrue(state["needsResync"])

    @unittest.skipUnless(shutil.which("node"), "Node.js is required for frontend monitor checks")
    def test_realtime_log_source_change_releases_stale_loading_state(self):
        script = r"""
global.window = {};
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

    @unittest.skipUnless(shutil.which("node"), "Node.js is required for frontend monitor checks")
    def test_full_log_tail_request_sends_a_valid_boolean_query_value(self):
        script = r"""
global.window = {};
let requestedUrl = '';
global.fetch = async url => {
  requestedUrl = String(url);
  return {json: async () => ({status:'success', data:{offset:0, total:0, lines:[], match_indices:[]}})};
};
eval(require('fs').readFileSync('frontend/js/monitor-core.js', 'utf8'));
const mixin = window.monitorCoreMixin;
const app = Object.assign(Object.create(mixin), {
  selectedRunDir: 'output/test-run',
  logFullOffset: 0,
  logFullMatches: [],
  logFullMatchIdx: -1,
  logFullQuery: '',
  _logSliceRequestSeq: 0,
  renderDashboard() {},
  toast() {},
});
(async () => {
  await app.fetchLogSlice({tail:true, silent:true});
  process.stdout.write(requestedUrl);
})().catch(error => { console.error(error); process.exit(1); });
"""
        result = subprocess.run(
            ["node", "-e", script], cwd=Path.cwd(), check=True,
            capture_output=True, text=True, encoding="utf-8",
        )

        self.assertIn("tail=true", result.stdout)
        self.assertNotIn("tail=undefined", result.stdout)

    @unittest.skipUnless(shutil.which("node"), "Node.js is required for frontend monitor checks")
    def test_preview_sort_reorders_existing_nodes_without_dashboard_rebuild(self):
        script = r"""
global.window = {};
const items = [0, 1, 2].map(index => ({dataset: {previewIndex: String(index)}}));
const grid = {
  items: items.slice(),
  querySelectorAll() { return this.items.slice(); },
  appendChild(item) {
    this.items = this.items.filter(existing => existing !== item);
    this.items.push(item);
  },
};
const buttons = ['asc', 'desc'].map(dir => ({
  dataset: {previewSort: dir},
  classList: {toggle(_name, active) { this.active = active; }},
  setAttribute(name, value) { this[name] = value; },
}));
const content = {
  querySelector(selector) { return selector.includes('preview-grid') ? grid : null; },
  querySelectorAll(selector) { return selector === '[data-preview-sort]' ? buttons : []; },
};
global.document = {getElementById(id) { return id === 'monitorTabContent' ? content : null; }};
eval(require('fs').readFileSync('frontend/js/monitor-core.js', 'utf8'));
const mixin = window.monitorCoreMixin;
let renders = 0;
const app = Object.assign(Object.create(mixin), {
  previews: [{name:'one'}, {name:'two'}, {name:'three'}],
  previewSortDir: 'asc',
  currentRoute: 'monitor-dashboard',
  monitorTab: 'samples',
  renderDashboard() { renders++; },
});
app.setPreviewSort('desc');
process.stdout.write(JSON.stringify({
  order: grid.items.map(item => Number(item.dataset.previewIndex)),
  sameNodes: items.every(item => grid.items.includes(item)),
  renders,
  active: buttons.map(button => button.classList.active),
  pressed: buttons.map(button => button['aria-pressed']),
}));
"""
        result = subprocess.run(
            ["node", "-e", script], cwd=Path.cwd(), check=True,
            capture_output=True, text=True, encoding="utf-8",
        )
        state = json.loads(result.stdout)

        self.assertEqual(state["order"], [2, 1, 0])
        self.assertTrue(state["sameNodes"])
        self.assertEqual(state["renders"], 0)
        self.assertEqual(state["active"], [False, True])
        self.assertEqual(state["pressed"], ["false", "true"])

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

    def test_environment_cold_start_is_throttled_and_shows_spinner(self):
        render_source = Path("frontend/js/environment-render.js").read_text(encoding="utf-8")
        self.assertIn("_runEnvironmentLoadQueue(loaders, 2)", self.environment_source)
        self.assertIn("_commitEnvironmentLoad", self.environment_source)
        self.assertIn("_waitForEnvironmentPaint", self.environment_source)
        self.assertIn("environmentLoadCompleted", self.environment_source)
        self.assertIn("scheduleEnvironmentRender", self.environment_source)
        self.assertIn('class="env-load-status"', render_source)
        self.assertIn('class="env-load-spinner"', render_source)
        self.assertNotIn('class="env-load-track"', render_source)
        self.assertNotIn('class="env-load-count"', render_source)

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

    @unittest.skipUnless(shutil.which("node"), "Node.js is required for environment URL checks")
    def test_flash_attention_status_url_is_shared_and_encoded(self):
        script = r"""
global.window = {};
eval(require('fs').readFileSync('frontend/js/environment-core.js', 'utf8'));
const mixin = window.environmentCoreMixin;
const urls = [];
global.fetch = async url => {
  urls.push(url);
  return {ok: true, json: async () => ({available: true})};
};
const app = Object.assign({}, mixin, {
  faSource: 'wheel & local',
  faError: null,
  faStatus: null,
  scheduleEnvironmentRender() {},
  renderEnvironment() {},
});
(async () => {
  const loader = app._environmentJsonLoader(app._flashAttentionStatusUrl(), value => { app.faStatus = value; });
  loader.apply(await loader.load());
  await app.faRefresh(true);
  process.stdout.write(JSON.stringify({urls, status: app.faStatus}));
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

        self.assertEqual(
            state["urls"],
            [
                "/api/flash-attention/status?source=wheel%20%26%20local",
                "/api/flash-attention/status?source=wheel%20%26%20local",
            ],
        )
        self.assertEqual(state["status"], {"available": True})

    @unittest.skipUnless(shutil.which("node"), "Node.js is required for environment card-state checks")
    def test_environment_default_card_open_follows_health(self):
        script = r"""
global.window = {};
eval(require('fs').readFileSync('frontend/js/environment-core.js', 'utf8'));
const mixin = window.environmentCoreMixin;
const app = Object.assign({}, mixin, { t: (key, fallback) => fallback || key });
// 全部健康 → 全部收起
Object.assign(app, {
  faBusy: false, faError: null, faStatus: {installed: true},
  xfBusy: false, xfError: null, xfStatus: {installed: true},
  tritonBusy: false, tritonError: null, tritonStatus: {installed: true},
  sdStatus: {local: {tag: 'v1'}},
  trainingCores: {adapters: [{id: 'lycoris', available: true}], engines: [{id: 'musubi_tuner', available: true}]},
  trainingCoresError: null,
  animaModelBusy: false, animaModelError: null,
  animaModelStatus: [
    {group: 'Anima', filename: 'a', exists: true},
    {group: 'Krea 2', filename: 'b', exists: true},
  ],
});
const healthy = ['fa','xf','triton','sd','lycoris','musubi','animaModel','krea2','trainUse']
  .map(slot => app._envDefaultCardOpen(slot));
// 默认全部收起；只有 busy（安装/下载进行中）自动展开以显示进度。
app.faStatus = {installed: false};
app.xfBusy = true;
app.tritonError = 'boom';
app.trainingCores = {adapters: [{id: 'lycoris', available: false}], engines: [{id: 'musubi_tuner', available: true}]};
app.animaModelStatus = [
  {group: 'Anima', filename: 'a', exists: false},
  {group: 'Krea 2', filename: 'b', exists: true},
];
const unhealthy = {
  fa: app._envDefaultCardOpen('fa'),
  xf: app._envDefaultCardOpen('xf'),
  triton: app._envDefaultCardOpen('triton'),
  lycoris: app._envDefaultCardOpen('lycoris'),
  musubi: app._envDefaultCardOpen('musubi'),
  animaModel: app._envDefaultCardOpen('animaModel'),
  krea2: app._envDefaultCardOpen('krea2'),
  trainUse: app._envDefaultCardOpen('trainUse'),
};
// 注册表/模型加载错误 → 同样收起（Hero/行内色字提示，不默认展开）
app.trainingCoresError = 'load failed';
app.animaModelError = 'status 500';
const errored = {
  lycoris: app._envDefaultCardOpen('lycoris'),
  musubi: app._envDefaultCardOpen('musubi'),
  animaModel: app._envDefaultCardOpen('animaModel'),
  krea2: app._envDefaultCardOpen('krea2'),
  trainUse: app._envDefaultCardOpen('trainUse'),
};
process.stdout.write(JSON.stringify({healthy, unhealthy, errored}));
"""
        result = subprocess.run(
            ["node", "-e", script], cwd=Path.cwd(), check=True,
            capture_output=True, text=True, encoding="utf-8",
        )
        state = json.loads(result.stdout)

        self.assertEqual(state["healthy"], [False] * 9)
        # 默认全部收起（含未安装/未配置/模型缺文件/错误）；仅 busy → 展开
        self.assertEqual(
            state["unhealthy"],
            {"fa": False, "xf": True, "triton": False, "lycoris": False,
             "musubi": False, "animaModel": False, "krea2": False, "trainUse": False},
        )
        self.assertEqual(
            state["errored"],
            {"lycoris": False, "musubi": False, "animaModel": False, "krea2": False, "trainUse": False},
        )

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

    @unittest.skipUnless(shutil.which("node"), "Node.js is required for environment card-state checks")
    def test_environment_card_overrides_persist_and_migrate_legacy_key(self):
        script = r"""
global.window = {};
eval(require('fs').readFileSync('frontend/js/environment-core.js', 'utf8'));
const mixin = window.environmentCoreMixin;
const store = {
  'anima_env_cards': JSON.stringify({fa: false, triton: true, coreRegistry: false}),
};
global.localStorage = {
  getItem: key => (key in store ? store[key] : null),
  setItem: (key, value) => { store[key] = String(value); },
  removeItem: key => { delete store[key]; },
};
const app = Object.assign({}, mixin, { t: (key, fallback) => fallback || key });
app._envInitCardState();
const migrated = {
  fa: app._envCardOverrides.fa,
  triton: app._envCardOverrides.triton,
  lycoris: app._envCardOverrides.lycoris,
  musubi: app._envCardOverrides.musubi,
  legacyRemoved: !('anima_env_cards' in store),
};
// 覆盖优先于智能默认：健康 fa 默认收起，覆盖 true 后展开
app.faStatus = {installed: true}; app.faBusy = false; app.faError = null;
app._envSetCardOpen('fa', true);
const faOverridden = app._envCardOpen('fa');
delete app._envCardOverrides.fa;
const faHealthyDefault = app._envCardOpen('fa');
app.faStatus = {installed: false};
const faUninstalledDefault = app._envCardOpen('fa'); // 未安装也默认收起（可选增强）
app.faBusy = true;
const faBusyDefault = app._envCardOpen('fa'); // busy 默认展开
// toggle 写入 v2 key
app._envSetCardOpen('krea2', true);
const saved = JSON.parse(store['anima_env_cards_v2']);
process.stdout.write(JSON.stringify({
  migrated, faOverridden, faHealthyDefault, faUninstalledDefault, faBusyDefault, savedKrea2: saved.krea2,
}));
"""
        result = subprocess.run(
            ["node", "-e", script], cwd=Path.cwd(), check=True,
            capture_output=True, text=True, encoding="utf-8",
        )
        state = json.loads(result.stdout)

        self.assertEqual(
            state["migrated"],
            {"fa": False, "triton": True, "lycoris": False, "musubi": False, "legacyRemoved": True},
        )
        self.assertTrue(state["faOverridden"])
        self.assertFalse(state["faHealthyDefault"])
        self.assertFalse(state["faUninstalledDefault"])
        self.assertTrue(state["faBusyDefault"])
        self.assertTrue(state["savedKrea2"])

    def test_weak_network_media_queue_and_explicit_original_are_present(self):
        render_source = Path("frontend/js/monitor-render.js").read_text(encoding="utf-8")
        app_source = Path("frontend/js/app.js").read_text(encoding="utf-8")
        config_io_source = Path("frontend/js/training-config-io.js").read_text(encoding="utf-8")
        index_source = Path("frontend/index.html").read_text(encoding="utf-8")
        self.assertIn("weakNetworkMode: true", self.monitor_source)
        self.assertIn("_previewMediaPaused", self.monitor_source)
        self.assertIn("_previewMediaQueue", self.monitor_source)
        self.assertNotIn("showMorePreviews", self.monitor_source)
        self.assertIn("requestWeakNetworkModeChange", app_source)
        self.assertIn("this.openConfirm(", app_source)
        self.assertIn("weakNetworkMode: this.weakNetworkMode", app_source)
        self.assertIn("confirmActionLabel", config_io_source)
        self.assertIn("settings.slowConnectionMode", index_source)
        self.assertNotIn("toggleWeakNetworkMode", render_source)
        self.assertNotIn("visiblePreviews", render_source)
        self.assertIn("this._previewDisplayIndices().forEach", render_source)
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

        self.assertIn('"/api/image-preview", "/api/monitor/preview-metadata"', application_source)
        self.assertNotIn('/api/monitor/preview-image', application_source)
        artifacts_source = Path("backend/monitor/artifacts.py").read_text(encoding="utf-8")
        self.assertIn('build_image_preview_url(scope="artifact"', artifacts_source)
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
