#Requires -Version 5.1
<#
.SYNOPSIS
    Runs the packaged or development Streamy Discord bot.

.DESCRIPTION
    Starts only the bot that posts the public viewer link. It does not start a
    relay, gateway or tunnel. The desktop app starts it with -Hidden and stops it
    with -Stop; it can also be run by hand for troubleshooting.

    The bot's node_modules, .env and src/ live in <root>\bot.
#>
[CmdletBinding()]
param(
    [int]$BotPort = 8791,
    [switch]$Stop,
    [switch]$Hidden
)

$ErrorActionPreference = "Stop"

$ScriptRoot = $PSScriptRoot
if (-not $ScriptRoot) { $ScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path }

# In development the script lives in stream-site\dev and the bot in
# stream-site\bot. The installer copies it to <app>\stack but keeps the bot in
# <app>\stack\bot, so prefer the bot beside this script when it is there.
if (Test-Path -LiteralPath (Join-Path $ScriptRoot "bot\src\index.js")) {
    $Root = $ScriptRoot
} else {
    $Root = Split-Path -Parent $ScriptRoot
}
$BotDir = Join-Path $Root "bot"
$RunDir = Join-Path $Root ".run"
$PidFile = Join-Path $RunDir "bot.pid"
$LogFile = Join-Path $RunDir "bot.log"
$ErrFile = Join-Path $RunDir "bot.err.log"

function Get-NodePath {
    $candidates = @(
        (Join-Path $Root "stack\node.exe"),
        (Join-Path $Root "node.exe"),
        (Join-Path $BotDir "node.exe")
    )
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate) { return $candidate }
    }
    $command = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    throw "node.exe was not found. Install Node.js or place node.exe beside start-bot.ps1."
}

function Stop-PortOwner([int]$Port) {
    $owners = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique)
    foreach ($owner in $owners) {
        if ($owner -and $owner -ne $PID) {
            Stop-Process -Id $owner -Force -ErrorAction SilentlyContinue
        }
    }
}

function Stop-Bot {
    if (Test-Path -LiteralPath $PidFile) {
        $oldPid = (Get-Content -LiteralPath $PidFile -Raw).Trim()
        if ($oldPid -match '^\d+$') {
            Stop-Process -Id ([int]$oldPid) -Force -ErrorAction SilentlyContinue
        }
        Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
    }
    Stop-PortOwner $BotPort
    Write-Host "Streamy bot stopped." -ForegroundColor Yellow
}

function Wait-Http([string]$Url, [int]$TimeoutSeconds) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2
            if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 300) { return $true }
        } catch {
        }
        Start-Sleep -Milliseconds 300
    }
    return $false
}

if ($Stop) {
    Stop-Bot
    exit 0
}

if (-not (Test-Path -LiteralPath (Join-Path $BotDir "src\index.js"))) {
    throw "Bot source not found at $BotDir\src\index.js"
}
if (-not (Test-Path -LiteralPath (Join-Path $BotDir ".env"))) {
    Write-Warning "No bot/.env found. The bot needs DISCORD_TOKEN and STREAMY_API_KEY."
}
if (Wait-Http "http://127.0.0.1:$BotPort/healthz" 1) {
    Write-Host "Streamy bot is already running on port $BotPort." -ForegroundColor Green
    exit 0
}

$node = Get-NodePath
New-Item -ItemType Directory -Force -Path $RunDir | Out-Null

# The app passes -Hidden so no console appears during normal use. Running the
# script by hand shows the bot in its own window instead.
$previousPort = $env:PORT
$env:PORT = [string]$BotPort
try {
    if ($Hidden) {
        $process = Start-Process -FilePath $node -ArgumentList "src/index.js" `
            -WorkingDirectory $BotDir -WindowStyle Hidden -PassThru `
            -RedirectStandardOutput $LogFile -RedirectStandardError $ErrFile
    } else {
        $quoted = $BotDir.Replace("'", "''")
        $command = "`$env:PORT='$BotPort'; Set-Location -LiteralPath '$quoted'; & '$($node.Replace("'", "''"))' src/index.js"
        $process = Start-Process -FilePath "powershell.exe" `
            -ArgumentList @("-NoProfile", "-NoExit", "-ExecutionPolicy", "Bypass", "-Command", $command) `
            -PassThru
    }
} finally {
    $env:PORT = $previousPort
}
Set-Content -LiteralPath $PidFile -Value $process.Id -Encoding ascii

if (-not (Wait-Http "http://127.0.0.1:$BotPort/healthz" 20)) {
    if (Test-Path -LiteralPath $ErrFile) {
        Get-Content -LiteralPath $ErrFile -Tail 20
    }
    Stop-Bot
    throw "The Streamy bot did not become healthy on port $BotPort."
}

Write-Host "Streamy bot is ready on http://127.0.0.1:$BotPort" -ForegroundColor Green
