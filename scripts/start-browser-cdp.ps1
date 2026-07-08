param(
	[string] $CaptureDir,
	[Alias('ChromePath')]
	[string] $BrowserPath,
	[string] $BrowserCommand = 'chrome.exe'
)

$ErrorActionPreference = 'Stop'

function New-CaptureTimestamp {
	return (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH-mm-ss')
}

function Resolve-BrowserPath {
	param(
		[string] $Path,
		[string] $Command
	)

	if ($Path) {
		if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
			throw "Browser executable was not found: $Path"
		}

		return (Resolve-Path -LiteralPath $Path).Path
	}

	$resolvedCommand = Get-Command $Command -CommandType Application -ErrorAction SilentlyContinue |
		Select-Object -First 1
	if (-not $resolvedCommand) {
		throw "Browser command was not found on PATH: $Command. Add it to PATH or pass -BrowserPath."
	}

	return $resolvedCommand.Source
}

$baseDir = Join-Path $env:LOCALAPPDATA 'ChromeCdpResponseLogger'
$profileDir = Join-Path $baseDir 'browser-profile'
$capturesDir = Join-Path $baseDir 'captures'
$binDir = Join-Path $baseDir 'bin'

New-Item -ItemType Directory -Force -Path $baseDir, $profileDir, $capturesDir, $binDir | Out-Null

if (-not $CaptureDir) {
	$CaptureDir = Join-Path $capturesDir (New-CaptureTimestamp)
}

New-Item -ItemType Directory -Force -Path $CaptureDir | Out-Null

$browser = Resolve-BrowserPath -Path $BrowserPath -Command $BrowserCommand
$netLogPath = Join-Path $CaptureDir 'netlog.json'
$arguments = @(
	"--user-data-dir=$profileDir",
	'--remote-debugging-address=127.0.0.1',
	'--remote-debugging-port=9222',
	"--log-net-log=$netLogPath",
	'--net-log-capture-mode=Everything'
)

Start-Process -FilePath $browser -ArgumentList $arguments

Write-Host "Browser: $browser"
Write-Host "Profile directory: $profileDir"
Write-Host "Capture directory: $CaptureDir"
Write-Host 'CDP endpoint: http://127.0.0.1:9222'
Write-Host "NetLog: $netLogPath"
