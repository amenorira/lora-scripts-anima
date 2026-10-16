"""Timestep counts API and chart injection for TensorBoard Time Series."""
from __future__ import annotations

from io import BytesIO
from pathlib import Path
import zipfile

from tensorboard import errors, plugin_util
from tensorboard.backend import http_util
from tensorboard.data import provider
from tensorboard.plugins import base_plugin
from werkzeug import wrappers


PLUGIN_NAME = "anima_timesteps"
TAG = "timestep/distribution"
SCRIPT = Path(__file__).resolve().parents[1] / "frontend" / "tensorboard" / "timesteps.mjs"


class TimestepPlugin(base_plugin.TBPlugin):
    plugin_name = PLUGIN_NAME

    def __init__(self, context):
        self.data = context.data_provider

    def is_active(self):
        # This extension lives inside Time Series, not a separate dashboard tab.
        return False

    def data_plugin_names(self):
        # TensorBoard otherwise auto-enables a tab when summary data is present.
        return ()

    def get_plugin_apps(self):
        return {"/runs": self.runs, "/distribution": self.distribution, "/index.js": self.script}

    @wrappers.Request.application
    def script(self, request):
        return wrappers.Response(SCRIPT.read_bytes(), mimetype="text/javascript",
                                 headers={"Cache-Control": "no-cache"})

    @wrappers.Request.application
    def runs(self, request):
        ctx = plugin_util.context(request.environ)
        mapping = self.data.list_tensors(
            ctx, experiment_id=plugin_util.experiment_id(request.environ), plugin_name=PLUGIN_NAME,
            run_tag_filter=provider.RunTagFilter(tags=[TAG]),
        )
        runs = sorted(run for run, tags in mapping.items()
                      if TAG in tags and tags[TAG].plugin_content == b"1")
        return http_util.Respond(request, runs, "application/json")

    @wrappers.Request.application
    def distribution(self, request):
        run = request.args.get("run")
        if run is None:
            raise errors.InvalidArgumentError("A run is required")
        ctx = plugin_util.context(request.environ)
        mapping = self.data.read_tensors(
            ctx, experiment_id=plugin_util.experiment_id(request.environ), plugin_name=PLUGIN_NAME,
            downsample=1, run_tag_filter=provider.RunTagFilter(runs=[run], tags=[TAG]),
        )
        events = mapping.get(run, {}).get(TAG, [])
        if not events:
            raise errors.NotFoundError("No timestep distribution for this run")
        event = events[-1]
        counts = event.numpy
        if counts.shape != (1000,) or counts.dtype.kind not in "iu" or (counts < 0).any():
            raise errors.InvalidArgumentError("Invalid timestep count tensor")
        return http_util.Respond(request, {
            "run": run, "step": event.step, "wall_time": event.wall_time,
            "counts": counts.tolist(), "total": sum(int(value) for value in counts),
        }, "application/json")


def chart_assets_provider(prefix):
    """Add an external bootstrap module to the in-memory web asset bundle."""
    from tensorboard import assets

    source = assets.get_default_assets_zip_provider()
    script = f'<script type="module" src="{prefix}/data/plugin/{PLUGIN_NAME}/index.js"></script>'
    result = BytesIO()
    with source() as handle, zipfile.ZipFile(handle) as original, zipfile.ZipFile(result, "w") as target:
        for entry in original.infolist():
            content = original.read(entry.filename)
            if entry.filename == "index.html":
                content = content.replace(b"</body>", script.encode("utf-8") + b"</body>")
            target.writestr(entry, content)
    bundle = result.getvalue()
    return lambda: BytesIO(bundle)
