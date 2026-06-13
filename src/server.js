const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');

const { callOpenAICompatible } = require('./providers/openai_compat');
const { callBedrock } = require('./providers/bedrock');
const MODELS = require('./models');
const installer = require('./install');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = process.env.PROXY_MAX_CONFIG || path.join(ROOT, 'config.json');
const PANEL_EVENTS_PATH = process.env.PROXY_MAX_PANEL_EVENTS || path.join(ROOT, 'panel-events.json');

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch { return { provider: null, providers: {} }; }
}
function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

let CONFIG = loadConfig();

function loadPanelEvents() {
  try {
    const raw = fs.readFileSync(PANEL_EVENTS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
  } catch {}
  return [];
}

function savePanelEvents(events) {
  fs.writeFileSync(PANEL_EVENTS_PATH, JSON.stringify(events, null, 2));
}

let PANEL_EVENTS = loadPanelEvents();

function send(res, status, body, headers = {}) {
  const isString = typeof body === 'string' || Buffer.isBuffer(body);
  const data = isString ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': isString ? (headers['Content-Type'] || 'text/plain; charset=utf-8') : 'application/json',
    ...headers
  });
  res.end(data);
}

function readJSONBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function activeProviderConfig() {
  const kind = CONFIG.provider;
  if (!kind) return null;
  const p = CONFIG.providers[kind] || {};
  return { kind, ...p };
}

// ---- Rate limiting (sliding 60s window for requests + tokens) ----

const DEFAULT_LIMITS = { enabled: true, rpm: 10000, tpm: 1000000 };

function getLimits() {
  const l = CONFIG.limits || {};
  return {
    enabled: l.enabled !== false,
    rpm: Number.isFinite(Number(l.rpm)) ? Number(l.rpm) : DEFAULT_LIMITS.rpm,
    tpm: Number.isFinite(Number(l.tpm)) ? Number(l.tpm) : DEFAULT_LIMITS.tpm
  };
}

class RateLimiter {
  constructor() { this.reqs = []; this.toks = []; }
  prune(now) {
    const cutoff = now - 60000;
    while (this.reqs.length && this.reqs[0] < cutoff) this.reqs.shift();
    while (this.toks.length && this.toks[0].ts < cutoff) this.toks.shift();
  }
  tokenSum() { return this.toks.reduce((s, t) => s + t.n, 0); }
  // Returns { ok } or { ok:false, reason, retryAfter }
  check(now, { rpm, tpm }) {
    this.prune(now);
    if (rpm > 0 && this.reqs.length >= rpm) {
      const retryAfter = Math.max(1, Math.ceil((this.reqs[0] + 60000 - now) / 1000));
      return { ok: false, reason: 'rpm', retryAfter, limit: rpm, current: this.reqs.length };
    }
    if (tpm > 0 && this.tokenSum() >= tpm) {
      const retryAfter = this.toks.length ? Math.max(1, Math.ceil((this.toks[0].ts + 60000 - now) / 1000)) : 60;
      return { ok: false, reason: 'tpm', retryAfter, limit: tpm, current: this.tokenSum() };
    }
    return { ok: true };
  }
  recordRequest(now) { this.reqs.push(now); }
  recordTokens(now, n) { if (n > 0) this.toks.push({ ts: now, n }); }
}

const limiter = new RateLimiter();

// Tee res.write/res.end to extract real token usage from the response (works
// for both non-streaming JSON usage objects and streaming SSE message events).
function sniffUsage(res, onUsage) {
  const origWrite = res.write.bind(res);
  const origEnd = res.end.bind(res);
  let buf = '';
  let reported = false;
  const scan = (chunk) => {
    if (!chunk) return;
    buf += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    if (buf.length > 262144) buf = buf.slice(-262144);
  };
  const report = () => {
    if (reported) return;
    reported = true;
    const ins = [...buf.matchAll(/"input_tokens":\s*(\d+)/g)];
    const outs = [...buf.matchAll(/"output_tokens":\s*(\d+)/g)];
    const input = ins.length ? Number(ins[ins.length - 1][1]) : 0;
    const output = outs.length ? Number(outs[outs.length - 1][1]) : 0;
    onUsage(input + output);
  };
  res.write = (chunk, ...a) => { scan(chunk); return origWrite(chunk, ...a); };
  res.end = (chunk, ...a) => { scan(chunk); report(); return origEnd(chunk, ...a); };
  return res;
}

