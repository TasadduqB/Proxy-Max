const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');

const { callOpenAICompatible } = require('./providers/openai_compat');
const { callBedrock } = require('./providers/bedrock');
const MODELS = require('./models');
const installer = require('./install');

const AnalyticsEngine = require('./analytics/engine');
const TokenCounter = require('./token-analyzer/counter');
const PricingCalculator = require('./cost-calculator/pricing');
const ProseCompressor = require('./compression/prose-compressor');
const { OutputFilter, BUILTIN_FILTERS } = require('./output-filters/filter');
const DASHBOARD_ROUTES = require('./dashboard/routes');

const HistoryTrimmer   = require('./optimizers/history-trimmer');
const ToolCompressor   = require('./optimizers/tool-compressor');
const CacheInjector    = require('./optimizers/cache-injector');
const ToolResultFilter = require('./optimizers/tool-result-filter');

const { SqliteStore }  = require('./cache/sqlite-store');
const ResponseCache    = require('./cache/response-cache');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH        = process.env.PROXY_MAX_CONFIG       || path.join(ROOT, 'config.json');
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

// ---- Persistent store (SQLite via node:sqlite, JSON fallback) ----
const store = new SqliteStore();
console.log(`[proxy] store backend: ${store.info().backend} (${store.info().dbFile})`);

// ---- Analytics / dashboard utilities ----
const analytics    = new AnalyticsEngine(null, store);
const tokenCounter = new TokenCounter();
const pricingCalc  = new PricingCalculator();
const compressor   = new ProseCompressor();
// ---- Proxy-layer optimizers (run automatically on every request) ----
const historyTrimmer = new HistoryTrimmer();
const toolCompressor = new ToolCompressor();
const cacheInjector  = new CacheInjector();
const responseCache  = new ResponseCache(store);
// Drop expired cache rows hourly.
setInterval(() => { try { store.cachePrune(); } catch {} }, 60 * 60 * 1000).unref?.();
// Shared deps object threaded into every dashboard route handler.
const dashDeps = { analytics, tokenCounter, pricingCalc, compressor };

// ---- Unified optimization config ----------------------------------------
// Every cost-saving strategy is configured here and applied transparently in
// the proxy path — there is no manual copy/paste UI. Defaults are tuned to be
// safe for Claude Code (lossless or near-lossless) so they can ship enabled.
// Defaults: EVERYTHING ON, tuned conservatively ("enable everything, tuned
// safe"). Lossless stages run with zero risk; the lossy stages use gentle
// settings — a large history window, a generous tool-description cap, and the
// mildest prose mode — so they save tokens without starving Claude Code of the
// context it needs for hooks, web search, subagents and accurate tool use.
//   • cacheInject   — Anthropic prompt-cache hints; capped at the 4-breakpoint
//                     limit so it can never error. (lossless)
//   • responseCache — exact-match SQLite response cache; identical requests
//                     replay verbatim at zero upstream cost. (lossless)
//   • toolResults   — ANSI stripping on; blank-collapse/truncation off. (lossless)
//   • historyTrim   — wide 120-message window, keeps opening context. (gentle)
//   • toolCompress  — trims descriptions only past 800 chars; schemas intact. (gentle)
//   • compression   — 'lite' (filler words only); never touches articles/code. (gentle)
const DEFAULT_OPTIMIZATION = {
  cacheInject:   { enabled: true },
  responseCache: { enabled: true, ttlMinutes: 60 },
  toolResults:   { enabled: true, stripAnsi: true, stripBlankLines: false, maxChars: 0 },
  historyTrim:   { enabled: true, maxMessages: 120, keepFirstN: 4 },
  toolCompress:  { enabled: true, maxDescLength: 800, stripExamples: true },
  compression:   { enabled: true, mode: 'lite' },
};

