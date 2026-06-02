import os
from backend.log import log
from packaging.version import Version

available_devices = []
printable_devices = []


def check_torch_gpu():
    try:
        import torch
        log.info(f'Torch {torch.__version__}')
        if not torch.cuda.is_available():
            log.warning("Torch is not able to use GPU. GUI will work, training requires GPU. / Torch 无法使用 GPU，界面可正常使用，但训练需要显卡。")
            if "cpu" in torch.__version__:
                log.warning("You are using torch CPU version. Training will not work. / 当前使用 CPU 版 PyTorch，无法训练。")
            return

        if Version(torch.__version__) < Version("2.3.0"):
            log.warning("Torch version is lower than 2.3.0, which may not be able to train FLUX model properly. Please re-run the installation script (start.bat or start.sh) to upgrade Torch.")
            log.warning("！！！Torch 版本低于 2.3.0，将无法正常训练 FLUX 模型。请考虑重新运行安装脚本以升级 Torch！！！")
            log.warning("！！！若您正在使用训练包，请直接下载最新训练包！！！")

        if torch.version.cuda:
            log.info(
                f'Torch backend: nVidia CUDA {torch.version.cuda} cuDNN {torch.backends.cudnn.version() if torch.backends.cudnn.is_available() else "N/A"}')
        elif torch.version.hip:
            log.info(f'Torch backend: AMD ROCm HIP {torch.version.hip}')

        device_count = torch.cuda.device_count()
        for pos in range(device_count):
            props = torch.cuda.get_device_properties(pos)
            name = props.name
            memory = props.total_memory
            device = torch.cuda.device(pos)
            available_devices.append(device)
            printable_devices.append(f"GPU {pos}: {name} ({round(memory / (1024**3))} GB)")
            log.info(
                f'Torch detected GPU: {name} VRAM {round(memory / 1024 / 1024)} '
                f'Arch {props.major}.{props.minor} Cores {props.multi_processor_count}')
    except Exception as e:
        log.error(f'Could not load torch: {e}')
