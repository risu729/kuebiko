param(
	[string] $Cdp = 'http://127.0.0.1:9222',
	[switch] $VerboseLogger,
	[string] $Include,
	[string] $Exclude,
	[string] $Config,
	[Alias('ChromePath')]
	[string] $BrowserPath,
	[string] $BrowserCommand = 'chrome.exe',
	[switch] $NoPlugins,
	[long] $MaxBodyBytes = -1
)

$ErrorActionPreference = 'Stop'

function New-CaptureTimestamp {
	return (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH-mm-ss')
}

$baseDir = Join-Path $env:LOCALAPPDATA 'ChromeCdpResponseLogger'
$captureDir = Join-Path (Join-Path $baseDir 'captures') (New-CaptureTimestamp)

$chromeArguments = @('-CaptureDir', $captureDir)
if ($BrowserPath) {
	$chromeArguments += @('-BrowserPath', $BrowserPath)
}
$chromeArguments += @('-BrowserCommand', $BrowserCommand)

& (Join-Path $PSScriptRoot 'start-browser-cdp.ps1') @chromeArguments

$deadline = (Get-Date).AddSeconds(15)
while ((Get-Date) -lt $deadline) {
	try {
		Invoke-RestMethod -Uri "$Cdp/json/version" -TimeoutSec 2 | Out-Null
		break
	}
 catch {
		Start-Sleep -Milliseconds 500
	}
}

$arguments = @('-CaptureDir', $captureDir, '-Cdp', $Cdp)
if ($VerboseLogger) {
	$arguments += '-VerboseLogger'
}
if ($Include) {
	$arguments += @('-Include', $Include)
}
if ($Exclude) {
	$arguments += @('-Exclude', $Exclude)
}
if ($Config) {
	$arguments += @('-Config', $Config)
}
if ($NoPlugins) {
	$arguments += '-NoPlugins'
}
if ($MaxBodyBytes -ge 0) {
	$arguments += @('-MaxBodyBytes', $MaxBodyBytes.ToString())
}

& (Join-Path $PSScriptRoot 'run-logger.ps1') @arguments
