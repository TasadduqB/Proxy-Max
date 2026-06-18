// Smart installer / doctor.
// Goals:
//   * Find node, npm, claude even if PATH / env vars are unset.
//   * Install the Anthropic CLI (`@anthropic-ai/claude-code`) globally if possible,
//     otherwise into a per-user prefix that needs no admin rights.
//   * If npm / node are missing entirely, can fetch a portable Node tarball
//     into ~/.proxy-max/node and use it (no admin required).
//
// Usage:
//   node src/install.js           -> ensure everything is ready
//   node src/install.js --doctor  -> just diagnose, don't install
//   node src/install.js --node-only / --claude-only

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync, execSync } = require('child_process');
const https = require('https');
const zlib = require('zlib');

const HOME = os.homedir();
const ROOT = path.join(HOME, '.proxy-max');
const NODE_DIR = path.join(ROOT, 'node');
const NPM_PREFIX = path.join(ROOT, 'npm-global');
fs.mkdirSync(ROOT, { recursive: true });
fs.mkdirSync(NPM_PREFIX, { recursive: true });

const isWin = process.platform === 'win32';
const EXE = isWin ? '.exe' : '';
const CMD = isWin ? '.cmd' : '';

function log(msg) { process.stdout.write(`[install] ${msg}\n`); }
function warn(msg) { process.stderr.write(`[install] ! ${msg}\n`); }

function which(cmd) {
  // Try PATH first.
  const paths = (process.env.PATH || '').split(path.delimiter);
  // Plus a list of common install locations on every OS.
  const extra = [
    '/usr/local/bin', '/usr/bin', '/opt/homebrew/bin', '/home/linuxbrew/.linuxbrew/bin',
    path.join(HOME, '.nvm/versions/node'),
    path.join(HOME, '.volta/bin'),
    path.join(HOME, '.fnm'),
    path.join(HOME, '.local/bin'),
    // Windows — standard npm global (Roaming)
    path.join(HOME, 'AppData', 'Roaming', 'npm'),
    // Windows — alternative npm global (Local)
    path.join(HOME, 'AppData', 'Local', 'npm'),
    // Windows — Node.js installer default locations
    path.join(HOME, 'AppData', 'Local', 'Programs', 'nodejs'),
    'C:\\Program Files\\nodejs',
    'C:\\Program Files (x86)\\nodejs',
    // Windows — nvm-windows: NVM_HOME env var or default location
    process.env.NVM_HOME || path.join(HOME, 'AppData', 'Roaming', 'nvm'),
    // Windows — Scoop package manager
    path.join(HOME, 'scoop', 'shims'),
    path.join(HOME, 'scoop', 'apps', 'nodejs', 'current'),
    // Windows — Chocolatey
    'C:\\tools\\nodejs',
    'C:\\ProgramData\\chocolatey\\bin',
    // Windows — WinGet NodeJS typically ends up via system PATH, but fallback:
    'C:\\Program Files\\nodejs',
    // Our portable Node and npm prefix
    path.join(NODE_DIR, 'bin'),
    NODE_DIR,
    path.join(NPM_PREFIX, 'bin'),
    NPM_PREFIX
  ];
  const candidates = [...paths, ...extra];
  // On Windows, npm installs CLIs as .cmd AND .ps1 wrappers alongside the shell script.
  const exts = isWin ? [EXE, CMD, '.ps1', '.bat', ''] : [''];
  for (const dir of candidates) {
    if (!dir) continue;
    for (const ext of exts) {
      const full = path.join(dir, cmd + ext);
      try { if (fs.statSync(full).isFile()) return full; } catch {}
    }
    // nvm-style nested versions/<v>/bin (Unix nvm)
    if (dir.endsWith('versions/node') || dir.endsWith('versions\\node')) {
      try {
        for (const v of fs.readdirSync(dir)) {
          for (const ext of exts) {
            const full = path.join(dir, v, isWin ? '' : 'bin', cmd + ext);
            try { if (fs.statSync(full).isFile()) return full; } catch {}
          }
        }
      } catch {}
    }
    // nvm-windows: Roaming\nvm\v<version> (each version dir is the bin dir)
    if (isWin && (dir === (process.env.NVM_HOME || path.join(HOME, 'AppData', 'Roaming', 'nvm')))) {
      try {
        for (const v of fs.readdirSync(dir)) {
          if (!v.startsWith('v')) continue;
          for (const ext of exts) {
            const full = path.join(dir, v, cmd + ext);
            try { if (fs.statSync(full).isFile()) return full; } catch {}
          }
        }
      } catch {}
    }
  }
  return null;
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: false, ...opts });
  return r.status === 0;
}

