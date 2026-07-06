param(
	[string] $CaptureDir
)

$ErrorActionPreference = 'Stop'

function New-CaptureTimestamp {
	return (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH-mm-ss')
}

function Find-Chrome {
	$candidates = @(
		"${env:ProgramFiles}\Google\Chrome\Application\chrome.exe",
		"${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
		"${env:ProgramFiles}\Google\Chrome Beta\Application\chrome.exe",
		"${env:ProgramFiles(x86)}\Google\Chrome Beta\Application\chrome.exe"
	)

	foreach ($candidate in $candidates) {
		if ($candidate -and (Test-Path -LiteralPath $candidate)) {
			return $candidate
		}
	}

	throw 'Chrome or Chrome Beta was not found in the standard Program Files locations.'
}

$baseDir = Join-Path $env:LOCALAPPDATA 'ChromeCdpResponseLogger'
$profileDir = Join-Path $baseDir 'chrome-profile'
$capturesDir = Join-Path $baseDir 'captures'
$binDir = Join-Path $baseDir 'bin'

New-Item -ItemType Directory -Force -Path $baseDir, $profileDir, $capturesDir, $binDir | Out-Null

if (-not $CaptureDir) {
	$CaptureDir = Join-Path $capturesDir (New-CaptureTimestamp)
}

New-Item -ItemType Directory -Force -Path $CaptureDir | Out-Null

$chrome = Find-Chrome
$netLogPath = Join-Path $CaptureDir 'netlog.json'
$arguments = @(
	"--user-data-dir=$profileDir",
	'--remote-debugging-address=127.0.0.1',
	'--remote-debugging-port=9222',
	"--log-net-log=$netLogPath",
	'--net-log-capture-mode=Everything'
)

Start-Process -FilePath $chrome -ArgumentList $arguments

Write-Host "Chrome: $chrome"
Write-Host "Capture directory: $CaptureDir"
Write-Host 'CDP endpoint: http://127.0.0.1:9222'
Write-Host "NetLog: $netLogPath"
