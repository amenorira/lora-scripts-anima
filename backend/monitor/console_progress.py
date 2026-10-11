"""Single-line training progress, including terminal reflow on resize."""
from rich.control import Control
from rich.live_render import LiveRender
from rich.progress import Progress
from rich.segment import ControlType
from rich.text import Text

from backend.log import COLORS, console


class _ResizeSafeLiveRender(LiveRender):
    def __init__(self, renderable, console, **kwargs):
        super().__init__(renderable, **kwargs)
        self.console = console

    def position_cursor(self):
        # Rich remembers the rendered height, but Windows Terminal reflows the
        # previous single line when narrowed. Clear those extra physical rows
        # too, before printing either the next frame or an ordinary log record.
        if self._shape is not None and not self.console.legacy_windows:
            cells, height = self._shape
            if height == 1:
                width = max(1, self.console.size.width)
                # Reflow preserves the blank cell under the cursor as well.
                # An exact multiple of the new width puts it on another row.
                rows = cells // width + 1
                return Control(
                    ControlType.CARRIAGE_RETURN,
                    (ControlType.ERASE_IN_LINE, 2),
                    *((ControlType.CURSOR_UP, 1), (ControlType.ERASE_IN_LINE, 2)) * (rows - 1),
                )
        return super().position_cursor()


class _TrainingRow:
    def __init__(self, task):
        self.task = task

    def __rich_console__(self, console, options):
        # Reserve the last cell to avoid terminal auto-wrap at the right edge.
        width = max(1, options.max_width - 1)
        task = self.task
        fields = task.fields

        def field(name, default="--"):
            return " ".join(str(fields.get(name) or default).split())

        total = int(task.total or 0)
        completed = int(task.completed)
        fraction = max(0.0, min(1.0, task.completed / total)) if total else 0
        pct = f"{fraction * 100:>3.0f}%" if total else "--%"
        step = f"{completed}/{total}" if total else str(completed)
        filled = round(20 * fraction)
        parts = [
            Text("#" * filled + "." * (20 - filled), style=COLORS["muted"]),
            Text(f"{pct} {step}", style=COLORS["accent"]),
            Text(f"{field('elapsed')}<{field('eta')}", style=COLORS["text"]),
            Text(f"loss={field('loss')}", style=COLORS["text"]),
            Text(f"lr={field('lr')}", style=COLORS["text"]),
            Text(f"ep={field('epoch')}", style=COLORS["text"]),
            Text(field("speed", ""), style=COLORS["text"]),
        ]
        # Keep steps and loss visible in narrow desktop windows. Optional
        # details return automatically when there is room again.
        for index in (6, 0, 5, 4, 2):
            tail = Text(" ").join(part for part in parts if part.plain)
            if tail.cell_len + len("Training ") + 8 <= width:
                break
            parts[index] = Text("")
        tail = Text(" ").join(part for part in parts if part.plain)
        description = Text(" ".join((task.description or "Training").split()), style=COLORS["text"])
        description.truncate(max(1, width - tail.cell_len - 1), overflow="ellipsis")
        row = Text(no_wrap=True, overflow="crop")
        row.append_text(description)
        row.append(" ")
        row.append_text(tail)
        row.truncate(width, overflow="ellipsis")
        yield row


class _TrainingProgress(Progress):
    def get_renderables(self):
        for task in self.tasks:
            if task.visible:
                yield _TrainingRow(task)


def build_console_progress():
    progress = _TrainingProgress(console=console, transient=True)
    # Local compatibility adapter: Rich has no public LiveRender factory.
    # Keep its lifecycle, shared-console logging and stdout redirection intact.
    progress.live._live_render = _ResizeSafeLiveRender(
        progress.get_renderable(), progress.console,
        vertical_overflow=progress.live.vertical_overflow,
    )
    return progress
