param(
	[string] $CaptureDir,
	[string] $Cdp = 'http://127.0.0.1:9222',
	[switch] $VerboseLogger,
	[string] $Include,
	[string] $Exclude,
	[string] $Config,
	[switch] $NoPlugins,
	[long] $MaxBodyBytes = -1
)

$ErrorActionPreference = 'Stop'

function New-CaptureTimestamp {
	return (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH-mm-ss')
}

$baseDir = Join-Path $env:LOCALAPPDATA 'ChromeCdpResponseLogger'
$capturesDir = Join-Path $baseDir 'captures'
$binDir = Join-Path $baseDir 'bin'
$exe = Join-Path $binDir 'cdp-response-logger.exe'

New-Item -ItemType Directory -Force -Path $capturesDir, $binDir | Out-Null

if (-not $CaptureDir) {
	$CaptureDir = Join-Path $capturesDir (New-CaptureTimestamp)
}

New-Item -ItemType Directory -Force -Path $CaptureDir | Out-Null

if (-not (Test-Path -LiteralPath $exe)) {
	throw "Logger executable not found: $exe"
}

$arguments = @('--cdp', $Cdp, '--out', $CaptureDir)
if ($VerboseLogger) {
	$arguments += '--verbose'
}
if ($Include) {
	$arguments += @('--include', $Include)
}
if ($Exclude) {
	$arguments += @('--exclude', $Exclude)
}
if ($Config) {
	$arguments += @('--config', $Config)
}
if ($NoPlugins) {
	$arguments += '--no-plugins'
}
if ($MaxBodyBytes -ge 0) {
	$arguments += @('--max-body-bytes', $MaxBodyBytes.ToString())
}

Write-Host "Capture directory: $CaptureDir"
Write-Host "CDP endpoint: $Cdp"
& $exe @arguments
