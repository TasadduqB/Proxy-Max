# Proxy-Max bootstrap (Windows PowerShell).
# Resolves Node, npm, and the Anthropic CLI with or without admin rights,
# then starts the proxy server. Re-runnable.

$ErrorActionPreference = "Stop"
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Here

$ProxyHome = if ($env:PROXY_MAX_HOME) { $env:PROXY_MAX_HOME } else { Join-Path $env:USERPROFILE ".proxy-max" }
$NodeDir   = Join-Path $ProxyHome "node"
$NpmPrefix = Join-Path $ProxyHome "npm-global"
New-Item -ItemType Directory -Force -Path $ProxyHome,$NpmPrefix | Out-Null

$env:Path = "$NpmPrefix;$NodeDir;$NodeDir\bin;$env:LOCALAPPDATA\Programs\nodejs;$env:APPDATA\npm;$env:Path"

function Test-Admin {
  try { ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator) } catch { $false }
}

function Ensure-Node {
  if ((Get-Command node -ErrorAction SilentlyContinue) -and (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Host "[bootstrap] node: $((Get-Command node).Source)"
    Write-Host "[bootstrap] npm : $((Get-Command npm).Source)"
    return
  }
  Write-Host "[bootstrap] installing Node…"
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    try { winget install -e --id OpenJS.NodeJS.LTS --silent --accept-source-agreements --accept-package-agreements } catch {}
    if (Get-Command node -ErrorAction SilentlyContinue) { return }
  }
  # Portable fallback: download Node ZIP into $NodeDir
  $ver  = "v20.18.0"
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "x64" }
  $zip  = "node-$ver-win-$arch.zip"
  $url  = "https://nodejs.org/dist/$ver/$zip"
  $tmp  = Join-Path $ProxyHome $zip
  Write-Host "[bootstrap] downloading $url"
  Invoke-WebRequest -Uri $url -OutFile $tmp
  if (Test-Path $NodeDir) { Remove-Item -Recurse -Force $NodeDir }
  $extract = Join-Path $ProxyHome "node-extract"
  if (Test-Path $extract) { Remove-Item -Recurse -Force $extract }
  Expand-Archive -Path $tmp -DestinationPath $extract -Force
  $inner = Get-ChildItem $extract | Where-Object { $_.Name -like "node-*" } | Select-Object -First 1
  Move-Item $inner.FullName $NodeDir
  Remove-Item $tmp,$extract -Recurse -Force
  $env:Path = "$NodeDir;$env:Path"
}

function Ensure-Claude {
  if (Get-Command claude -ErrorAction SilentlyContinue) {
    Write-Host "[bootstrap] claude: $((Get-Command claude).Source)"
    return
  }
  Write-Host "[bootstrap] installing @anthropic-ai/claude-code…"
  if (Test-Admin) {
    try { npm install -g @anthropic-ai/claude-code } catch {}
    if (Get-Command claude -ErrorAction SilentlyContinue) { return }
  }
  $env:npm_config_prefix = $NpmPrefix
  npm install -g @anthropic-ai/claude-code
  $env:Path = "$NpmPrefix;$env:Path"
}

Ensure-Node
Ensure-Claude

$Port = if ($env:PORT) { $env:PORT } else { "8787" }
$Host_ = if ($env:HOST) { $env:HOST } else { "127.0.0.1" }

function Start-Proxy {
  param([string]$Insecure = "")
  # Kill any existing proxy on this port
  $existing = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
              Select-Object -ExpandProperty OwningProcess -ErrorAction SilentlyContinue
  if ($existing) {
    Write-Host "[bootstrap] stopping existing proxy (PID $existing)…"
    Stop-Process -Id $existing -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 600
  }
  Write-Host "[bootstrap] starting proxy on http://${Host_}:${Port}$(if ($Insecure) { ' [PROXY_INSECURE=1]' })"
  $env:PORT = $Port; $env:HOST = $Host_
  if ($Insecure) { $env:PROXY_INSECURE = "1" } else { Remove-Item Env:PROXY_INSECURE -ErrorAction SilentlyContinue }
  Start-Process -WindowStyle Hidden -FilePath "node" -ArgumentList "$Here\src\server.js" `
    -RedirectStandardOutput (Join-Path $ProxyHome "server.log") `
    -RedirectStandardError  (Join-Path $ProxyHome "server.err.log")
  Write-Host "[bootstrap] waiting for proxy…" -NoNewline
  for ($i=0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 200
    try { Invoke-WebRequest -Uri "http://${Host_}:${Port}/api/health" -TimeoutSec 1 -UseBasicParsing | Out-Null; Write-Host " ready."; return } catch {}
    Write-Host "." -NoNewline
  }
  Write-Host " timeout."
}

$alive = $false
try { Invoke-WebRequest -Uri "http://${Host_}:${Port}/api/health" -TimeoutSec 1 -UseBasicParsing | Out-Null; $alive = $true } catch {}
if (-not $alive) { Start-Proxy }

$BaseUrl = "http://${Host_}:${Port}"

Write-Host ""
Write-Host "  Proxy-Max is running at $BaseUrl"
Write-Host ""
Write-Host "  What would you like to do?"
Write-Host ""
Write-Host "  [1] Open UI in browser"
Write-Host "  [2] Launch claude"
Write-Host "  [3] Hard restart proxy  (pick up code changes / clear stuck state)"
Write-Host "  [4] Hard restart proxy with PROXY_INSECURE=1  (fix: fetch failed / SSL cert error)"
Write-Host "  [5] Exit"
Write-Host ""

$choice = Read-Host "  Enter choice (1-5)"

function Set-ClaudeEnv {
  $env:ANTHROPIC_BASE_URL   = $BaseUrl
  $env:ANTHROPIC_AUTH_TOKEN = if ($env:ANTHROPIC_AUTH_TOKEN) { $env:ANTHROPIC_AUTH_TOKEN } else { "proxy-max" }
  $env:ANTHROPIC_API_KEY    = if ($env:ANTHROPIC_API_KEY)    { $env:ANTHROPIC_API_KEY }    else { $env:ANTHROPIC_AUTH_TOKEN }
}

switch ($choice.Trim()) {
  "1" {
    Start-Process $BaseUrl
    Write-Host "  Opened $BaseUrl in your browser."
  }
  "2" {
    Set-ClaudeEnv
    Write-Host "  Starting claude…"
    & claude --dangerously-skip-permissions
  }
  "3" {
    Write-Host "  Hard restarting proxy…"
    Start-Proxy
    Write-Host "  Proxy restarted. Open $BaseUrl to configure."
    Start-Process $BaseUrl
  }
  "4" {
    Write-Host "  Hard restarting proxy with PROXY_INSECURE=1…"
    Start-Proxy -Insecure "1"
    Set-ClaudeEnv
    Write-Host "  Starting claude…"
    & claude --dangerously-skip-permissions
  }
  "5" {
    Write-Host "  Proxy is still running at $BaseUrl. Goodbye."
  }
  default {
    Write-Host "  Invalid choice. Proxy is running at $BaseUrl"
  }
}
