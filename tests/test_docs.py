import json
import shutil
import subprocess
import unittest
from pathlib import Path, PurePosixPath
from unittest.mock import patch

from fastapi import HTTPException

from backend.server.routes.docs import (
    _DOCUMENTS,
    _document_path,
    _list_documents,
    _normalize_locale,
    _render_markdown,
    _resolve_asset_path,
)
from backend.training.field_registry import FIELDS
from backend.training.musubi_krea2 import KREA2_FIELDS


class DocumentationTests(unittest.TestCase):
    def test_optimizer_documents_render_registered_field_anchors(self):
        expected_anchors = {
            field["doc_anchor"]
            for field in FIELDS
            if field.get("doc_slug") == "optimizers" and field.get("doc_anchor")
        }
        for locale in ("zh-CN", "en-US"):
            path = _document_path("optimizers", locale)
            html, toc = _render_markdown(
                path.read_text(encoding="utf-8"),
                PurePosixPath(f"parameters/optimizers.{locale}.md"),
            )
            for anchor in expected_anchors:
                self.assertIn(f'id="{anchor}"', html)
                self.assertIn(f'href="#{anchor}"', toc)

    def test_optimizer_fields_link_to_guide_sections(self):
        expected = {
            "optimizer_type": "optimizer-type",
            "learning_rate": "learning-rate",
            "lr_scheduler": "scheduler-warmup",
            "lr_warmup_steps": "scheduler-warmup",
            "max_grad_norm": "gradient-clipping",
            "weight_decay": "weight-decay",
            "betas": "betas",
            "eps": "eps",
            "bnb_percentile_clipping": "percentile-clipping",
            "bnb_min_8bit_size": "min-8bit-size",
            "stableadamw_kahan_sum": "stableadamw-options",
            "stableadamw_weight_decouple": "stableadamw-options",
            "came_clip_threshold": "came-clipping",
        }
        fields = {field["key"]: field for field in FIELDS if field["key"] in expected}
        self.assertEqual(set(fields), set(expected))
        for key, anchor in expected.items():
            self.assertEqual(fields[key]["doc_slug"], "optimizers")
            self.assertEqual(fields[key]["doc_anchor"], anchor)

    def test_optimizer_category_and_i18n_keys_are_registered(self):
        document = _DOCUMENTS["optimizers"]
        self.assertEqual(document["category"], "optimizer")
        root = Path(__file__).resolve().parents[1]
        locales = {
            locale: json.loads((root / "frontend" / "i18n" / f"{locale}.json").read_text(encoding="utf-8"))
            for locale in ("zh-CN", "en-US")
        }
        for translations in locales.values():
            self.assertIn("optimizer", translations["docs"]["categories"])
            for key in (
                "bnb_percentile_clipping",
                "bnb_min_8bit_size",
                "stableadamw_kahan_sum",
                "stableadamw_weight_decouple",
            ):
                self.assertIn(key, translations["field"])
                self.assertIn(f"{key}Hint", translations["field"])
            self.assertIn("optimizer_type_StableAdamW", translations["opt"])

    def test_loraplus_documents_render_registered_field_anchors(self):
        expected_anchors = {
            field["doc_anchor"]
            for field in FIELDS
            if field.get("doc_slug") == "lora-plus" and field.get("doc_anchor")
        }
        for locale in ("zh-CN", "en-US"):
            path = _document_path("lora-plus", locale)
            self.assertTrue(path.is_file())
            html, toc = _render_markdown(
                path.read_text(encoding="utf-8"),
                PurePosixPath(f"parameters/lora-plus.{locale}.md"),
            )
            for anchor in expected_anchors:
                self.assertIn(f'id="{anchor}"', html)
                self.assertIn(f'href="#{anchor}"', toc)

    def test_adaln_documents_render_registered_field_anchors(self):
        expected_anchors = {
            field["doc_anchor"]
            for field in FIELDS
            if field.get("doc_slug") == "adaln" and field.get("doc_anchor")
        }
        self.assertEqual(expected_anchors, {"overview"})
        for locale in ("zh-CN", "en-US"):
            path = _document_path("adaln", locale)
            self.assertTrue(path.is_file())
            html, toc = _render_markdown(
                path.read_text(encoding="utf-8"),
                PurePosixPath(f"parameters/adaln.{locale}.md"),
            )
            for anchor in expected_anchors:
                self.assertIn(f'id="{anchor}"', html)
                self.assertIn(f'href="#{anchor}"', toc)

    def test_timestep_documents_render_registered_field_anchors_and_widget(self):
        expected_anchors = {
            field["doc_anchor"]
            for field in (*FIELDS, *KREA2_FIELDS)
            if field.get("doc_slug") == "timesteps" and field.get("doc_anchor")
        }
        for locale in ("zh-CN", "en-US"):
            path = _document_path("timesteps", locale)
            self.assertTrue(path.is_file())
            html, toc = _render_markdown(
                path.read_text(encoding="utf-8"),
                PurePosixPath(f"parameters/timesteps.{locale}.md"),
            )
            self.assertIn('data-doc-widget="timestep-preview"', html)
            for anchor in expected_anchors:
                self.assertIn(f'id="{anchor}"', html)
                self.assertIn(f'href="#{anchor}"', toc)

    def test_timestep_fields_link_to_the_relevant_document_sections(self):
        expected = {
            "timestep_sampling": "sampling",
            "sigmoid_scale": "sigmoid-scale",
            "discrete_flow_shift": "flow-shift",
            "weighting_scheme": "weighting",
            "logit_mean": "logit-normal",
            "logit_std": "logit-normal",
            "mode_scale": "mode",
        }
        anima_fields = {
            field["key"]: field
            for field in FIELDS
            if field.get("group") == "anima" and field["key"] in expected
        }
        krea_fields = {
            field["key"]: field
            for field in KREA2_FIELDS
            if field["key"] in expected
        }
        for fields in (anima_fields, krea_fields):
            self.assertEqual(set(fields), set(expected))
            for key, anchor in expected.items():
                self.assertEqual(fields[key]["doc_slug"], "timesteps")
                self.assertEqual(fields[key]["doc_anchor"], anchor)

        sdxl_fields = {
            field["key"]: field
            for field in FIELDS
            if field.get("group") == "sdxl"
            and field["key"] in {"min_timestep", "max_timestep"}
        }
        self.assertEqual(set(sdxl_fields), {"min_timestep", "max_timestep"})
        for field in sdxl_fields.values():
            self.assertEqual(field["doc_slug"], "timesteps")
            self.assertEqual(field["doc_anchor"], "sdxl-range")

    def test_markdown_renders_stable_anchors_toc_and_relative_images(self):
        html, toc = _render_markdown(
            "# Guide\n\n<!-- doc-anchor: ratio -->\n## Ratio\n\n### Detail\n\n![curve](images/curve.png)",
            PurePosixPath("parameters/guide.md"),
        )

        self.assertIn('id="ratio"', html)
        self.assertNotIn('href="#guide"', toc)
        self.assertIn('href="#ratio"', toc)
        self.assertIn('href="#detail"', toc)
        self.assertNotIn("doc-anchor", html)
        self.assertNotIn("{#ratio}", html)
        self.assertIn('src="/api/docs/assets/parameters/images/curve.png"', html)

    def test_document_index_is_sorted_by_category_order_and_slug(self):
        documents = {
            "z-last": self._document_metadata("zeta", 1, "Z last"),
            "a-second": self._document_metadata("alpha", 20, "A second"),
            "a-first": self._document_metadata("alpha", 10, "A first"),
        }
        with patch.dict(_DOCUMENTS, documents, clear=True):
            index = _list_documents("en-US")

        self.assertEqual(
            [document["slug"] for document in index],
            ["a-first", "a-second", "z-last"],
        )

    def test_unsupported_locale_falls_back_to_chinese(self):
        self.assertEqual(_normalize_locale("fr-FR"), "zh-CN")
        self.assertEqual(
            _document_path("lora-plus", "fr-FR"),
            _document_path("lora-plus", "zh-CN"),
        )

    def test_asset_path_rejects_parent_traversal(self):
        with self.assertRaises(HTTPException) as context:
            _resolve_asset_path("../requirements.txt")
        self.assertEqual(context.exception.status_code, 404)

    @staticmethod
    def _document_metadata(category: str, order: int, title: str):
        return {
            "category": category,
            "order": order,
            "titles": {"zh-CN": title, "en-US": title},
            "summaries": {"zh-CN": title, "en-US": title},
            "files": {},
        }


