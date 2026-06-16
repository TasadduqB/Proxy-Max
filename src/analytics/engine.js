/**
 * Analytics Engine - Session tracking, lifetime metrics, recommendations
 * Storage: JSON file at ~/.proxy-max/analytics.json (no native deps)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const DATA_DIR = path.join(os.homedir(), '.proxy-max');
const DATA_FILE = path.join(DATA_DIR, 'analytics.json');

const EMPTY_STORE = () => ({
  sessions: {},          // { [sessionId]: sessionRow }
  request_logs: [],      // array of request rows
  optimization_opportunities: [], // array of opportunity rows
  _nextLogId: 1,
  _nextOppId: 1,
});

class AnalyticsEngine {
  /**
   * @param {string|null} dataPath  JSON file path (used when no SQLite store)
   * @param {object|null} store     optional SqliteStore — analytics persist into
   *                                 its `kv` table under 'analytics' when present
   */
  constructor(dataPath = null, store = null) {
    this.dataPath = dataPath || DATA_FILE;
    this.store = store && store.ready() ? store : null;
    this.sessionId = null;
    this.sessionStartTime = null;
    this._store = null;
    this._load();
  }

  backend() { return this.store ? this.store.backend : 'json-file'; }

  // ---- internal persistence ----

  _load() {
    // Prefer the shared SQLite store when available.
    if (this.store) {
      try {
        let parsed = this.store.kvGet('analytics');
        // One-time migration: if the store has no analytics yet but a legacy
        // JSON file exists, seed from it so prior history isn't lost.
        if (!parsed) {
          try {
            const legacy = JSON.parse(fs.readFileSync(this.dataPath, 'utf8'));
            if (legacy && (legacy.sessions || legacy.request_logs)) {
              parsed = legacy;
              this.store.kvSet('analytics', Object.assign(EMPTY_STORE(), legacy));
            }
          } catch { /* no legacy file */ }
        }
        this._store = parsed ? Object.assign(EMPTY_STORE(), parsed) : EMPTY_STORE();
        return;
      } catch { this._store = EMPTY_STORE(); return; }
    }
    try {
      fs.mkdirSync(path.dirname(this.dataPath), { recursive: true });
    } catch { /* already exists */ }
    try {
      const raw = fs.readFileSync(this.dataPath, 'utf8');
      this._store = Object.assign(EMPTY_STORE(), JSON.parse(raw));
    } catch {
      this._store = EMPTY_STORE();
    }
  }

  _save() {
    if (this.store) {
      try { this.store.kvSet('analytics', this._store); return; }
      catch (e) { /* fall through to file */ }
    }
    try {
      fs.mkdirSync(path.dirname(this.dataPath), { recursive: true });
      fs.writeFileSync(this.dataPath, JSON.stringify(this._store, null, 2), 'utf8');
    } catch (e) {
      console.error('[analytics] save error:', e.message);
    }
  }

  // ---- public API (mirrors the original SQLite-based engine) ----

  /**
   * Start new session
   */
  startSession(sessionId = null) {
    this.sessionId = sessionId || `session_${Date.now()}`;
    this.sessionStartTime = Date.now();

    this._store.sessions[this.sessionId] = {
      id: this.sessionId,
      start_time: this.sessionStartTime,
      end_time: null,
      total_requests: 0,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cost_nano_usd: 0,
      total_tokens_saved: 0,
      compression_enabled: 1,
    };
    this._save();
    return this.sessionId;
  }

  /**
   * Log individual request
   */
  logRequest(data) {
    const {
      provider,
      model,
      inputTokens = 0,
      outputTokens = 0,
      cachedTokens = 0,
      costNanoUsd = 0,
      compressionMode = 'none',
      originalTokenCount = null,
      compressedTokenCount = null,
      responseTimeMs = 0,
      status = 'success',
      upstream = null,
    } = data;

    const originalCount = originalTokenCount || inputTokens + outputTokens;
    const compressedCount = compressedTokenCount || inputTokens + outputTokens;
    const tokensSaved = originalCount - compressedCount;

    const row = {
      id: this._store._nextLogId++,
      session_id: this.sessionId,
      timestamp: Date.now(),
      provider,
      model,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cached_tokens: cachedTokens,
      cost_nano_usd: costNanoUsd,
      compression_mode: compressionMode,
      original_token_count: originalCount,
      compressed_token_count: compressedCount,
      response_time_ms: responseTimeMs,
      status,
      upstream,
    };
    this._store.request_logs.push(row);

    // Keep log from growing unboundedly (keep last 10 000 rows).
    if (this._store.request_logs.length > 10000) {
      this._store.request_logs = this._store.request_logs.slice(-10000);
    }

    // Update session totals.
    const sess = this._store.sessions[this.sessionId];
    if (sess) {
      sess.total_requests += 1;
      sess.total_input_tokens += inputTokens;
      sess.total_output_tokens += outputTokens;
      sess.total_cost_nano_usd += costNanoUsd;
      sess.total_tokens_saved += tokensSaved;
    }

    this._save();
  }

  /**
   * Record optimization opportunity
   */
  logOpportunity(command, currentTokens, estimatedReduced, suggestedFilter = null) {
    const savingsPct = currentTokens > 0
      ? ((currentTokens - estimatedReduced) / currentTokens) * 100
      : 0;

    this._store.optimization_opportunities.push({
      id: this._store._nextOppId++,
      session_id: this.sessionId,
      command,
      current_output_tokens: currentTokens,
      estimated_reduced_tokens: estimatedReduced,
      savings_pct: savingsPct,
      suggested_filter: suggestedFilter,
      timestamp: Date.now(),
    });

    // Keep last 1 000 opportunities.
    if (this._store.optimization_opportunities.length > 1000) {
      this._store.optimization_opportunities = this._store.optimization_opportunities.slice(-1000);
    }

    this._save();
  }

  /**
   * Get session statistics
   */
  getSessionStats(sessionId = null) {
    const sid = sessionId || this.sessionId;
    return Promise.resolve(this._store.sessions[sid] || {});
  }

  /**
   * Get request history for session
   */
  getRequestHistory(sessionId = null, limit = 100) {
    const sid = sessionId || this.sessionId;
    const rows = this._store.request_logs
      .filter(r => r.session_id === sid)
      .slice(-limit)
      .reverse();
    return Promise.resolve(rows);
  }

  /**
   * Get provider breakdown
   */
  getProviderBreakdown(sessionId = null) {
    const sid = sessionId || this.sessionId;
    const map = {};
    for (const r of this._store.request_logs) {
      if (r.session_id !== sid) continue;
      const key = r.provider || 'unknown';
      if (!map[key]) map[key] = { provider: key, request_count: 0, total_input: 0, total_output: 0, total_cost_nano: 0 };
      map[key].request_count += 1;
      map[key].total_input += r.input_tokens;
      map[key].total_output += r.output_tokens;
      map[key].total_cost_nano += r.cost_nano_usd;
    }
    const rows = Object.values(map).sort((a, b) => b.total_cost_nano - a.total_cost_nano);
    return Promise.resolve(rows);
  }

  /**
   * Get model breakdown
   */
  getModelBreakdown(sessionId = null) {
    const sid = sessionId || this.sessionId;
    const map = {};
    for (const r of this._store.request_logs) {
      if (r.session_id !== sid) continue;
      const key = r.model || 'unknown';
      if (!map[key]) map[key] = { model: key, request_count: 0, total_input: 0, total_output: 0, total_cost_nano: 0, tokens_saved: 0 };
      map[key].request_count += 1;
      map[key].total_input += r.input_tokens;
      map[key].total_output += r.output_tokens;
      map[key].total_cost_nano += r.cost_nano_usd;
      map[key].tokens_saved += (r.compressed_token_count - r.original_token_count);
    }
    const rows = Object.values(map).sort((a, b) => b.total_cost_nano - a.total_cost_nano);
    return Promise.resolve(rows);
  }

  /**
   * Get compression impact
   */
  getCompressionStats(sessionId = null) {
    const sid = sessionId || this.sessionId;
    const map = {};
    for (const r of this._store.request_logs) {
      if (r.session_id !== sid) continue;
      const key = r.compression_mode || 'none';
      if (!map[key]) map[key] = { compression_mode: key, request_count: 0, original_tokens: 0, compressed_tokens: 0, tokens_saved: 0 };
      map[key].request_count += 1;
      map[key].original_tokens += r.original_token_count;
      map[key].compressed_tokens += r.compressed_token_count;
      map[key].tokens_saved += (r.original_token_count - r.compressed_token_count);
    }
    const rows = Object.values(map).sort((a, b) => b.tokens_saved - a.tokens_saved);
    return Promise.resolve(rows);
  }

  /**
   * Get lifetime statistics across all sessions
   */
  getLifetimeStats() {
    const sessions = Object.values(this._store.sessions);
    const result = {
      total_sessions: sessions.length,
      total_requests: 0,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cost_nano_usd: 0,
      total_tokens_saved: 0,
    };
    for (const s of sessions) {
      result.total_requests += s.total_requests || 0;
      result.total_input_tokens += s.total_input_tokens || 0;
      result.total_output_tokens += s.total_output_tokens || 0;
      result.total_cost_nano_usd += s.total_cost_nano_usd || 0;
      result.total_tokens_saved += s.total_tokens_saved || 0;
    }
    return Promise.resolve(result);
  }

  /**
   * Get top optimization opportunities
   */
  getOptimizationOpportunities(limit = 10) {
    const rows = this._store.optimization_opportunities
      .slice()
      .sort((a, b) => b.savings_pct - a.savings_pct)
      .slice(0, limit);
    return Promise.resolve(rows);
  }

  /**
   * End session
   */
  endSession(sessionId = null) {
    const sid = sessionId || this.sessionId;
    const sess = this._store.sessions[sid];
    if (sess) {
      sess.end_time = Date.now();
      this._save();
    }
    return Promise.resolve();
  }

  /**
   * Close (no-op for file-based storage; kept for API compatibility)
   */
  close() {
    return Promise.resolve();
  }
}

module.exports = AnalyticsEngine;
