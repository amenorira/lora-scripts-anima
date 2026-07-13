import logging
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from backend.log import log
from backend.monitor.monitor import TaskMonitor, _build_console_progress
from backend.monitor.artifacts import _tail_file, read_clean_log_lines
from backend.monitor.training import parse_log_progress
from backend.training.supervisor import _build_train_env


class ProgressParsingTests(unittest.TestCase):
    def test_terminal_cr_overwrites_do_not_inflate_log_line_count(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            log_path = Path(tmp_dir) / "train.log"
            log_path.write_bytes(b"start\nstep 1\rstep 2\rstep 3\nfinished\n")

            lines = read_clean_log_lines(log_path)

        self.assertEqual(lines, ["start", "step 3", "finished"])

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

    def test_diagnostic_explanation_exposes_evidence_rules_and_limits(self):
        rules = self.render_source.split("_trainingDiagnosticRules() {", 1)[1].split("\n  },", 1)[0]
        evidence = self.render_source.split("_diagnosticEvidence(t, diagnostic) {", 1)[1].split("\n  },", 1)[0]
        diagnostics_html = self.render_source.split("_trainingDiagnosticsHtml(t) {", 1)[1].split("\n  },", 1)[0]

        for declaration in (
            "minimumPoints: 6",
            "windowRatio: 0.15",
            "windowMin: 12",
            "windowMax: 60",
            "reboundChange: 3",
            "volatileCv: 12",
            "convergingChange: -2",
            "plateauAbsChange: 1",
            "plateauCv: 4",
        ):
            self.assertIn(declaration, rules)

        self.assertIn("this._trainingDiagnosticRules()", evidence)
        self.assertIn("diagnosticEvidenceConverging", evidence)
        self.assertIn("diagnosticEvidenceVolatile", evidence)
        self.assertIn("data-diagnostic-field=\"evidence\"", diagnostics_html)
        self.assertIn("data-diagnostic-field=\"window-evidence\"", diagnostics_html)
        self.assertIn('<details class="m-diagnostic-method">', diagnostics_html)
        self.assertIn("diagnosticScopeText", diagnostics_html)
        self.assertIn("diagnosticMethodNote", diagnostics_html)
        self.assertIn(".m-diagnostic-method", self.css_source)
        self.assertIn(".m-diagnostic-boundary", self.css_source)

        for key in (
            "diagnosticEvidence",
            "diagnosticEvidenceConverging",
            "diagnosticWindowEvidence",
            "diagnosticMethodTitle",
            "diagnosticScopeText",
            "diagnosticRuleReboundCondition",
            "diagnosticRulePlateauCondition",
            "diagnosticMethodNote",
        ):
            self.assertIn(f'"{key}"', self.zh_source)
            self.assertIn(f'"{key}"', self.en_source)

        self.assertIn("不能判断成图质量、过拟合或最佳 checkpoint", self.zh_source)
        self.assertIn("cannot determine image quality, overfitting, or the best checkpoint", self.en_source)

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

    def test_sse_reconnect_preserves_loss_and_versions_updates(self):
        connect = self.core_source.split("connectMonitorSSE(taskId) {", 1)[1].split("\n  },", 1)[0]
        loss_update = self.core_source.split("handleSSELossUpdate(data) {", 1)[1].split("\n  },", 1)[0]

        self.assertNotIn("this.lossSeries = [];", connect)
        self.assertIn("this.lossDataVersion++", loss_update)
        self.assertIn("Number(p.step) <= Number(series.points[series.points.length - 1].step)", loss_update)

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

    def test_full_log_top_button_scrolls_on_first_page(self):
        method = self.core_source.split("async logFullFirstPage() {", 1)[1].split("\n  },", 1)[0]
        toolbar = self.render_source.split("_logFullToolbarHtml(t) {", 1)[1].split("\n  },", 1)[0]

        self.assertIn("if (this.logFullOffset > 0) await this.fetchLogSlice({ offset: 0 });", method)
        self.assertIn("requestAnimationFrame(() => this._scrollLogsToTop());", method)
        self.assertNotIn('logFullTotal<=0 || logFullOffset<=0', toolbar)
        self.assertIn("logFullTotal<=0 || logFullLoading", toolbar)

    def test_monitor_visuals_use_neutral_background_and_subtle_statuses(self):
        route = self.css_source.split(".main-fullscreen .route-monitor-dashboard {", 1)[1].split("}", 1)[0]
        sticky = self.css_source.split(".monitor-sticky-stack {", 1)[1].split("}", 1)[0]
        badge = self.css_source.split(".m-badge {", 1)[1].split("}", 1)[0]

        self.assertIn("background: var(--bg-root);", route)
        self.assertNotIn("radial-gradient", route)
        self.assertIn("background: var(--bg-root);", sticky)
        self.assertIn("border-radius: var(--radius-control);", badge)
        self.assertIn(".m-training-diagnostics", self.css_source)
        self.assertIn(".m-diagnostic-metrics", self.css_source)
        self.assertNotIn(".m-loss-chart", self.css_source)
        self.assertIn(".hist-action-primary", self.css_source)

    def test_monitor_tabs_and_responsive_breakpoints_are_accessible(self):
        self.assertIn('role="tablist"', self.index_source)
        self.assertEqual(self.index_source.count('role="tab"'), 4)
        self.assertEqual(self.index_source.count(':aria-selected='), 4)
        self.assertEqual(self.index_source.count('@keydown.right.prevent="moveMonitorTab(1)"'), 4)
        self.assertIn("@media (max-width: 1199px)", self.css_source)
        self.assertIn("@media (max-width: 899px)", self.css_source)
        self.assertIn("@media (max-width: 719px)", self.css_source)
        self.assertIn(".route-monitor-dashboard .m-sb-progress-block", self.css_source)
        self.assertIn("overflow-x: auto", self.css_source)
        self.assertIn("@media (prefers-reduced-motion: reduce)", self.css_source)

    def test_samples_and_outputs_keep_dense_non_cropped_layout(self):
        self.assertIn(".m-samples-section .preview-grid-item img", self.css_source)
        self.assertIn("object-fit: contain", self.css_source)
        self.assertIn("grid-template-columns: 28px 24px minmax(190px, 1fr) 92px 78px 72px 132px 34px", self.css_source)

    def test_global_geometry_uses_square_panels_and_subtle_controls(self):
        for declaration in (
            "--radius-panel: 0;",
            "--radius-control: 2px;",
            "--radius-pill: 999px;",
            "--radius-sm: var(--radius-control);",
            "--radius-md: var(--radius-panel);",
            "--radius-lg: var(--radius-panel);",
            "--radius-xl: var(--radius-panel);",
            "--monitor-radius: var(--radius-panel);",
            "--monitor-card-shadow: none;",
        ):
            self.assertIn(declaration, self.css_source)

        self.assertIn("border-radius: var(--radius-lg);", self.css_source.split(".card {", 1)[1].split("}", 1)[0])
        self.assertIn("border-radius: var(--radius-sm);", self.css_source.split(".btn {", 1)[1].split("}", 1)[0])
        self.assertIn("border-radius: var(--radius-lg);", self.css_source.split(".modal {", 1)[1].split("}", 1)[0])

    def test_sse_merges_fields_and_updates_state(self):
        self.assertIn("this.monitorData.state = data.status;", self.core_source)
        self.assertIn("Object.prototype.hasOwnProperty.call(progress, key)", self.core_source)


if __name__ == "__main__":
    unittest.main()
