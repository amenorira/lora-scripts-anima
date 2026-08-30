import os
import sys
from backend.log import log
try:
    import tkinter
    import tkinter.filedialog as _filedialog
except ImportError:
    tkinter = None
    _filedialog = None
    log.warning("tkinter is unavailable, native file picker disabled / tkinter 不可用，本地文件选择功能已禁用")

last_dir = ""

_tk_root = None


def _set_dpi_awareness() -> None:
    """声明进程 DPI 感知。不声明时 Windows 会把文件对话框当低 DPI 程序做位图
    拉伸，在开启缩放的屏幕上显得模糊。必须在创建任何窗口前调用。"""
    if os.name != "nt":
        return
    import ctypes
    try:
        # Windows 10 1703+：Per-Monitor V2
        ctypes.windll.user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
        return
    except (AttributeError, OSError):
        pass
    try:
        # Windows 8.1+：Per-Monitor
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
        return
    except (AttributeError, OSError):
        pass
    try:
        # Vista+：系统级 DPI 感知
        ctypes.windll.user32.SetProcessDPIAware()
    except (AttributeError, OSError):
        pass


_set_dpi_awareness()



def is_available() -> bool:
    """tkinter 是否可用（导入失败或无图形环境时为 False，前端据此隐藏本地选择器按钮）。"""
    if tkinter is None:
        return False
    # Linux 无图形环境（云服务器/容器）时对话框必然弹不出来；ssh -X 转发会设置 DISPLAY，不受影响
    if sys.platform.startswith("linux") and not (os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY")):
        return False
    return True


def _get_tk_root():
    """获取或创建共享的 Tk 根实例（避免每次文件对话框重复创建）"""
    global _tk_root
    if tkinter is None:
        return None
    if _tk_root is None:
        _tk_root = tkinter.Tk()
        _tk_root.wm_attributes('-topmost', 1)
        _tk_root.withdraw()
    return _tk_root


def open_file_selector(
        initialdir="",
        title="Select a file",
        filetypes="*") -> str:
    global last_dir
    if last_dir != "":
        initialdir = last_dir
    elif initialdir == "":
        initialdir = os.getcwd()
    try:
        _get_tk_root()
        filename = _filedialog.askopenfilename(
            initialdir=initialdir, title=title,
            filetypes=filetypes
        )
        last_dir = os.path.dirname(filename)
        return filename
    except (OSError, RuntimeError, TypeError):
        return ""


def open_directory_selector(initialdir) -> str:
    global last_dir
    if last_dir != "":
        initialdir = last_dir
    elif initialdir == "":
        initialdir = os.getcwd()
    try:
        _get_tk_root()
        directory = _filedialog.askdirectory(
            initialdir=initialdir
        )
        last_dir = directory
        return directory
    except (OSError, RuntimeError, TypeError):
        return ""
