"""
硬件监控 — GPU (pynvml) + CPU/RAM (psutil)
"""
from __future__ import annotations

import platform

_nvml_ready = False


def _ensure_nvml() -> bool:
    global _nvml_ready
    if _nvml_ready:
        return True
    try:
        import pynvml
        pynvml.nvmlInit()
        _nvml_ready = True
        return True
    except Exception:
        return False


def gpu_info() -> dict | None:
    if not _ensure_nvml():
        return None
    try:
        import pynvml
        handle = pynvml.nvmlDeviceGetHandleByIndex(0)
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

        return {
            "name": name,
            "vram_used_mb": round(mem.used / (1024 * 1024)),
            "vram_total_mb": round(mem.total / (1024 * 1024)),
            "gpu_load_pct": util.gpu,
            "mem_load_pct": util.memory,
            "temperature_c": temp,
            "power_w": power_w,
        }
    except Exception:
        return None


def _get_cpu_name() -> str:
    """获取 CPU 型号名称"""
    name = ""
    try:
        if platform.system() == "Windows":
            import winreg
            key = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE,
                                 r"HARDWARE\DESCRIPTION\System\CentralProcessor\0")
            name = winreg.QueryValueEx(key, "ProcessorNameString")[0].strip()
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
    return name or platform.processor() or ""


def system_info() -> dict:
    """CPU / RAM 使用率"""
    try:
        import psutil
        cpu = psutil.cpu_percent(interval=0.1)
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