async function handleMessages(req, res) {
  const cfg = activeProviderConfig();
  if (!cfg || !cfg.model) {
    return send(res, 503, {
      type: 'error',
      error: { type: 'configuration_error', message: 'Proxy not configured. Open the UI and pick a provider/model.' }
    });
  }

  // Enforce local rate limits before doing any upstream work.
  const limits = getLimits();
  if (limits.enabled) {
    const now = Date.now();
    const verdict = limiter.check(now, limits);
    if (!verdict.ok) {
      return send(res, 429, {
        type: 'error',
        error: {
          type: 'rate_limit_error',
          message: `Local proxy ${verdict.reason.toUpperCase()} limit reached (${verdict.current}/${verdict.limit} in the last 60s). Retry in ${verdict.retryAfter}s.`
        }
      }, { 'retry-after': String(verdict.retryAfter) });
    }
    limiter.recordRequest(now);
    res = sniffUsage(res, n => limiter.recordTokens(Date.now(), n));
  }

  let body;
  try { body = await readJSONBody(req); }
  catch { return send(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'Bad JSON' } }); }

  // The CLI sends its own model id; we always route to the configured one.
  body.model = cfg.model;

  try {
    if (cfg.kind === 'bedrock') {
      await callBedrock(cfg, body, res);
    } else {
      await callOpenAICompatible(cfg, body, res);
    }
  } catch (err) {
    if (!res.headersSent) {
      send(res, 502, { type: 'error', error: { type: 'api_error', message: String(err.message || err) } });
    } else {
      try { res.end(); } catch {}
    }
    console.error('[proxy] error:', err.message);
  }
}

function handleConfigGet(_req, res) {
  // Redact secrets in responses.
  const safe = JSON.parse(JSON.stringify(CONFIG));
  for (const k of Object.keys(safe.providers || {})) {
    const p = safe.providers[k];
    if (p.apiKey) p.apiKey = '••••' + p.apiKey.slice(-4);
    if (p.secretAccessKey) p.secretAccessKey = '••••' + p.secretAccessKey.slice(-4);
  }
  send(res, 200, { ...safe, configPath: CONFIG_PATH });
}

async function handleConfigPost(req, res) {
  const body = await readJSONBody(req);
  // Body shape: { provider: 'bedrock'|'azure'|'nvidia', config: {...} }
  if (!body.provider) return send(res, 400, { error: 'provider required' });
  CONFIG.provider = body.provider;
  CONFIG.providers = CONFIG.providers || {};
  const prev = CONFIG.providers[body.provider] || {};
  const incoming = body.config || {};
  // If apiKey/secret comes back as the masked string, keep the previous value.
  const merged = { ...prev, ...incoming };
  if (typeof incoming.apiKey === 'string' && incoming.apiKey.startsWith('••••')) merged.apiKey = prev.apiKey;
  if (typeof incoming.secretAccessKey === 'string' && incoming.secretAccessKey.startsWith('••••')) merged.secretAccessKey = prev.secretAccessKey;
  CONFIG.providers[body.provider] = merged;
  saveConfig(CONFIG);
  send(res, 200, { ok: true });
}

function handleLimitsGet(_req, res) {
  const now = Date.now();
  limiter.prune(now);
  send(res, 200, {
    limits: getLimits(),
    usage: { rpm: limiter.reqs.length, tpm: limiter.tokenSum(), windowSeconds: 60 }
  });
}

async function handleLimitsPost(req, res) {
  const body = await readJSONBody(req);
  const next = { ...DEFAULT_LIMITS, ...(CONFIG.limits || {}) };
  if (typeof body.enabled === 'boolean') next.enabled = body.enabled;
  if (body.rpm != null) {
    const n = Number(body.rpm);
    if (!Number.isFinite(n) || n < 0) return send(res, 400, { error: 'rpm must be a non-negative number' });
    next.rpm = Math.floor(n);
  }
  if (body.tpm != null) {
    const n = Number(body.tpm);
    if (!Number.isFinite(n) || n < 0) return send(res, 400, { error: 'tpm must be a non-negative number' });
    next.tpm = Math.floor(n);
  }
  CONFIG.limits = next;
  saveConfig(CONFIG);
  send(res, 200, { ok: true, limits: getLimits() });
}

async function handleTest(req, res) {
  const body = await readJSONBody(req);
  const provider = body.provider;
  const cfg = { kind: provider, ...(body.config || {}) };
  // Resolve masked secrets from saved config.
  const saved = (CONFIG.providers || {})[provider] || {};
  if (typeof cfg.apiKey === 'string' && cfg.apiKey.startsWith('••••')) cfg.apiKey = saved.apiKey;
  if (typeof cfg.secretAccessKey === 'string' && cfg.secretAccessKey.startsWith('••••')) cfg.secretAccessKey = saved.secretAccessKey;
  // Fail fast on the Test button so the UI never hangs.
  cfg.timeoutMs = 20000;

  const probe = {
    model: cfg.model,
    max_tokens: 16,
    messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
    stream: false
  };
  // Capture upstream response in-memory.
  const fakeRes = new MemoryResponse();
  try {
    if (provider === 'bedrock') await callBedrock(cfg, probe, fakeRes);
    else await callOpenAICompatible(cfg, probe, fakeRes);
    const txt = fakeRes.bodyString();
    send(res, 200, { ok: true, sample: txt.slice(0, 400) });
  } catch (err) {
    send(res, 200, { ok: false, error: String(err.message || err) });
  }
}