function tryRun(cmd, args, opts = {}) {
  try {
    const r = spawnSync(cmd, args, { stdio: 'pipe', encoding: 'utf8', shell: false, ...opts });
    return { ok: r.status === 0, out: (r.stdout || '') + (r.stderr || '') };
  } catch (e) { return { ok: false, out: String(e.message) }; }
}

function isAdmin() {
  if (isWin) {
    const r = tryRun('net', ['session']);
    return r.ok;
  }
  return process.getuid && process.getuid() === 0;
}

// ---- Node detection / portable install ----

function detectNode() {
  // process.execPath is the running node, always valid.
  const node = process.execPath;
  let npm = which('npm');
  if (!npm) {
    // npm usually lives next to node
    const sib = path.join(path.dirname(node), 'npm' + (isWin ? '.cmd' : ''));
    if (fs.existsSync(sib)) npm = sib;
  }
  return { node, npm };
}

async function downloadPortableNode() {
  // v22 LTS (Active LTS) ships the built-in `node:sqlite` module used for the
  // persistent cache + analytics — no native compilation required.
  const version = 'v22.15.0';
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const platform = process.platform === 'darwin' ? 'darwin'
    : process.platform === 'linux' ? 'linux'
    : process.platform === 'win32' ? 'win'
    : null;
  if (!platform) throw new Error('Unsupported platform for portable Node: ' + process.platform);

  const ext = platform === 'win' ? 'zip' : 'tar.gz';
  const fileName = `node-${version}-${platform}-${arch}.${ext}`;
  const urlStr = `https://nodejs.org/dist/${version}/${fileName}`;
  log(`Downloading portable Node ${version} (${platform}-${arch})…`);
  const dest = path.join(ROOT, fileName);
  await downloadFile(urlStr, dest);

  if (ext === 'tar.gz') {
    fs.mkdirSync(NODE_DIR, { recursive: true });
    run('tar', ['-xzf', dest, '-C', NODE_DIR, '--strip-components=1']);
  } else {
    // Windows: try PowerShell Expand-Archive
    const tmpExtract = path.join(ROOT, 'node-extract');
    fs.mkdirSync(tmpExtract, { recursive: true });
    run('powershell', ['-NoProfile', '-Command',
      `Expand-Archive -Force -Path '${dest}' -DestinationPath '${tmpExtract}'`]);
    const inner = fs.readdirSync(tmpExtract).find(n => n.startsWith('node-'));
    if (inner) {
      // Move contents up
      fs.rmSync(NODE_DIR, { recursive: true, force: true });
      fs.renameSync(path.join(tmpExtract, inner), NODE_DIR);
    }
  }
  fs.unlinkSync(dest);
  log(`Portable Node installed at ${NODE_DIR}`);
}

function downloadFile(urlStr, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(urlStr, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close(); fs.unlinkSync(dest);
        return downloadFile(res.headers.location, dest).then(resolve, reject);
      }
      if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode + ' for ' + urlStr));
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', reject);
  });
}

function ensureNode() {
  let { node, npm } = detectNode();
  if (node && npm) return { node, npm };
  // Try OS package managers (with admin if available)
  if (process.platform === 'darwin' && which('brew')) {
    log('Installing node via Homebrew…');
    if (run('brew', ['install', 'node'])) return detectNode();
  }
  if (process.platform === 'linux') {
    if (isAdmin() && which('apt-get')) {
      log('Installing node via apt-get…');
      run('apt-get', ['update']);
      if (run('apt-get', ['install', '-y', 'nodejs', 'npm'])) return detectNode();
    } else if (isAdmin() && which('dnf')) {
      if (run('dnf', ['install', '-y', 'nodejs', 'npm'])) return detectNode();
    } else if (isAdmin() && which('pacman')) {
      if (run('pacman', ['-Sy', '--noconfirm', 'nodejs', 'npm'])) return detectNode();
    }
  }
  if (isWin && which('winget')) {
    log('Installing node via winget…');
    if (run('winget', ['install', '-e', '--id', 'OpenJS.NodeJS.LTS', '--silent'])) return detectNode();
  }
  // Fall back to portable.
  return downloadPortableNode().then(() => {
    const portableNode = path.join(NODE_DIR, isWin ? 'node.exe' : 'bin/node');
    const portableNpm = path.join(NODE_DIR, isWin ? 'npm.cmd' : 'bin/npm');
    return { node: portableNode, npm: portableNpm };
  });
}

