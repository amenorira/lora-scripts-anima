# SD-Trainer - Update kohya-ss/sd-scripts (PowerShell)
$ErrorActionPreference = "Stop"

Write-Output "============================================"
Write-Output "  SD-Trainer - Update kohya-ss/sd-scripts"
Write-Output "============================================"
Write-Output ""

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$TempDir = Join-Path $ScriptDir "_sdscripts_temp"

# Check git
if (!(Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Output "[ERROR] Git not found. Please install Git for Windows"
    Write-Output "Download: https://git-scm.com/download/win"
    Read-Host | Out-Null
    exit 1
}

# [1/4] Clone latest
Write-Output "[1/4] Cloning latest kohya-ss/sd-scripts ..."
if (Test-Path $TempDir) {
    Remove-Item -Recurse -Force $TempDir
}
git clone --depth 1 https://github.com/kohya-ss/sd-scripts.git $TempDir
if ($LASTEXITCODE -ne 0) {
    Write-Output "[ERROR] Clone failed. Check network connection."
    Read-Host | Out-Null
    exit 1
}
Write-Output "[OK] Clone complete"

# [2/4] Remove old versions
Write-Output "[2/4] Removing old sd-scripts/stable and sd-scripts/dev ..."
$StableDir = Join-Path $ScriptDir "..\vendor\sd-scripts\stable"
$DevDir = Join-Path $ScriptDir "..\vendor\sd-scripts\dev"
if (Test-Path $StableDir) {
    Remove-Item -Recurse -Force $StableDir
    Write-Output "[OK] Removed sd-scripts/stable"
}
if (Test-Path $DevDir) {
    Remove-Item -Recurse -Force $DevDir
    Write-Output "[OK] Removed sd-scripts/dev"
}

# [3/4] Copy new scripts
Write-Output "[3/4] Copying new scripts to sd-scripts/ ..."
$TargetDir = Join-Path $ScriptDir "..\vendor\sd-scripts"
Copy-Item -Path "$TempDir\*" -Destination $TargetDir -Recurse -Force

# Remove .git files
$GitDir = Join-Path $TargetDir ".git"
$GitIgnore = Join-Path $TargetDir ".gitignore"
$GitHubDir = Join-Path $TargetDir ".github"
if (Test-Path $GitDir) { Remove-Item -Recurse -Force $GitDir }
if (Test-Path $GitIgnore) { Remove-Item -Force $GitIgnore }
if (Test-Path $GitHubDir) { Remove-Item -Recurse -Force $GitHubDir }
Write-Output "[OK] Copy complete"

# [4/4] Cleanup
Write-Output "[4/4] Cleaning temp files ..."
Remove-Item -Recurse -Force $TempDir
Write-Output "[OK] Cleanup complete"

Write-Output ""
Write-Output "============================================"
Write-Output "  Update complete!"
Write-Output "  sd-scripts/ now uses the latest single-version sd-scripts"
Write-Output "  All script paths have been updated"
Write-Output "============================================"
Write-Output ""

Read-Host | Out-Null
