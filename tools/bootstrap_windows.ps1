# Windows bootstrap for lora-scripts-anima.
# Keep this source ASCII-only so Windows PowerShell 5.1 can parse it without a BOM.
# Bilingual UTF-8 strings are loaded explicitly from bootstrap_messages.json.

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

$script:Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $script:Utf8NoBom
[Console]::OutputEncoding = $script:Utf8NoBom
$OutputEncoding = $script:Utf8NoBom
$script:InlineLength = 0

$script:ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$script:DefaultRoot = [IO.Path]::GetFullPath((Join-Path $script:ScriptDir ".."))
$script:RepositoryRoot = $script:DefaultRoot
$script:RepositoryUrl = "https://github.com/amenorira/lora-scripts-anima.git"
$script:RepositoryBranch = "main"
$script:Action = "run"
$script:Quiet = $false
$script:SetupGit = $false
$script:SkipGitSetup = $false
$script:AssumeYes = $false
$script:ForwardArgs = @()
$script:BootstrapExitCode = 0
$script:ProtectedUserRoots = @(
    ".venv",
    "bootstrap-backups",
    "cache",
    "config",
    "git",
    "huggingface",
    "logs",
    "models",
    "output",
    "py310",
    "python",
    "venv",
    "wd14_tagger_model"
)

for ($i = 0; $i -lt $args.Count; $i++) {
    $arg = [string]$args[$i]
    if ($arg -eq "--quiet" -or $arg -eq "-q") {
        $script:Quiet = $true
        continue
    }
    if ($arg -eq "--setup-git") {
        $script:SetupGit = $true
        continue
    }
    if ($arg -eq "--skip-git-setup") {
        $script:SkipGitSetup = $true
        continue
    }
    if ($arg -eq "--bootstrap-assume-yes") {
        $script:AssumeYes = $true
        continue
    }
    if ($arg -like "--bootstrap-action=*") {
        $script:Action = $arg.Substring("--bootstrap-action=".Length)
        continue
    }
    if ($arg -like "--bootstrap-root=*") {
        $script:RepositoryRoot = [IO.Path]::GetFullPath($arg.Substring("--bootstrap-root=".Length))
        continue
    }
    if ($arg -like "--bootstrap-repository-url=*") {
        $script:RepositoryUrl = $arg.Substring("--bootstrap-repository-url=".Length)
        continue
    }
    if ($arg -like "--bootstrap-branch=*") {
        $script:RepositoryBranch = $arg.Substring("--bootstrap-branch=".Length)
        continue
    }
    $script:ForwardArgs += $arg
}

$script:Messages = @{}
$messagesPath = Join-Path $script:ScriptDir "bootstrap_messages.json"
try {
    $messageObject = Get-Content -LiteralPath $messagesPath -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($property in $messageObject.PSObject.Properties) {
        $script:Messages[$property.Name] = [string]$property.Value
    }
} catch {
    $script:Messages["fatal_error"] = "Startup failed: {0}"
    $script:Messages["process_failed"] = "{0} failed with exit code {1}."
}

function Get-Text {
    param(
        [Parameter(Mandatory = $true)][string]$Key,
        [object[]]$FormatArgs = @()
    )
    $template = $script:Messages[$Key]
    if ([string]::IsNullOrEmpty([string]$template)) {
        $template = $Key
    }
    if ($FormatArgs.Count -gt 0) {
        return ($template -f $FormatArgs)
    }
    return [string]$template
}

function Write-Text {
    param(
        [Parameter(Mandatory = $true)][string]$Key,
        [object[]]$FormatArgs = @(),
        [ConsoleColor]$Color = [ConsoleColor]::Gray
    )
    Write-Host (Get-Text $Key $FormatArgs) -ForegroundColor $Color
}

function Format-ByteSize {
    param([double]$Bytes)
    if ($Bytes -ge 1GB) { return ("{0:0.00} GiB" -f ($Bytes / 1GB)) }
    if ($Bytes -ge 1MB) { return ("{0:0.00} MiB" -f ($Bytes / 1MB)) }
    if ($Bytes -ge 1KB) { return ("{0:0.0} KiB" -f ($Bytes / 1KB)) }
    return ("{0:0} B" -f $Bytes)
}

function Format-Duration {
    param([TimeSpan]$Duration)
    if ($Duration.TotalHours -ge 1) { return $Duration.ToString("hh\:mm\:ss") }
    return $Duration.ToString("mm\:ss")
}

function Write-InlineProgress {
    param([string]$Text)
    if ([Console]::IsOutputRedirected) { return }
    $padding = ""
    if ($script:InlineLength -gt $Text.Length) {
        $padding = " " * ($script:InlineLength - $Text.Length)
    }
    [Console]::Write("`r" + $Text + $padding)
    $script:InlineLength = $Text.Length
}

function Complete-InlineProgress {
    if (-not [Console]::IsOutputRedirected) {
        if ($script:InlineLength -gt 0) {
            [Console]::Write("`r" + (" " * $script:InlineLength) + "`r")
        }
        $script:InlineLength = 0
    }
}