class MemoryResponse {
  constructor() { this.headers = {}; this.chunks = []; this.headersSent = false; }
  setHeader(k, v) { this.headers[k] = v; }
  writeHead(s, h) { this.status = s; Object.assign(this.headers, h || {}); this.headersSent = true; }
  write(chunk) { this.chunks.push(Buffer.from(chunk)); }
  end(chunk) { if (chunk) this.chunks.push(Buffer.from(chunk)); }
  bodyString() { return Buffer.concat(this.chunks).toString('utf8'); }
}

// ---- System inspection ----

function probeVersion(bin, arg = '--version') {
  try {
    const r = spawnSync(bin, [arg], { encoding: 'utf8', timeout: 4000 });
    if (r.status === 0) return (r.stdout || r.stderr || '').trim().split('\n')[0];
  } catch {}
  return null;
}

function isAdminSync() {
  if (process.platform === 'win32') {
    try {
      const r = spawnSync('net', ['session'], { encoding: 'utf8', timeout: 3000 });
      return r.status === 0;
    } catch { return false; }
  }
  try { return process.getuid() === 0 || spawnSync('sudo', ['-n', 'true']).status === 0; }
  catch { return false; }
}

function buildSystem() {
  const node = { path: process.execPath, version: process.version, ok: true };

  const npmPath = installer.which('npm');
  const npmVer = npmPath ? probeVersion(npmPath) : null;
  const npm = { path: npmPath, version: npmVer, ok: !!npmPath };

  const claudePath = installer.detectClaude();
  const claudeVer = claudePath ? probeVersion(claudePath) : null;
  const claude = { path: claudePath, version: claudeVer, ok: !!claudePath };

  const admin = isAdminSync();

  const home = os.homedir();
  const writableHome = (() => {
    try { fs.accessSync(home, fs.constants.W_OK); return true; } catch { return false; }
  })();

  // Useful path candidates we scanned for binaries.
  const pathDirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);

  return {
    platform: process.platform,
    arch: process.arch,
    user: os.userInfo().username,
    home,
    writableHome,
    admin,
    proxyHome: installer.ROOT,
    npmPrefix: installer.NPM_PREFIX,
    portableNodeDir: installer.NODE_DIR,
    pathDirs,
    components: { node, npm, claude },
    canConfigure: !!claudePath
  };
}

async function handleSystem(_req, res) {
  send(res, 200, buildSystem());
}

// Spawn an installer step and stream stdout/stderr back as plain text.
async function handleInstall(req, res) {
  const u = new URL(req.url, 'http://localhost');
  const what = u.searchParams.get('what') || 'all'; // 'node' | 'claude' | 'all'
  const wantAdmin = u.searchParams.get('admin') === '1';

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });
  const send = (line) => res.write(`data: ${JSON.stringify(line)}\n\n`);
  send({ type: 'log', msg: `Starting install (target=${what}, useAdmin=${wantAdmin})` });

  const args = ['src/install.js'];
  if (what === 'node')   args.push('--node-only');
  if (what === 'claude') args.push('--claude-only');
  const env = { ...process.env };
  if (!wantAdmin) env.PROXY_MAX_NO_ADMIN = '1'; // hint (the installer also auto-detects)

  const child = spawn(process.execPath, args, { cwd: ROOT, env });
  child.stdout.on('data', d => send({ type: 'log', msg: d.toString() }));
  child.stderr.on('data', d => send({ type: 'log', msg: d.toString(), level: 'warn' }));
  child.on('close', code => {
    send({ type: 'done', code, system: buildSystem() });
    res.end();
  });
}

function summarizePanelEvents(events) {
  const summary = {
    total: events.length,
    impressions: 0,
    clicks: 0,
    watchMsTotal: 0,
    ctr: 0,
    byAd: {}
  };

  for (const evt of events) {
    if (evt.type === 'impression') summary.impressions += 1;
    if (evt.type === 'click') summary.clicks += 1;
    if (Number.isFinite(evt.watchMs) && evt.watchMs > 0) summary.watchMsTotal += evt.watchMs;

    const adKey = evt.adId || 'unknown';
    if (!summary.byAd[adKey]) summary.byAd[adKey] = { impressions: 0, clicks: 0 };
    if (evt.type === 'impression') summary.byAd[adKey].impressions += 1;
    if (evt.type === 'click') summary.byAd[adKey].clicks += 1;
  }

  summary.ctr = summary.impressions > 0 ? Number((summary.clicks / summary.impressions).toFixed(4)) : 0;
  return summary;
}

