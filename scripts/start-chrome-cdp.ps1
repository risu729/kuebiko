param(
	[string] $CaptureDir,
	[string] $ChromePath
)

$ErrorActionPreference = 'Stop'

function New-CaptureTimestamp {
	return (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH-mm-ss')
}

function Resolve-ChromePath {
	param(
		[string] $Path
	)

	if ($Path) {
		if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
			throw "Chrome executable was not found: $Path"
		}

		return (Resolve-Path -LiteralPath $Path).Path
	}

	$command = Get-Command 'chrome.exe' -CommandType Application -ErrorAction SilentlyContinue |
		Select-Object -First 1
	if (-not $command) {
		throw 'chrome.exe was not found on PATH. Add Chrome to PATH or pass -ChromePath.'
	}

	return $command.Source
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

$chrome = Resolve-ChromePath -Path $ChromePath
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
