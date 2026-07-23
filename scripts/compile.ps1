param(
  [string]$Target = "all"
)

$ErrorActionPreference = "Stop"

function Invoke-Compile {
  param(
    [Parameter(Mandatory = $true)]
    [string]$BunTarget,

    [Parameter(Mandatory = $true)]
    [string]$OutputPath
  )

  bun build --compile "--target=$BunTarget" "--outfile=$OutputPath" src/index.ts
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }
}

switch ($Target) {
  "all" {
    Invoke-Compile -BunTarget "bun-linux-x64" -OutputPath "dist/kuebiko-linux-x64"
    Invoke-Compile -BunTarget "bun-darwin-arm64" -OutputPath "dist/kuebiko-macos-arm64"
    Invoke-Compile -BunTarget "bun-windows-x64" -OutputPath "dist/kuebiko-windows-x64.exe"
  }
  "linux-x64" {
    Invoke-Compile -BunTarget "bun-linux-x64" -OutputPath "dist/kuebiko-linux-x64"
  }
  "macos-arm64" {
    Invoke-Compile -BunTarget "bun-darwin-arm64" -OutputPath "dist/kuebiko-macos-arm64"
  }
  "windows-x64" {
    Invoke-Compile -BunTarget "bun-windows-x64" -OutputPath "dist/kuebiko-windows-x64.exe"
  }
  default {
    [Console]::Error.WriteLine(
      "Unsupported target: $Target. Use all, linux-x64, macos-arm64, or windows-x64."
    )
    exit 2
  }
}
