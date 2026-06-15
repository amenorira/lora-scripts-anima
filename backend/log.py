import logging
import os
from logging.handlers import RotatingFileHandler


log = logging.getLogger('anima-trainer')
log.setLevel(logging.DEBUG)

try:
    from rich.console import Console
    from rich.logging import RichHandler
    from rich.pretty import install as pretty_install
    from rich.theme import Theme

    console = Console(
        log_time=True,
        log_time_format='%H:%M:%S-%f',
        theme=Theme(
            {
                'traceback.border': 'black',
                'traceback.border.syntax_error': 'black',
                'inspect.value.border': 'black',
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
        rich_tracebacks=True,
        log_time_format='%H:%M:%S-%f',
        level=logging.INFO,
        console=console,
    )
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
    log.handlers.clear()
    log.addHandler(_sh)

