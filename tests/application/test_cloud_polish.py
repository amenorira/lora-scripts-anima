"""Unit tests for Lean Cloud Polish backend endpoints and cloud runtime fixes."""
from __future__ import annotations

import asyncio
import io
import json
import os
import stat
import tempfile
import threading
import time
import unittest
import zipfile
from contextlib import ExitStack
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend import launch_utils
from backend.monitor import hardware
from backend.monitor.monitor import TaskMonitor
from backend.server.routes import environment as env_routes
from backend.server.routes import system as system_routes
from backend.tagger import tagger_download
from backend.training import checkpoint_state
from backend.training.execution import supervisor
from tools import moss_acceleration as accel


class LaunchUtilsAndCloudPolishTests(unittest.TestCase):
    def test_supervisor_launcher_hint_is_platform_aware(self):
        missing_exe = Path("/nonexistent/venv/bin/python")
        fake_engine = SimpleNamespace(python_executable=missing_exe, label="Krea 2")
        dummy_script = Path(__file__)

        with patch.object(supervisor, "_get_trainer_script", return_value=dummy_script), \
             patch.object(supervisor, "get_engine", return_value=fake_engine):
            with patch.object(supervisor.sys, "platform", "win32"):
                win_res = supervisor.run_train("cfg.toml", reserved_task=MagicMock())
            with patch.object(supervisor.sys, "platform", "linux"):
                lin_res = supervisor.run_train("cfg.toml", reserved_task=MagicMock())

        self.assertEqual(win_res["status"], "error")
        self.assertIn("start.bat", win_res["message"])
        self.assertEqual(lin_res["status"], "error")
        self.assertIn("start.sh", lin_res["message"])
        self.assertNotIn("start.bat", lin_res["message"])


if __name__ == "__main__":
    unittest.main()
