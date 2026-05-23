$Env:HF_HOME = "huggingface"

if (!(Test-Path -Path "venv")) {
    Write-Output  "Creating venv for python..."
    python -m venv venv
}
.\venv\Scripts\activate

Write-Output "Installing deps..."

# PyTorch 2.9.0 + CUDA 12.8 — 兼容 RTX 30/40/50 全系列
pip install torch==2.9.0+cu128 torchvision==0.24.0+cu128 --extra-index-url https://download.pytorch.org/whl/cu128
# xformers 可选（flash-attn 已通过 install-flash-attn.bat 安装）
# pip install -U -I --no-deps xformers==0.0.30 --extra-index-url https://download.pytorch.org/whl/cu128
pip install --upgrade -r requirements.txt
pip install -r vendor/sd-scripts/requirements.txt

Write-Output "Install completed"
Read-Host | Out-Null ;
