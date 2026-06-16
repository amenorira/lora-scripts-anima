import os
from backend.log import log
try:
    import tkinter
    from tkinter.filedialog import askdirectory, askopenfilename
except ImportError:
    tkinter = None
    askdirectory = None
    askopenfilename = None
    log.warning("tkinter not found, file selector will not work.")

last_dir = ""

_tk_root = None


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
        filename = askopenfilename(
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
        directory = askdirectory(
            initialdir=initialdir
        )
        last_dir = directory
        return directory
    except (OSError, RuntimeError, TypeError):
        return ""
