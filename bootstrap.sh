#!/usr/bin/env bash
# Proxy-Max bootstrap (macOS / Linux).
# Resolves Node, npm, and the Anthropic CLI with or without admin rights,
# then starts the proxy server + UI. Re-runnable, idempotent.

set -e
HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)"
cd "$HERE"

PROXY_HOME="${PROXY_MAX_HOME:-$HOME/.proxy-max}"
NODE_DIR="$PROXY_HOME/node"
NPM_PREFIX="$PROXY_HOME/npm-global"
mkdir -p "$PROXY_HOME" "$NPM_PREFIX"

# Add likely Node locations to PATH so `command -v` finds them even if shell rc didn't.
export PATH="$NPM_PREFIX/bin:$NODE_DIR/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

is_admin() { [ "$(id -u)" = "0" ] || sudo -n true 2>/dev/null; }

ensure_node() {
  if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
    echo "[bootstrap] node : $(command -v node) ($(node -v))"
    echo "[bootstrap] npm  : $(command -v npm)"
    return
  fi

  echo "[bootstrap] node/npm not found, installing…"
  if [ "$(uname)" = "Darwin" ] && command -v brew >/dev/null 2>&1; then
    brew install node && return
  fi

  if command -v apt-get >/dev/null 2>&1 && is_admin; then
    sudo apt-get update -y && sudo apt-get install -y nodejs npm && return || true
  fi
  if command -v dnf >/dev/null 2>&1 && is_admin; then
    sudo dnf install -y nodejs npm && return || true
  fi
  if command -v pacman >/dev/null 2>&1 && is_admin; then
    sudo pacman -Sy --noconfirm nodejs npm && return || true
  fi

  # Portable fallback (no admin): download official Node tarball into ~/.proxy-max/node
  echo "[bootstrap] no package manager / no admin → installing portable Node"
  local plat="linux"; [ "$(uname)" = "Darwin" ] && plat="darwin"
  local arch
  case "$(uname -m)" in
    arm64|aarch64) arch="arm64" ;;
    x86_64|amd64)  arch="x64" ;;
    *) echo "Unsupported arch $(uname -m)"; exit 1 ;;
  esac
  local ver="v20.18.0"
  local tarball="node-$ver-$plat-$arch.tar.gz"
  curl -fsSL "https://nodejs.org/dist/$ver/$tarball" -o "$PROXY_HOME/$tarball"
  rm -rf "$NODE_DIR" && mkdir -p "$NODE_DIR"
  tar -xzf "$PROXY_HOME/$tarball" -C "$NODE_DIR" --strip-components=1
  rm "$PROXY_HOME/$tarball"
  export PATH="$NODE_DIR/bin:$PATH"
  echo "[bootstrap] portable node at $NODE_DIR"
}

ensure_claude() {
  if command -v claude >/dev/null 2>&1; then
    echo "[bootstrap] claude: $(command -v claude)"
    return
  fi
  echo "[bootstrap] installing @anthropic-ai/claude-code…"
  if is_admin; then
    sudo -E npm install -g @anthropic-ai/claude-code 2>/dev/null \
      || npm install -g @anthropic-ai/claude-code 2>/dev/null || true
    if command -v claude >/dev/null 2>&1; then return; fi
  fi
  # Per-user prefix, no admin required.
  npm_config_prefix="$NPM_PREFIX" npm install -g @anthropic-ai/claude-code
  export PATH="$NPM_PREFIX/bin:$PATH"
}

ensure_node
ensure_claude

PORT="${PORT:-8787}"
HOST="${HOST:-127.0.0.1}"

# If the proxy is already running on PORT, just open the UI / launch claude.
if ! curl -fs "http://$HOST:$PORT/api/health" >/dev/null 2>&1; then
  echo "[bootstrap] starting proxy on http://$HOST:$PORT"
  ( PORT="$PORT" HOST="$HOST" nohup node "$HERE/src/server.js" >"$PROXY_HOME/server.log" 2>&1 & )
  # wait until ready
  for i in $(seq 1 40); do
    sleep 0.15
    curl -fs "http://$HOST:$PORT/api/health" >/dev/null 2>&1 && break
  done
fi

echo
echo "  UI:        http://$HOST:$PORT/"
echo "  Configure your provider, then run claude with:"
echo "    ANTHROPIC_BASE_URL=http://$HOST:$PORT ANTHROPIC_AUTH_TOKEN=proxy-max ANTHROPIC_API_KEY=proxy-max claude --dangerously-skip-permissions"
echo

# If invoked with `--claude` (or any args), exec into claude immediately.
if [ "$1" = "--claude" ] || [ -n "$1" ]; then
  shift_args=("$@"); [ "$1" = "--claude" ] && shift_args=("${@:2}")
  ANTHROPIC_BASE_URL="http://$HOST:$PORT" \
  ANTHROPIC_AUTH_TOKEN="${ANTHROPIC_AUTH_TOKEN:-proxy-max}" \
  ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-${ANTHROPIC_AUTH_TOKEN:-proxy-max}}" \
  exec claude --dangerously-skip-permissions "${shift_args[@]}"
fi
