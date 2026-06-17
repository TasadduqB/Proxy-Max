# Proxy-Max Bootstrap (Windows PowerShell)
# First-run setup: detects admin, installs Node.js if needed, installs npm
# packages, auto-resolves paths, configures environment, and starts the proxy.
# Re-runnable — skips steps already satisfied.

$ErrorActionPreference = "Stop"
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Here

# ---- Configuration ----
$ProxyHome = if ($env:PROXY_MAX_HOME) { $env:PROXY_MAX_HOME } else { Join-Path $env:USERPROFILE ".proxy-max" }
$NodeDir   = Join-Path $ProxyHome "node"
$NpmPrefix = Join-Path $ProxyHome "npm-global"
$Port      = if ($env:PORT) { $env:PORT } else { "8787" }
$Host_     = if ($env:HOST) { $env:HOST } else { "127.0.0.1" }

New-Item -ItemType Directory -Force -Path $ProxyHome, $NpmPrefix | Out-Null

# Prepend known paths so we find locally installed tools
$env:Path = "$NpmPrefix;$NodeDir;$NodeDir\bin;$env:LOCALAPPDATA\Programs\nodejs;$env:ProgramFiles\nodejs;$env:APPDATA\npm;$env:Path"

# ---- Helpers ----
function Write-Step { param([string]$msg) Write-Host "`n  [*] $msg" -ForegroundColor Cyan }
function Write-Ok   { param([string]$msg) Write-Host "      $msg" -ForegroundColor Green }
function Write-Warn { param([string]$msg) Write-Host "      $msg" -ForegroundColor Yellow }
function Write-Err  { param([string]$msg) Write-Host "      $msg" -ForegroundColor Red }

function Test-Admin {
  try {
    ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
      [Security.Principal.WindowsBuiltinRole]::Administrator
    )
  } catch { $false }
}

# ---- Step 1: Detect privileges ----
Write-Host ""
Write-Host "  =============================================" -ForegroundColor Magenta
Write-Host "       Proxy-Max Bootstrap" -ForegroundColor White
Write-Host "  =============================================" -ForegroundColor Magenta

Write-Step "Checking privileges..."
$isAdmin = Test-Admin
if ($isAdmin) {
  Write-Ok "Running as Administrator"
} else {
  Write-Warn "Running as standard user (portable install mode)"
}

# ---- Step 2: Install Node.js ----
Write-Step "Checking Node.js..."

function Ensure-Node {
  # Check if node and npm already exist in PATH
  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  $npmCmd  = Get-Command npm -ErrorAction SilentlyContinue

  if ($nodeCmd -and $npmCmd) {
    $nodeVer = & node --version 2>$null
    $npmVer  = & npm --version 2>$null
    Write-Ok "Node.js $nodeVer (npm $npmVer) found at $($nodeCmd.Source)"
    return
  }

  Write-Warn "Node.js not found. Installing..."

  # Try winget first (admin or not, it can install per-user)
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    Write-Host "      Using winget..." -ForegroundColor Gray
    try {
      winget install -e --id OpenJS.NodeJS.LTS --silent --accept-source-agreements --accept-package-agreements 2>$null
      # Refresh path after winget install
      $env:Path = "$env:LOCALAPPDATA\Programs\nodejs;$env:ProgramFiles\nodejs;$env:Path"
      if (Get-Command node -ErrorAction SilentlyContinue) {
        Write-Ok "Node.js installed via winget"
        return
      }
    } catch {}
  }

  # Portable fallback: download Node ZIP
  $ver  = "v24.16.0"
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "x64" }
  $zip  = "node-$ver-win-$arch.zip"
  $url  = "https://nodejs.org/dist/$ver/$zip"
  $tmp  = Join-Path $ProxyHome $zip

  Write-Host "      Downloading portable Node.js $ver ($arch)..." -ForegroundColor Gray
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing

  if (Test-Path $NodeDir) { Remove-Item -Recurse -Force $NodeDir }
  $extract = Join-Path $ProxyHome "node-extract"
  if (Test-Path $extract) { Remove-Item -Recurse -Force $extract }
  Expand-Archive -Path $tmp -DestinationPath $extract -Force
  $inner = Get-ChildItem $extract | Where-Object { $_.Name -like "node-*" } | Select-Object -First 1
  Move-Item $inner.FullName $NodeDir
  Remove-Item $tmp, $extract -Recurse -Force
  $env:Path = "$NodeDir;$env:Path"
  Write-Ok "Node.js $ver installed (portable) at $NodeDir"
}

Ensure-Node

# ---- Step 3: Install project dependencies ----
Write-Step "Installing project dependencies..."

$nodeModules = Join-Path $Here "node_modules"
$pkgJson     = Join-Path $Here "package.json"

if (Test-Path $pkgJson) {
  # Always run npm install to ensure deps are current
  Push-Location $Here
  try {
    & npm install --production 2>&1 | ForEach-Object { Write-Host "      $_" -ForegroundColor Gray }
    if ($LASTEXITCODE -ne 0) {
      Write-Warn "npm install had warnings, attempting with --force..."
      & npm install --production --force 2>&1 | ForEach-Object { Write-Host "      $_" -ForegroundColor Gray }
    }
    Write-Ok "Dependencies installed"
  } catch {
    Write-Err "npm install failed: $_"
    Write-Warn "Try running manually: npm install"
  }
  Pop-Location
} else {
  Write-Err "package.json not found at $Here"
  exit 1
}

# ---- Step 4: Install Claude Code CLI (optional) ----
Write-Step "Checking Claude Code CLI..."

