# BridgeDev portable Windows installer (PowerShell 5.1+ / 7+); no elevation.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
function Fail([string]$Message) { throw "BridgeDev: $Message" }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail 'Node.js 22+ required.' }
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { Fail 'npm required.' }
$major = (& node -p 'Number(process.versions.node.split(".")[0])')
if ($LASTEXITCODE -ne 0 -or [int]$major -lt 22) { Fail 'Node.js 22+ required.' }
if ($env:BRIDGEDEV_INSTALL_SOURCE_DIR) {
  & node (Join-Path $env:BRIDGEDEV_INSTALL_SOURCE_DIR 'scripts/install-portable.mjs') --source $env:BRIDGEDEV_INSTALL_SOURCE_DIR
  if ($LASTEXITCODE -ne 0) { Fail 'Local install failed.' }
  return
}
$temp = Join-Path ([IO.Path]::GetTempPath()) ('bridge-dev-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temp -Force | Out-Null
try {
  Write-Host '[BridgeDev] Downloading source from GitHub...'
  $archive = Join-Path $temp 'source.zip'
  Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/kmanisk/bridge-dev/archive/refs/heads/main.zip' -OutFile $archive
  Expand-Archive -LiteralPath $archive -DestinationPath $temp -Force
  $source = Join-Path $temp 'bridge-dev-main'
  if (-not (Test-Path (Join-Path $source 'scripts/install-portable.mjs'))) { Fail 'Incomplete archive.' }
  & node (Join-Path $source 'scripts/install-portable.mjs') --source $source
  if ($LASTEXITCODE -ne 0) { Fail 'Install failed.' }
  $bin = Join-Path $env:LOCALAPPDATA 'BridgeDev\bin'
  if (-not $env:BRIDGEDEV_INSTALL_BIN -and (Test-Path (Join-Path $bin 'bridge-dev.cmd'))) {
    $old = [Environment]::GetEnvironmentVariable('Path','User')
    if (-not (($old -split ';') -contains $bin)) {
      [Environment]::SetEnvironmentVariable('Path',(($old.TrimEnd(';') + ';' + $bin).TrimStart(';')),'User')
      Write-Host '[BridgeDev] Added user-level CLI directory to PATH (available in new terminals).'
    }
    $env:Path += ';' + $bin
  }
} finally {
  if (Test-Path $temp) { Remove-Item -LiteralPath $temp -Force -Recurse -ErrorAction SilentlyContinue }
}
