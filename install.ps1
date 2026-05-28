$Env:HF_HOME = "huggingface"

if (!(Test-Path -Path "venv")) {
    Write-Output  "Creating venv for python..."
    python -m venv venv
}
.\venv\Scripts\activate

Write-Output "Installing deps..."

# PyTorch 2.10.0 + CUDA 12.8 — 兼容 RTX 30/40/50 全系列，cp312 有预编译 flash-attn
pip install torch==2.10.0+cu128 torchvision==0.25.0+cu128 --extra-index-url https://download.pytorch.org/whl/cu128
# xformers 可选（flash-attn 已通过 install-flash-attn.bat 安装）
# pip install -U -I --no-deps xformers==0.0.30 --extra-index-url https://download.pytorch.org/whl/cu128

# 训练核心 sd-scripts 依赖优先安装，确保精确版本
pip install -r vendor/sd-scripts/requirements.txt
# 主项目依赖（GUI 层等），补充 sd-scripts 未覆盖的包
pip install --upgrade -r requirements.txt

Write-Output "Install completed"
Read-Host | Out-Null ;