async function handlePanelEventPost(req, res) {
  let body;
  try {
    body = await readJSONBody(req);
  } catch {
    return send(res, 400, { ok: false, error: 'Bad JSON' });
  }

  const type = String(body.type || '').trim().toLowerCase();
  if (!type || (type !== 'impression' && type !== 'click')) {
    return send(res, 400, { ok: false, error: 'type must be impression or click' });
  }

  const event = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ts: new Date().toISOString(),
    type,
    adId: body.adId ? String(body.adId) : 'unknown',
    impressionId: body.impressionId ? String(body.impressionId) : null,
    sessionId: body.sessionId ? String(body.sessionId) : null,
    watchMs: Number.isFinite(Number(body.watchMs)) ? Math.max(0, Number(body.watchMs)) : 0,
    source: body.source ? String(body.source) : 'local-test'
  };

  PANEL_EVENTS.push(event);
  if (PANEL_EVENTS.length > 2000) PANEL_EVENTS = PANEL_EVENTS.slice(-2000);
  savePanelEvents(PANEL_EVENTS);

  return send(res, 200, { ok: true, event, summary: summarizePanelEvents(PANEL_EVENTS) });
}

function handlePanelEventsGet(req, res) {
  const u = new URL(req.url, 'http://localhost');
  const limitRaw = Number.parseInt(u.searchParams.get('limit') || '100', 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 500) : 100;
  const events = PANEL_EVENTS.slice(-limit).reverse();
  return send(res, 200, { ok: true, count: events.length, events });
}

function handlePanelSummaryGet(_req, res) {
  return send(res, 200, { ok: true, summary: summarizePanelEvents(PANEL_EVENTS) });
}

function handlePanelResetPost(_req, res) {
  PANEL_EVENTS = [];
  savePanelEvents(PANEL_EVENTS);
  return send(res, 200, { ok: true });
}

function serveStatic(req, res) {
  let p = new URL(req.url, 'http://localhost').pathname;
  if (p === '/' || p === '/ui') p = '/ui/index.html';
  const filePath = path.join(ROOT, p);
  if (!filePath.startsWith(ROOT)) return send(res, 403, 'forbidden');
  fs.readFile(filePath, (err, data) => {
    if (err) return send(res, 404, 'not found');
    const ext = path.extname(filePath);
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'POST' && (u.pathname === '/v1/messages' || u.pathname === '/messages')) {
      return await handleMessages(req, res);
    }
    if (u.pathname === '/api/models') return send(res, 200, MODELS);
    if (u.pathname === '/api/system' && req.method === 'GET') return await handleSystem(req, res);
    if (u.pathname === '/api/install' && req.method === 'POST') return await handleInstall(req, res);
    if (u.pathname === '/api/config' && req.method === 'GET') return handleConfigGet(req, res);
    if (u.pathname === '/api/config' && req.method === 'POST') return await handleConfigPost(req, res);
    if (u.pathname === '/api/test' && req.method === 'POST') return await handleTest(req, res);
    if (u.pathname === '/api/limits' && req.method === 'GET') return handleLimitsGet(req, res);
    if (u.pathname === '/api/limits' && req.method === 'POST') return await handleLimitsPost(req, res);
    if (u.pathname === '/api/panel/event' && req.method === 'POST') return await handlePanelEventPost(req, res);
    if (u.pathname === '/api/panel/events' && req.method === 'GET') return handlePanelEventsGet(req, res);
    if (u.pathname === '/api/panel/summary' && req.method === 'GET') return handlePanelSummaryGet(req, res);
    if (u.pathname === '/api/panel/reset' && req.method === 'POST') return handlePanelResetPost(req, res);
    if (u.pathname === '/api/health') return send(res, 200, { ok: true, provider: CONFIG.provider, model: activeProviderConfig()?.model });
    if (u.pathname === '/api/reload') { CONFIG = loadConfig(); return send(res, 200, { ok: true }); }
    return serveStatic(req, res);
  } catch (err) {
    console.error('[proxy] unhandled:', err);
    if (!res.headersSent) send(res, 500, { error: String(err.message || err) });
  }
});

const PORT = parseInt(process.env.PORT || '8787', 10);
const HOST = process.env.HOST || '127.0.0.1';
server.listen(PORT, HOST, () => {
  console.log(`\nProxy-Max running`);
  console.log(`  UI:        http://${HOST}:${PORT}/`);
  console.log(`  API base:  http://${HOST}:${PORT}  (point ANTHROPIC_BASE_URL here)`);
  console.log(`  Config:    ${CONFIG_PATH}`);
  if (CONFIG.provider) {
    const ac = activeProviderConfig();
    console.log(`  Active:    ${CONFIG.provider} / ${ac?.model || '(no model selected)'}`);
  } else {
    console.log(`  Active:    (none — open the UI to configure)`);
  }
});