function Ensure-Claude {
  if (Get-Command claude -ErrorAction SilentlyContinue) {
    Write-Ok "claude CLI found at $((Get-Command claude).Source)"
    return
  }
  Write-Warn "Claude Code CLI not found. Installing @anthropic-ai/claude-code..."
  if ($isAdmin) {
    try {
      & npm install -g @anthropic-ai/claude-code 2>&1 | ForEach-Object { Write-Host "      $_" -ForegroundColor Gray }
      if (Get-Command claude -ErrorAction SilentlyContinue) { Write-Ok "claude CLI installed globally"; return }
    } catch {}
  }
  # Non-admin: install to custom prefix
  $env:npm_config_prefix = $NpmPrefix
  & npm install -g @anthropic-ai/claude-code 2>&1 | ForEach-Object { Write-Host "      $_" -ForegroundColor Gray }
  $env:Path = "$NpmPrefix;$env:Path"
  if (Get-Command claude -ErrorAction SilentlyContinue) {
    Write-Ok "claude CLI installed at $NpmPrefix"
  } else {
    Write-Warn "Could not install claude CLI (non-critical, proxy still works)"
  }
}

Ensure-Claude

# ---- Step 5: Auto-configure paths & environment ----
Write-Step "Configuring environment..."

$env:PORT = $Port
$env:HOST = $Host_
$BaseUrl  = "http://${Host_}:${Port}"

# Set ANTHROPIC_BASE_URL so any Claude Code session points at us
$env:ANTHROPIC_BASE_URL = $BaseUrl
if (-not $env:ANTHROPIC_AUTH_TOKEN) { $env:ANTHROPIC_AUTH_TOKEN = "proxy-max" }
if (-not $env:ANTHROPIC_API_KEY)    { $env:ANTHROPIC_API_KEY = $env:ANTHROPIC_AUTH_TOKEN }

Write-Ok "ANTHROPIC_BASE_URL = $BaseUrl"
Write-Ok "PORT = $Port | HOST = $Host_"
Write-Ok "Logs: $ProxyHome\server.log"

# ---- Step 6: Start proxy ----
Write-Step "Starting Proxy-Max..."

function Start-Proxy {
  param([string]$Insecure = "")

  # Kill any existing proxy on this port
  $existing = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
              Select-Object -ExpandProperty OwningProcess -ErrorAction SilentlyContinue
  if ($existing) {
    Write-Host "      Stopping existing process (PID $existing)..." -ForegroundColor Gray
    Stop-Process -Id $existing -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 600
  }

  if ($Insecure) { $env:PROXY_INSECURE = "1" } else { Remove-Item Env:PROXY_INSECURE -ErrorAction SilentlyContinue }

  Start-Process -WindowStyle Hidden -FilePath "node" -ArgumentList "$Here\src\server.js" `
    -RedirectStandardOutput (Join-Path $ProxyHome "server.log") `
    -RedirectStandardError  (Join-Path $ProxyHome "server.err.log")

  Write-Host "      Waiting for proxy..." -NoNewline -ForegroundColor Gray
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 250
    try {
      Invoke-WebRequest -Uri "$BaseUrl/api/health" -TimeoutSec 1 -UseBasicParsing | Out-Null
      Write-Host " ready!" -ForegroundColor Green
      return $true
    } catch {}
    Write-Host "." -NoNewline
  }
  Write-Host ""
  Write-Err "Proxy failed to start. Check $ProxyHome\server.err.log"
  return $false
}

# Check if already running
$alive = $false
try { Invoke-WebRequest -Uri "$BaseUrl/api/health" -TimeoutSec 1 -UseBasicParsing | Out-Null; $alive = $true } catch {}

if ($alive) {
  Write-Ok "Proxy already running at $BaseUrl"
} else {
  $started = Start-Proxy
  if (-not $started) { exit 1 }
}

# ---- Step 7: Ready ----
Write-Host ""
Write-Host "  =============================================" -ForegroundColor Green
Write-Host "       Proxy-Max is READY" -ForegroundColor White
Write-Host "       $BaseUrl" -ForegroundColor White
Write-Host "  =============================================" -ForegroundColor Green
Write-Host ""
Write-Host "  What would you like to do?" -ForegroundColor White
Write-Host ""
Write-Host "  [1] Open dashboard in browser"
Write-Host "  [2] Launch claude (with proxy)"
Write-Host "  [3] Restart proxy"
Write-Host "  [4] Restart proxy with PROXY_INSECURE=1 (fix SSL errors)"
Write-Host "  [5] Exit (proxy keeps running)"
Write-Host ""

$choice = Read-Host "  Enter choice (1-5)"

switch ($choice.Trim()) {
  "1" {
    Start-Process $BaseUrl
    Write-Host "`n  Opened $BaseUrl in your browser." -ForegroundColor Green
  }
  "2" {
    Write-Host "`n  Starting claude..." -ForegroundColor Cyan
    & claude --dangerously-skip-permissions
  }
  "3" {
    Write-Host "`n  Restarting proxy..." -ForegroundColor Cyan
    Start-Proxy
    Start-Process $BaseUrl
  }
  "4" {
    Write-Host "`n  Restarting proxy (insecure mode)..." -ForegroundColor Cyan
    Start-Proxy -Insecure "1"
    Write-Host "  Starting claude..." -ForegroundColor Cyan
    & claude --dangerously-skip-permissions
  }
  "5" {
    Write-Host "`n  Proxy is running at $BaseUrl. Goodbye." -ForegroundColor Green
  }
  default {
    Write-Host "`n  Proxy running at $BaseUrl. Use 'claude' to start coding." -ForegroundColor Green
  }
}
