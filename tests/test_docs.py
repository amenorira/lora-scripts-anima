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
    def test_loraplus_documents_exist_for_both_locales(self):
        self.assertTrue(_document_path("lora-plus", "zh-CN").is_file())
        self.assertTrue(_document_path("lora-plus", "en-US").is_file())

    def test_timestep_documents_keep_widgets_equations_and_stable_anchors(self):
        expected_anchors = (
            "quick-start",
            "terminology",
            "visualizer",
            "dataset-guidance",
            "scenarios",
            "diagnosis",
            "flow-matching",
            "defaults",
            "sampling",
            "sigmoid-scale",
            "flow-shift",
            "weighting",
            "logit-normal",
            "mode",
            "compatibility",
            "sdxl-range",
            "common-mistakes",
            "testing",
        )
        for locale in ("zh-CN", "en-US"):
            path = _document_path("timesteps", locale)
            self.assertTrue(path.is_file())
            html, toc = _render_markdown(
                path.read_text(encoding="utf-8"),
                PurePosixPath(f"parameters/timesteps.{locale}.md"),
            )
            self.assertIn('data-doc-widget="timestep-preview"', html)
            equation_count = html.count('<div class="doc-equation"') + html.count(
                '<div class="doc-equation doc-equation-compact"'
            )
            self.assertEqual(equation_count, 9)
            self.assertIn('class="doc-frac"', html)
            self.assertIn('role="group"', html)
            self.assertNotIn('class="language-text"', html)
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
    weighting_scheme: 'uniform',
    sigmoid_scale: 1,
    discrete_flow_shift: 1,
    resolution: '1024,1024',
  },
  t(key) { return key; },
});
context._renderDocsTimestepPreview(container);
console.log(JSON.stringify({
  className: container.className,
  barCount: (container.innerHTML.match(/title="\d+-\d+:/g) || []).length,
  hasMiddleSummary: container.innerHTML.includes('57.0%'),
  hasWeightCurve: container.innerHTML.includes('<polyline points='),
  refreshBound: typeof refreshHandler === 'function',
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
        self.assertEqual(state["barCount"], 32)
        self.assertTrue(state["hasMiddleSummary"])
        self.assertTrue(state["hasWeightCurve"])
        self.assertTrue(state["refreshBound"])

    def test_scrollspy_uses_visibility_and_preserves_clipped_click_target(self):
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
        self.assertIn("max-width: 1760px", css)
        self.assertIn("clamp(760px, 52cqi, 900px)", css)


if __name__ == "__main__":
    unittest.main()