@unittest.skipUnless(shutil.which("node"), "Node.js is required for frontend checks")
class DocumentationFrontendTests(unittest.TestCase):
    def test_active_toc_item_scrolls_into_the_outline_safe_area(self):
        script = r"""
global.window = {
  requestAnimationFrame(callback) { callback(); return 1; },
  cancelAnimationFrame() {},
  matchMedia() { return { matches: false }; },
  setTimeout,
  clearTimeout,
};

let linkRect = { top: 280, bottom: 310 };
const link = { getBoundingClientRect() { return linkRect; } };
const outline = {
  clientHeight: 300,
  scrollHeight: 1000,
  scrollTop: 100,
  lastScroll: null,
  querySelector(selector) {
    return selector === 'a[href="#testing"]' ? link : null;
  },
  getBoundingClientRect() { return { top: 0, bottom: 300 }; },
  scrollTo(options) { this.scrollTop = options.top; this.lastScroll = options; },
};
global.document = {
  querySelector(selector) { return selector === '.docs-outline' ? outline : null; },
};

require('./frontend/js/docs.js');
const context = Object.assign({}, window.docsMixin, { docsActiveAnchor: '' });
context._setDocsActiveAnchor('testing');
const lowerScroll = outline.lastScroll;

outline.lastScroll = null;
linkRect = { top: 120, bottom: 145 };
context._revealDocsTocAnchor('testing');
const visibleScroll = outline.lastScroll;

outline.scrollTop = 200;
linkRect = { top: 10, bottom: 30 };
context._revealDocsTocAnchor('testing');
const upperScroll = outline.lastScroll;

outline.lastScroll = null;
outline.scrollTop = 100;
linkRect = { top: 280, bottom: 310 };
window.matchMedia = () => ({ matches: true });
context._revealDocsTocAnchor('testing');
const reducedMotionScroll = outline.lastScroll;

console.log(JSON.stringify({ lowerScroll, visibleScroll, upperScroll, reducedMotionScroll }));
"""
        result = subprocess.run(
            ["node", "-e", script],
            cwd=Path.cwd(),
            capture_output=True,
            text=True,
            encoding="utf-8",
            check=True,
        )
        state = json.loads(result.stdout)
        self.assertEqual(state["lowerScroll"], {"top": 146, "behavior": "smooth"})
        self.assertIsNone(state["visibleScroll"])
        self.assertEqual(state["upperScroll"], {"top": 174, "behavior": "smooth"})
        self.assertEqual(
            state["reducedMotionScroll"],
            {"top": 146, "behavior": "auto"},
        )

    def test_document_tables_receive_responsive_headers_and_wide_class(self):
        script = r"""
global.window = {};
global.document = { getElementById() { return null; } };
require('./frontend/js/docs.js');

const classes = new Set();
const headers = ['Parameter', 'sigmoid', 'uniform', 'shift', 'sigma', 'logsnr'];
const cells = headers.map(() => ({
  tagName: 'TD',
  labels: {},
  setAttribute(name, value) { this.labels[name] = value; },
}));
const row = { children: cells };
const table = {
  classList: { add(name) { classes.add(name); } },
  querySelectorAll(selector) {
    if (selector === 'thead th') return headers.map(textContent => ({ textContent }));
    if (selector === 'tbody tr') return [row];
    return [];
  },
};
const article = { querySelectorAll(selector) { return selector === 'table' ? [table] : []; } };

window.docsMixin._hydrateDocsTables(article);
console.log(JSON.stringify({
  classes: Array.from(classes).sort(),
  labels: cells.map(cell => cell.labels['data-label']),
}));
"""
        result = subprocess.run(
            ["node", "-e", script],
            cwd=Path.cwd(),
            capture_output=True,
            text=True,
            encoding="utf-8",
            check=True,
        )
        state = json.loads(result.stdout)
        self.assertEqual(
            state["classes"],
            ["docs-table-responsive", "docs-table-wide"],
        )
        self.assertEqual(state["labels"], [
            "Parameter", "sigmoid", "uniform", "shift", "sigma", "logsnr",
        ])

    def test_timestep_widget_reuses_the_training_preview_calculation(self):
        script = r"""
global.window = {};
global.document = { getElementById() { return null; } };
require('./frontend/js/training-core.js');
require('./frontend/js/docs.js');

let refreshHandler = null;
const container = {
  className: '',
  innerHTML: '',
  querySelector(selector) {
    if (selector !== '.docs-timestep-refresh') return null;
    return {
      addEventListener(name, handler) {
        if (name === 'click') refreshHandler = handler;
      },
    };
  },
};
const context = Object.assign({}, window.trainingCoreMixin, window.docsMixin, {
  form: {
    model_train_type: 'anima-lora',
    timestep_sampling: 'sigmoid',
    weighting_scheme: 'sigma_sqrt',
    sigmoid_scale: 1,
    discrete_flow_shift: 1,
    resolution: '1024,768',
  },
  t(key) { return key; },
});
context._renderDocsTimestepPreview(container);
const sigmoidHtml = container.innerHTML;
// shift mode adds the flow shift card; flux_shift shows the resolution-derived shift
context.form.timestep_sampling = 'shift';
context.form.discrete_flow_shift = 3;
context._renderDocsTimestepPreview(container);
const shiftHtml = container.innerHTML;
context.form.timestep_sampling = 'flux_shift';
context._renderDocsTimestepPreview(container);
const fluxHtml = container.innerHTML;
// sigma also consumes discrete_flow_shift (same as the form's show_if)
context.form.timestep_sampling = 'sigma';
context._renderDocsTimestepPreview(container);
const sigmaHtml = container.innerHTML;
console.log(JSON.stringify({
  className: container.className,
  hasSmoothCurve: sigmoidHtml.includes('timestep-curve-current'),
  hasMiddleSummary: sigmoidHtml.includes('timestep-preview-summary') && /\d+\.\d+%/.test(sigmoidHtml),
  hasWeightCurve: sigmoidHtml.includes('timestep-curve-weight'),
  refreshBound: typeof refreshHandler === 'function',
  dualLayout: sigmoidHtml.includes('timestep-preview-layout') && sigmoidHtml.includes('timestep-layout-sidebar'),
  scopeSelect: sigmoidHtml.includes('docs-timestep-scope') && sigmoidHtml.includes('timestepPreview.previewRange'),
  metaCards: (sigmoidHtml.match(/<span><small>/g) || []).length,
  sigmoidCard: sigmoidHtml.includes('<small>timestepPreview.sigmoidScale</small>'),
  noScopeCard: !sigmoidHtml.includes('<small>timestepPreview.previewRange</small>'),
  flowShiftCard: shiftHtml.includes('<small>timestepPreview.flowShift</small>') && shiftHtml.includes('<b>3</b>'),
  derivedShiftCard: fluxHtml.includes('<small>timestepPreview.derivedShift</small>'),
  noFlowShiftOnFlux: !fluxHtml.includes('<small>timestepPreview.flowShift</small>'),
  sigmaFlowShiftCard: sigmaHtml.includes('<small>timestepPreview.flowShift</small>'),
  offsetCard: sigmoidHtml.includes('timestepPreview.offset') && sigmoidHtml.includes('timestepPreview.medianTimestep'),
  resolution: context._buildTimestepPreview().resolution,
}));
"""
        result = subprocess.run(
            ["node", "-e", script],
            cwd=Path.cwd(),
            capture_output=True,
            text=True,
            encoding="utf-8",
            check=True,
        )
        state = json.loads(result.stdout)
        self.assertEqual(state["className"], "docs-timestep-widget")
        self.assertTrue(state["hasSmoothCurve"])
        self.assertTrue(state["hasMiddleSummary"])
        self.assertTrue(state["hasWeightCurve"])
        self.assertTrue(state["refreshBound"])
        self.assertTrue(state["dualLayout"])
        self.assertTrue(state["scopeSelect"])
        self.assertEqual(state["metaCards"], 6)
        self.assertTrue(state["sigmoidCard"])
        self.assertTrue(state["noScopeCard"])
        self.assertTrue(state["flowShiftCard"])
        self.assertTrue(state["derivedShiftCard"])
        self.assertTrue(state["noFlowShiftOnFlux"])
        self.assertTrue(state["sigmaFlowShiftCard"])
        self.assertTrue(state["offsetCard"])
        self.assertEqual(state["resolution"], "1024 × 768")

    def test_scrollspy_uses_section_at_viewport_top_and_preserves_click_target(self):
        script = r"""
global.window = {
  CSS: { escape(value) { return value; } },
  matchMedia() { return { matches: false }; },
  requestAnimationFrame() { return 1; },
  cancelAnimationFrame() {},
  setTimeout,
  clearTimeout,
};

let testingTop = -100;
let lastTop = 900;
const headings = [
  {
    id: 'testing',
    tagName: 'H2',
    textContent: 'Recommended testing',
    getBoundingClientRect() { return { top: testingTop }; },
  },
  {
    id: 'tensorboard',
    tagName: 'H2',
    textContent: 'TensorBoard logs',
    getBoundingClientRect() { return { top: lastTop }; },
  },
];
const listeners = {};
const scroller = {
  scrollTop: 0,
  scrollHeight: 1500,
  clientHeight: 500,
  getBoundingClientRect() { return { top: 0, bottom: 500 }; },
  addEventListener(name, handler) { listeners[name] = handler; },
  removeEventListener(name) { delete listeners[name]; },
  scrollTo(options) {
    this.lastScroll = options;
    if (options.behavior === 'auto') this.scrollTop = options.top;
  },
};
const article = {
  querySelectorAll() { return headings; },
  querySelector(selector) {
    if (selector === '#testing') return headings[0];
    if (selector === '#tensorboard') return headings[1];
    return null;
  },
  getBoundingClientRect() { return { bottom: 500 }; },
};
global.document = {
  getElementById(id) {
    if (id === 'docsArticle') return article;
    if (id === 'mainContent') return scroller;
    return null;
  },
};

require('./frontend/js/docs.js');
const context = Object.assign({}, window.docsMixin, { currentRoute: 'docs' });
const groups = Object.assign({}, window.docsMixin, {
  docsDocuments: [
    { slug: 'lora-plus', category: 'network' },
    { slug: 'loha', category: 'network' },
    { slug: 'adamw', category: 'optimizer' },
  ],
}).docsDocumentGroups().map(group => ({
  category: group.category,
  slugs: group.documents.map(document => document.slug),
}));
context._setupDocsScrollSpy();
const tocItems = context.docsTocItems;

scroller.scrollTop = 999.5;
testingTop = 80;
lastTop = 220;
context._refreshDocsActiveAnchor();
const bottomActive = context.docsActiveAnchor;

scroller.scrollTop = 400;
testingTop = 18;
lastTop = 190;
context._refreshDocsActiveAnchor();
const shortSectionActive = context.docsActiveAnchor;

scroller.scrollTop = 100;
testingTop = -100;
lastTop = 900;
context.scrollToDocAnchor('tensorboard', true);
const targetTop = context._docsScrollTarget.top;
context._refreshDocsActiveAnchor();
const duringSmooth = context.docsActiveAnchor;
const targetStillLocked = context._docsScrollTarget !== null;

scroller.scrollTop = targetTop;
lastTop = 18;
context._refreshDocsActiveAnchor();
const finalActive = context.docsActiveAnchor;
const targetReleased = context._docsScrollTarget === null;

context._docsTocRaf = 0;
scroller.scrollTop = 1000;
testingTop = 140;
lastTop = 520;
context.scrollToDocAnchor('testing', true);
context._refreshDocsActiveAnchor();
const clippedClickActive = context.docsActiveAnchor;
const clippedClickPinned = context._docsPinnedAnchor !== null;
scroller.scrollTop = 960;
listeners.scroll();
const pinClearedAfterUserScroll = context._docsPinnedAnchor === null;

console.log(JSON.stringify({
  groups,
  tocItems,
  bottomActive,
  shortSectionActive,
  duringSmooth,
  targetStillLocked,
  finalActive,
  targetReleased,
  clippedClickActive,
  clippedClickPinned,
  pinClearedAfterUserScroll,
  behavior: scroller.lastScroll.behavior,
}));
"""
        result = subprocess.run(
            ["node", "-e", script],
            cwd=Path.cwd(),
            capture_output=True,
            text=True,
            encoding="utf-8",
            check=True,
        )
        state = json.loads(result.stdout)

        self.assertEqual(
            state["groups"],
            [
                {"category": "network", "slugs": ["lora-plus", "loha"]},
                {"category": "optimizer", "slugs": ["adamw"]},
            ],
        )
        self.assertEqual(
            state["tocItems"],
            [
                {"anchor": "testing", "level": 2, "title": "Recommended testing"},
                {"anchor": "tensorboard", "level": 2, "title": "TensorBoard logs"},
            ],
        )
        self.assertEqual(state["bottomActive"], "tensorboard")
        self.assertEqual(state["shortSectionActive"], "testing")
        self.assertEqual(state["duringSmooth"], "tensorboard")
        self.assertTrue(state["targetStillLocked"])
        self.assertEqual(state["finalActive"], "tensorboard")
        self.assertTrue(state["targetReleased"])
        self.assertEqual(state["clippedClickActive"], "testing")
        self.assertTrue(state["clippedClickPinned"])
        self.assertTrue(state["pinClearedAfterUserScroll"])
        self.assertEqual(state["behavior"], "smooth")

    def test_reader_uses_reactive_toc_and_shows_document_library_for_one_doc(self):
        html = Path("frontend/index.html").read_text(encoding="utf-8")
        css = Path("frontend/css/app.css").read_text(encoding="utf-8")

        self.assertIn('class="docs-index" x-show="docsDocuments.length"', html)
        self.assertIn("item in docsTocItems", html)
        self.assertNotIn('x-html="docsToc"', html)
        toc_css = css[css.index(".docs-toc {") : css.index(".markdown-body {")]
        self.assertNotIn("border-left", toc_css)
        self.assertIn("text-overflow: ellipsis", toc_css)
        self.assertIn("max-width: 1920px", css)
        self.assertIn("minmax(620px, 1120px)", css)
        self.assertIn("min-width: 1018px", css)
        self.assertNotIn("docs-mobile-outline", html)
        self.assertIn("scrollbar-color: transparent transparent", css)
        self.assertIn("table.docs-table-wide", css)
        self.assertNotIn("@container (max-width:", css)
        docs_widget_css = css[css.index(".docs-timestep-widget {") : css.index("Anima Custom Select — 2026-style dropdown")]
        self.assertIn("max-width: 880px", docs_widget_css)
        self.assertNotIn("flex: none", docs_widget_css)


if __name__ == "__main__":
    unittest.main()
