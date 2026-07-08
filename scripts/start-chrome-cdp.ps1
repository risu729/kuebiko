param(
	[string] $CaptureDir,
	[string] $ChromePath
)

$ErrorActionPreference = 'Stop'

$arguments = @('-BrowserCommand', 'chrome.exe')
if ($CaptureDir) {
	$arguments += @('-CaptureDir', $CaptureDir)
}
if ($ChromePath) {
	$arguments += @('-BrowserPath', $ChromePath)
}

& (Join-Path $PSScriptRoot 'start-browser-cdp.ps1') @arguments