// ---- Anthropic CLI ----

// Query npm's actual configured global prefix (may differ from our NPM_PREFIX).
function getNpmGlobalBinDir(npmBin) {
  if (!npmBin) return null;
  try {
    const r = spawnSync(npmBin, ['config', 'get', 'prefix'],
      { encoding: 'utf8', stdio: 'pipe', timeout: 6000, shell: isWin });
    const prefix = (r.stdout || '').trim();
    if (r.status === 0 && prefix && prefix !== 'undefined') {
      return isWin ? prefix : path.join(prefix, 'bin');
    }
  } catch {}
  return null;
}

function detectClaude(npmBin) {
  // 1. Check every directory in PATH + well-known locations (includes .cmd / .ps1 on Windows).
  const direct = which('claude');
  if (direct) return direct;

  // 2. Our own per-user npm prefix.
  const winExts = ['.cmd', '.ps1', '.bat', ''];
  for (const ext of isWin ? winExts : ['']) {
    const local = path.join(NPM_PREFIX, isWin ? ('claude' + ext) : 'bin/claude');
    if (fs.existsSync(local)) return local;
  }

  // 3. Dynamically ask npm where it actually installs global binaries.
  //    This catches non-default prefixes set via `npm config set prefix`.
  if (npmBin || (npmBin = which('npm'))) {
    const binDir = getNpmGlobalBinDir(npmBin);
    if (binDir) {
      for (const ext of isWin ? winExts : ['']) {
        const f = path.join(binDir, 'claude' + ext);
        try { if (fs.statSync(f).isFile()) return f; } catch {}
      }
    }
  }

  return null;
}

