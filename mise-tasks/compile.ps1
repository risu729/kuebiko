#!/usr/bin/env pwsh
#MISE description="Compile local binaries."
#USAGE flag "--target <target>" default="all" help="Target platform: all, linux-x64, macos-arm64, or windows-x64" {
#USAGE   choices "all" "linux-x64" "macos-arm64" "windows-x64"
#USAGE }
#USAGE flag "--version <version>" default="0.0.0-development" help="Version to embed in the binaries."

$ErrorActionPreference = "Stop"
$Target = if ($env:usage_target) { $env:usage_target } else { "all" }
$Version = if ($env:usage_version) { $env:usage_version } else { "0.0.0-development" }

if ($Version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$') {
  throw "Invalid build version: $Version"
}

$VersionDefine = ConvertTo-Json -Compress $Version

function Invoke-Compile {
  param(
    [Parameter(Mandatory = $true)]
    [string]$BunTarget,

    [Parameter(Mandatory = $true)]
    [string]$OutputPath,

    [Parameter(Mandatory = $true)]
    [string]$BuildVersionDefine
  )

  bun build --compile "--target=$BunTarget" "--define=KUEBIKO_BUILD_VERSION=$BuildVersionDefine" "--outfile=$OutputPath" src/index.ts
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }
}

switch ($Target) {
  "all" {
    Invoke-Compile -BunTarget "bun-linux-x64" -OutputPath "dist/kuebiko-linux-x64" -BuildVersionDefine $VersionDefine
    Invoke-Compile -BunTarget "bun-darwin-arm64" -OutputPath "dist/kuebiko-macos-arm64" -BuildVersionDefine $VersionDefine
    Invoke-Compile -BunTarget "bun-windows-x64" -OutputPath "dist/kuebiko-windows-x64.exe" -BuildVersionDefine $VersionDefine
  }
  "linux-x64" {
    Invoke-Compile -BunTarget "bun-linux-x64" -OutputPath "dist/kuebiko-linux-x64" -BuildVersionDefine $VersionDefine
  }
  "macos-arm64" {
    Invoke-Compile -BunTarget "bun-darwin-arm64" -OutputPath "dist/kuebiko-macos-arm64" -BuildVersionDefine $VersionDefine
  }
  "windows-x64" {
    Invoke-Compile -BunTarget "bun-windows-x64" -OutputPath "dist/kuebiko-windows-x64.exe" -BuildVersionDefine $VersionDefine
  }
}
