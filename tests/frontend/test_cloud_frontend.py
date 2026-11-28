"""Targeted static and integration checks for cloud/remote frontend readiness."""
import re
import shutil
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
FRONTEND = ROOT / "frontend"


class CloudFrontendTests(unittest.TestCase):
    def test_index_html_uses_relative_assets_and_loads_net_js_first(self):
        html = (FRONTEND / "index.html").read_text(encoding="utf-8")
        # No root-absolute /anima-ui/ or /favicon.png in link/script tags
        self.assertIsNone(re.search(r'(?:href|src)=["\']/anima-ui/', html))
        self.assertIsNone(re.search(r'href=["\']/favicon\.png["\']', html))
        self.assertIn('href="favicon.png"', html)

        scripts = re.findall(r'<script\s+src="([^"]+)"', html)
        self.assertTrue(scripts, "Expected defer script tags in frontend/index.html")
        self.assertEqual(scripts[0], "anima-ui/js/shared/net.js")

    def test_all_frontend_js_files_pass_node_syntax_check(self):
        node = shutil.which("node")
        self.assertIsNotNone(node, "Install Node.js to validate JS syntax")
        js_files = sorted(
            p for p in (FRONTEND / "js").rglob("*.js")
            if "vendor" not in p.parts
        )
        self.assertTrue(js_files)
        for path in js_files:
            proc = subprocess.run(
                [node, "--check", str(path)],
                cwd=ROOT,
                capture_output=True,
                text=True,
                encoding="utf-8",
            )
            self.assertEqual(proc.returncode, 0, f"Syntax error in {path}:\n{proc.stderr}")