function detectPython() {
  // Prefer versioned 3.10+ binaries (needed by Claude Code security-guidance hooks).
  for (const bin of ['python3.14','python3.13','python3.12','python3.11','python3.10']) {
    const p = which(bin); if (p) return p;
  }
  // Fall back to unversioned — check if it's actually 3.10+.
  for (const bin of ['python3','python']) {
    const p = which(bin);
    if (!p) continue;
    try {
      const r = spawnSync(p, ['-c', 'import sys; print(sys.version_info[:2])'], { encoding:'utf8', stdio:'pipe' });
      const m = (r.stdout||'').match(/\((\d+),\s*(\d+)/);
      if (m && (parseInt(m[1]) > 3 || (parseInt(m[1]) === 3 && parseInt(m[2]) >= 10))) return p;
    } catch {}
  }
  return null;
}

async function ensurePython() {
  if (detectPython()) return;
  log('Python 3.10+ not found — installing…');
  if (process.platform === 'darwin') {
    if (which('brew')) {
      run('brew', ['install', 'python@3.13']);
      if (detectPython()) { log('Python installed via Homebrew.'); return; }
    }
  } else if (process.platform === 'linux') {
    // Try to add deadsnakes PPA on Ubuntu/Debian for a newer python if needed.
    if (isAdmin() && which('apt-get')) {
      run('apt-get', ['update', '-qq']);
      // Try python3.12 first, fall back to python3.11 / python3.10.
      for (const pkg of ['python3.12','python3.11','python3.10','python3']) {
        if (run('apt-get', ['install', '-y', '-qq', pkg])) {
          if (detectPython()) { log(`Python installed via apt-get (${pkg}).`); return; }
        }
      }
    } else if (isAdmin() && which('dnf')) {
      run('dnf', ['install', '-y', 'python3.12']) || run('dnf', ['install', '-y', 'python3']);
      if (detectPython()) { log('Python installed via dnf.'); return; }
    } else if (isAdmin() && which('yum')) {
      run('yum', ['install', '-y', 'python3']);
      if (detectPython()) { log('Python installed via yum.'); return; }
    } else if (isAdmin() && which('pacman')) {
      run('pacman', ['-Sy', '--noconfirm', 'python']);
      if (detectPython()) { log('Python installed via pacman.'); return; }
    }
  }
  warn('Could not auto-install Python 3.10+. Claude Code hooks that need Python will show a non-blocking warning.');
  warn('Fix: brew install python@3.13  (macOS)  or  sudo apt-get install python3.12  (Linux)');
}

function symlinkPythonForHooks() {
  // Claude Code hooks run in a minimal PATH. Symlink the best python3 we can find
  // into /usr/local/bin so hooks always resolve it without Homebrew in PATH.
  if (isWin) return;
  const p = detectPython();
  if (!p) return;
  const target = '/usr/local/bin/python3';
  try {
    const existing = fs.existsSync(target) ? fs.realpathSync(target) : null;
    if (existing === fs.realpathSync(p)) return; // already correct
    if (!existing || existing !== p) {
      try { fs.unlinkSync(target); } catch {}
      fs.symlinkSync(p, target);
      log(`Symlinked ${p} → ${target} (for Claude Code hooks)`);
    }
  } catch {
    // No write permission to /usr/local/bin — try ~/.local/bin instead.
    const localBin = path.join(HOME, '.local', 'bin');
    try {
      fs.mkdirSync(localBin, { recursive: true });
      const lt = path.join(localBin, 'python3');
      try { fs.unlinkSync(lt); } catch {}
      fs.symlinkSync(p, lt);
      log(`Symlinked ${p} → ${lt} (add ${localBin} to PATH for hooks)`);
    } catch {}
  }
}

// ---- Corporate proxy / SSL helpers ----

function getNpmProxyArgs() {
  const proxy = process.env.https_proxy || process.env.HTTPS_PROXY
              || process.env.http_proxy  || process.env.HTTP_PROXY
              || process.env.npm_config_proxy || '';
  const caFile = process.env.NODE_EXTRA_CA_CERTS || process.env.npm_config_cafile || '';
  const args = [];
  if (proxy) {
    args.push('--proxy', proxy, '--https-proxy', proxy);
    log(`Corporate proxy detected: ${proxy}`);
  }
  if (caFile) {
    args.push('--cafile', caFile);
    log(`Custom CA file: ${caFile}`);
  }
  return args;
}

// Write PATH additions to shell RC files and Windows user registry.
function persistPath() {
  const binDirs = [
    path.join(NPM_PREFIX, isWin ? '' : 'bin'),
    path.join(NODE_DIR,   isWin ? '' : 'bin'),
  ].filter(d => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });

  if (!binDirs.length) return;

  if (isWin) {
    try {
      const reg = spawnSync('reg', ['query', 'HKCU\\Environment', '/v', 'PATH'],
        { encoding: 'utf8', stdio: 'pipe' });
      const m = (reg.stdout || '').match(/PATH\s+REG_(?:EXPAND_)?SZ\s+(.+)/i);
      const existing = (m ? m[1].trim() : process.env.PATH || '').split(';');
      const newDirs  = binDirs.filter(d => !existing.includes(d));
      if (!newDirs.length) { log('Windows PATH already includes required dirs.'); return; }
      const newPath  = [...newDirs, ...existing].join(';');
      spawnSync('reg', ['add', 'HKCU\\Environment', '/v', 'PATH', '/t', 'REG_EXPAND_SZ', '/d', newPath, '/f'],
        { stdio: 'pipe' });
      log(`Updated Windows user PATH in registry: ${newDirs.join(';')}`);
      log('Open a NEW terminal for PATH changes to take effect.');
    } catch (e) { warn('Could not update Windows PATH registry: ' + e.message); }
    return;
  }

  const exportLine = `\n# proxy-max PATH additions (added by install.js)\nexport PATH="${binDirs.join(':')}:$PATH"\n`;
  const shell = process.env.SHELL || '';
  const rcCandidates = [
    shell.includes('zsh')  ? path.join(HOME, '.zshrc')  : null,
    shell.includes('bash') ? path.join(HOME, '.bashrc') : null,
    path.join(HOME, '.zshrc'),
    path.join(HOME, '.bashrc'),
    path.join(HOME, '.profile'),
  ].filter(Boolean);

  for (const f of [...new Set(rcCandidates)]) {
    try {
      if (!fs.existsSync(f)) continue;
      const content = fs.readFileSync(f, 'utf8');
      if (content.includes('proxy-max PATH additions')) { log(`PATH already in ${f}`); return; }
      fs.appendFileSync(f, exportLine, 'utf8');
      log(`Added PATH to ${f} — run: source ${f}  (or open a new terminal)`);
      return;
    } catch {}
  }
  warn(`Could not write to any RC file. Add manually:\n${exportLine.trim()}`);
}

