"""Check that field guide entry points resolve in every supported language."""
from html.parser import HTMLParser
from pathlib import PurePosixPath
import unittest

from backend.server.routes.docs import _DOCUMENTS, _document_path, _render_markdown
from backend.training.fields.field_registry import field_applies_to_profile, get_all_fields, get_fields_json


class DocumentLinks(HTMLParser):
    def __init__(self):
        super().__init__()
        self.ids = set()
        self.anchors = []
        self.links = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if "id" in attrs:
            self.ids.add(attrs["id"])
        if tag == "a" and attrs.get("href", "").startswith("#"):
            self.anchors.append(attrs["href"][1:])
        if tag == "a":
            self.links.append(attrs)


class ParameterDocTests(unittest.TestCase):
    def test_memory_field_guides_resolve_in_all_languages(self):
        slug = "memory-optimization"
        fields = [field for field in get_all_fields() if field.get("doc_slug") == slug]
        self.assertTrue(fields)
        # Exercise the public field payload as well as the registry definitions.
        published = [field for section in get_fields_json()["sections"] for field in section["fields"]
                     if field.get("docSlug") == slug]
        self.assertEqual({field['key'] for field in published}, {
            'gradient_checkpointing_skip_blocks', 'blocks_to_swap', 'text_encoder_blocks_to_swap',
        })
        expected = {
            'anima-lora': {'gradient_checkpointing_skip_blocks'},
            'moss-image-lora': {'gradient_checkpointing_skip_blocks', 'blocks_to_swap', 'text_encoder_blocks_to_swap'},
            'sdxl-lora': set(), 'krea2-lora': set(),
        }
        for profile, keys in expected.items():
            available = [field for field in fields if field_applies_to_profile(field, profile)
                         and profile in field.get('doc_anchor_by_profile', {})]
            self.assertEqual({field['key'] for field in available}, keys)
            for locale, relative in _DOCUMENTS[slug]["files"].items():
                with self.subTest(slug=slug, locale=locale):
                    path = _document_path(slug, locale)
                    html, _ = _render_markdown(path.read_text(encoding="utf-8"), PurePosixPath(relative))
                    links = DocumentLinks()
                    links.feed(html)
                    for field in available:
                        self.assertIn(field['doc_anchor_by_profile'][profile], links.ids, field['key'])
                    for anchor in links.anchors:
                        self.assertIn(anchor, links.ids, anchor)

    def test_external_sources_open_a_new_tab_and_local_links_keep_reader_navigation(self):
        source = ('[HTTPS](https://example.com/paper) [HTTP](http://example.com) '
                  '[CDN](//example.com/guide) [Section](#section) '
                  '[Guide](timesteps.en-US.md#sampling)\n\n## Section {#section}')
        html, _ = _render_markdown(source, PurePosixPath('parameters/fixture.en-US.md'))
        parsed = DocumentLinks()
        parsed.feed(html)
        self.assertEqual(len(parsed.links), 5)
        for link in parsed.links[:3]:
            self.assertEqual(link.get('target'), '_blank')
            self.assertEqual(set(link.get('rel', '').split()), {'noopener', 'noreferrer'})
        for link in parsed.links[3:]:
            self.assertNotIn('target', link)
