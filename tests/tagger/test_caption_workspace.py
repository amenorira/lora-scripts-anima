"""Caption output extensions must preserve existing images and sidecar records."""
import tempfile
import unittest
from pathlib import Path

from PIL import Image

from backend.tagger import workspace


class CaptionWorkspaceTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.image = self.add_image("00.png")

    def add_image(self, name):
        path = self.root / name
        Image.new("RGB", (32, 24), (100, 80, 170)).save(path)
        return path

    def scan(self, **options):
        return workspace.scan_source(str(self.root), caption_extension=options.get("caption_extension", ".txt"), caption_options=options)

    def test_compound_extensions_cannot_overwrite_images_or_json(self):
        from backend.tagger.captioning import output_options
        from backend.tagger.errors import TaggerUserError

        for extension in (".custom.json", ".preview.PNG", ".custom.json.", ".json. "):
            with self.subTest(extension=extension):
                target = self.image.with_suffix(extension.rstrip(" ."))
                original = b"user file to preserve"
                target.write_bytes(original)
                with self.assertRaises(TaggerUserError):
                    self.scan(caption_extension=extension)
                self.assertEqual(target.read_bytes(), original)
        self.assertEqual(output_options(extension=".caption.txt")["caption_extension"], ".caption.txt")

    def test_source_and_task_errors_carry_stable_error_codes(self):
        from backend.tagger.errors import TaggerIndexError, TaggerNotFoundError, TaggerUserError, error_data

        with self.assertRaises(TaggerUserError) as root_ctx:
            workspace.scan_source(str(Path(self.root.anchor)))
        self.assertEqual(root_ctx.exception.code, "taggerRootNotAllowed")

        with self.assertRaises(TaggerNotFoundError) as source_ctx:
            workspace.source_items("expired-token")
        self.assertEqual(source_ctx.exception.code, "taggerSourceExpired")

        scanned = self.scan()
        with self.assertRaises(TaggerIndexError) as index_ctx:
            workspace.annotation_detail(scanned["source_token"], 99, {})
        self.assertIsInstance(index_ctx.exception, IndexError)
        self.assertEqual(index_ctx.exception.code, "taggerImageIndexOutOfRange")
        self.assertEqual(error_data(index_ctx.exception), {"errorCode": "taggerImageIndexOutOfRange", "errorParams": {}})

        with self.assertRaises(TaggerNotFoundError) as items_ctx:
            workspace.task_items("missing-task")
        self.assertEqual(items_ctx.exception.code, "taggerTaskNotFound")

        with self.assertRaises(TaggerNotFoundError) as prompt_ctx:
            workspace.task_check_prompt("missing-task")
        self.assertEqual(prompt_ctx.exception.code, "taggerTaskNotFound")
