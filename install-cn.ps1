# install-cn.ps1 - CN mirror install (Tsinghua pip + PyTorch CDN)
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

# Pre-check: run environment checker
& (Join-Path $PSScriptRoot "check_env.ps1")
if ($LASTEXITCODE -ne 0) {
    Write-Error "Environment check failed. Please fix the issues above and retry."
    Read-Host | Out-Null
    exit 1
}

# Detect local python directory
if (Test-Path -Path "python\python.exe") {
    Write-Output "[INFO] Using local python directory..."
    $py_path = (Get-Item "python").FullName
    $env:PATH = "$py_path;$env:PATH"
    $venvPython = "python"
} else {
    if (!(Test-Path -Path "venv")) {
        Write-Output "[INFO] Creating virtual environment..."
        python -m venv venv
        Check "Failed to create venv. Check if Python 3.10+ 64-bit is installed."
    }
    # Use venv Python directly to avoid cross-shell activation issues
    $venvPython = Join-Path $PSScriptRoot "venv\Scripts\python.exe"
    Write-Output "[INFO] Using venv Python: $venvPython"
}

Write-Output "============================================"
Write-Output "  lora-scripts-anima - CN Mirror Install"
Write-Output "  pip: Tsinghua Mirror | PyTorch: Official CDN"
Write-Output "============================================"
Write-Output ""

# PyTorch 2.10.0 + CUDA 12.8
Write-Output "[1/3] Installing PyTorch 2.10.0 + CUDA 12.8 ..."
& $venvPython -m pip install torch==2.10.0+cu128 torchvision==0.25.0+cu128 --index-url https://download.pytorch.org/whl/cu128
Check "PyTorch install failed. Check network or delete venv and retry."

# Project dependencies
Write-Output "[2/3] Installing project dependencies ..."
& $venvPython -m pip install --upgrade -r requirements.txt
Check "Project dependencies install failed."

# Training script dependencies
Write-Output "[3/3] Installing training script dependencies ..."
& $venvPython -m pip install -r vendor/sd-scripts/requirements.txt
Check "Training dependencies install failed."

Write-Output ""
Write-Output "============================================"
Write-Output "  Install complete! Run start.bat to launch."
Write-Output "  RTX 40/50: also run .\install-flash-attn.bat"
Write-Output "============================================"
Read-Host | Out-Null
