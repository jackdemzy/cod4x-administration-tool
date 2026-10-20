# COD4X CONTROL: robust Windows build
# Uses npm ci when a lockfile is present; otherwise creates one with npm install.
$ErrorActionPreference = 'Stop'
# Keep PowerShell 5/7 console output UTF-8 so German status text renders correctly.
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
Set-Location $PSScriptRoot

Write-Host ''
Write-Host '========================================='
Write-Host ' COD4X CONTROL 4.18.14 - Windows Build'
Write-Host '========================================='
Write-Host ''

function Require-Command($name) {
  if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
    throw "$name wurde nicht gefunden. Bitte Node.js 20+ installieren und das Terminal neu starten."
  }
}

Require-Command node
Require-Command npm

$nodeMajor = [int]((node -p "process.versions.node.split('.')[0]").Trim())
if ($nodeMajor -lt 20) { throw "Node.js 20+ erforderlich. Gefunden: $(node --version)" }

Write-Host "Node: $(node --version)"
Write-Host "npm : $(npm --version)"
Write-Host ''

Write-Host '[1/4] Prüfe Source ...'
npm run preflight
if ($LASTEXITCODE -ne 0) { throw "Preflight fehlgeschlagen (ExitCode $LASTEXITCODE)." }

Write-Host '[2/4] Installiere Dependencies ...'
$lockfile = Join-Path $PSScriptRoot 'package-lock.json'
if (Test-Path $lockfile) {
  Write-Host 'package-lock.json gefunden -> npm ci'
  npm ci --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw "npm ci fehlgeschlagen (ExitCode $LASTEXITCODE)." }
} else {
  # Older source bundles were shipped without a lockfile. npm ci cannot run in
  # that state, so create a lockfile with a normal install and continue.
  Write-Host 'package-lock.json fehlt -> verwende npm install und erzeuge den Lockfile.' -ForegroundColor Yellow
  npm install --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw "npm install fehlgeschlagen (ExitCode $LASTEXITCODE)." }
  if (-not (Test-Path $lockfile)) {
    throw "npm install wurde ausgefuehrt, aber package-lock.json wurde nicht erzeugt."
  }
}

# electron-builder expects this NSIS helper to be present inside app-builder-lib.
# Some npm/node_modules states can leave the package incomplete even though the dependency install succeeds.
$stdUtils = Join-Path $PSScriptRoot 'node_modules\app-builder-lib\templates\nsis\include\StdUtils.nsh'
if (-not (Test-Path $stdUtils)) {
  Write-Host 'NSIS helper StdUtils.nsh fehlt. Repariere app-builder-lib ...' -ForegroundColor Yellow
  npm install --no-save --no-audit --no-fund --ignore-scripts --prefer-online 'app-builder-lib@26.15.3'
  if ($LASTEXITCODE -ne 0) { throw "Reparatur von app-builder-lib fehlgeschlagen (ExitCode $LASTEXITCODE)." }
}
if (-not (Test-Path $stdUtils)) {
  throw "NSIS-Abhängigkeit unvollständig: StdUtils.nsh fehlt weiterhin unter $stdUtils"
}
Write-Host 'NSIS-Abhängigkeit OK: StdUtils.nsh vorhanden.' -ForegroundColor Green

Write-Host '[3/4] Baue React/Vite ...'
npm run build
if ($LASTEXITCODE -ne 0) { throw "Vite-Build fehlgeschlagen (ExitCode $LASTEXITCODE). Installer wird nicht gebaut." }

Write-Host '[4/4] Erzeuge Electron/NSIS Installer ...'
npx electron-builder --win nsis
if ($LASTEXITCODE -ne 0) { throw "Electron/NSIS-Build fehlgeschlagen (ExitCode $LASTEXITCODE)." }

$installer = Join-Path $PSScriptRoot 'dist-installer\COD4X-CONTROL-Setup-4.18.14-x64.exe'
if (-not (Test-Path $installer)) {
  throw "Build beendet, aber erwartete EXE wurde nicht gefunden: $installer"
}

Write-Host ''
Write-Host 'BUILD ERFOLGREICH' -ForegroundColor Green
Write-Host "Installer: $installer"
