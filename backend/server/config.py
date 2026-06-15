import os
import json
import shutil
from backend.constants import CONFIG_DIR, REPO_ROOT
from backend.log import log

class Config:

    def __init__(self, path: str):
        self.path = path
        self._stored = {}
        self._default = {
            "saved_params": {}
        }

    def load_config(self):
        log.info(f"Loading config from {self.path}")
        if not os.path.exists(self.path):
            old_path = REPO_ROOT / "assets" / "config.json"
            if os.path.exists(old_path):
                try:
                    shutil.copy2(old_path, self.path)
                    log.info(f"Migrated config from {old_path} to {self.path}")
                except Exception as e:
                    log.error(f"Migration failed: {e}, using defaults")
                    self._stored = dict(self._default)
                    self.save_config()
                    return
            else:
                self._stored = dict(self._default)
                self.save_config()
                return

        try:
            with open(self.path, "r", encoding="utf-8") as f:
                self._stored = json.load(f)
        except Exception as e:
            log.error(f"Error loading config: {e}")
            self._stored = dict(self._default)
            self.save_config()
            return

    def save_config(self):
        try:
            with open(self.path, "w", encoding="utf-8") as f:
                json.dump(self._stored, f, indent=4, ensure_ascii=False)
        except Exception as e:
            log.error(f"Error saving config: {e}")

    def __getitem__(self, key):
        val = self._stored.get(key)
        if val is None:
            val = self._default.get(key)
        return val

    def __setitem__(self, key, value):
        self._stored[key] = value


app_config = Config(CONFIG_DIR / "state.json")
