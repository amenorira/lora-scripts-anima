# install-cn.ps1 — 国内镜像加速安装（清华 pip + PyTorch 官方 CDN）
$Env:HF_HOME = "huggingface"
$Env:PIP_DISABLE_PIP_VERSION_CHECK = 1
$Env:PIP_INDEX_URL = "https://pypi.tuna.tsinghua.edu.cn/simple"

function Check {
    param($ErrorInfo)
    if (!($?)) {
        Write-Output "[ERROR] $ErrorInfo"
        Read-Host | Out-Null
        Exit 1
    }
}

# 检测本地 python 目录
if (Test-Path -Path "python\python.exe") {
    Write-Output "[INFO] 使用本地 python 目录..."
    $py_path = (Get-Item "python").FullName
    $env:PATH = "$py_path;$env:PATH"
} else {
    if (!(Test-Path -Path "venv")) {
        Write-Output "[INFO] 创建虚拟环境..."
        python -m venv venv
        Check "venv 创建失败，请检查 Python 是否安装（需 3.10+ 64bit）"
    }
    Write-Output "[INFO] 激活虚拟环境..."
    .\venv\Scripts\activate
    Check "venv 激活失败"
}

Write-Output "============================================"
Write-Output "  lora-scripts-anima - 国内镜像安装"
Write-Output "  pip: 清华镜像 | PyTorch: 官方 CDN"
Write-Output "============================================"
Write-Output ""

# PyTorch 2.10.0 + CUDA 12.8 — RTX 30/40/50 全系兼容
Write-Output "[1/3] 安装 PyTorch 2.10.0 + CUDA 12.8 ..."
python -m pip install torch==2.10.0+cu128 torchvision==0.25.0+cu128 --index-url https://download.pytorch.org/whl/cu128
Check "PyTorch 安装失败，请检查网络或删除 venv 后重试"

# 项目依赖
Write-Output "[2/3] 安装项目依赖 ..."
python -m pip install --upgrade -r requirements.txt
Check "项目依赖安装失败"

# 训练脚本依赖
Write-Output "[3/3] 安装训练脚本依赖 ..."
python -m pip install -r vendor/sd-scripts/requirements.txt
Check "训练依赖安装失败"

Write-Output ""
Write-Output "============================================"
Write-Output "  安装完成！运行 start.bat 启动训练 GUI"
Write-Output "  RTX 40/50 系建议再运行: .\install-flash-attn.bat"
Write-Output "============================================"
Read-Host | Out-Null
