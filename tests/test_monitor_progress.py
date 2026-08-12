import logging
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from backend.log import log
from backend.monitor.monitor import TaskMonitor, _build_console_progress, _format_learning_rate
from backend.monitor.artifacts import _tail_file, read_clean_log_lines, read_log_slice
from backend.monitor.training import parse_log_progress
from backend.training.supervisor import _build_train_env


class ProgressParsingTests(unittest.TestCase):
    def test_terminal_width_tqdm_bars_are_compacted_for_web_logs(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            log_path = Path(tmp_dir) / "train.log"
            log_path.write_text(
                "steps:   8%|##" + " " * 180 + "| 52/650 [01:04<12:21, 1.24s/it, avr_loss=0.118]\n",
                encoding="utf-8",
            )

            lines = read_clean_log_lines(log_path)

        self.assertEqual(
            lines,
            ["steps:   8%|#---------| 52/650 [01:04<12:21, 1.24s/it, avr_loss=0.118]"],
        )

    def test_terminal_cr_overwrites_do_not_inflate_log_line_count(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            log_path = Path(tmp_dir) / "train.log"
            log_path.write_bytes(b"start\nstep 1\rstep 2\rstep 3\nfinished\n")

            lines = read_clean_log_lines(log_path)

        self.assertEqual(lines, ["start", "step 3", "finished"])

    def test_adjacent_updates_for_the_same_tqdm_step_keep_the_latest_value(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            log_path = Path(tmp_dir) / "train.log"
            log_path.write_text(
                "steps: 64%|######----| 513/800 [39:36<22:09, 4.63s/it, avr_loss=0.0276]\n"
                "steps: 64%|######----| 513/800 [39:36<22:09, 4.63s/it, avr_loss=0.0287]\n"
                "ordinary duplicate\nordinary duplicate\n"
                "steps: 64%|######----| 514/800 [39:40<22:04, 4.63s/it, avr_loss=0.0278]\n",
                encoding="utf-8",
            )

            lines = read_clean_log_lines(log_path)
            page = read_log_slice(log_path, offset=0, limit=20)

        self.assertEqual(lines, page["lines"])
        self.assertEqual(page["total"], 4)
        self.assertEqual(page["lines"][0].split("avr_loss=")[-1], "0.0287]")
        self.assertEqual(page["lines"][1:3], ["ordinary duplicate", "ordinary duplicate"])
        self.assertIn("514/800", page["lines"][3])

    def test_tail_reader_keeps_terminal_overwrite_semantics(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            log_path = Path(tmp_dir) / "train.log"
            log_path.write_bytes(b"start\nstep 1\rstep 2\rstep 3\nfinished\n")

            lines = _tail_file(log_path, max_bytes=1024)

        self.assertEqual(lines, ["start", "step 3", "finished"])

    def test_speed_is_taken_from_latest_training_progress_line(self):
        progress = parse_log_progress([
            "cache latents: 100%|##########| 2048/2048 [00:00<00:00, 51025.60it/s]",
            "steps:   1%|#         | 5/600 [00:13<27:06, 2.73s/it, loss=0.0615]",
        ])

        self.assertEqual(progress["step"], 5)
        self.assertEqual(progress["total_steps"], 600)
        self.assertEqual(progress["speed"], "2.73s/it")
        self.assertEqual(progress["loss"], "0.0615")

    def test_speed_is_absent_without_training_progress(self):
        progress = parse_log_progress([
            "cache latents: 100%|##########| 2048/2048 [00:00<00:00, 51025.60it/s]",
        ])

        self.assertNotIn("speed", progress)


class ProgressStateTests(unittest.TestCase):
    def test_learning_rate_format_is_stable_across_sources(self):
        self.assertEqual(_format_learning_rate("9.7000e-5"), "9.7000e-05")
        self.assertEqual(_format_learning_rate(9.5e-5), "9.5000e-05")

    def test_partial_updates_keep_previous_fields(self):
        monitor = TaskMonitor()
        first = monitor._merge_progress("task", {
            "step": 0,
            "total_steps": 600,
            "percent": 0,
            "epoch": "1/2",
            "lr": "3.0000e-04",
        })
        second = monitor._merge_progress("task", {
            "step": 1,
            "total_steps": 600,
            "percent": 0.17,
            "loss": "0.113",
            "epoch": None,
            "lr": "",
        })

        self.assertEqual(first["step"], 0)
        self.assertEqual(second["step"], 1)
        self.assertEqual(second["epoch"], "1/2")
        self.assertEqual(second["lr"], "3.0000e-04")
        self.assertEqual(second["loss"], "0.113")

    def test_cleanup_removes_cached_progress(self):
        monitor = TaskMonitor()
        monitor._merge_progress("task", {"step": 1, "total_steps": 10})

        monitor._cleanup_task("task")

        self.assertNotIn("task", monitor._last_progress)


class ConsoleLoggingTests(unittest.TestCase):
    def test_application_logger_does_not_propagate_to_root(self):
        self.assertFalse(log.propagate)

    def test_tensorboard_info_logging_is_disabled(self):
        self.assertFalse(logging.getLogger("tensorboard").isEnabledFor(logging.INFO))
        self.assertTrue(logging.getLogger("tensorboard").isEnabledFor(logging.WARNING))

    def test_tensorboard_proxy_request_logging_is_disabled(self):
        for logger_name in ("httpx", "httpcore"):
            logger = logging.getLogger(logger_name)
            self.assertFalse(logger.isEnabledFor(logging.INFO))
            self.assertTrue(logger.isEnabledFor(logging.WARNING))

    def test_console_progress_is_transient(self):
        progress = _build_console_progress()
        self.assertTrue(progress.live.transient)

    def test_train_env_suppresses_only_known_vendor_syntax_warning(self):
        env = _build_train_env("output/test", "task")
        self.assertIn("ignore:invalid escape sequence:SyntaxWarning", env["PYTHONWARNINGS"])


class MonitorFrontendContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.render_source = Path("frontend/js/monitor-render.js").read_text(encoding="utf-8")
        cls.core_source = Path("frontend/js/monitor-core.js").read_text(encoding="utf-8")
        cls.index_source = Path("frontend/index.html").read_text(encoding="utf-8")
        cls.css_source = Path("frontend/css/app.css").read_text(encoding="utf-8")
        cls.app_source = Path("frontend/js/app.js").read_text(encoding="utf-8")
        cls.zh_source = Path("frontend/i18n/zh-CN.json").read_text(encoding="utf-8")
        cls.en_source = Path("frontend/i18n/en-US.json").read_text(encoding="utf-8")

    def test_statusbar_exposes_connection_progress_and_actions(self):
        body = self.render_source.split("_statusbarHtml(d, t) {", 1)[1].split("\n  },", 1)[0]
        for field in ("loss", "lr", "epoch", "elapsed", "eta", "speed"):
            self.assertNotIn(f'data-field="{field}"', body)
        for field in ("state", "connection", "step", "pct"):
            self.assertIn(f'data-field="{field}"', body)
        self.assertIn('data-role="progress"', body)
        self.assertIn('data-role="actions"', body)
        self.assertIn('role="progressbar"', body)

    def test_overview_uses_live_field_patching(self):
        patch_body = self.render_source.split("_patchOverviewStatus(d, t, isHistory) {", 1)[1].split("\n  },", 1)[0]
        metrics_body = self.render_source.split("const metrics = [", 1)[1].split("];", 1)[0]
        for field in ("step", "loss", "lr", "epoch", "elapsed", "eta", "speed"):
            self.assertIn(f"{field}:", patch_body)
        for field in ("loss", "lr", "epoch", "speed", "elapsed", "eta"):
            self.assertIn(f"['{field}'", metrics_body)
        self.assertIn("data-live-field=\"' + item[0] + '\"", self.render_source)
        self.assertIn("this._patchOverviewStatus(d, t, isHistory);", self.render_source)
        self.assertIn("(d.state||'')", self.render_source)

        render_tab = self.render_source.split("_renderTab(tab, d, gpu, sys, t, isHistory) {", 1)[1].split("\n  },", 1)[0]
        self.assertIn("this._patchTrainingDiagnostics(root, t, d, isHistory);", self.render_source)
        self.assertNotIn("lossDataVersion", render_tab)

    def test_learning_rate_fallback_uses_padded_scientific_notation(self):
        formatter = self.render_source.split("_formatLearningRate(value, fallback) {", 1)[1].split("\n  },", 1)[0]
        self.assertIn("toExponential(4)", formatter)
        self.assertIn("padStart(2, '0')", formatter)
        self.assertIn("this._formatLearningRate(number, fallback)", self.render_source)
        self.assertEqual(self.render_source.count("this._formatLearningRate(d.lr, String(d.lr))"), 2)

    def test_training_diagnostics_replace_duplicate_loss_chart(self):
        diagnostics = self.render_source.split("_trainingDiagnostics(points) {", 1)[1].split("\n  },", 1)[0]
        patch = self.render_source.split("_patchTrainingDiagnostics(root, t, d, isHistory) {", 1)[1].split("\n  },", 1)[0]

        self.assertIn("desiredWindow", diagnostics)
        self.assertIn("changePct", diagnostics)
        self.assertIn("volatilityPct", diagnostics)
        self.assertIn("gapFromBestPct", diagnostics)
        self.assertIn("code: 'converging'", diagnostics)
        self.assertIn("code: 'plateau'", diagnostics)
        self.assertIn("code: 'rebound'", diagnostics)
        self.assertIn("code: 'volatile'", diagnostics)
        self.assertNotIn("innerHTML", patch)
        self.assertIn("lossDataVersion", patch)
        self.assertIn("data-diagnostic-field", self.render_source)
        self.assertIn("@click=\"navigate(\\'tensorboard\\')\"", self.render_source)
        self.assertNotIn("_lossChartHtml", self.render_source)
        self.assertNotIn("data-chart-path", self.render_source)

    def test_monitor_locale_invalidates_all_cached_shells(self):
        self.assertIn("this._shellLocale !== locale", self.render_source)
        self.assertIn("[controlMode, locale]", self.render_source)
        self.assertIn("this._builtLogLocale !== this._shellLocale", self.render_source)
        self.assertIn("'sm:' + this._shellLocale", self.render_source)
        self.assertIn("'out:' + this._shellLocale", self.render_source)
        self.assertIn("if (r === 'monitor-dashboard' && typeof this.renderDashboard === 'function') this.renderDashboard();", self.app_source)
        for key in ("readyToTrain", "trainingDiagnostics", "previousTrainingDiagnostics", "previousDiagnosticSubtitle", "diagnosticConverging", "openTensorBoard"):
            self.assertIn(f'"{key}"', self.zh_source)
            self.assertIn(f'"{key}"', self.en_source)

    def test_idle_diagnostics_are_labeled_as_previous_run_data(self):
        patch = self.render_source.split("_patchTrainingDiagnostics(root, t, d, isHistory) {", 1)[1].split("\n  },", 1)[0]

        self.assertIn("d.state !== 'RUNNING'", patch)
        self.assertIn("diagnostic.count > 0", patch)
        self.assertIn("previousTrainingDiagnostics", patch)
        self.assertIn("previousDiagnosticSubtitle", patch)

    def test_websocket_replay_deduplicates_metric_points(self):
        realtime_source = Path("frontend/js/realtime.js").read_text(encoding="utf-8")
        metrics_update = self.core_source.split("handleRealtimeTaskMetrics(data) {", 1)[1].split("\n  },", 1)[0]

        self.assertIn("new WebSocket", realtime_source)
        self.assertIn("op: 'subscribe'", realtime_source)
        self.assertIn("resync_required", realtime_source)
        self.assertIn("this.lossDataVersion++", metrics_update)
        self.assertIn("Number(p.step) <= Number(series.points[series.points.length - 1].step)", metrics_update)

    def test_outputs_choose_newer_checkpoint_for_equal_lowest_loss(self):
        body = self.render_source.split("_bestCheckpointPath(models) {", 1)[1].split("\n  },", 1)[0]

        self.assertIn("Number.isFinite(loss)", body)
        self.assertIn("loss === bestLoss && time > bestTime", body)
        self.assertIn("m-ckpt-best", self.render_source)
        self.assertIn("m-output-selection-bar", self.render_source)

    @unittest.skipUnless(shutil.which("node"), "Node.js is required for frontend pure-function checks")
    def test_diagnostic_and_checkpoint_helpers_execute_edge_cases(self):
        script = r"""
global.window = {};
eval(require('fs').readFileSync('frontend/js/monitor-render.js', 'utf8'));
const mixin = window.monitorRenderMixin;
const points = values => values.map((value, step) => ({step: step + 1, value}));
const insufficient = mixin._trainingDiagnostics([]);
const constant = mixin._trainingDiagnostics(points(Array(24).fill(0.05)));
const declining = mixin._trainingDiagnostics(points(Array.from({length: 40}, (_, index) => 0.1 - index * 0.001)));
const rebound = mixin._trainingDiagnostics(points(Array(20).fill(0.05).concat(Array(20).fill(0.07))));
const volatile = mixin._trainingDiagnostics(points(Array.from({length: 40}, (_, index) => index % 2 ? 0.06 : 0.04)));
const cleaned = mixin._trainingDiagnostics([
  {step: 2, value: 0.2}, {step: null, value: 0.1}, {step: 1, value: ''},
  {step: 1, value: 0.3}, {step: 2, value: 0.15}, {step: 3, value: Number.NaN}
]);
const best = mixin._bestCheckpointPath([
  {path: 'older', ckpt_loss: 0.08, mtime: 100},
  {path: 'invalid', ckpt_loss: 'nan', mtime: 400},
  {path: 'newer', ckpt_loss: 0.08, mtime: 200},
  {path: 'higher', ckpt_loss: 0.1, mtime: 300}
]);
const translate = (key, fallback) => ({
  diagnosticEvidenceConverging: 'mean fell {magnitude}; decrease threshold {converging}%; volatility {volatility}',
  diagnosticWindowEvidence: 'recent {recentStart}-{recentEnd}; previous {previousStart}-{previousEnd}; window {window}'
}[key] || fallback);
const decliningEvidence = mixin._diagnosticEvidence(translate, declining);
const decliningWindow = mixin._diagnosticWindowEvidence(translate, declining);
process.stdout.write(JSON.stringify({
  insufficient,
  constant,
  declining,
  rebound,
  volatile,
  cleaned,
  best,
  decliningEvidence,
  decliningWindow
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
        data = json.loads(result.stdout)

        self.assertEqual(data["insufficient"]["code"], "insufficient")
        self.assertEqual(data["constant"]["code"], "plateau")
        self.assertEqual(data["declining"]["code"], "converging")
        self.assertEqual(data["rebound"]["code"], "rebound")
        self.assertEqual(data["volatile"]["code"], "volatile")
        self.assertEqual(data["declining"]["bestStep"], 40)
        self.assertAlmostEqual(data["declining"]["gapFromBestPct"], 0)
        self.assertEqual(data["cleaned"]["count"], 2)
        self.assertEqual(data["cleaned"]["bestStep"], 2)
        self.assertAlmostEqual(data["cleaned"]["bestValue"], 0.15)
        self.assertEqual(data["best"], "newer")
        self.assertIn("15.3%", data["decliningEvidence"])
        self.assertIn("decrease threshold 2%", data["decliningEvidence"])
        self.assertIn("window 12", data["decliningWindow"])

    @unittest.skipUnless(shutil.which("node"), "Node.js is required for frontend snapshot checks")
    def test_config_snapshot_requests_share_encoded_fetch_helper(self):
        script = r"""
global.window = {};
eval(require('fs').readFileSync('frontend/js/monitor-render.js', 'utf8'));
const mixin = window.monitorRenderMixin;
const urls = [];
global.fetch = async url => {
  urls.push(url);
  return {json: async () => ({status: 'success', data: {params: {seed: 7}, content: 'seed = 7'}})};
};
const events = [];
const app = Object.assign({}, mixin, {
  form: {},
  t(key, fallback) { return fallback || key; },
  startProgress() { events.push('start'); },
  finishProgress() { events.push('finish'); },
  showSnapshotModal(snapshot) { events.push('show:' + snapshot.content); },
  async _applyConfigToTraining(params) { events.push('apply:' + params.seed); },
  toast(message, kind) { events.push('toast:' + kind); },
  navigate(route) { events.push('navigate:' + route); },
});
(async () => {
  await app.viewSnapshot('run & one');
  await app.reuseConfig('run & one');
  process.stdout.write(JSON.stringify({urls, events}));
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
        data = json.loads(result.stdout)

        self.assertEqual(
            data["urls"],
            [
                "/api/monitor/config-from-run?run_dir=run%20%26%20one",
                "/api/monitor/config-from-run?run_dir=run%20%26%20one",
            ],
        )
        self.assertEqual(
            data["events"],
            [
                "start",
                "show:seed = 7",
                "finish",
                "start",
                "apply:7",
                "toast:success",
                "navigate:train-basic",
                "finish",
            ],
        )

    def test_history_log_source_resets_before_navigation(self):
        body = self.core_source.split("async viewRunDetail(runDir) {", 1)[1].split("\n  },", 1)[0]
        navigate_at = body.index("this.navigate('monitor-dashboard');")

        for statement in (
            "this._logSliceRequestSeq++;",
            "this.logLines = [];",
            "this.logTotal = 0;",
            "this.logFullLines = [];",
            "this.logFullOffset = 0;",
            "this.logFullTotal = 0;",
            "this.logFullMatches = [];",
        ):
            self.assertLess(body.index(statement), navigate_at)

    def test_history_detail_seeds_full_log_count_from_normalized_total(self):
        body = self.core_source.split("async _fetchRunDetail(runDir) {", 1)[1].split("\n  },", 1)[0]

        self.assertIn("this.logFullTotal = this.logTotal;", body)

    def test_full_log_top_button_scrolls_on_first_page(self):
        method = self.core_source.split("async logFullFirstPage() {", 1)[1].split("\n  },", 1)[0]
        toolbar = self.render_source.split("_logFullToolbarHtml(t) {", 1)[1].split("\n  },", 1)[0]

        self.assertIn("if (this.logFullOffset > 0) await this.fetchLogSlice({ offset: 0 });", method)
        self.assertIn("requestAnimationFrame(() => this._scrollLogsToTop());", method)
        self.assertNotIn('logFullTotal<=0 || logFullOffset<=0', toolbar)
        self.assertIn("logFullTotal<=0 || logFullLoading", toolbar)

    def test_realtime_merges_fields_and_updates_state(self):
        self.assertIn("this.monitorData.state = data.status;", self.core_source)
        self.assertIn("Object.prototype.hasOwnProperty.call(progress, key)", self.core_source)


if __name__ == "__main__":
    unittest.main()
