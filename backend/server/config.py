import os
import json
import shutil
import threading
from backend.constants import CONFIG_DIR, REPO_ROOT
from backend.log import log


class Config:

    def __init__(self, path: str):
        self.path = path
        self._stored = {}
        self._default = {
            "saved_params": {}
        }
        self._save_timer: threading.Timer | None = None
        self._save_lock = threading.Lock()

    def load_config(self):
        log.info("Loading config from %s", self.path, extra={"console": False})
        if not os.path.exists(self.path):
            old_path = REPO_ROOT / "assets" / "config.json"
            if os.path.exists(old_path):
                try:
                    shutil.copy2(old_path, self.path)
                    log.info(f"Migrated config from {old_path} to {self.path}")
                except Exception as e:
                    log.error(f"Migration failed: {e}, using defaults")
                    self._stored = dict(self._default)
                    self._flush_config()
                    return
            else:
                self._stored = dict(self._default)
                self._flush_config()
                return

        try:
            with open(self.path, "r", encoding="utf-8") as f:
                self._stored = json.load(f)
        except Exception as e:
            log.error(f"Error loading config: {e}")
            self._stored = dict(self._default)
            self._flush_config()
            return

    def _flush_config(self):
        """立即写入配置（无防抖）。线程安全：快照数据后写入，避免与 __setitem__ 竞态。"""
        with self._save_lock:
            data = dict(self._stored)
        try:
            with open(self.path, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=4, ensure_ascii=False)
        except Exception as e:
            log.error(f"Error saving config: {e}")

    def save_config(self):
        """防抖保存：500ms 内多次调用只触发一次写入"""
        with self._save_lock:
            if self._save_timer:
                self._save_timer.cancel()
            self._save_timer = threading.Timer(0.5, self._flush_config)
            self._save_timer.daemon = True
            self._save_timer.start()

    def __getitem__(self, key):
        val = self._stored.get(key)
        if val is None:
            val = self._default.get(key)
        return val

    def __setitem__(self, key, value):
        with self._save_lock:
            self._stored[key] = value


app_config = Config(CONFIG_DIR / "state.json")