async function ensureClaude(npmBin) {
  const found = detectClaude(npmBin);
  if (found) return found;
  log('Installing @anthropic-ai/claude-code…');

  const proxyArgs = getNpmProxyArgs();
  const perUserEnv = { ...process.env, npm_config_prefix: NPM_PREFIX };

  // Attempt 1: global install as admin (when available).
  if (isAdmin()) {
    if (run(npmBin, ['install', '-g', '@anthropic-ai/claude-code', ...proxyArgs])) {
      const c = detectClaude(npmBin); if (c) return c;
    }
  }

  // Attempt 2: per-user prefix (no admin needed).
  log('Falling back to per-user install at ' + NPM_PREFIX);
  if (run(npmBin, ['install', '-g', '@anthropic-ai/claude-code', ...proxyArgs], { env: perUserEnv })) {
    const c = detectClaude(npmBin); if (c) return c;
  }

  // Attempt 3: same but with --strict-ssl=false for corporate SSL-inspection proxies.
  if (!proxyArgs.includes('--strict-ssl=false')) {
    warn('Retrying with --strict-ssl=false (corporate SSL-inspection proxy workaround)…');
    if (run(npmBin, ['install', '-g', '@anthropic-ai/claude-code', ...proxyArgs, '--strict-ssl=false'], { env: perUserEnv })) {
      const c = detectClaude(npmBin); if (c) return c;
    }
  }

  // Attempt 4: legacy peer deps in case of dependency conflicts.
  warn('Retrying with --legacy-peer-deps…');
  if (run(npmBin, ['install', '-g', '@anthropic-ai/claude-code', ...proxyArgs, '--legacy-peer-deps'], { env: perUserEnv })) {
    const c = detectClaude(npmBin); if (c) return c;
  }

  throw new Error('Failed to install @anthropic-ai/claude-code via npm. Check network/proxy settings and try: node src/install.js --doctor');
}

// ---- Doctor ----

function doctor() {
  console.log('--- Proxy-Max doctor ---');
  console.log('platform :', process.platform, process.arch);
  console.log('admin    :', isAdmin() ? 'yes' : 'no');
  console.log('node     :', process.execPath, '(running)');
  const npm = which('npm');
  console.log('npm      :', npm || '(not found)');
  if (isWin && npm) {
    const binDir = getNpmGlobalBinDir(npm);
    console.log('npm global bin:', binDir || '(could not detect)');
  }
  const claude = detectClaude(npm);
  console.log('claude   :', claude || '(not found)');
  const python = detectPython();
  console.log('python   :', python || '(not found — Claude Code hooks need python3.10+)');
  console.log('home     :', HOME);
  console.log('cache    :', ROOT);
  console.log('PATH adds:', [path.join(NODE_DIR, isWin ? '' : 'bin'), path.join(NPM_PREFIX, isWin ? '' : 'bin')].join(path.delimiter));
}

async function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has('--doctor')) return doctor();

  const onlyClaude = args.has('--claude-only');
  const onlyNode = args.has('--node-only');

  let nodeInfo = detectNode();
  if (!nodeInfo.node || !nodeInfo.npm) {
    log('Node / npm not fully detected — installing.');
    nodeInfo = await ensureNode();
  } else {
    log(`Found node: ${nodeInfo.node}`);
    log(`Found npm:  ${nodeInfo.npm}`);
  }
  if (onlyNode) return;

  const claude = await ensureClaude(nodeInfo.npm);
  log(`Anthropic CLI: ${claude}`);

  if (!onlyClaude && !onlyNode) {
    await ensurePython();
    symlinkPythonForHooks();
  }

  // Persist PATH so new terminals can find node + claude without manual setup.
  persistPath();
}

if (require.main === module) {
  main().catch(err => { warn(err.stack || err.message); process.exit(1); });
}

module.exports = { detectNode, detectClaude, detectPython, ensurePython, symlinkPythonForHooks, ensureNode, ensureClaude, getNpmProxyArgs, getNpmGlobalBinDir, persistPath, which, doctor, ROOT, NPM_PREFIX, NODE_DIR };
