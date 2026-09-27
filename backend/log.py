import logging
import os
from logging.handlers import RotatingFileHandler

COLORS = dict(text="#E0E6ED", muted="#AAB4C0", accent="#4DE0CE",
              secondary="#62ADFF", success="#72DB83", warning="#FFD166",
              error="#FF7878", border="#7D8793", timestamp="dim cyan")


class _ConsoleVisibilityFilter(logging.Filter):
    """Allow selected records to be kept in the file log without console noise."""

    def filter(self, record):
        return getattr(record, "console", True)


# TensorBoard is served through an internal httpx reverse proxy. Its per-request
# INFO records interrupt Rich's live training row and leave a screenful of
# progress snapshots; warnings and transport errors remain visible.
for _quiet_logger in ("httpx", "httpcore"):
    logging.getLogger(_quiet_logger).setLevel(logging.WARNING)


log = logging.getLogger('anima-trainer')
log.setLevel(logging.DEBUG)
console = None
# 应用日志由本模块统一输出；禁止继续传播给 uvicorn/sd-scripts 配置的 root handler，
# 否则同一条记录会以两种格式打印两遍。
log.propagate = False

try:
    from rich.console import Console
    from rich.logging import RichHandler
    from rich.pretty import install as pretty_install
    from rich.theme import Theme
    from rich.highlighter import NullHighlighter

    console = Console(
        style=COLORS["text"], highlight=False,
        log_time=True,
        log_time_format='%Y-%m-%d %H:%M:%S-%f',
        theme=Theme(
            {
                'log.time': COLORS['timestamp'],
                'logging.level.debug': COLORS['muted'],
                'logging.level.info': COLORS['text'],
                'logging.level.warning': COLORS['warning'],
                'logging.level.error': COLORS['error'],
                'logging.level.critical': COLORS['error'],
                'progress.description': COLORS['text'],
                'progress.percentage': COLORS['accent'],
                'progress.download': COLORS['text'],
                'progress.data.speed': COLORS['muted'],
                'progress.elapsed': COLORS['muted'],
                'progress.remaining': COLORS['muted'],
                'bar.back': COLORS['border'],
                'bar.complete': COLORS['accent'],
                'bar.finished': COLORS['success'],
                'bar.pulse': COLORS['accent'],
                'inspect.value.border': COLORS['border'],
            }
        ),
    )
    pretty_install(console=console)
    rh = RichHandler(
        show_time=True,
        omit_repeated_times=False,
        show_level=True,
        show_path=False,
        markup=False,
        highlighter=NullHighlighter(), keywords=[],
        # Preserve full tracebacks without syntax colors or bold code tokens.
        rich_tracebacks=False,
        log_time_format='%Y-%m-%d %H:%M:%S',
        level=logging.INFO,
        console=console,
    )
    rh.addFilter(_ConsoleVisibilityFilter())
    rh.set_name(logging.INFO)
    log.handlers.clear()
    log.addHandler(rh)

    # File log with rotation (10 MB × 5 backups)
    os.makedirs('logs', exist_ok=True)
    fh = RotatingFileHandler(
        'logs/anima.log', maxBytes=10 * 1024 * 1024, backupCount=5, encoding='utf-8'
    )
    fh.setLevel(logging.DEBUG)
    fh.setFormatter(logging.Formatter(
        '%(asctime)s [%(levelname)s] %(name)s: %(message)s',
        datefmt='%Y-%m-%d %H:%M:%S'
    ))
    log.addHandler(fh)

except ModuleNotFoundError:
    # Fallback: ensure log has at least a basic handler so messages aren't silently lost
    _sh = logging.StreamHandler()
    _sh.setLevel(logging.INFO)
    _sh.setFormatter(logging.Formatter('%(asctime)s [%(levelname)s] %(name)s: %(message)s'))
    _sh.addFilter(_ConsoleVisibilityFilter())
    log.handlers.clear()
    log.addHandler(_sh)
