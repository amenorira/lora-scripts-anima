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

        if Version(torch.__version__) < Version("2.3.0"):
            log.warning("Torch version is lower than 2.3.0, which may not be able to train FLUX model properly. Please re-run the installation script (start.bat or start.sh) to upgrade Torch.")
            log.warning("！！！Torch 版本低于 2.3.0，将无法正常训练 FLUX 模型。请考虑重新运行安装脚本以升级 Torch！！！")
            log.warning("！！！若您正在使用训练包，请直接下载最新训练包！！！")

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
