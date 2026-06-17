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
      total_context_input_tokens: 0,
      total_billable_input_tokens: 0,
      total_cache_read_input_tokens: 0,
      total_cache_creation_input_tokens: 0,
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
      cacheCreationInputTokens = 0,
      billableInputTokens = null,
      totalInputTokens = null,
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
      cache_creation_input_tokens: cacheCreationInputTokens,
      billable_input_tokens: billableInputTokens == null ? inputTokens + cachedTokens + cacheCreationInputTokens : billableInputTokens,
      total_input_tokens: totalInputTokens == null ? inputTokens + cachedTokens + cacheCreationInputTokens : totalInputTokens,
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
      sess.total_context_input_tokens = (sess.total_context_input_tokens || 0) + row.total_input_tokens;
      sess.total_billable_input_tokens = (sess.total_billable_input_tokens || 0) + row.billable_input_tokens;
      sess.total_cache_read_input_tokens = (sess.total_cache_read_input_tokens || 0) + cachedTokens;
      sess.total_cache_creation_input_tokens = (sess.total_cache_creation_input_tokens || 0) + cacheCreationInputTokens;
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
  getSessionStats(sessionId = null, pricingCalc = null) {
    const sid = sessionId || this.sessionId;
    const sess = this._store.sessions[sid] || {};
    return Promise.resolve(this._recalculateStatsFromLogs([sess], sid, pricingCalc));
  }

  /**
   * Get request history for session
   */
  getRequestHistory(sessionId = null, limit = 100) {
    const logs = sessionId
      ? this._store.request_logs.filter(r => r.session_id === sessionId)
      : this._store.request_logs;
    return Promise.resolve(logs.slice(-limit).reverse());
  }

  /**
   * Get provider breakdown
   */
  getProviderBreakdown(sessionId = null, pricingCalc = null) {
    const logs = sessionId
      ? this._store.request_logs.filter(r => r.session_id === sessionId)
      : this._store.request_logs;
    const map = {};
    for (const r of logs) {
      const key = r.provider || 'unknown';
      if (!map[key]) map[key] = { provider: key, request_count: 0, total_input: 0, total_context_input: 0, total_billable_input: 0, total_cache_read_input: 0, total_cache_creation_input: 0, total_output: 0, total_cost_nano: 0 };
      map[key].request_count += 1;
      map[key].total_input += r.input_tokens || 0;
      map[key].total_context_input += r.total_input_tokens || ((r.input_tokens || 0) + (r.cached_tokens || 0) + (r.cache_creation_input_tokens || 0));
      map[key].total_billable_input += r.billable_input_tokens || ((r.input_tokens || 0) + (r.cached_tokens || 0) + (r.cache_creation_input_tokens || 0));
      map[key].total_cache_read_input += r.cached_tokens || 0;
      map[key].total_cache_creation_input += r.cache_creation_input_tokens || 0;
      map[key].total_output += r.output_tokens || 0;
      map[key].total_cost_nano += (r.cost_nano_usd || this._estimatedCostNano(pricingCalc, r));
    }
    const rows = Object.values(map).sort((a, b) => b.total_cost_nano - a.total_cost_nano);
    return Promise.resolve(rows);
  }

  /**
   * Get model breakdown
   */
  getModelBreakdown(sessionId = null, pricingCalc = null) {
    const logs = sessionId
      ? this._store.request_logs.filter(r => r.session_id === sessionId)
      : this._store.request_logs;
    const map = {};
    for (const r of logs) {
      const key = r.model || 'unknown';
      if (!map[key]) map[key] = {
        model: key, provider: r.provider || 'unknown', request_count: 0, success_count: 0, error_count: 0,
        total_input: 0, total_context_input: 0, total_billable_input: 0, total_cache_read_input: 0,
        total_cache_creation_input: 0, total_output: 0, total_cost_nano: 0, tokens_saved: 0,
        total_response_time_ms: 0, min_response_time_ms: 0, max_response_time_ms: 0, latest_response_time_ms: 0,
        latest_at: 0, cache_hit_count: 0, estimated_usage_count: 0, estimated_pricing_count: 0,
        compression_modes: {}
      };
      const row = map[key];
      row.request_count += 1;
      if (String(r.status || '').includes('error') || String(r.status || '') === 'failed') row.error_count += 1;
      else row.success_count += 1;
      row.total_input += r.input_tokens || 0;
      row.total_context_input += r.total_input_tokens || ((r.input_tokens || 0) + (r.cached_tokens || 0) + (r.cache_creation_input_tokens || 0));
      row.total_billable_input += r.billable_input_tokens || ((r.input_tokens || 0) + (r.cached_tokens || 0) + (r.cache_creation_input_tokens || 0));
      row.total_cache_read_input += r.cached_tokens || 0;
      row.total_cache_creation_input += r.cache_creation_input_tokens || 0;
      row.total_output += r.output_tokens || 0;
      row.total_cost_nano += (r.cost_nano_usd || this._estimatedCostNano(pricingCalc, r));
      row.tokens_saved += Math.max(0, (r.original_token_count || 0) - (r.compressed_token_count || 0));
      const ms = Math.max(0, Number(r.response_time_ms) || 0);
      if (ms) {
        row.total_response_time_ms += ms;
        row.min_response_time_ms = row.min_response_time_ms ? Math.min(row.min_response_time_ms, ms) : ms;
        row.max_response_time_ms = Math.max(row.max_response_time_ms || 0, ms);
      }
      if ((r.timestamp || 0) >= (row.latest_at || 0)) {
        row.latest_at = r.timestamp || 0;
        row.latest_response_time_ms = ms;
        if (r.provider && r.provider !== 'cache') row.provider = r.provider;
      }
      if (r.status === 'cache_hit' || r.compression_mode === 'response-cache') row.cache_hit_count += 1;
      if (r.upstream?.usageEstimated) row.estimated_usage_count += 1;
      if (r.upstream?.pricingEstimated) row.estimated_pricing_count += 1;
      const mode = r.compression_mode || 'none';
      row.compression_modes[mode] = (row.compression_modes[mode] || 0) + 1;
    }
    const rows = Object.values(map).map(row => ({
      ...row,
      avg_response_time_ms: row.request_count ? Math.round(row.total_response_time_ms / row.request_count) : 0,
      error_rate: row.request_count ? Number((row.error_count / row.request_count).toFixed(3)) : 0,
      cache_hit_rate: row.request_count ? Number((row.cache_hit_count / row.request_count).toFixed(3)) : 0,
      tokens_per_request: row.request_count ? Math.round((row.total_context_input + row.total_output) / row.request_count) : 0,
    })).sort((a, b) => b.total_cost_nano - a.total_cost_nano);
    return Promise.resolve(rows);
  }

  /**
   * Get compression impact
   */
  getCompressionStats(sessionId = null) {
    const logs = sessionId
      ? this._store.request_logs.filter(r => r.session_id === sessionId)
      : this._store.request_logs;
    const map = {};
    for (const r of logs) {
      const key = r.compression_mode || 'none';
      if (!map[key]) map[key] = { compression_mode: key, request_count: 0, original_tokens: 0, compressed_tokens: 0, tokens_saved: 0 };
      map[key].request_count += 1;
      map[key].original_tokens += r.original_token_count || 0;
      map[key].compressed_tokens += r.compressed_token_count || 0;
      map[key].tokens_saved += Math.max(0, (r.original_token_count || 0) - (r.compressed_token_count || 0));
    }
    const rows = Object.values(map).sort((a, b) => b.tokens_saved - a.tokens_saved);
    return Promise.resolve(rows);
  }

  _estimatedCostNano(pricingCalc, r) {
    if (!pricingCalc) return 0;
    const input = Math.max(0, Number(r.input_tokens) || 0);
    const output = Math.max(0, Number(r.output_tokens) || 0);
    const cachedTokens = Math.max(0, Number(r.cached_tokens) || 0);
    const cacheCreationTokens = Math.max(0, Number(r.cache_creation_input_tokens) || 0);
    if (input + output + cachedTokens + cacheCreationTokens <= 0) return 0;
    return pricingCalc.calculateCostNano(input, output, r.model || 'unknown', { cachedTokens, cacheCreationTokens })?.cost_nano_usd || 0;
  }

  _recalculateStatsFromLogs(sessions, sessionId = null, pricingCalc = null) {
    const logs = sessionId
      ? this._store.request_logs.filter(r => r.session_id === sessionId)
      : this._store.request_logs;
    const result = {
      total_sessions: sessions.filter(Boolean).length,
      total_requests: logs.length,
      total_input_tokens: 0,
      total_context_input_tokens: 0,
      total_billable_input_tokens: 0,
      total_cache_read_input_tokens: 0,
      total_cache_creation_input_tokens: 0,
      total_output_tokens: 0,
      total_cost_nano_usd: 0,
      total_tokens_saved: 0,
      estimated_usage_requests: 0,
      estimated_pricing_requests: 0,
    };
    for (const r of logs) {
      const uncachedInput = r.input_tokens || 0;
      const cacheReadInput = r.cached_tokens || 0;
      const cacheCreationInput = r.cache_creation_input_tokens || 0;
      result.total_input_tokens += uncachedInput;
      result.total_context_input_tokens += r.total_input_tokens || (uncachedInput + cacheReadInput + cacheCreationInput);
      result.total_billable_input_tokens += r.billable_input_tokens || (uncachedInput + cacheReadInput + cacheCreationInput);
      result.total_cache_read_input_tokens += cacheReadInput;
      result.total_cache_creation_input_tokens += cacheCreationInput;
      result.total_output_tokens += r.output_tokens || 0;
      const actualCost = r.cost_nano_usd || 0;
      const estimatedCost = actualCost || this._estimatedCostNano(pricingCalc, r);
      result.total_cost_nano_usd += estimatedCost;
      result.total_tokens_saved += Math.max(0, (r.original_token_count || 0) - (r.compressed_token_count || 0));
      if (r.upstream?.usageEstimated) result.estimated_usage_requests += 1;
      if (r.upstream?.pricingEstimated || (!actualCost && estimatedCost)) result.estimated_pricing_requests += 1;
    }
    if (logs.length === 0 && sessions.length === 1 && sessions[0]) {
      const s = sessions[0];
      result.total_requests = s.total_requests || 0;
      result.total_input_tokens = s.total_input_tokens || 0;
      result.total_context_input_tokens = s.total_context_input_tokens || result.total_input_tokens;
      result.total_billable_input_tokens = s.total_billable_input_tokens || result.total_context_input_tokens;
      result.total_cache_read_input_tokens = s.total_cache_read_input_tokens || 0;
      result.total_cache_creation_input_tokens = s.total_cache_creation_input_tokens || 0;
      result.total_output_tokens = s.total_output_tokens || 0;
      result.total_cost_nano_usd = s.total_cost_nano_usd || 0;
      result.total_tokens_saved = s.total_tokens_saved || 0;
    }
    return result;
  }

  /**
   * Get lifetime statistics across all sessions
   */
  getLifetimeStats(pricingCalc = null) {
    return Promise.resolve(this._recalculateStatsFromLogs(Object.values(this._store.sessions), null, pricingCalc));
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

  backfillMissingUsageAndCost({ pricingCalc, defaultProvider = 'azure', defaultModel = 'unknown' } = {}) {
    if (!pricingCalc) return { updated: 0 };
    let updated = 0;
    for (const r of this._store.request_logs) {
      const original = r.original_token_count || 0;
      const compressed = r.compressed_token_count || 0;
      let input = Math.max(0, Number(r.input_tokens) || 0);
      let output = Math.max(0, Number(r.output_tokens) || 0);
      let changed = false;

      if (input === 0 && original > output) {
        input = Math.max(0, compressed - output, original - Math.max(0, original - compressed) - output);
        r.input_tokens = input;
        changed = true;
      }
      if ((r.cost_nano_usd || 0) === 0 && (input + output) > 0) {
        const cost = pricingCalc.calculateCostNano(input, output, r.model || defaultModel);
        r.cost_nano_usd = cost?.cost_nano_usd || 0;
        r.upstream = { ...(r.upstream || {}), usageEstimated: true, pricingEstimated: !!cost?.pricing_estimated };
        changed = true;
      }
      if (!r.provider) { r.provider = defaultProvider; changed = true; }
      if (!r.model) { r.model = defaultModel; changed = true; }
      if (changed) updated++;
    }
    if (updated) this._save();
    return { updated };
  }

  /**
   * Close (no-op for file-based storage; kept for API compatibility)
   */
  close() {
    return Promise.resolve();
  }
}

module.exports = AnalyticsEngine;
