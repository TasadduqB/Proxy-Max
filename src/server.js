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
const CONFIG_PATH        = process.env.PROXY_MAX_CONFIG       || path.join(ROOT, 'config.json');
const PANEL_EVENTS_PATH  = process.env.PROXY_MAX_PANEL_EVENTS || path.join(ROOT, 'panel-events.json');
const LOG_DIR            = process.env.PROXY_MAX_LOG_DIR      || path.join(ROOT, 'logs');
const LOG_FILE           = path.join(LOG_DIR, 'requests.log');
const LOG_MAX_BYTES      = 10 * 1024 * 1024; // 10 MB before rotation
const LOG_KEEP_ROTATIONS = 3;                 // keep .1 .2 .3 then drop oldest

// Ensure log directory exists (sync at startup — cheap one-time call).
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch { /* already exists */ }

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
      } catch (e) {
        e.raw = Buffer.concat(chunks).toString('utf8').slice(0, 2000);
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function compactText(value, maxLen = 1200) {
  if (value == null) return null;
  let text;
  if (typeof value === 'string') text = value;
  else if (Buffer.isBuffer(value)) text = value.toString('utf8');
  else {
    try { text = JSON.stringify(value); }
    catch { text = String(value); }
  }
  text = String(text).replace(/\s+/g, ' ').trim();
  if (text.length > maxLen) return `${text.slice(0, maxLen)}…`;
  return text;
}

function extractMessagePreview(content) {
  if (typeof content === 'string') return compactText(content, 400);
  if (!Array.isArray(content)) return null;
  const parts = [];
  for (const block of content) {
    if (block && block.type === 'text' && block.text) parts.push(block.text);
  }
  return parts.length ? compactText(parts.join(' '), 400) : null;
}

function summarizeRequestBody(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  const lastMessage = messages.length ? messages[messages.length - 1] : null;
  return {
    model: body?.model || null,
    stream: !!body?.stream,
    maxTokens: body?.max_tokens ?? null,
    messageCount: messages.length,
    toolCount: tools.length,
    hasSystem: !!body?.system,
    lastRole: lastMessage?.role || null,
    lastMessagePreview: extractMessagePreview(lastMessage?.content),
    toolNames: tools.map(t => t && t.name).filter(Boolean).slice(0, 12)
  };
}

function summarizeError(err) {
  if (!err) return null;
  const out = {
    name: err.name || 'Error',
    message: compactText(err.message || String(err), 1600)
  };
  if (err.stage) out.stage = err.stage;
  if (err.code) out.code = err.code;
  if (err.status != null) out.status = err.status;
  if (err.contentType) out.contentType = err.contentType;
  if (err.debug) out.debug = err.debug;
  return out;
}

function attachRequestTrace(res, logEntry, reqStart) {
  let finalized = false;
  const finalize = (status, extra = {}) => {
    if (finalized) return false;
    finalized = true;
    logEntry.finalStatus = status;
    logEntry.totalMs = Date.now() - reqStart;
    if (extra && typeof extra === 'object') Object.assign(logEntry, extra);
    pushLog(logEntry);
    return true;
  };
  const note = (extra = {}) => {
    if (extra && typeof extra === 'object') Object.assign(logEntry, extra);
  };
  res.__proxyTrace = { logEntry, finalize, note };
  return res.__proxyTrace;
}

function activeProviderConfig() {
  const kind = CONFIG.provider;
  if (!kind) return null;
  const p = CONFIG.providers[kind] || {};
  return { kind, ...p };
}

// ---- Model pool (round-robin + fallback) ----

let poolRR = 0;
// `${provider}::${model}` → { req, err, lastMs, consecutiveFails, cooledUntil }
const poolStats = new Map();

// Cooldown durations:
//   404 (model removed from provider) → 1 hour — won't come back on its own
//   3+ consecutive non-404 failures  → 5 minutes — could be transient
const COOLDOWN_404_MS  = 60 * 60 * 1000;
const COOLDOWN_FAIL_MS = 5  * 60 * 1000;
const COOLDOWN_FAIL_THRESHOLD = 3;

function getOrInitStat(key) {
  if (!poolStats.has(key)) {
    poolStats.set(key, { req: 0, err: 0, lastMs: 0, consecutiveFails: 0, cooledUntil: 0 });
  }
  return poolStats.get(key);
}

function isCooledDown(stat) {
  return stat.cooledUntil > 0 && Date.now() < stat.cooledUntil;
}

function cooldownRemaining(stat) {
  return Math.max(0, Math.ceil((stat.cooledUntil - Date.now()) / 1000));
}

function getPool() {
  const raw = CONFIG.pool;
  if (!Array.isArray(raw) || raw.length === 0) {
    const cfg = activeProviderConfig();
    return cfg ? [{ ...cfg, _key: `${cfg.kind}::${cfg.model}` }] : [];
  }
  return raw.map(entry => {
    const provCfg = (CONFIG.providers || {})[entry.provider] || {};
    // Per-entry credential fields (endpoint, apiKey, apiVersion, deployment, etc.)
    // override the shared provider config. This lets pool entries from the same
    // provider use different endpoints / API keys (e.g. two Azure deployments).
    const { provider, model, label, _key, ...entryOverrides } = entry;
    return {
      kind: entry.provider,
      ...provCfg,
      ...entryOverrides,   // per-entry overrides win over provider defaults
      model: entry.model,
      label: entry.label || `${entry.provider} / ${entry.model}`,
      _key: `${entry.provider}::${entry.model}`
    };
  }).filter(e => e.kind && e.model);
}

// ---- Request log — in-memory ring buffer + rotating file ----
//
// Every completed request (ok / all-failed / mid-stream-err) is:
//   1. Pushed into REQUEST_LOG (last 300, served via GET /api/logs)
//   2. Appended as a single JSON line to logs/requests.log
//      Rotation: when the file exceeds 10 MB it is renamed to .1, old .1→.2
//      etc. up to LOG_KEEP_ROTATIONS copies; the oldest is deleted.
//
// The file survives server restarts and is readable from the VM even when
// no browser can reach the UI.

const REQUEST_LOG = [];
const MAX_LOG_ENTRIES = 300;

function rotateLogs() {
  try {
    const stat = fs.statSync(LOG_FILE);
    if (stat.size < LOG_MAX_BYTES) return;
    // Shift existing rotations: .3 → drop, .2 → .3, .1 → .2, current → .1
    for (let i = LOG_KEEP_ROTATIONS; i >= 1; i--) {
      const older = `${LOG_FILE}.${i}`;
      const newer = i < LOG_KEEP_ROTATIONS ? `${LOG_FILE}.${i + 1}` : null;
      try {
        if (newer) fs.renameSync(older, newer);
        else fs.unlinkSync(older);
      } catch { /* file may not exist yet */ }
    }
    fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
  } catch { /* file doesn't exist yet — nothing to rotate */ }
}

function writeLogLine(entry) {
  try {
    rotateLogs();
    // Build a compact single-line summary for easy grepping.
    const time = new Date(entry.ts).toISOString();
    const firstAttempt = (entry.attempts || []).find(a => a.status !== 'skipped') || {};
    const line = JSON.stringify({
      time,
      id:       entry.id,
      status:   entry.finalStatus,
      model:    firstAttempt.model  || '?',
      provider: firstAttempt.provider || '?',
      label:    firstAttempt.label  || '?',
      totalMs:  entry.totalMs,
      stream:   entry.stream,
      hasTools: entry.hasTools,
      hasSystem: entry.hasSystem,
      poolSize: entry.poolSize,
      request: entry.request || null,
      error: entry.error || null,
      attempts: (entry.attempts || []).map(a => ({
        label:      a.label,
        status:     a.status,
        durationMs: a.durationMs,
        stage:      a.stage || null,
        upstreamStatus: a.upstreamStatus ?? null,
        contentType: a.contentType || null,
        error:      a.error || null,
        responsePreview: a.responsePreview || null
      }))
    });
    fs.appendFileSync(LOG_FILE, line + '\n', 'utf8');
  } catch (e) {
    // Never let logging crash the server.
    console.error('[proxy] [log-write-error]', e.message);
  }
}

function pushLog(entry) {
  REQUEST_LOG.push(entry);
  if (REQUEST_LOG.length > MAX_LOG_ENTRIES) REQUEST_LOG.shift();
  writeLogLine(entry);
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
  const pool = getPool();
  if (pool.length === 0) {
    return send(res, 503, {
      type: 'error',
      error: { type: 'configuration_error', message: 'No models configured. Open the UI and set up a provider / model pool.' }
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
  catch (err) {
    return send(res, 400, {
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: 'Bad JSON',
        detail: err.raw || err.message
      }
    });
  }

  // Build log entry for this request.
  const reqId = Math.random().toString(36).slice(2, 10);
  const logEntry = {
    id: reqId,
    ts: Date.now(),
    request: summarizeRequestBody(body),
    stream: !!body.stream,
    maxTokens: body.max_tokens || null,
    messageCount: (body.messages || []).length,
    hasTools: !!(body.tools && body.tools.length),
    hasSystem: !!body.system,
    poolSize: pool.length,
    attempts: [],
    finalStatus: 'ok',
    totalMs: 0
  };
  const reqStart = Date.now();
  attachRequestTrace(res, logEntry, reqStart);

  // Round-robin + fallback with circuit breaker.
  // Members in cooldown are skipped instantly (no upstream call).
  const startIdx = poolRR;
  let tried = 0; // members actually called (not skipped)
  let skipped = 0;

  for (let attempt = 0; attempt < pool.length; attempt++) {
    const idx = (startIdx + attempt) % pool.length;
    const cfg = pool[idx];
    const key = cfg._key;
    const stat = getOrInitStat(key);

    // Circuit breaker: skip cooled-down members instantly.
    if (isCooledDown(stat)) {
      skipped++;
      const secs = cooldownRemaining(stat);
      console.log(`[proxy] [skip] ${cfg.label} in cooldown ${secs}s remaining`);
      logEntry.attempts.push({
        model: cfg.model, provider: cfg.kind, label: cfg.label,
        status: 'skipped', durationMs: 0,
        error: `circuit open — cooldown ${secs}s`
      });
      continue;
    }

    tried++;
    body.model = cfg.model;
    stat.req++;
    const t0 = Date.now();

    const attemptLog = {
      model: cfg.model,
      provider: cfg.kind,
      label: cfg.label,
      endpoint: cfg.endpoint || null,
      status: 'ok',
      durationMs: 0,
      error: null
    };

    try {
      if (cfg.kind === 'bedrock') await callBedrock(cfg, body, res);
      else await callOpenAICompatible(cfg, body, res);
      attemptLog.durationMs = Date.now() - t0;
      stat.lastMs = attemptLog.durationMs;
      stat.consecutiveFails = 0;
      stat.cooledUntil = 0;
      poolRR = (idx + 1) % pool.length;
      logEntry.attempts.push(attemptLog);
      logEntry.totalMs = Date.now() - reqStart;
      pushLog(logEntry);
      console.log(`[proxy] [ok] ${cfg.label} dur=${attemptLog.durationMs}ms stream=${body.stream}`);
      return;
    } catch (err) {
      attemptLog.durationMs = Date.now() - t0;
      attemptLog.status = 'err';
      attemptLog.error = compactText(err.message, 400);
      if (err.stage) attemptLog.stage = err.stage;
      if (err.status != null) attemptLog.upstreamStatus = err.status;
      if (err.contentType) attemptLog.contentType = err.contentType;
      if (err.debug?.responsePreview) attemptLog.responsePreview = err.debug.responsePreview;
      if (err.debug?.responseBody) attemptLog.responsePreview = err.debug.responseBody;
      if (err.debug?.requestPreview && !logEntry.requestPreview) logEntry.requestPreview = err.debug.requestPreview;
      stat.err++;
      stat.lastMs = attemptLog.durationMs;
      stat.consecutiveFails = (stat.consecutiveFails || 0) + 1;

      // Circuit breaker: trip on 404 (dead model) or repeated failures.
      const is404 = /Upstream 4[0-9]{2}/.test(err.message) && err.message.includes('404');
      if (is404) {
        stat.cooledUntil = Date.now() + COOLDOWN_404_MS;
        console.warn(`[proxy] [breaker] ${cfg.label} → 404 (model gone), cooldown 1h`);
      } else if (stat.consecutiveFails >= COOLDOWN_FAIL_THRESHOLD) {
        stat.cooledUntil = Date.now() + COOLDOWN_FAIL_MS;
        console.warn(`[proxy] [breaker] ${cfg.label} → ${stat.consecutiveFails} consecutive fails, cooldown 5m`);
      }

      logEntry.attempts.push(attemptLog);

      if (res.headersSent) {
        if (res.__proxyTrace) {
          res.__proxyTrace.finalize('mid-stream-err', {
            error: summarizeError(err),
            request: logEntry.request,
            attempt: attemptLog
          });
        } else {
          logEntry.finalStatus = 'mid-stream-err';
          logEntry.totalMs = Date.now() - reqStart;
          pushLog(logEntry);
        }
        console.error(`[proxy] [mid-stream] ${reqId} ${cfg.label}: ${err.message}`);
        try { res.end(); } catch {}
        return;
      }

      const remaining = pool.length - attempt - 1;
      if (remaining > 0) {
        console.warn(`[proxy] [fallback] ${cfg.label} failed → trying next (${remaining} left)`);
      } else {
        logEntry.finalStatus = tried > 0 ? 'all-failed' : 'all-skipped';
        logEntry.totalMs = Date.now() - reqStart;
        pushLog(logEntry);
        const msg = tried === 0
          ? `All ${pool.length} pool members are in circuit-breaker cooldown. Try again later.`
          : `All pool members failed. Last error: ${err.message}`;
        console.error(`[proxy] [${logEntry.finalStatus}] ${reqId} ${msg}`);
        send(res, 502, { type: 'error', error: { type: 'api_error', message: msg } });
      }
    }
  }

  // Edge case: every member was skipped (all in cooldown, none tried).
  if (tried === 0 && skipped > 0) {
    logEntry.finalStatus = 'all-skipped';
    logEntry.totalMs = Date.now() - reqStart;
    pushLog(logEntry);
    send(res, 503, {
      type: 'error',
      error: { type: 'api_error', message: `All ${skipped} pool members are in circuit-breaker cooldown. Try again later.` }
    });
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

function handleLaunchCommand(_req, res) {
  const port = parseInt(process.env.PORT || '8787', 10);
  const host = process.env.HOST || '127.0.0.1';
  const base = `http://${host}:${port}`;
  const claudePath = installer.detectClaude();
  const claudeCmd = claudePath || 'claude';
  const platform = process.platform;

  const unix   = `export ANTHROPIC_BASE_URL="${base}"\nexport ANTHROPIC_AUTH_TOKEN="proxy-max"\nexport ANTHROPIC_API_KEY="proxy-max"\n${claudeCmd} --dangerously-skip-permissions`;
  const ps     = `$env:ANTHROPIC_BASE_URL = "${base}"\n$env:ANTHROPIC_AUTH_TOKEN = "proxy-max"\n$env:ANTHROPIC_API_KEY = "proxy-max"\n${claudeCmd} --dangerously-skip-permissions`;
  const wincmd = `set ANTHROPIC_BASE_URL=${base} && set ANTHROPIC_AUTH_TOKEN=proxy-max && set ANTHROPIC_API_KEY=proxy-max && ${claudeCmd} --dangerously-skip-permissions`;

  send(res, 200, {
    platform,
    claudeInstalled: !!claudePath,
    claudePath: claudePath || null,
    base,
    commands: { unix, ps, wincmd }
  });
}

function handlePoolGet(_req, res) {
  const now = Date.now();
  const pool = (CONFIG.pool || []).map(e => {
    const stat = poolStats.get(`${e.provider}::${e.model}`) || { req: 0, err: 0, lastMs: 0, consecutiveFails: 0, cooledUntil: 0 };
    return {
      ...e,
      stats: {
        req: stat.req,
        err: stat.err,
        lastMs: stat.lastMs,
        consecutiveFails: stat.consecutiveFails || 0,
        cooledUntil: stat.cooledUntil || 0,
        cooldownSecsLeft: stat.cooledUntil > now ? Math.ceil((stat.cooledUntil - now) / 1000) : 0
      }
    };
  });
  send(res, 200, { pool, rrIndex: poolRR, size: pool.length });
}

async function handlePoolPost(req, res) {
  const body = await readJSONBody(req);
  if (!Array.isArray(body.pool)) return send(res, 400, { error: 'pool must be an array' });
  const CRED_FIELDS = ['endpoint', 'apiKey', 'apiVersion', 'deployment', 'region', 'accessKeyId', 'secretAccessKey'];
  CONFIG.pool = body.pool
    .map(e => {
      const entry = { provider: e.provider, model: e.model, label: e.label || null };
      for (const f of CRED_FIELDS) {
        if (e[f] != null && e[f] !== '') entry[f] = e[f];
      }
      return entry;
    })
    .filter(e => e.provider && e.model);
  saveConfig(CONFIG);
  send(res, 200, { ok: true, pool: CONFIG.pool });
}

function handlePoolResetCircuits(_req, res) {
  for (const stat of poolStats.values()) {
    stat.consecutiveFails = 0;
    stat.cooledUntil = 0;
  }
  send(res, 200, { ok: true });
}

function handleLogsGet(_req, res) {
  send(res, 200, { logs: REQUEST_LOG.slice().reverse(), count: REQUEST_LOG.length });
}

// Serve the last N lines of the on-disk log file as a JSON array of parsed objects.
// ?lines=N (default 200, max 2000). Falls back gracefully if file doesn't exist yet.
function handleLogsFileGet(req, res) {
  const u = new URL(req.url, 'http://localhost');
  const limit = Math.min(2000, Math.max(1, parseInt(u.searchParams.get('lines') || '200', 10)));
  try {
    const raw = fs.readFileSync(LOG_FILE, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    const tail = lines.slice(-limit).reverse();
    const parsed = tail.map(l => { try { return JSON.parse(l); } catch { return { raw: l }; } });
    const logFiles = [];
    for (let i = 1; i <= LOG_KEEP_ROTATIONS; i++) {
      try { const s = fs.statSync(`${LOG_FILE}.${i}`); logFiles.push({ name: `requests.log.${i}`, bytes: s.size }); } catch {}
    }
    try { const s = fs.statSync(LOG_FILE); logFiles.unshift({ name: 'requests.log', bytes: s.size }); } catch {}
    send(res, 200, { logs: parsed, total: lines.length, limit, logFile: LOG_FILE, logFiles });
  } catch {
    send(res, 200, { logs: [], total: 0, limit, logFile: LOG_FILE, logFiles: [] });
  }
}

function handleLogsClear(_req, res) {
  REQUEST_LOG.length = 0;
  // Also truncate the log file and all rotations.
  try { fs.writeFileSync(LOG_FILE, '', 'utf8'); } catch {}
  for (let i = 1; i <= LOG_KEEP_ROTATIONS; i++) {
    try { fs.unlinkSync(`${LOG_FILE}.${i}`); } catch {}
  }
  send(res, 200, { ok: true });
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
    if (u.pathname === '/api/pool' && req.method === 'GET') return handlePoolGet(req, res);
    if (u.pathname === '/api/pool' && req.method === 'POST') return await handlePoolPost(req, res);
    if (u.pathname === '/api/pool/reset-circuits' && req.method === 'POST') return handlePoolResetCircuits(req, res);
    if (u.pathname === '/api/logs' && req.method === 'GET') return handleLogsGet(req, res);
    if (u.pathname === '/api/logs/file' && req.method === 'GET') return handleLogsFileGet(req, res);
    if (u.pathname === '/api/logs/clear' && req.method === 'POST') return handleLogsClear(req, res);
    if (u.pathname === '/api/health') {
      const pool = getPool();
      const poolMode = Array.isArray(CONFIG.pool) && CONFIG.pool.length > 0;
      return send(res, 200, {
        ok: true,
        provider: CONFIG.provider,
        model: activeProviderConfig()?.model,
        poolMode,
        poolSize: poolMode ? CONFIG.pool.length : 0,
        poolActive: [...poolStats.values()].filter(s => s.req > 0).length
      });
    }
    if (u.pathname === '/api/launch/command' && req.method === 'GET') return handleLaunchCommand(req, res);
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
  console.log(`  Log file:  ${LOG_FILE}  (tail -f for live view)`);
  if (CONFIG.provider) {
    const ac = activeProviderConfig();
    console.log(`  Active:    ${CONFIG.provider} / ${ac?.model || '(no model selected)'}`);
  } else {
    console.log(`  Active:    (none — open the UI to configure)`);
  }
});
