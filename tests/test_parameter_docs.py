"""Check that field guide entry points resolve in every supported language."""
from html.parser import HTMLParser
from pathlib import PurePosixPath
import unittest

from backend.server.routes.docs import _DOCUMENTS, _document_path, _render_markdown
from backend.training.fields.field_registry import get_all_fields, get_fields_json


class DocumentLinks(HTMLParser):
    def __init__(self):
        super().__init__()
        self.ids = set()
        self.anchors = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if "id" in attrs:
            self.ids.add(attrs["id"])
        if tag == "a" and attrs.get("href", "").startswith("#"):
            self.anchors.append(attrs["href"][1:])


class ParameterDocTests(unittest.TestCase):
    def test_memory_field_guides_resolve_in_all_languages(self):
        slug = "memory-optimization"
        fields = [field for field in get_all_fields() if field.get("doc_slug") == slug]
        self.assertTrue(fields)
        # Exercise the public field payload as well as the registry definitions.
        published = [field for section in get_fields_json()["sections"] for field in section["fields"]
                     if field.get("docSlug") == slug]
        self.assertTrue(any(field["key"] == "gradient_checkpointing_skip_blocks" for field in published))
        for locale, relative in _DOCUMENTS[slug]["files"].items():
            with self.subTest(locale=locale):
                path = _document_path(slug, locale)
                html, _ = _render_markdown(path.read_text(encoding="utf-8"), PurePosixPath(relative))
                links = DocumentLinks()
                links.feed(html)
                for field in fields:
                    self.assertIn(field["doc_anchor"], links.ids, field["key"])
                for anchor in links.anchors:
                    self.assertIn(anchor, links.ids, anchor)
