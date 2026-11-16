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