function getOptimization() {
  const o = CONFIG.optimization || {};
  // Back-compat: fold a legacy top-level CONFIG.compression into the new shape.
  const legacyCompression = (!o.compression && CONFIG.compression) ? CONFIG.compression : null;
  return {
    compression:   { ...DEFAULT_OPTIMIZATION.compression,   ...(legacyCompression || {}), ...(o.compression   || {}) },
    toolResults:   { ...DEFAULT_OPTIMIZATION.toolResults,   ...(o.toolResults   || {}) },
    historyTrim:   { ...DEFAULT_OPTIMIZATION.historyTrim,   ...(o.historyTrim   || {}) },
    toolCompress:  { ...DEFAULT_OPTIMIZATION.toolCompress,  ...(o.toolCompress  || {}) },
    cacheInject:   { ...DEFAULT_OPTIMIZATION.cacheInject,   ...(o.cacheInject   || {}) },
    responseCache: { ...DEFAULT_OPTIMIZATION.responseCache, ...(o.responseCache || {}) },
  };
}

// Live counters surfaced on the dashboard ("savings since startup").
const OPT_STATS = {
  startedAt: Date.now(),
  requests: 0,
  toolResultsFiltered: 0,
  toolResultCharsSaved: 0,
  historyMessagesTrimmed: 0,
  toolDescCharsSaved: 0,
  proseCharsSaved: 0,
  cacheBreakpointsInjected: 0,
  estTokensSaved: 0,
  responseCacheHits: 0,
  responseCacheMisses: 0,
  responseCacheStored: 0,
  responseCacheTokensSaved: 0,
  responseCacheCostSavedNano: 0,
};

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
const COOLDOWN_429_MS  = 30 * 1000;        // rate-limit: short wait, it'll clear
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
    onUsage(input, output);
  };
  res.write = (chunk, ...a) => { scan(chunk); return origWrite(chunk, ...a); };
  res.end = (chunk, ...a) => { scan(chunk); report(); return origEnd(chunk, ...a); };
  return res;
}

// Tee res.write/res.end to accumulate the FULL response body (for the response
// cache). Caps at maxBytes — past that we give up capturing (don't cache huge
// responses) but never disturb the live stream to the client. The assembled
// buffer is exposed on res._capturedBody once res.end fires.
function captureResponse(res, maxBytes = 2_000_000) {
  const origWrite = res.write.bind(res);
  const origEnd = res.end.bind(res);
  const chunks = [];
  let size = 0;
  let overflow = false;
  const take = (chunk) => {
    if (overflow || !chunk) return;
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += b.length;
    if (size > maxBytes) { overflow = true; chunks.length = 0; return; }
    chunks.push(b);
  };
  res.write = (chunk, ...a) => { take(chunk); return origWrite(chunk, ...a); };
  res.end = (chunk, ...a) => {
    take(chunk);
    res._capturedBody = overflow ? null : Buffer.concat(chunks);
    return origEnd(chunk, ...a);
  };
  return res;
}

