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

$alive = $false
try { Invoke-WebRequest -Uri "http://${Host_}:${Port}/api/health" -TimeoutSec 1 -UseBasicParsing | Out-Null; $alive = $true } catch {}
if (-not $alive) {
  Write-Host "[bootstrap] starting proxy on http://${Host_}:${Port}"
  $env:PORT = $Port; $env:HOST = $Host_
  # PROXY_INSECURE=1 bypasses TLS cert verification — needed on networks with SSL inspection
  # (corporate proxies that inject a self-signed cert, causing SELF_SIGNED_CERT_IN_CHAIN errors).
  # Set $env:PROXY_INSECURE = "1" before running bootstrap.ps1 to enable.
  if ($env:PROXY_INSECURE) { $env:PROXY_INSECURE = $env:PROXY_INSECURE }
  Start-Process -WindowStyle Hidden -FilePath "node" -ArgumentList "$Here\src\server.js" `
    -RedirectStandardOutput (Join-Path $ProxyHome "server.log") `
    -RedirectStandardError  (Join-Path $ProxyHome "server.err.log")
  for ($i=0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 150
    try { Invoke-WebRequest -Uri "http://${Host_}:${Port}/api/health" -TimeoutSec 1 -UseBasicParsing | Out-Null; break } catch {}
  }
}

Write-Host ""
Write-Host "  UI:        http://${Host_}:${Port}/"
Write-Host "  Configure your provider, then run:"
Write-Host "    `$env:ANTHROPIC_BASE_URL = 'http://${Host_}:${Port}'"
Write-Host "    `$env:ANTHROPIC_AUTH_TOKEN = 'proxy-max'"
Write-Host "    `$env:ANTHROPIC_API_KEY = 'proxy-max'"
Write-Host "    claude --dangerously-skip-permissions"
Write-Host ""
Write-Host "  TIP: If you get 'fetch failed' / SELF_SIGNED_CERT_IN_CHAIN (corporate SSL proxy):"
Write-Host "    `$env:PROXY_INSECURE = '1'; .\bootstrap.ps1"
Write-Host ""

if ($args.Count -gt 0 -and ($args[0] -eq "--claude" -or $args[0])) {
  $env:ANTHROPIC_BASE_URL = "http://${Host_}:${Port}"
  if (-not $env:ANTHROPIC_AUTH_TOKEN) { $env:ANTHROPIC_AUTH_TOKEN = "proxy-max" }
  if (-not $env:ANTHROPIC_API_KEY) { $env:ANTHROPIC_API_KEY = $env:ANTHROPIC_AUTH_TOKEN }
  $rest = if ($args[0] -eq "--claude") { $args[1..($args.Count-1)] } else { $args }
  & claude --dangerously-skip-permissions @rest
}