function ConvertTo-CommandLineArgument {
    param([AllowEmptyString()][string]$Argument)
    if ($Argument.Length -eq 0) { return '""' }
    if ($Argument -notmatch '[\s"]') { return $Argument }

    $builder = New-Object System.Text.StringBuilder
    [void]$builder.Append('"')
    $backslashes = 0
    foreach ($character in $Argument.ToCharArray()) {
        if ($character -eq '\') {
            $backslashes++
            continue
        }
        if ($character -eq '"') {
            [void]$builder.Append(('\' * ($backslashes * 2 + 1)))
            [void]$builder.Append('"')
            $backslashes = 0
            continue
        }
        if ($backslashes -gt 0) {
            [void]$builder.Append(('\' * $backslashes))
            $backslashes = 0
        }
        [void]$builder.Append($character)
    }
    if ($backslashes -gt 0) {
        [void]$builder.Append(('\' * ($backslashes * 2)))
    }
    [void]$builder.Append('"')
    return $builder.ToString()
}

function Join-CommandLineArguments {
    param([string[]]$Arguments)
    return (($Arguments | ForEach-Object { ConvertTo-CommandLineArgument ([string]$_) }) -join " ")
}

function Invoke-ProcessWithSpinner {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$Arguments = @(),
        [Parameter(Mandatory = $true)][string]$Label,
        [string]$WorkingDirectory = $script:RepositoryRoot
    )

    Write-Host $Label -ForegroundColor Cyan
    $start = [Diagnostics.Stopwatch]::StartNew()
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = $FilePath
    $info.Arguments = Join-CommandLineArguments $Arguments
    $info.WorkingDirectory = $WorkingDirectory
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $info
    if (-not $process.Start()) { throw "Unable to start $FilePath" }

    $frames = @('|', '/', '-', '\')
    $frame = 0
    if ([Console]::IsOutputRedirected) {
        $process.WaitForExit()
    } else {
        while (-not $process.WaitForExit(150)) {
            Write-InlineProgress ("{0} {1}  {2}" -f $frames[$frame % $frames.Count], $Label, (Format-Duration $start.Elapsed))
            $frame++
        }
    }
    Complete-InlineProgress
    $start.Stop()
    if ($process.ExitCode -ne 0) {
        throw (Get-Text "process_failed" @($Label, $process.ExitCode))
    }
    Write-Text "process_done" @($Label, (Format-Duration $start.Elapsed)) -Color Green
}

function Invoke-NativeLive {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$Arguments = @(),
        [string]$WorkingDirectory = $script:RepositoryRoot,
        [string]$Description = $FilePath
    )
    Push-Location $WorkingDirectory
    try {
        & $FilePath @Arguments | Out-Host
        $code = $LASTEXITCODE
    } finally {
        Pop-Location
    }
    if ($code -ne 0) {
        throw (Get-Text "process_failed" @($Description, $code))
    }
}

function Invoke-NativeCapture {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$Arguments = @(),
        [string]$WorkingDirectory = $script:RepositoryRoot,
        [switch]$AllowFailure
    )
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = $FilePath
    $info.Arguments = Join-CommandLineArguments $Arguments
    $info.WorkingDirectory = $WorkingDirectory
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.StandardOutputEncoding = $script:Utf8NoBom
    $info.StandardErrorEncoding = $script:Utf8NoBom
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $info
    if (-not $process.Start()) { throw "Unable to start $FilePath" }
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $process.WaitForExit()
    $stdout = $stdoutTask.GetAwaiter().GetResult()
    $stderr = $stderrTask.GetAwaiter().GetResult()
    $code = $process.ExitCode
    $process.Dispose()
    if ($code -ne 0 -and -not $AllowFailure) {
        $detail = $stderr.Trim()
        if ([string]::IsNullOrWhiteSpace($detail)) { $detail = Get-Text "process_failed" @($FilePath, $code) }
        throw $detail
    }
    if ([string]::IsNullOrEmpty($stdout)) { return @() }
    return @($stdout -split "`r?`n" | Where-Object { $_ -ne "" })
}

function Download-FileWithProgress {
    param(
        [Parameter(Mandatory = $true)][string]$Url,
        [Parameter(Mandatory = $true)][string]$Destination,
        [Parameter(Mandatory = $true)][string]$DisplayName
    )

    Write-Text "download_start" @($DisplayName) -Color Cyan
    $parent = Split-Path -Parent $Destination
    if (-not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    if (Test-Path -LiteralPath $Destination) {
        Remove-Item -LiteralPath $Destination -Force
    }

    Add-Type -AssemblyName System.Net.Http
    $handler = New-Object System.Net.Http.HttpClientHandler
    $handler.AllowAutoRedirect = $true
    $client = New-Object System.Net.Http.HttpClient($handler)
    $client.Timeout = [TimeSpan]::FromMinutes(30)
    $client.DefaultRequestHeaders.UserAgent.ParseAdd("lora-scripts-anima-bootstrap/1.0")
    $response = $null
    $networkStream = $null
    $fileStream = $null
    $stopwatch = [Diagnostics.Stopwatch]::StartNew()
    try {
        $response = $client.GetAsync($Url, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
        [void]$response.EnsureSuccessStatusCode()
        $total = $response.Content.Headers.ContentLength
        $networkStream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
        $fileStream = New-Object IO.FileStream($Destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        $buffer = New-Object byte[] (1024 * 1024)
        [long]$downloaded = 0
        [long]$sampleBytes = 0
        $sampleTime = [Diagnostics.Stopwatch]::StartNew()
        [double]$speed = 0
        $frames = @('|', '/', '-', '\')
        $frame = 0

        while (($read = $networkStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
            $fileStream.Write($buffer, 0, $read)
            $downloaded += $read
            $sampleBytes += $read
            if ($sampleTime.ElapsedMilliseconds -ge 250) {
                $speed = $sampleBytes / [Math]::Max($sampleTime.Elapsed.TotalSeconds, 0.001)
                $sampleBytes = 0
                $sampleTime.Restart()
                if ($total -and $total -gt 0) {
                    $percent = 100.0 * $downloaded / $total
                    $remaining = [Math]::Max(0, $total - $downloaded)
                    $eta = if ($speed -gt 0) { Format-Duration ([TimeSpan]::FromSeconds($remaining / $speed)) } else { "--:--" }
                    $line = ("{0,6:0.0}%  {1} / {2}  {3}/s  ETA {4}" -f $percent, (Format-ByteSize $downloaded), (Format-ByteSize $total), (Format-ByteSize $speed), $eta)
                } else {
                    $line = ("{0}  {1}  {2}/s  {3}" -f $frames[$frame % $frames.Count], (Format-ByteSize $downloaded), (Format-ByteSize $speed), (Format-Duration $stopwatch.Elapsed))
                    $frame++
                }
                Write-InlineProgress ("{0}: {1}" -f $DisplayName, $line)
            }
        }
        $fileStream.Flush()
        Complete-InlineProgress
        Write-Text "download_complete" @($DisplayName, (Format-ByteSize $downloaded)) -Color Green
    } catch {
        Complete-InlineProgress
        if ($fileStream) { $fileStream.Dispose(); $fileStream = $null }
        if (Test-Path -LiteralPath $Destination) { Remove-Item -LiteralPath $Destination -Force }
        throw (Get-Text "download_failed" @($DisplayName, $_.Exception.Message))
    } finally {
        if ($fileStream) { $fileStream.Dispose() }
        if ($networkStream) { $networkStream.Dispose() }
        if ($response) { $response.Dispose() }
        $client.Dispose()
        $handler.Dispose()
        $stopwatch.Stop()
    }
}

function Assert-FileHash {
    param([string]$Path, [string]$ExpectedHash, [string]$DisplayName)
    $actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
    if ($actual -ne $ExpectedHash.ToUpperInvariant()) {
        throw (Get-Text "checksum_failed" @($DisplayName))
    }
}

function Assert-AuthenticodeSignature {
    param([string]$Path, [string]$DisplayName, [string]$SignerPattern = "*")
    $signature = Get-AuthenticodeSignature -LiteralPath $Path
    $subject = if ($signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { "" }
    if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid -or $subject -notlike $SignerPattern) {
        throw (Get-Text "signature_failed" @($DisplayName))
    }
}

function Find-GitExecutable {
    $command = Get-Command git.exe -ErrorAction SilentlyContinue
    if ($command -and (Test-Path -LiteralPath $command.Source)) { return $command.Source }

    $candidates = @(
        (Join-Path $env:LOCALAPPDATA "Programs\Git\cmd\git.exe"),
        (Join-Path $env:ProgramFiles "Git\cmd\git.exe")
    )
    if (${env:ProgramFiles(x86)}) {
        $candidates += (Join-Path ${env:ProgramFiles(x86)} "Git\cmd\git.exe")
    }
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate) {
            $gitDir = Split-Path -Parent $candidate
            if (($env:PATH -split ';') -notcontains $gitDir) { $env:PATH = "$gitDir;$env:PATH" }
            return $candidate
        }
    }
    return $null
}

function Ensure-GitShellIntegration {
    param([string]$GitExecutable)
    try {
        $gitRoot = Split-Path -Parent (Split-Path -Parent $GitExecutable)
        $gitBash = Join-Path $gitRoot "git-bash.exe"
        if (-not (Test-Path -LiteralPath $gitBash)) { return }

        $entries = @(
            @{ Key = "HKCU:\Software\Classes\Directory\shell\git_shell"; Target = "%1" },
            @{ Key = "HKCU:\Software\Classes\Directory\Background\shell\git_shell"; Target = "%v." }
        )
        foreach ($entry in $entries) {
            New-Item -Path $entry.Key -Force | Out-Null
            Set-Item -Path $entry.Key -Value "Git Bash Here"
            New-ItemProperty -Path $entry.Key -Name "Icon" -Value $gitBash -PropertyType String -Force | Out-Null
            $commandKey = Join-Path $entry.Key "command"
            New-Item -Path $commandKey -Force | Out-Null
            Set-Item -Path $commandKey -Value ('"{0}" "--cd={1}"' -f $gitBash, $entry.Target)
        }
    } catch {
        Write-Text "git_shell_warning" @($_.Exception.Message) -Color Yellow
    }
}

function Install-GitForWindows {
    $git = Find-GitExecutable
    if ($git) { return $git }

    $installerOptions = '/CURRENTUSER /VERYSILENT /NORESTART /NOCANCEL /SP- /CLOSEAPPLICATIONS /COMPONENTS=icons,ext\reg\shellhere,assoc,assoc_sh /o:PathOption=Cmd'
    $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
    if ($winget) {
        Write-Text "git_install_winget" -Color Cyan
        $wingetSucceeded = $false
        try {
            Invoke-NativeLive $winget.Source @(
                "install", "--id", "Git.Git", "-e", "--source", "winget",
                "--accept-source-agreements", "--accept-package-agreements", "--disable-interactivity",
                "--override", $installerOptions
            ) $script:RepositoryRoot "winget Git.Git"
            $wingetSucceeded = $true
        } catch {
            $wingetSucceeded = $false
        }
        if ($wingetSucceeded) {
            $git = Find-GitExecutable
            if ($git) {
                Ensure-GitShellIntegration $git
                Write-Text "git_installed" -Color Green
                return $git
            }
        }
        Write-Text "git_install_winget_failed" -Color Yellow
    }

    $version = "2.55.0.3"
    $url = "https://github.com/git-for-windows/git/releases/download/v2.55.0.windows.3/Git-2.55.0.3-64-bit.exe"
    $sha256 = "af12577d0fdff74243a5988197aa49b957d5044edc17004f6ddf0768996f1dca"
    $downloadDir = Join-Path $env:TEMP "lora-scripts-anima-bootstrap"
    $installer = Join-Path $downloadDir "Git-$version-64-bit.exe"
    $displayName = "Git for Windows $version"
    Write-Text "git_install_fallback" -Color Cyan
    Download-FileWithProgress $url $installer $displayName
    try {
        Assert-FileHash $installer $sha256 $displayName
        Assert-AuthenticodeSignature $installer $displayName "*"
        $installArgs = @(
            "/CURRENTUSER", "/VERYSILENT", "/NORESTART", "/NOCANCEL", "/SP-", "/CLOSEAPPLICATIONS",
            "/COMPONENTS=icons,ext\reg\shellhere,assoc,assoc_sh", "/o:PathOption=Cmd"
        )
        Invoke-ProcessWithSpinner $installer $installArgs (Get-Text "git_installing")
    } finally {
        if (Test-Path -LiteralPath $installer) { Remove-Item -LiteralPath $installer -Force }
    }
    $git = Find-GitExecutable
    if (-not $git) { throw "git.exe was not found after installation" }
    Ensure-GitShellIntegration $git
    Write-Text "git_installed" -Color Green
    return $git
}

function Confirm-RecommendedAction {
    param([string]$PromptKey)
    if ($script:SkipGitSetup) { return $false }
    if ($script:SetupGit -or $script:AssumeYes) { return $true }
    if ($script:Quiet) { return $false }
    Write-Text $PromptKey -Color Cyan
    Write-Text "choice_install"
    Write-Text "choice_skip"
    $choice = Read-Host (Get-Text "choice_input")
    return ([string]::IsNullOrWhiteSpace($choice) -or $choice -eq "1")
}

function Confirm-RequiredInstall {
    param([string]$PromptKey)
    if ($script:Quiet -or $script:AssumeYes) { return $true }
    Write-Text $PromptKey -Color Cyan
    Write-Text "choice_install"
    Write-Text "choice_skip"
    $choice = Read-Host (Get-Text "choice_input")
    return ([string]::IsNullOrWhiteSpace($choice) -or $choice -eq "1")
}

function Test-RepositoryValid {
    param([string]$Root, [string]$GitExecutable)
    if (-not (Test-Path -LiteralPath (Join-Path $Root ".git"))) { return $false }
    if (-not $GitExecutable) { return $null }
    $top = @(Invoke-NativeCapture -FilePath $GitExecutable -Arguments @("-C", $Root, "rev-parse", "--show-toplevel") -WorkingDirectory $Root -AllowFailure)
    if ($top.Count -eq 0) { return $false }
    try {
        return ([IO.Path]::GetFullPath($top[0]).TrimEnd('\') -eq [IO.Path]::GetFullPath($Root).TrimEnd('\'))
    } catch {
        return $false
    }
}

function Normalize-RepositoryLocation {
    param([string]$Location)
    if ([string]::IsNullOrWhiteSpace($Location)) { return "" }
    $normalized = $Location.Trim().Replace('\', '/').TrimEnd('/')
    if ($normalized -match '^git@github\.com:(.+)$') {
        $normalized = "https://github.com/$($Matches[1])"
    } elseif ($normalized -match '^ssh://git@github\.com/(.+)$') {
        $normalized = "https://github.com/$($Matches[1])"
    }
    if ($normalized.EndsWith(".git", [StringComparison]::OrdinalIgnoreCase)) {
        $normalized = $normalized.Substring(0, $normalized.Length - 4)
    }
    return $normalized.ToLowerInvariant()
}

function Test-RepositoryOriginMatches {
    param([string]$Root, [string]$GitExecutable, [string]$ExpectedRemote)
    $origin = @(Invoke-NativeCapture -FilePath $GitExecutable -Arguments @("-C", $Root, "remote", "get-url", "origin") -WorkingDirectory $Root -AllowFailure)
    if ($origin.Count -eq 0) { return $false }
    return ((Normalize-RepositoryLocation $origin[0]) -eq (Normalize-RepositoryLocation $ExpectedRemote))
}

function Test-ProtectedUserPath {
    param([string]$RelativePath)
    if ([string]::IsNullOrWhiteSpace($RelativePath)) { return $false }
    $normalized = $RelativePath.Replace('\', '/').TrimStart('/')
    while ($normalized.StartsWith("./", [StringComparison]::Ordinal)) {
        $normalized = $normalized.Substring(2)
    }
    if ([string]::IsNullOrWhiteSpace($normalized)) { return $false }
    $rootName = @($normalized -split '/', 2)[0]
    return ($script:ProtectedUserRoots -contains $rootName)
}

function Get-SourceAlignmentPathspec {
    $pathspec = @(".")
    foreach ($rootName in $script:ProtectedUserRoots) {
        $pathspec += ":(top,exclude,icase,literal)$rootName"
        $pathspec += ":(top,exclude,icase)$rootName/**"
    }
    return $pathspec
}

function Get-SafeWorkspacePath {
    param([string]$Root, [string]$RelativePath)
    if ([IO.Path]::IsPathRooted($RelativePath)) { throw "Absolute repository path is not allowed: $RelativePath" }
    $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
    $relativeNative = $RelativePath.Replace('/', '\')
    $full = [IO.Path]::GetFullPath((Join-Path $Root $relativeNative))
    if (-not $full.StartsWith($rootFull, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Repository path escapes the project root: $RelativePath"
    }
    return $full
}

function Assert-NoReparseTraversal {
    param([string]$Root, [string]$FullPath)
    $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd('\')
    $targetFull = [IO.Path]::GetFullPath($FullPath)
    if (-not $targetFull.StartsWith($rootFull + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw "Path is outside the project root: $targetFull"
    }
    $relative = $targetFull.Substring($rootFull.Length + 1)
    $current = $rootFull
    foreach ($part in $relative.Split('\')) {
        if ([string]::IsNullOrEmpty($part)) { continue }
        $current = Join-Path $current $part
        if (Test-Path -LiteralPath $current) {
            $item = Get-Item -LiteralPath $current -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Repository repair refuses to traverse a reparse point: $current"
            }
        }
    }
}

function New-BootstrapBackup {
    param(
        [string]$Root,
        [string[]]$ChangedPaths,
        [string[]]$ObsoletePaths,
        [string]$RemoteCommit,
        [string]$RemoteUrl,
        [string]$Branch
    )
    $all = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach ($path in @($ChangedPaths) + @($ObsoletePaths)) {
        if (-not [string]::IsNullOrWhiteSpace($path)) { [void]$all.Add($path) }
    }
    if ($all.Count -eq 0) { return $null }

    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $backupDir = Join-Path $Root "bootstrap-backups"
    if (Test-Path -LiteralPath $backupDir) {
        Assert-NoReparseTraversal $Root $backupDir
    }
    New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $zipPath = Join-Path $backupDir ("source-before-git-repair-{0}.zip" -f $stamp)
    $counter = 1
    while (Test-Path -LiteralPath $zipPath) {
        $zipPath = Join-Path $backupDir ("source-before-git-repair-{0}-{1}.zip" -f $stamp, $counter)
        $counter++
    }

    $stream = New-Object IO.FileStream($zipPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    $archive = New-Object IO.Compression.ZipArchive($stream, [IO.Compression.ZipArchiveMode]::Create, $false)
    try {
        foreach ($relative in $all) {
            $full = Get-SafeWorkspacePath $Root $relative
            Assert-NoReparseTraversal $Root $full
            if (Test-Path -LiteralPath $full -PathType Leaf) {
                $entryName = $relative.Replace('\', '/')
                [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $full, $entryName, [IO.Compression.CompressionLevel]::Optimal)
            }
        }
        $manifest = [ordered]@{
            created_utc = [DateTime]::UtcNow.ToString("o")
            repository_url = $RemoteUrl
            branch = $Branch
            remote_commit = $RemoteCommit
            changed_or_missing = @($ChangedPaths)
            obsolete_historical_files = @($ObsoletePaths)
        } | ConvertTo-Json -Depth 5
        $entry = $archive.CreateEntry("bootstrap-manifest.json", [IO.Compression.CompressionLevel]::Optimal)
        $writer = New-Object IO.StreamWriter($entry.Open(), $script:Utf8NoBom)
        try { $writer.Write($manifest) } finally { $writer.Dispose() }
    } finally {
        $archive.Dispose()
        $stream.Dispose()
    }
    return $zipPath
}

function Remove-EmptyParentDirectories {
    param([string]$Root, [string]$FilePath)
    $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd('\')
    $current = Split-Path -Parent $FilePath
    while ($current -and $current.StartsWith($rootFull + '\', [StringComparison]::OrdinalIgnoreCase)) {
        if (@(Get-ChildItem -LiteralPath $current -Force).Count -gt 0) { break }
        Remove-Item -LiteralPath $current -Force
        $current = Split-Path -Parent $current
    }
}

function Repair-GitRepository {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$GitExecutable,
        [Parameter(Mandatory = $true)][string]$RemoteUrl,
        [Parameter(Mandatory = $true)][string]$Branch
    )

    $rootFull = [IO.Path]::GetFullPath($Root)
    $gitMarker = Join-Path $rootFull ".git"
    if (Test-Path -LiteralPath $gitMarker) {
        if (Test-RepositoryValid $rootFull $GitExecutable) {
            Write-Text "git_existing" -Color Green
            if (-not (Test-RepositoryOriginMatches $rootFull $GitExecutable $RemoteUrl)) {
                Write-Text "git_origin_unknown" -Color Yellow
            }
            return [pscustomobject]@{ Success = $true; Repaired = $false; Backup = $null }
        }
        Write-Text "git_corrupt" -Color Yellow
        return [pscustomobject]@{ Success = $false; Repaired = $false; Backup = $null }
    }
    foreach ($sentinel in @("start.bat", "backend\gui.py")) {
        if (-not (Test-Path -LiteralPath (Join-Path $rootFull $sentinel))) {
            throw "Project sentinel is missing: $sentinel"
        }
    }

    Write-Text "git_repair_start" -Color Cyan
    $tempParent = Join-Path $rootFull ".anima_tmp"
    if (Test-Path -LiteralPath $tempParent) {
        Assert-NoReparseTraversal $rootFull $tempParent
    }
    New-Item -ItemType Directory -Path $tempParent -Force | Out-Null
    $tempGit = Join-Path $tempParent ("git-bootstrap-{0}" -f [Guid]::NewGuid().ToString("N"))
    $tempFull = [IO.Path]::GetFullPath($tempGit)
    $safeParent = [IO.Path]::GetFullPath($tempParent).TrimEnd('\') + '\'
    if (-not $tempFull.StartsWith($safeParent, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Unsafe temporary Git directory"
    }
    $common = @("--git-dir=$tempGit", "--work-tree=$rootFull")
    $backup = $null
    try {
        try {
            Invoke-NativeLive $GitExecutable ($common + @("init", "-b", $Branch)) $rootFull "git init"
        } catch {
            Invoke-NativeLive $GitExecutable ($common + @("init")) $rootFull "git init"
            Invoke-NativeLive $GitExecutable ($common + @("symbolic-ref", "HEAD", "refs/heads/$Branch")) $rootFull "git symbolic-ref"
        }
        Invoke-NativeLive $GitExecutable ($common + @("config", "core.autocrlf", "false")) $rootFull "git config"
        Invoke-NativeLive $GitExecutable ($common + @("config", "core.quotepath", "false")) $rootFull "git config"
        Invoke-NativeLive $GitExecutable ($common + @("remote", "add", "origin", $RemoteUrl)) $rootFull "git remote add"
        Write-Text "git_fetch" -Color Cyan
        Invoke-NativeLive $GitExecutable ($common + @("fetch", "--progress", "--tags", "origin", "+refs/heads/${Branch}:refs/remotes/origin/${Branch}")) $rootFull "git fetch"

        $remoteRef = "refs/remotes/origin/$Branch"
        $remoteCommit = (@(Invoke-NativeCapture $GitExecutable ($common + @("rev-parse", $remoteRef)) $rootFull))[0]
        Invoke-NativeLive $GitExecutable ($common + @("update-ref", "refs/heads/$Branch", $remoteRef)) $rootFull "git update-ref"
        Invoke-NativeLive $GitExecutable ($common + @("symbolic-ref", "HEAD", "refs/heads/$Branch")) $rootFull "git symbolic-ref"
        $null = Invoke-NativeCapture $GitExecutable ($common + @("reset", "--mixed", $remoteRef)) $rootFull

        $changed = @(Invoke-NativeCapture $GitExecutable ($common + @("-c", "core.quotepath=false", "diff", "--name-only", "--diff-filter=ACMRTUXB", $remoteRef, "--")) $rootFull)
        $untracked = @(Invoke-NativeCapture $GitExecutable ($common + @("-c", "core.quotepath=false", "ls-files", "--others", "--exclude-standard")) $rootFull)
        $tracked = @(Invoke-NativeCapture $GitExecutable ($common + @("-c", "core.quotepath=false", "ls-files")) $rootFull)
        $obsolete = @()
        foreach ($relative in $untracked) {
            if ([string]::IsNullOrWhiteSpace($relative)) { continue }
            if (Test-ProtectedUserPath $relative) { continue }
            $history = @(Invoke-NativeCapture -FilePath $GitExecutable -Arguments ($common + @("log", "-1", "--format=%H", "--all", "--", $relative)) -WorkingDirectory $rootFull -AllowFailure)
            if ($history.Count -gt 0 -and -not [string]::IsNullOrWhiteSpace($history[0])) {
                $obsolete += $relative
            }
        }

        $backup = New-BootstrapBackup $rootFull $changed $obsolete $remoteCommit $RemoteUrl $Branch
        if ($backup) {
            Write-Text "git_backup" @($backup) -Color Green
        } else {
            Write-Text "git_no_backup" -Color Green
        }

        foreach ($relative in @($tracked) + @($obsolete)) {
            if ([string]::IsNullOrWhiteSpace($relative)) { continue }
            if (Test-ProtectedUserPath $relative) { continue }
            $full = Get-SafeWorkspacePath $rootFull $relative
            Assert-NoReparseTraversal $rootFull $full
        }

        Write-Text "git_align" @($Branch) -Color Cyan
        $alignmentPathspec = @(Get-SourceAlignmentPathspec)
        Invoke-NativeLive $GitExecutable ($common + @("checkout", "--force", $remoteRef, "--") + $alignmentPathspec) $rootFull "git checkout source files"
        foreach ($relative in $obsolete) {
            $full = Get-SafeWorkspacePath $rootFull $relative
            if (Test-Path -LiteralPath $full -PathType Leaf) {
                Remove-Item -LiteralPath $full -Force
                Remove-EmptyParentDirectories $rootFull $full
            }
        }
        Invoke-NativeLive $GitExecutable ($common + @("branch", "--set-upstream-to=origin/$Branch", $Branch)) $rootFull "git branch --set-upstream-to"
        Invoke-NativeLive $GitExecutable ($common + @("config", "pull.ff", "only")) $rootFull "git config pull.ff"
        Invoke-NativeLive $GitExecutable ($common + @("config", "fetch.prune", "true")) $rootFull "git config fetch.prune"

        if (Test-Path -LiteralPath $gitMarker) { throw ".git appeared while repository repair was running" }
        Move-Item -LiteralPath $tempGit -Destination $gitMarker
        $tempGit = $null
        $verify = @(Invoke-NativeCapture $GitExecutable @("-C", $rootFull, "rev-parse", "--abbrev-ref", "@{upstream}") $rootFull)
        if ($verify.Count -eq 0 -or $verify[0] -ne "origin/$Branch") {
            throw "Repository upstream verification failed"
        }
        Write-Text "git_repair_done" -Color Green
        return [pscustomobject]@{ Success = $true; Repaired = $true; Backup = $backup }
    } catch {
        Write-Text "git_repair_failed" @($_.Exception.Message) -Color Yellow
        return [pscustomobject]@{ Success = $false; Repaired = $false; Backup = $backup }
    } finally {
        if ($tempGit -and (Test-Path -LiteralPath $tempGit)) {
            $cleanup = [IO.Path]::GetFullPath($tempGit)
            if ($cleanup.StartsWith($safeParent, [StringComparison]::OrdinalIgnoreCase)) {
                Remove-Item -LiteralPath $cleanup -Recurse -Force
            }
        }
    }
}

function Invoke-OptionalGitBootstrap {
    $root = $script:RepositoryRoot
    $marker = Join-Path $root ".git"
    $git = Find-GitExecutable
    if (Test-Path -LiteralPath $marker) {
        if ($git) {
            Write-Text "git_found" @($git) -Color DarkGray
            if (Test-RepositoryValid $root $git) {
                Write-Text "git_existing" -Color Green
                return $false
            }
            Write-Text "git_corrupt" -Color Yellow
            return $false
        }
        Write-Text "git_repo_missing_tool" -Color Yellow
        if (-not (Confirm-RecommendedAction "git_install_prompt")) {
            Write-Text "git_skipped" -Color Yellow
            return $false
        }
        try {
            $git = Install-GitForWindows
            Write-Text "git_found" @($git) -Color Green
            if (-not (Test-RepositoryValid $root $git)) {
                Write-Text "git_corrupt" -Color Yellow
            }
        } catch {
            Write-Text "git_install_failed" @($_.Exception.Message) -Color Yellow
        }
        return $false
    }

    Write-Text "git_zip_detected" -Color Yellow
    if (-not (Confirm-RecommendedAction "git_setup_prompt")) {
        Write-Text "git_skipped" -Color Yellow
        return $false
    }
    try {
        if (-not $git) { $git = Install-GitForWindows }
        Ensure-GitShellIntegration $git
        Write-Text "git_found" @($git) -Color Green
        $result = Repair-GitRepository $root $git $script:RepositoryUrl $script:RepositoryBranch
        return [bool]$result.Repaired
    } catch {
        Write-Text "git_install_failed" @($_.Exception.Message) -Color Yellow
        return $false
    }
}

function Test-CompatiblePython {
    param([string]$PythonExecutable)
    if (-not $PythonExecutable -or -not (Test-Path -LiteralPath $PythonExecutable)) { return $false }
    $probe = @(Invoke-NativeCapture -FilePath $PythonExecutable -Arguments @(
        "-c",
        "import sys; print('compatible') if (3,10) <= sys.version_info[:2] < (3,13) and sys.maxsize > 2**32 else sys.exit(1)"
    ) -WorkingDirectory $script:RepositoryRoot -AllowFailure)
    return ($probe.Count -gt 0 -and $probe[0] -eq "compatible")
}

function Find-CompatiblePython {
    $venvPython = Join-Path $script:RepositoryRoot "venv\Scripts\python.exe"
    if (Test-Path -LiteralPath $venvPython) {
        if (-not (Test-CompatiblePython $venvPython)) {
            throw (Get-Text "python_venv_invalid")
        }
        return [pscustomobject]@{ Path = $venvPython; Source = "existing venv" }
    }

    $launcher = Get-Command py.exe -ErrorAction SilentlyContinue
    if ($launcher) {
        foreach ($version in @("3.12", "3.11", "3.10")) {
            $candidateJson = @(Invoke-NativeCapture -FilePath $launcher.Source -Arguments @("-$version", "-c", "import json,sys; print(json.dumps(sys.executable, ensure_ascii=True))") -WorkingDirectory $script:RepositoryRoot -AllowFailure)
            if ($candidateJson.Count -gt 0) {
                try { $candidate = [string]($candidateJson[0] | ConvertFrom-Json) } catch { $candidate = $null }
                if ($candidate -and (Test-CompatiblePython $candidate)) {
                    return [pscustomobject]@{ Path = $candidate; Source = "Python Launcher" }
                }
            }
        }
    }

    $candidates = @(
        (Join-Path $env:LOCALAPPDATA "Programs\Python\Python312\python.exe"),
        (Join-Path $env:LOCALAPPDATA "Python\pythoncore-3.12-64\python.exe"),
        (Join-Path $env:ProgramFiles "Python312\python.exe")
    )
    foreach ($candidate in $candidates) {
        if (Test-CompatiblePython $candidate) {
            return [pscustomobject]@{ Path = $candidate; Source = "installed Python" }
        }
    }

    foreach ($name in @("python3.12.exe", "python3.11.exe", "python3.10.exe", "python3.exe", "python.exe")) {
        $commands = @(Get-Command $name -All -ErrorAction SilentlyContinue)
        foreach ($command in $commands) {
            $candidate = $command.Source
            if ($candidate -like "*\WindowsApps\*") { continue }
            if (Test-CompatiblePython $candidate) {
                return [pscustomobject]@{ Path = $candidate; Source = "PATH" }
            }
        }
    }
    return $null
}

function Install-Python312 {
    $url = "https://www.python.org/ftp/python/3.12.10/python-3.12.10-amd64.exe"
    $downloadDir = Join-Path $env:TEMP "lora-scripts-anima-bootstrap"
    $installer = Join-Path $downloadDir "python-3.12.10-amd64.exe"
    $installDir = Join-Path $env:LOCALAPPDATA "Programs\Python\Python312"
    $displayName = Get-Text "python_download"
    Download-FileWithProgress $url $installer $displayName
    try {
        Assert-AuthenticodeSignature $installer $displayName "*Python Software Foundation*"
        $installArgs = @(
            "/quiet", "InstallAllUsers=0", "AssociateFiles=0", "Shortcuts=0", "PrependPath=0",
            "Include_launcher=0", "Include_test=0", "Include_doc=0", "Include_tcltk=0", "TargetDir=$installDir"
        )
        Invoke-ProcessWithSpinner $installer $installArgs (Get-Text "python_installing")
    } finally {
        if (Test-Path -LiteralPath $installer) { Remove-Item -LiteralPath $installer -Force }
    }
    $python = Join-Path $installDir "python.exe"
    if (-not (Test-CompatiblePython $python)) { throw "python.exe was not found after installation" }
    Write-Text "python_installed" -Color Green
    return $python
}

function Repair-PipMirrorForProcess {
    param([string]$PythonExecutable)
    $hosts = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach ($key in @("global.index-url", "global.extra-index-url")) {
        $value = @(Invoke-NativeCapture -FilePath $PythonExecutable -Arguments @("-m", "pip", "config", "get", $key) -WorkingDirectory $script:RepositoryRoot -AllowFailure)
        if ($value.Count -eq 0) { continue }
        $url = [string]$value[0]
        if ($url.StartsWith("http://", [StringComparison]::OrdinalIgnoreCase)) {
            $secure = "https://" + $url.Substring(7)
            if ($key -eq "global.extra-index-url") { $env:PIP_EXTRA_INDEX_URL = $secure } else { $env:PIP_INDEX_URL = $secure }
            try { [void]$hosts.Add(([Uri]$secure).Host) } catch { }
        }
    }
    foreach ($name in @("PIP_INDEX_URL", "PIP_EXTRA_INDEX_URL")) {
        $value = [Environment]::GetEnvironmentVariable($name, "Process")
        if ($value -and $value.StartsWith("http://", [StringComparison]::OrdinalIgnoreCase)) {
            $secure = "https://" + $value.Substring(7)
            [Environment]::SetEnvironmentVariable($name, $secure, "Process")
            try { [void]$hosts.Add(([Uri]$secure).Host) } catch { }
        }
    }
    if ($hosts.Count -gt 0) {
        $existing = @($env:PIP_TRUSTED_HOST -split '\s+' | Where-Object { $_ })
        foreach ($hostName in $hosts) { if ($existing -notcontains $hostName) { $existing += $hostName } }
        $env:PIP_TRUSTED_HOST = $existing -join " "
        Write-Text "pip_mirror_fixed" @($env:PIP_TRUSTED_HOST) -Color Yellow
    }
}

function Invoke-PipInstall {
    param([string]$PythonExecutable, [string[]]$PipArguments, [string]$WorkingDirectory = $script:RepositoryRoot)
    $arguments = @("-m", "pip") + $PipArguments + @("--progress-bar", "on")
    Invoke-NativeLive $PythonExecutable $arguments $WorkingDirectory "pip"
}

function Install-ProjectEnvironment {
    param([string]$BootstrapPython)
    $venvPython = Join-Path $script:RepositoryRoot "venv\Scripts\python.exe"
    if (-not (Test-Path -LiteralPath $venvPython)) {
        Invoke-ProcessWithSpinner $BootstrapPython @("-m", "venv", (Join-Path $script:RepositoryRoot "venv")) (Get-Text "venv_creating")
        if (-not (Test-Path -LiteralPath $venvPython)) { throw "venv python.exe was not created" }
        Write-Text "pip_upgrade" -Color Cyan
        Invoke-PipInstall $venvPython @("install", "--upgrade", "pip")
    }

    Write-Text "install_start" -Color Cyan
    $env:PIP_DISABLE_PIP_VERSION_CHECK = "1"
    $env:PIP_PREFER_BINARY = "1"
    Write-Text "install_torch" -Color Cyan
    Invoke-PipInstall $venvPython @("install", "setuptools>=68,<82")
    Invoke-PipInstall $venvPython @("install", "torch==2.10.0+cu130", "torchvision==0.25.0+cu130", "--extra-index-url", "https://download.pytorch.org/whl/cu130")
    Write-Text "install_sd" -Color Cyan
    Invoke-PipInstall $venvPython @("install", "-r", "requirements.txt") (Join-Path $script:RepositoryRoot "vendor\sd-scripts")
    Write-Text "install_project" -Color Cyan
    Invoke-PipInstall $venvPython @("install", "-r", "requirements.txt") $script:RepositoryRoot
    Write-Text "install_done" -Color Green
}

function Invoke-MainBootstrap {
    Write-Text "bootstrap_start" -Color Cyan
    Write-Text "project_dir" @($script:RepositoryRoot) -Color DarkGray
    Set-Location $script:RepositoryRoot

    $repaired = Invoke-OptionalGitBootstrap
    if ($repaired) {
        Write-Text "git_restart" -Color Cyan
        $script:BootstrapExitCode = 23
        return
    }

    $python = Find-CompatiblePython
    if (-not $python) {
        Write-Text "python_missing" -Color Yellow
        if (-not (Confirm-RequiredInstall "python_install_prompt")) {
            throw (Get-Text "python_required")
        }
        $installed = Install-Python312
        $python = [pscustomobject]@{ Path = $installed; Source = "automatic per-user install" }
    }
    Write-Text "python_using" @($python.Source, $python.Path) -Color Green
    & $python.Path --version | Out-Host
    Repair-PipMirrorForProcess $python.Path

    $venvPython = Join-Path $script:RepositoryRoot "venv\Scripts\python.exe"
    if (-not (Test-Path -LiteralPath $venvPython)) {
        Write-Text "venv_missing" -Color Yellow
        if (-not (Confirm-RequiredInstall "venv_install_prompt")) {
            Write-Text "cancelled" -Color Yellow
            $script:BootstrapExitCode = 0
            return
        }
        Install-ProjectEnvironment $python.Path
    }

    Set-Location $script:RepositoryRoot
    & $venvPython -X utf8 -m tools.ensure_runtime
    if ($LASTEXITCODE -ne 0) {
        throw (Get-Text "process_failed" @("CUDA 13.0 runtime upgrade", $LASTEXITCODE))
    }

    $env:HF_HOME = Join-Path $script:RepositoryRoot "huggingface"
    $env:PYTHONUTF8 = "1"
    if (-not $env:HF_ENDPOINT) { $env:HF_ENDPOINT = "https://hf-mirror.com" }
    $startupHooks = Join-Path $script:RepositoryRoot "tools\python_startup"
    $pythonPathEntries = @($env:PYTHONPATH -split ';' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    if ($pythonPathEntries -notcontains $startupHooks) {
        $env:PYTHONPATH = (@($startupHooks) + $pythonPathEntries) -join ';'
    }
    Write-Text "launching" -Color Cyan
    Set-Location $script:RepositoryRoot
    & $venvPython -m backend.gui @script:ForwardArgs
    if ($null -eq $LASTEXITCODE) {
        $script:BootstrapExitCode = 0
    } else {
        $script:BootstrapExitCode = $LASTEXITCODE
    }
}

try {
    if ($script:Action -eq "repair-git") {
        $git = Find-GitExecutable
        if (-not $git) { throw "git.exe is required for the repair-git action" }
        $result = Repair-GitRepository $script:RepositoryRoot $git $script:RepositoryUrl $script:RepositoryBranch
        Write-Text "internal_action_done" -Color DarkGray
        exit 0
    }
    if ($script:Action -ne "run") { throw "Unknown bootstrap action: $($script:Action)" }
    Invoke-MainBootstrap
    exit $script:BootstrapExitCode
} catch {
    Write-Text "fatal_error" @($_.Exception.Message) -Color Red
    exit 1
}
