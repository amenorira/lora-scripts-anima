import warnings
from backend.log import log
from packaging.version import Version

available_devices = []
printable_devices = []


def check_torch_gpu():
    report = {
        "torch_version": None,
        "backend": "CPU",
        "gpus": [],
    }
    available_devices.clear()
    printable_devices.clear()
    try:
        import torch
        report["torch_version"] = torch.__version__
        log.info("Torch %s", torch.__version__, extra={"console": False})
        with warnings.catch_warnings():
            warnings.filterwarnings(
                "ignore",
                message=r"cudaGetDeviceCount\(\) returned cudaErrorNotSupported.*",
                category=UserWarning,
            )
            cuda_available = torch.cuda.is_available()
        if not cuda_available:
            log.warning("Torch is not able to use GPU. GUI will work, training requires GPU. / Torch 无法使用 GPU，界面可正常使用，但训练需要显卡。")
            if "cpu" in torch.__version__:
                log.warning("You are using torch CPU version. Training will not work. / 当前使用 CPU 版 PyTorch，无法训练。")
            return report

        # 项目启动脚本（ensure_runtime）会把 torch 钉在指定构建上；
        # 走到这里版本仍不一致，说明环境被手工动过，提示用启动脚本自修复
        try:
            from tools.ensure_runtime import TORCH as _PINNED_TORCH
        except Exception:
            _PINNED_TORCH = None
        if _PINNED_TORCH and Version(torch.__version__) != Version(_PINNED_TORCH):
            log.warning(
                "Torch %s differs from the pinned build %s; training may fail. "
                "Re-run start.bat / start.sh to repair automatically. / "
                "Torch %s 与项目指定版本 %s 不一致，训练可能失败：重新运行 start.bat / start.sh 可自动修复。",
                torch.__version__, _PINNED_TORCH, torch.__version__, _PINNED_TORCH,
            )

        if torch.version.cuda:
            report["backend"] = f"CUDA {torch.version.cuda}"
            log.info(
                "Torch backend: NVIDIA CUDA %s cuDNN %s",
                torch.version.cuda,
                torch.backends.cudnn.version() if torch.backends.cudnn.is_available() else "N/A",
                extra={"console": False},
            )
        elif torch.version.hip:
            report["backend"] = f"ROCm {torch.version.hip}"
            log.info(
                "Torch backend: AMD ROCm HIP %s",
                torch.version.hip,
                extra={"console": False},
            )

        device_count = torch.cuda.device_count()
        for pos in range(device_count):
            props = torch.cuda.get_device_properties(pos)
            name = props.name
            memory = props.total_memory
            device = torch.cuda.device(pos)
            available_devices.append(device)
            memory_gb = round(memory / (1024**3))
            printable_devices.append(f"GPU {pos}: {name} ({memory_gb} GB)")
            report["gpus"].append({"index": pos, "name": name, "memory_gb": memory_gb})
            log.info(
                "Torch detected GPU %s: %s, VRAM %s MiB, arch %s.%s, cores %s",
                pos, name, round(memory / 1024 / 1024),
                props.major, props.minor, props.multi_processor_count,
                extra={"console": False},
            )
        return report
    except Exception as e:
        log.error("Could not load torch / 无法加载 Torch: %s", e)
        return report