function setAnthropicRateLimitHeaders(res, limiterState) {
  // Return synthetic generous limits so Claude Code doesn't self-throttle.
  // Use actual remaining budget from our local limiter if available.
  const limits = getLimits();
  const nowRpm = limiterState?.reqs?.length || 0;
  const nowTpm = limiterState?.tokenSum?.() || 0;
  const rpmRemaining = Math.max(0, (limits.rpm || 40000) - nowRpm);
  const tpmRemaining = Math.max(0, (limits.tpm || 2000000) - nowTpm);
  const resetTime = new Date(Date.now() + 60000).toISOString();

  res.setHeader('anthropic-ratelimit-requests-limit', String(limits.rpm || 40000));
  res.setHeader('anthropic-ratelimit-requests-remaining', String(rpmRemaining));
  res.setHeader('anthropic-ratelimit-requests-reset', resetTime);
  res.setHeader('anthropic-ratelimit-tokens-limit', String(limits.tpm || 2000000));
  res.setHeader('anthropic-ratelimit-tokens-remaining', String(tpmRemaining));
  res.setHeader('anthropic-ratelimit-tokens-reset', resetTime);
  res.setHeader('anthropic-ratelimit-input-tokens-limit', String(Math.floor((limits.tpm || 2000000) / 2)));
  res.setHeader('anthropic-ratelimit-input-tokens-remaining', String(Math.floor(tpmRemaining / 2)));
  res.setHeader('anthropic-ratelimit-output-tokens-limit', String(Math.floor((limits.tpm || 2000000) / 2)));
  res.setHeader('anthropic-ratelimit-output-tokens-remaining', String(Math.floor(tpmRemaining / 2)));
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
    setAnthropicRateLimitHeaders(res, limiter);
  }

  // Always sniff usage so analytics + cache savings have real token counts,
  // even when rate limiting is disabled.
  res = sniffUsage(res, (inputN, outputN) => {
    if (limits.enabled) limiter.recordTokens(Date.now(), inputN + outputN);
    res._analyticsInput = inputN;
    res._analyticsOutput = outputN;
  });

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

  const opt = getOptimization();

  // ── Response cache (lossless, exact-match) ─────────────────────────────
  // Key on the ORIGINAL request (pre-optimization) so identical CLI requests
  // hit regardless of current optimization settings. A hit replays the exact
  // upstream bytes (streaming SSE included) at zero upstream cost.
  const requestedModelForKey = body.model || 'claude-sonnet-4-20250514';
  let cacheKey = null;
  if (opt.responseCache.enabled) {
    cacheKey = responseCache.makeKey(requestedModelForKey, body);
    const hit = cacheKey ? responseCache.get(cacheKey) : null;
    if (hit) {
      OPT_STATS.responseCacheHits++;
      const savedTokens = (hit.inputTokens || 0) + (hit.outputTokens || 0);
      OPT_STATS.responseCacheTokensSaved += savedTokens;
      const costSaved = pricingCalc.calculateCostNano(hit.inputTokens || 0, hit.outputTokens || 0, requestedModelForKey);
      OPT_STATS.responseCacheCostSavedNano += costSaved?.cost_nano_usd || 0;
      // Record a zero-cost cache-hit request for the dashboard.
      try {
        analytics.logRequest({
          provider: 'cache', model: requestedModelForKey,
          inputTokens: hit.inputTokens || 0, outputTokens: hit.outputTokens || 0,
          cachedTokens: savedTokens, costNanoUsd: 0,
          compressionMode: 'response-cache', responseTimeMs: 0, status: 'cache_hit'
        });
      } catch {}
      // Build a fresh log entry for the hit.
      pushLog({
        id: Math.random().toString(36).slice(2, 10), ts: Date.now(),
        request: summarizeRequestBody(body), stream: !!body.stream,
        hasTools: !!(body.tools && body.tools.length), hasSystem: !!body.system,
        poolSize: 0, finalStatus: 'cache-hit', totalMs: 0,
        attempts: [{ label: 'response-cache', provider: 'cache', model: requestedModelForKey, status: 'ok', durationMs: 0 }]
      });
      console.log(`[proxy] [cache-hit] ${requestedModelForKey} saved ~${savedTokens} tokens`);
      res.writeHead(200, { 'Content-Type': hit.contentType || 'application/json' });
      return res.end(hit.body);
    }
    OPT_STATS.responseCacheMisses++;
    // On a miss, capture the full upstream response so we can store it on success.
    res = captureResponse(res, 2_000_000);
  }

  // ── Proxy-layer optimization pipeline ──────────────────────────────────
  // Runs automatically on every request. Each stage is independently gated by
  // CONFIG.optimization and tracked for savings. Ordering matters: filter and
  // trim before measuring, compress prose last, inject cache breakpoints per
  // provider (handled later in sanitizeBodyForProvider for Bedrock).
  const optApplied = [];     // human-readable list of stages that fired
  let optEstTokensSaved = 0; // rough estimate (~4 chars / token)
  OPT_STATS.requests++;

  // Stage 1 — Filter verbose tool_result blocks (strip ANSI, blank lines, cap size).
  if (opt.toolResults.enabled && Array.isArray(body.messages)) {
    const trf = new ToolResultFilter({
      stripAnsi:       opt.toolResults.stripAnsi,
      stripBlankLines: opt.toolResults.stripBlankLines,
      maxChars:        opt.toolResults.maxChars,
    });
    const r = trf.filterMessages(body.messages);
    if (r.savedChars > 0) {
      body.messages = r.messages;
      OPT_STATS.toolResultsFiltered += r.filteredCount;
      OPT_STATS.toolResultCharsSaved += r.savedChars;
      optEstTokensSaved += r.savedChars / 4;
      optApplied.push(`tool-results(-${r.savedChars}c)`);
    }
  }

  // Stage 2 — Sliding-window history trim.
  if (opt.historyTrim.enabled && Array.isArray(body.messages)) {
    const r = historyTrimmer.trim(body.messages, {
      maxMessages: opt.historyTrim.maxMessages,
      keepFirstN:  opt.historyTrim.keepFirstN,
    });
    if (r.trimmed > 0) {
      body.messages = r.messages;
      OPT_STATS.historyMessagesTrimmed += r.trimmed;
      // Estimate ~250 tokens per dropped message (conservative).
      optEstTokensSaved += r.trimmed * 250;
      optApplied.push(`history(-${r.trimmed}msg)`);
    }
  }

  // Stage 3 — Compress verbose tool descriptions.
  if (opt.toolCompress.enabled && Array.isArray(body.tools)) {
    const r = toolCompressor.compress(body.tools, {
      maxDescLength: opt.toolCompress.maxDescLength,
      stripExamples: opt.toolCompress.stripExamples,
    });
    if (r.savedChars > 0) {
      body.tools = r.tools;
      OPT_STATS.toolDescCharsSaved += r.savedChars;
      optEstTokensSaved += r.savedChars / 4;
      optApplied.push(`tool-defs(-${r.savedChars}c)`);
    }
  }

  // Stage 4 — Prose compression of system prompt + message text blocks.
  if (opt.compression.enabled) {
    const compMode = opt.compression.mode || 'lite';
    let proseSaved = 0;
    if (body.system && typeof body.system === 'string') {
      const before = body.system.length;
      body.system = compressor.compress(body.system, compMode);
      proseSaved += Math.max(0, before - body.system.length);
    }
    if (Array.isArray(body.messages)) {
      for (const msg of body.messages) {
        if (Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block && block.type === 'text' && typeof block.text === 'string') {
              const before = block.text.length;
              block.text = compressor.compress(block.text, compMode);
              proseSaved += Math.max(0, before - block.text.length);
            }
          }
        }
      }
    }
    body._compressionMode = compMode;
    if (proseSaved > 0) {
      OPT_STATS.proseCharsSaved += proseSaved;
      optEstTokensSaved += proseSaved / 4;
      optApplied.push(`prose:${compMode}(-${proseSaved}c)`);
    }
  }

  optEstTokensSaved = Math.round(optEstTokensSaved);
  OPT_STATS.estTokensSaved += optEstTokensSaved;
  body._optApplied = optApplied;
  body._optEstTokensSaved = optEstTokensSaved;
  body._cacheInject = opt.cacheInject.enabled;

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

  // Strip cache_control from providers that don't support it, and reject
  // computer-use tools for providers other than Bedrock.
  function sanitizeBodyForProvider(b, cfg) {
    const kind = cfg.kind;
    const out = { ...b };

    // NIM doesn't support cache_control — strip it from all content blocks.
    if (kind === 'nvidia') {
      if (out.system && Array.isArray(out.system)) {
        out.system = out.system.map(blk => { const { cache_control, ...rest } = blk; return rest; });
      }
      if (out.messages) {
        out.messages = out.messages.map(msg => ({
          ...msg,
          content: Array.isArray(msg.content)
            ? msg.content.map(blk => { const { cache_control, ...rest } = blk; return rest; })
            : msg.content
        }));
      }
      if (out.tools) {
        out.tools = out.tools.map(t => { const { cache_control, ...rest } = t; return rest; });
      }
    }

    // Detect computer-use tools — only Bedrock supports them.
    const hasComputerUse = (out.tools || []).some(t => t.type && t.type.startsWith('computer_'));
    if (hasComputerUse && kind !== 'bedrock') {
      throw Object.assign(
        new Error(`Computer-use tools are not supported by provider "${kind}". Use AWS Bedrock.`),
        { status: 400, stage: 'validation' }
      );
    }

    // Inject Anthropic prompt-cache breakpoints (Bedrock is the only Anthropic-
    // native path here). Cache hits on the system prompt + tool definitions cost
    // ~10% of normal input — the single biggest lever for Claude Code sessions.
    if (kind === 'bedrock' && b._cacheInject) {
      const r = cacheInjector.inject(out, kind);
      if (r.injected > 0) {
        Object.assign(out, r.body);
        OPT_STATS.cacheBreakpointsInjected += r.injected;
      }
    }

    return out;
  }

  // Round-robin + fallback with circuit breaker.
  // Members in cooldown are skipped instantly (no upstream call).
  const startIdx = poolRR;
  let tried = 0; // members actually called (not skipped)
  let skipped = 0;

  // Preserve the model name the CLI originally requested (e.g. "claude-opus-4-8").
  // The proxy overwrites body.model with the real upstream model for each attempt,
  // but the *response* must echo back the requested name so the Claude CLI doesn't
  // detect a non-Claude model and fall into degraded/simulation mode.
  const requestedModel = body.model || 'claude-sonnet-4-20250514';

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
    body._requestedModel = requestedModel;
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
      const sanitizedBody = sanitizeBodyForProvider(body, cfg);
      if (cfg.kind === 'bedrock') await callBedrock(cfg, sanitizedBody, res);
      else await callOpenAICompatible(cfg, sanitizedBody, res);
      attemptLog.durationMs = Date.now() - t0;
      stat.lastMs = attemptLog.durationMs;
      stat.consecutiveFails = 0;
      stat.cooledUntil = 0;
      poolRR = (idx + 1) % pool.length;
      logEntry.attempts.push(attemptLog);
      logEntry.totalMs = Date.now() - reqStart;
      pushLog(logEntry);
      // Log analytics after success. Token counts come from the sniffUsage
      // callback which fires on res.end(); we use setImmediate to ensure it
      // has already fired before we read the values.
      setImmediate(() => {
        try {
          const inputTokens = res._analyticsInput || 0;
          const outputTokens = res._analyticsOutput || 0;
          const costResult = pricingCalc.calculateCostNano(inputTokens, outputTokens, cfg.model);
          // Record optimizer savings so the dashboard's tokens-saved / cost-saved
          // figures reflect the proxy-layer work. original = what we *would* have
          // sent; compressed = what we actually sent.
          const saved = body._optEstTokensSaved || 0;
          const actualTokens = inputTokens + outputTokens;
          analytics.logRequest({
            provider: cfg.kind,
            model: cfg.model,
            inputTokens,
            outputTokens,
            costNanoUsd: costResult?.cost_nano_usd || 0,
            compressionMode: (body._optApplied && body._optApplied.length)
              ? (body._compressionMode || 'optimized')
              : 'none',
            originalTokenCount: actualTokens + saved,
            compressedTokenCount: actualTokens,
            responseTimeMs: attemptLog.durationMs,
            status: 'success'
          });

          // Store the captured response in the lossless cache (success only).
          if (opt.responseCache.enabled && cacheKey && res._capturedBody && res._capturedBody.length > 0) {
            const ttlMs = Math.max(0, (Number(opt.responseCache.ttlMinutes) || 0) * 60 * 1000);
            responseCache.set(cacheKey, {
              body: res._capturedBody,
              contentType: res.getHeader ? (res.getHeader('content-type') || 'application/json') : 'application/json',
              inputTokens, outputTokens, ttlMs,
              provider: cfg.kind, model: requestedModel,
            });
            OPT_STATS.responseCacheStored++;
          }
        } catch (e) {
          console.error('[proxy] [analytics] logRequest error:', e.message);
        }
      });
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

      // Circuit breaker: trip on 404 (dead model), short-cool 429 (rate limit),
      // or repeated non-transient failures.
      const is404 = /Upstream 4[0-9]{2}/.test(err.message) && err.message.includes('404');
      const is429 = /Upstream 429/.test(err.message) || (err.status === 429);
      if (is404) {
        stat.cooledUntil = Date.now() + COOLDOWN_404_MS;
        console.warn(`[proxy] [breaker] ${cfg.label} → 404 (model gone), cooldown 1h`);
      } else if (is429) {
        // 429 = rate limit. Don't count toward consecutiveFails (it's transient).
        // Use a short cooldown so other pool members get a chance.
        stat.cooledUntil = Date.now() + COOLDOWN_429_MS;
        // Don't increment consecutiveFails — rate limits aren't model failures.
        stat.consecutiveFails = Math.max(0, (stat.consecutiveFails || 0) - 1);
        console.warn(`[proxy] [breaker] ${cfg.label} → 429 (rate limited), short cooldown 30s`);
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

async function handleCountTokens(req, res) {
  try {
    const body = await readJSONBody(req);
    const tokens = tokenCounter.estimateTokens(JSON.stringify(body), { provider: 'anthropic' });
    send(res, 200, { input_tokens: tokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });
  } catch (err) {
    send(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: err.message } });
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

function handleCompressionGet(_req, res) {
  send(res, 200, getOptimization().compression);
}

async function handleCompressionPost(req, res) {
  const body = await readJSONBody(req);
  CONFIG.optimization = CONFIG.optimization || {};
  CONFIG.optimization.compression = { ...getOptimization().compression };
  if (typeof body.enabled === 'boolean') CONFIG.optimization.compression.enabled = body.enabled;
  if (body.mode && typeof body.mode === 'string') CONFIG.optimization.compression.mode = body.mode;
  delete CONFIG.compression; // retire the legacy top-level key
  saveConfig(CONFIG);
  send(res, 200, { ok: true, compression: CONFIG.optimization.compression });
}

// ---- Unified optimization config + live stats ----

function handleOptimizationGet(_req, res) {
  send(res, 200, { optimization: getOptimization(), defaults: DEFAULT_OPTIMIZATION });
}

async function handleOptimizationPost(req, res) {
  const body = await readJSONBody(req);
  const incoming = body.optimization || body;
  const current = getOptimization();
  const next = {};
  // Deep-merge each known section; ignore unknown keys.
  for (const section of Object.keys(DEFAULT_OPTIMIZATION)) {
    next[section] = { ...current[section], ...(incoming[section] || {}) };
  }
  // Coerce numeric fields defensively.
  next.toolResults.maxChars       = Math.max(0, Number(next.toolResults.maxChars)       || 0);
  next.historyTrim.maxMessages    = Math.max(2, Number(next.historyTrim.maxMessages)    || 2);
  next.historyTrim.keepFirstN     = Math.max(0, Number(next.historyTrim.keepFirstN)     || 0);
  next.toolCompress.maxDescLength = Math.max(40, Number(next.toolCompress.maxDescLength) || 40);
  next.responseCache.ttlMinutes   = Math.max(0, Number(next.responseCache.ttlMinutes)   || 0);
  CONFIG.optimization = next;
  delete CONFIG.compression;
  saveConfig(CONFIG);
  send(res, 200, { ok: true, optimization: getOptimization() });
}

function handleOptimizationStats(_req, res) {
  const uptimeMs = Date.now() - OPT_STATS.startedAt;
  const totalCharsSaved = OPT_STATS.toolResultCharsSaved + OPT_STATS.toolDescCharsSaved + OPT_STATS.proseCharsSaved;
  // Cost-saved estimate: optimizer-saved tokens at a representative input rate
  // (~$3 / 1M) plus the actual cost avoided by response-cache hits.
  const estCostSavedUsd = (OPT_STATS.estTokensSaved / 1e6) * 3.0 + (OPT_STATS.responseCacheCostSavedNano / 1e9);
  const cacheStats = store.cacheStats();
  const hitRate = (OPT_STATS.responseCacheHits + OPT_STATS.responseCacheMisses) > 0
    ? OPT_STATS.responseCacheHits / (OPT_STATS.responseCacheHits + OPT_STATS.responseCacheMisses)
    : 0;
  send(res, 200, {
    ...OPT_STATS,
    uptimeMs,
    totalCharsSaved,
    estCostSavedUsd: Number(estCostSavedUsd.toFixed(6)),
    storeBackend: store.info().backend,
    storeFile: store.info().dbFile,
    cache: { ...cacheStats, hitRate: Number(hitRate.toFixed(3)) },
  });
}

function handleCacheClear(_req, res) {
  try { store.cacheClear(); OPT_STATS.responseCacheStored = 0; send(res, 200, { ok: true }); }
  catch (e) { send(res, 500, { ok: false, error: e.message }); }
}

async function handleAnalyticsGet(_req, res) {
  try {
    const [sessionStats, lifetimeStats, history] = await Promise.all([
      analytics.getSessionStats(),
      analytics.getLifetimeStats(),
      analytics.getRequestHistory(null, 100)
    ]);
    send(res, 200, { session: sessionStats, lifetime: lifetimeStats, history });
  } catch (err) {
    send(res, 500, { error: err.message });
  }
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

  const pythonPath = installer.detectPython ? installer.detectPython() : null;
  const pythonVer = pythonPath ? probeVersion(pythonPath) : null;
  const python = { path: pythonPath, version: pythonVer, ok: !!pythonPath };

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
    components: { node, npm, claude, python },
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

// Anthropic /v1/models response — Claude Code may query this to confirm the API is reachable.
function handleV1Models(_req, res) {
  // Surface a realistic-looking Claude model list so Claude Code doesn't fall into
  // degraded mode. The actual upstream model is transparent to the CLI.
  // Include max_input_tokens, max_tokens, capabilities so the SDK can use them.
  const provider = CONFIG.provider;
  // Determine capabilities based on active provider.
  const supportsComputerUse   = provider === 'bedrock'; // Only Bedrock supports computer-use
  const supportsThinking      = provider !== 'nvidia';  // NIM doesn't support extended thinking
  const supportsPromptCaching = provider !== 'nvidia';  // NIM doesn't support prompt caching
  const supportsVision        = provider !== 'nvidia';  // NIM has limited vision support

  const data = [
    { type: 'model', id: 'claude-opus-4-20250514',    display_name: 'Claude Opus 4',      created_at: '2025-05-14T00:00:00Z', max_input_tokens: 200000, max_tokens: 32000, capabilities: { vision: supportsVision, tool_use: true, extended_thinking: supportsThinking, computer_use: supportsComputerUse, prompt_caching: supportsPromptCaching } },
    { type: 'model', id: 'claude-opus-4-8',            display_name: 'Claude Opus 4.8',    created_at: '2025-05-14T00:00:00Z', max_input_tokens: 200000, max_tokens: 32000, capabilities: { vision: supportsVision, tool_use: true, extended_thinking: supportsThinking, computer_use: supportsComputerUse, prompt_caching: supportsPromptCaching } },
    { type: 'model', id: 'claude-sonnet-4-20250514',   display_name: 'Claude Sonnet 4',    created_at: '2025-05-14T00:00:00Z', max_input_tokens: 200000, max_tokens: 16000, capabilities: { vision: supportsVision, tool_use: true, extended_thinking: supportsThinking, computer_use: false, prompt_caching: supportsPromptCaching } },
    { type: 'model', id: 'claude-sonnet-4-6',          display_name: 'Claude Sonnet 4.6',  created_at: '2025-05-14T00:00:00Z', max_input_tokens: 200000, max_tokens: 16000, capabilities: { vision: supportsVision, tool_use: true, extended_thinking: supportsThinking, computer_use: false, prompt_caching: supportsPromptCaching } },
    { type: 'model', id: 'claude-haiku-4-5-20251001',  display_name: 'Claude Haiku 4.5',   created_at: '2025-10-01T00:00:00Z', max_input_tokens: 200000, max_tokens: 16000, capabilities: { vision: supportsVision, tool_use: true, extended_thinking: false, computer_use: false, prompt_caching: supportsPromptCaching } },
    { type: 'model', id: 'claude-3-5-sonnet-20241022', display_name: 'Claude 3.5 Sonnet',  created_at: '2024-10-22T00:00:00Z', max_input_tokens: 200000, max_tokens: 8192,  capabilities: { vision: supportsVision, tool_use: true, extended_thinking: false, computer_use: false, prompt_caching: supportsPromptCaching } },
    { type: 'model', id: 'claude-fable-5',             display_name: 'Claude Fable 5',     created_at: '2026-01-01T00:00:00Z', max_input_tokens: 200000, max_tokens: 32000, capabilities: { vision: supportsVision, tool_use: true, extended_thinking: supportsThinking, computer_use: supportsComputerUse, prompt_caching: supportsPromptCaching } },
  ];
  send(res, 200, { data, has_more: false, first_id: data[0].id, last_id: data[data.length - 1].id });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');

  // CORS — Claude Code and browser-based tests may call from different origins.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, anthropic-version, anthropic-beta');
  // request-id — echo back client's id if provided, otherwise generate one.
  const clientReqId = req.headers['request-id'] || req.headers['x-request-id'];
  const proxyReqId = clientReqId || `proxy-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  res.setHeader('request-id', proxyReqId);
  res.setHeader('x-request-id', proxyReqId);
  // anthropic-version — expected by Claude Code SDK on every response.
  res.setHeader('anthropic-version', '2023-06-01');
  res.setHeader('cache-control', 'private, no-cache');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  try {
    if (req.method === 'POST' && (u.pathname === '/v1/messages' || u.pathname === '/messages')) {
      return await handleMessages(req, res);
    }
    if (req.method === 'POST' && u.pathname === '/v1/messages/count_tokens') {
      return await handleCountTokens(req, res);
    }
    // /v1/models — Claude Code Anthropic SDK may query this on startup.
    if (u.pathname === '/v1/models' && req.method === 'GET') return handleV1Models(req, res);
    if (u.pathname === '/api/models') return send(res, 200, MODELS);
    if (u.pathname === '/api/system' && req.method === 'GET') return await handleSystem(req, res);
    if (u.pathname === '/api/install' && req.method === 'POST') return await handleInstall(req, res);
    if (u.pathname === '/api/config' && req.method === 'GET') return handleConfigGet(req, res);
    if (u.pathname === '/api/config' && req.method === 'POST') return await handleConfigPost(req, res);
    if (u.pathname === '/api/test' && req.method === 'POST') return await handleTest(req, res);
    if (u.pathname === '/api/limits' && req.method === 'GET') return handleLimitsGet(req, res);
    if (u.pathname === '/api/limits' && req.method === 'POST') return await handleLimitsPost(req, res);
    if (u.pathname === '/api/compression' && req.method === 'GET') return handleCompressionGet(req, res);
    if (u.pathname === '/api/compression' && req.method === 'POST') return await handleCompressionPost(req, res);
    if (u.pathname === '/api/optimization' && req.method === 'GET') return handleOptimizationGet(req, res);
    if (u.pathname === '/api/optimization' && req.method === 'POST') return await handleOptimizationPost(req, res);
    if (u.pathname === '/api/optimization/stats' && req.method === 'GET') return handleOptimizationStats(req, res);
    if (u.pathname === '/api/cache/clear' && req.method === 'POST') return handleCacheClear(req, res);
    if (u.pathname === '/api/analytics' && req.method === 'GET') return await handleAnalyticsGet(req, res);
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

    // ---- Dashboard analytics routes (read-only data for the Dashboard tab) ----
    const dashKey = `${req.method} ${u.pathname}`;
    if (DASHBOARD_ROUTES[dashKey]) return DASHBOARD_ROUTES[dashKey](req, res, dashDeps);

    // Legacy redirect: the dashboard now lives as a tab in the main UI.
    if (u.pathname === '/dashboard' && req.method === 'GET') {
      res.writeHead(302, { Location: '/#dashboard' });
      return res.end();
    }

    return serveStatic(req, res);
  } catch (err) {
    console.error('[proxy] unhandled:', err);
    if (!res.headersSent) send(res, 500, { error: String(err.message || err) });
  }
});

const PORT = parseInt(process.env.PORT || '8787', 10);
const HOST = process.env.HOST || '127.0.0.1';

analytics.startSession();

server.listen(PORT, HOST, () => {
  console.log(`\nProxy-Max running`);
  console.log(`  UI:        http://${HOST}:${PORT}/  (dashboard, optimization & config all here)`);
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

process.on('SIGINT', async () => {
  console.log('\n[proxy] shutting down...');
  try {
    await analytics.endSession();
    await analytics.close();
  } catch (e) {
    console.error('[proxy] analytics shutdown error:', e.message);
  }
  server.close(() => process.exit(0));
});
