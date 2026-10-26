#Requires -Version 5.1
<#
.SYNOPSIS
    Writes the Discord bot notification settings into the Streamy desktop config.

.DESCRIPTION
    Points the desktop app at the local bot started by dev/start-bot.ps1. The
    notify key is read from bot/.env (STREAMY_API_KEY), so the two sides always
    match.

    The previous file is kept as config.json.bak. Restart streamy.exe afterwards;
    it reads the configuration at startup.

.EXAMPLE
    .\dev\configure-desktop.ps1 -ChannelID 123456789012345678
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ChannelID,
    [int]$BotPort = 8791,
    [switch]$NoNotify,
    [string]$ConfigPath
)

$ErrorActionPreference = "Stop"

$Site = Split-Path -Parent $PSScriptRoot

if (-not $ChannelID.Trim()) { throw "ChannelID must not be empty." }
if ($ChannelID -notmatch '^\d{5,32}$') {
    throw "'$ChannelID' is not a Discord channel ID (all digits, 5 to 32 characters)."
}

if (-not $ConfigPath) {
    $ConfigPath = Join-Path $env:APPDATA "streamy\config.json"
}
if (-not (Test-Path -LiteralPath $ConfigPath)) {
    throw "No config at $ConfigPath. Start streamy.exe once, then run this again."
}

$notifyURL = ""
$notifyKey = ""
if (-not $NoNotify) {
    $envFile = Join-Path $Site "bot\.env"
    if (-not (Test-Path -LiteralPath $envFile)) {
        throw "bot\.env not found, so the notify key is unknown. Create it first, or rerun with -NoNotify."
    }
    foreach ($line in Get-Content -LiteralPath $envFile) {
        $trimmed = $line.Trim()
        if ($trimmed -notmatch '^STREAMY_API_KEY\s*=\s*(.+)$') { continue }
        $value = $Matches[1].Trim()
        if ($value.Length -ge 2 -and ($value.StartsWith('"') -or $value.StartsWith("'")) -and $value.EndsWith($value[0])) {
            $value = $value.Substring(1, $value.Length - 2)
        }
        $notifyKey = $value
    }
    if (-not $notifyKey) {
        throw "bot\.env has no STREAMY_API_KEY. Fill it in, or rerun with -NoNotify."
    }
    $notifyURL = "http://127.0.0.1:$BotPort/api/notify"
}

$config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
$config | Add-Member -MemberType NoteProperty -Name schema -Value 3 -Force
if (-not $config.stream) {
    $config | Add-Member -MemberType NoteProperty -Name stream -Value (New-Object psobject) -Force
}

$discord = [ordered]@{
    channelID = $ChannelID.Trim()
    notifyURL = $notifyURL
    notifyKey = $notifyKey
}
$config.stream | Add-Member -MemberType NoteProperty -Name discord -Value ([pscustomobject]$discord) -Force
$config.stream.PSObject.Properties.Remove("relay")

if (-not $config.stream.stack) {
    $config.stream | Add-Member -MemberType NoteProperty -Name stack -Value ([pscustomobject]@{ autoStart = $true; script = "" }) -Force
} else {
    $config.stream.stack | Add-Member -MemberType NoteProperty -Name autoStart -Value $true -Force
    $config.stream.stack | Add-Member -MemberType NoteProperty -Name script -Value "" -Force
    $config.stream.stack.PSObject.Properties.Remove("publishToken")
}

Copy-Item -LiteralPath $ConfigPath -Destination "$ConfigPath.bak" -Force
$json = $config | ConvertTo-Json -Depth 20
Set-Content -LiteralPath $ConfigPath -Value $json -Encoding utf8

# Fail loudly rather than leaving an unreadable config behind.
try {
    $check = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
    if (-not $check.stream.discord.channelID) { throw "the discord block did not survive the round trip" }
} catch {
    Copy-Item -LiteralPath "$ConfigPath.bak" -Destination $ConfigPath -Force
    throw "Writing $ConfigPath failed ($($_.Exception.Message)). The previous file was restored."
}

Write-Host ""
Write-Host "  Config   : $ConfigPath" -ForegroundColor White
Write-Host "  Backup   : $ConfigPath.bak" -ForegroundColor DarkGray
Write-Host "  Channel  : $($ChannelID.Trim())"
Write-Host "  Bot      : http://127.0.0.1:$BotPort"
Write-Host "  Notify   : $(if ($notifyURL) { $notifyURL } else { 'disabled' })"
Write-Host ""
Write-Host "  Restart streamy.exe, then start sharing with Ctrl+\\." -ForegroundColor White
Write-Host ""
