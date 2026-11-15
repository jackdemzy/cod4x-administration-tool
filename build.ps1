# COD4X CONTROL: robust Windows build
# Uses npm ci when a lockfile is present; otherwise creates one with npm install.
$ErrorActionPreference = 'Stop'
# Keep PowerShell 5/7 console output UTF-8 so German status text renders correctly.
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
Set-Location $PSScriptRoot

Write-Host ''
Write-Host '========================================='
Write-Host ' COD4X CONTROL 4.18.31 - Windows Build'
Write-Host '========================================='
Write-Host ''

function Require-Command($name) {
  if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
    throw "$name was not found. Install Node.js 22.12+ (24 LTS recommended) and restart the terminal."
  }
}

Require-Command node
Require-Command npm

# Electron 45 needs Node.js >= 22.12 to install; Node 20 is end-of-life since 2026-04-30.
$nodeOk = (node -p "const [a,b]=process.versions.node.split('.').map(Number); a>22||(a===22&&b>=12)").Trim()
if ($nodeOk -ne 'true') { throw "Node.js 22.12+ required (24 LTS recommended). Found: $(node --version)" }

Write-Host "Node: $(node --version)"
Write-Host "npm : $(npm --version)"
Write-Host ''

# Dependencies come first: the preflight runs the test suite, and those tests import
# npm packages (tar, express, ssh2). On a fresh source folder they are not there yet.
Write-Host '[1/5] Installing dependencies ...'
$lockfile = Join-Path $PSScriptRoot 'package-lock.json'
if (Test-Path $lockfile) {
  Write-Host 'package-lock.json found -> npm ci'
  npm ci --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw "npm ci failed (exit code $LASTEXITCODE)." }
} else {
  # Older source bundles were shipped without a lockfile. npm ci cannot run in
  # that state, so create a lockfile with a normal install and continue.
  Write-Host 'package-lock.json missing -> using npm install and creating the lockfile.' -ForegroundColor Yellow
  npm install --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw "npm install failed (exit code $LASTEXITCODE)." }
  if (-not (Test-Path $lockfile)) {
    throw "npm install ran, but package-lock.json was not created."
  }
}

# electron-builder expects this NSIS helper to be present inside app-builder-lib.
# Some npm/node_modules states can leave the package incomplete even though the dependency install succeeds.
$stdUtils = Join-Path $PSScriptRoot 'node_modules\app-builder-lib\templates\nsis\include\StdUtils.nsh'
if (-not (Test-Path $stdUtils)) {
  Write-Host 'NSIS helper StdUtils.nsh missing. Repairing app-builder-lib ...' -ForegroundColor Yellow
  npm install --no-save --no-audit --no-fund --ignore-scripts --prefer-online 'app-builder-lib@26.15.3'
  if ($LASTEXITCODE -ne 0) { throw "Repairing app-builder-lib failed (exit code $LASTEXITCODE)." }
}
if (-not (Test-Path $stdUtils)) {
  throw "NSIS dependency incomplete: StdUtils.nsh still missing at $stdUtils"
}
Write-Host 'NSIS dependency OK: StdUtils.nsh present.' -ForegroundColor Green

Write-Host '[2/5] Checking source ...'
npm run preflight
if ($LASTEXITCODE -ne 0) { throw "Preflight failed (exit code $LASTEXITCODE)." }

Write-Host '[3/5] Building React/Vite ...'
npm run build
if ($LASTEXITCODE -ne 0) { throw "Vite build failed (exit code $LASTEXITCODE). The installer is not built." }

Write-Host '[4/5] Creating Electron/NSIS installer and portable EXE ...'
npx electron-builder --win nsis portable --publish never
if ($LASTEXITCODE -ne 0) { throw "Electron/NSIS build failed (exit code $LASTEXITCODE)." }

$installer = Join-Path $PSScriptRoot 'dist-installer\COD4X-CONTROL-Setup-4.18.31-x64.exe'
$portable = Join-Path $PSScriptRoot 'dist-installer\COD4X-CONTROL-Portable-4.18.31-x64.exe'
foreach ($artifact in @($installer, $portable)) {
  if (-not (Test-Path $artifact)) { throw "Build finished, but the expected EXE was not found: $artifact" }
}

# Block 23: SHA-256 and artifact verification (expected files, app.asar content), writes
# dist-installer\SHA256SUMS and dist-installer\release-manifest.json.
Write-Host '[5/5] Checking artifacts and writing SHA-256 ...'
node scripts/release-verify.mjs --platform win
if ($LASTEXITCODE -ne 0) { throw "Artifact check failed (exit code $LASTEXITCODE)." }

Write-Host ''
Write-Host 'BUILD SUCCEEDED' -ForegroundColor Green
Write-Host "Installer: $installer"
Write-Host "Portable : $portable"
Write-Host "SHA-256  : $(Join-Path $PSScriptRoot 'dist-installer\SHA256SUMS')"
