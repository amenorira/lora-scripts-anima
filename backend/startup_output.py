import atexit
import os
from datetime import datetime
from pathlib import Path
from time import monotonic, time

from backend.log import console, log


try:
    _PREPARATION_SECONDS = max(0, time() - float(os.environ.get("ANIMA_STARTUP_STARTED_AT", time())))
except ValueError:
    _PREPARATION_SECONDS = 0
_STARTED_AT = monotonic() - _PREPARATION_SECONDS
_live = None
_step = ""
_step_started = ""


def _timestamp() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _elapsed() -> str:
    return f"{monotonic() - _STARTED_AT:.1f}s"


def _record(message: str) -> None:
    """Keep curated startup output in anima.log without printing it twice."""
    log.info(message, extra={"console": False})


def show_step(message: str) -> None:
    """Animate the active stage and retain previous stages as static rows."""
    global _live, _step, _step_started
    if _live is not None:
        _print_step()
    _record(message)
    _step = message
    _step_started = _timestamp()
    if console is None or not console.is_terminal:
        print(f"{_step_started}  > {message}", flush=True)
        return
    if _live is None:
        from rich.live import Live
        from rich.spinner import Spinner
        spinner = Spinner("dots", style="cyan")
        _live = Live(get_renderable=lambda: _render_step(spinner), console=console,
                     transient=True, refresh_per_second=12.5)
        _live.start()
    else:
        _live.refresh()


def _render_step(spinner):
    from rich.table import Table
    from rich.text import Text
    row = Table.grid(padding=0)
    row.add_row(Text(_step_started + "  ", style="dim cyan"), spinner,
                Text(f" {_step}  {_elapsed()}"))
    return row


def _print_step() -> None:
    from rich.text import Text
    line = Text()
    line.append(_step_started, style="dim cyan")
    line.append("  > ", style="cyan")
    line.append(_step, style="default")
    console.print(line)


def finish_step() -> None:
    global _live
    if _live is not None:
        _live.stop()
        _live = None
        _print_step()


atexit.register(finish_step)


def _print_summary(title, rows, *, style="bold", expand=False) -> None:
    """Render the same labeled values with or without Rich."""
    if console is None:
        print(f"{_timestamp()}  {title}", flush=True)
        for label, value, _ in rows:
            print(f"  {label}: {value}", flush=True)
        return
    from rich.table import Table
    from rich.text import Text
    console.print(Text.assemble((_timestamp(), "dim cyan"), ("  " + title, style)))
    table = Table.grid(expand=expand, padding=(0, 1))
    table.add_column(style="bold", no_wrap=True)
    table.add_column(ratio=1 if expand else None, overflow="fold")
    for label, value, value_style in rows:
        table.add_row(label, Text(value, style=value_style))
    console.print(table)


def show_environment(sections: list[tuple[str, str]]) -> None:
    finish_step()
    details = " | ".join(f"{label}: {value}" for label, value in sections)
    _record(f"Runtime environment / 运行环境: {details}")
    _print_summary("Environment / 运行环境", [(label, value, "") for label, value in sections])


def show_ready(
    gui_url: str,
    *,
    tensorboard_url: str | None,
    log_path: Path,
    tensorboard_state: str = "ready",
) -> None:
    finish_step()
    tensorboard = tensorboard_url or "Disabled / 未启用"
    if tensorboard_url and tensorboard_state == "failed":
        tensorboard += "  (Unavailable / 不可用)"
    elapsed = _elapsed()
    message = (
        f"Ready / 服务已就绪 | GUI: {gui_url} | TensorBoard: {tensorboard} | "
        f"Startup: {elapsed} | Log: {log_path} | "
        f"Keep this window open / 使用期间请保持此窗口开启"
    )
    _record(message)

    write = console.print if console is not None else print
    write()
    _print_summary("READY / 服务已就绪", [
        ("GUI", gui_url, "bold cyan"),
        ("TensorBoard", tensorboard, "cyan" if tensorboard_url else "dim"),
        ("Startup / 启动", elapsed, ""),
        ("Log / 日志", str(log_path), "dim"),
    ], style="bold green", expand=True)
    write("Keep this window open / 使用期间请保持此窗口开启",
          **({"style": "dim yellow"} if console is not None else {}))
    write()
