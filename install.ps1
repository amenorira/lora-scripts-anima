$Env:HF_HOME = "huggingface"

# Pre-check: run environment checker
Write-Output "============================================"
Write-Output "  lora-scripts-anima - Environment Check"
Write-Output "============================================"
& (Join-Path $PSScriptRoot "check_env.ps1")
if ($LASTEXITCODE -ne 0) {
    Write-Error "Environment check failed. Please fix the issues above and retry."
    Read-Host | Out-Null
    exit 1
}

if (!(Test-Path -Path "venv")) {
    Write-Output "Creating venv for python..."
    python -m venv venv
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Failed to create venv. Make sure Python is installed and in PATH."
        Read-Host | Out-Null
        exit 1
    }
}

# Use venv Python directly to avoid cross-shell activation issues
$venvPython = Join-Path $PSScriptRoot "venv\Scripts\python.exe"

Write-Output "Installing deps..."

# PyTorch 2.10.0 + CUDA 12.8
& $venvPython -m pip install torch==2.10.0+cu128 torchvision==0.25.0+cu128 --extra-index-url https://download.pytorch.org/whl/cu128

# sd-scripts dependencies (install first for exact versions)
& $venvPython -m pip install -r vendor/sd-scripts/requirements.txt

# Main project dependencies
& $venvPython -m pip install --upgrade -r requirements.txt

Write-Output "Install completed"
Read-Host | Out-Null
