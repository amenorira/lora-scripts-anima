"""
硬件监控 — GPU (pynvml) + CPU/RAM (psutil)
"""
from __future__ import annotations

import atexit
import platform
import threading
import time as _time

_nvml_ready = False

_cpu_name_cache: str | None = None
_gpu_sample: dict | None = None
_gpu_sample_lock = threading.Lock()
_sys_sample: dict | None = None
_sys_sample_lock = threading.Lock()
_SAMPLE_TTL = 1.0
_sample_started = False


def _ensure_nvml() -> bool:
    global _nvml_ready
    if _nvml_ready:
        return True
    try:
        import pynvml
        pynvml.nvmlInit()
        _nvml_ready = True
        atexit.register(pynvml.nvmlShutdown)
        return True
    except Exception:
        return False


def _start_sampler():
    global _sample_started
    if _sample_started:
        return
    _sample_started = True

    def _sample():
        global _gpu_sample, _sys_sample
        while True:
            try:
                with _gpu_sample_lock:
                    _gpu_sample = _gpu_info_raw()
            except Exception:
                pass
            try:
                with _sys_sample_lock:
                    _sys_sample = _sys_info_raw()
            except Exception:
                pass
            _time.sleep(_SAMPLE_TTL)

    t = threading.Thread(target=_sample, daemon=True)
    t.start()


def _gpu_info_raw() -> dict | None:
    if not _ensure_nvml():
        return None
    try:
        import pynvml
        device_count = pynvml.nvmlDeviceGetCount()
        gpus = []
        for i in range(device_count):
            handle = pynvml.nvmlDeviceGetHandleByIndex(i)
            name = pynvml.nvmlDeviceGetName(handle)
            if isinstance(name, bytes):
                name = name.decode("utf-8", errors="replace")
            mem = pynvml.nvmlDeviceGetMemoryInfo(handle)
            util = pynvml.nvmlDeviceGetUtilizationRates(handle)

            try:
                temp = pynvml.nvmlDeviceGetTemperature(handle, pynvml.NVML_TEMPERATURE_GPU)
            except Exception:
                temp = None

            try:
                power_mw = pynvml.nvmlDeviceGetPowerUsage(handle)
                power_w = round(power_mw / 1000, 1)
            except Exception:
                power_w = None

            gpus.append({
                "index": i,
                "name": name,
                "vram_used_mb": round(mem.used / (1024 * 1024)),
                "vram_total_mb": round(mem.total / (1024 * 1024)),
                "gpu_load_pct": util.gpu,
                "mem_load_pct": util.memory,
                "temperature_c": temp,
                "power_w": power_w,
            })

        result: dict = {"gpus": gpus}
        # 向后兼容：将第一个 GPU 的字段提升到顶层
        if gpus:
            first = gpus[0]
            result.update({k: v for k, v in first.items() if k != "index"})
        return result
    except Exception:
        return None


def gpu_info() -> dict | None:
    _start_sampler()
    with _gpu_sample_lock:
        if _gpu_sample is not None:
            return _gpu_sample
    return _gpu_info_raw()


def _get_cpu_name() -> str:
    """获取 CPU 型号名称"""
    global _cpu_name_cache
    if _cpu_name_cache is not None:
        return _cpu_name_cache
    name = ""
    try:
        if platform.system() == "Windows":
            import winreg
            key = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE,
                                 r"HARDWARE\DESCRIPTION\System\CentralProcessor\0")
            try:
                name = winreg.QueryValueEx(key, "ProcessorNameString")[0].strip()
            finally:
                winreg.CloseKey(key)
        else:
            try:
                with open("/proc/cpuinfo") as f:
                    for line in f:
                        if line.startswith("model name"):
                            name = line.split(":", 1)[1].strip()
                            break
            except Exception:
                pass
    except Exception:
        pass
    _cpu_name_cache = name or platform.processor() or ""
    return _cpu_name_cache


def _sys_info_raw() -> dict:
    """CPU / RAM 使用率"""
    try:
        import psutil
        cpu = psutil.cpu_percent(interval=None)
        mem = psutil.virtual_memory()
        cpu_name = _get_cpu_name()
        return {
            "cpu_name": cpu_name,
            "cpu_pct": cpu,
            "ram_used_gb": round(mem.used / (1024**3), 1),
            "ram_total_gb": round(mem.total / (1024**3), 1),
            "ram_pct": mem.percent,
        }
    except Exception:
        return {"cpu_name": "", "cpu_pct": 0, "ram_used_gb": 0,
                "ram_total_gb": 0, "ram_pct": 0}


def system_info() -> dict:
    _start_sampler()
    with _sys_sample_lock:
        if _sys_sample is not None:
            return _sys_sample
    return _sys_info_raw()
