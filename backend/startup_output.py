from datetime import datetime
from pathlib import Path
from time import monotonic

from backend.log import console, log


_STARTED_AT = monotonic()


def _timestamp() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S-%f")


def _elapsed() -> str:
    seconds = monotonic() - _STARTED_AT
    return f"{seconds:.1f}s" if seconds < 10 else f"{seconds:.0f}s"


def _record(message: str) -> None:
    """Keep curated startup output in anima.log without printing it twice."""
    log.info(message, extra={"console": False})


def show_step(message: str) -> None:
    _record(message)
    timestamp = _timestamp()
    if console is None:
        print(f"{timestamp}  > {message}", flush=True)
        return

    from rich.text import Text

    line = Text()
    line.append(timestamp, style="dim cyan")
    line.append("  > ", style="bold cyan")
    line.append(message)
    console.print(line)


def show_environment(sections: list[tuple[str, str]]) -> None:
    details = " | ".join(f"{label}: {value}" for label, value in sections)
    _record(f"Runtime environment / 运行环境: {details}")
    timestamp = _timestamp()
    if console is None:
        print(f"{timestamp}  Environment / 运行环境", flush=True)
        for label, value in sections:
            print(f"  {label}: {value}", flush=True)
        return

    from rich.table import Table
    from rich.text import Text

    heading = Text()
    heading.append(timestamp, style="dim cyan")
    heading.append("  Environment / 运行环境", style="bold")
    console.print(heading)
    table = Table.grid(padding=(0, 1))
    table.add_column(style="bold", no_wrap=True)
    table.add_column(overflow="fold")
    for label, value in sections:
        table.add_row(label, value)
    console.print(table)


def show_ready(
    gui_url: str,
    *,
    tensorboard_url: str | None,
    log_path: Path,
) -> None:
    tensorboard = tensorboard_url or "Disabled / 未启用"
    timestamp = _timestamp()
    elapsed = _elapsed()
    message = (
        f"Ready / 服务已就绪 | GUI: {gui_url} | TensorBoard: {tensorboard} | "
        f"Startup: {elapsed} | Log: {log_path} | "
        f"Keep this window open / 使用期间请保持此窗口开启"
    )
    _record(message)

    if console is None:
        print(f"\n{timestamp}  READY / 服务已就绪", flush=True)
        print(f"  GUI:         {gui_url}", flush=True)
        print(f"  TensorBoard: {tensorboard}", flush=True)
        print(f"  Startup / 启动: {elapsed}", flush=True)
        print(f"  Log / 日志:  {log_path}", flush=True)
        print("  Keep this window open / 使用期间请保持此窗口开启\n", flush=True)
        return

    from rich.align import Align
    from rich.table import Table
    from rich.text import Text

    table = Table.grid(expand=True, padding=(0, 1))
    table.add_column(style="bold", no_wrap=True)
    table.add_column(ratio=1, overflow="fold")
    table.add_row("GUI", Text(gui_url, style="bold cyan"))
    table.add_row("TensorBoard", Text(tensorboard, style="cyan" if tensorboard_url else "dim"))
    table.add_row("Startup / 启动", elapsed)
    table.add_row("Log / 日志", Text(str(log_path), style="dim"))
    title = Text()
    title.append(timestamp, style="dim cyan")
    title.append("  READY / 服务已就绪", style="bold green")
    console.print()
    console.print(title)
    console.print(table)
    console.print(
        Align.center(
            Text("Keep this window open / 使用期间请保持此窗口开启", style="yellow")
        )
    )
    console.print()
