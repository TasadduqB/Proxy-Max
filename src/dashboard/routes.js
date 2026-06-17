/**
 * Dashboard API Routes - plain http handler functions (no Express)
 *
 * Exports an object keyed by "METHOD /path".
 * Each value is: async (req, res, { analytics, tokenCounter, pricingCalc, compressor }) => void
 *
 * Handlers use res.writeHead + res.end instead of res.json / res.status.
 */

const { BUILTIN_FILTERS } = require('../output-filters/filter');

// ---- helpers ----

function jsonOk(res, body) {
  const data = JSON.stringify(body);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(data);
}

function jsonErr(res, status, message) {
  const data = JSON.stringify({ error: message });
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

// ---- route handlers ----

const DASHBOARD_ROUTES = {

  // === OVERVIEW TAB ===
  'GET /api/dashboard/overview': async (req, res, { analytics, pricingCalc }) => {
    try {
      const sessionStats    = await analytics.getSessionStats(null, pricingCalc);
      const lifetimeStats   = await analytics.getLifetimeStats(pricingCalc);
      const requestHistory  = await analytics.getRequestHistory(null, 10);
      jsonOk(res, {
        current_session: sessionStats,
        lifetime: lifetimeStats,
        recent_requests: requestHistory,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      jsonErr(res, 500, err.message);
    }
  },

  // === TOKEN USAGE TAB ===
  'GET /api/dashboard/token-usage': async (req, res, { analytics, pricingCalc }) => {
    try {
      const modelBreakdown    = await analytics.getModelBreakdown(null, pricingCalc);
      const compressionStats  = await analytics.getCompressionStats();
      const formatted = modelBreakdown.map(m => ({
        ...m,
        reduction_pct: m.tokens_saved && (m.total_context_input + m.total_output + m.tokens_saved)
          ? ((m.tokens_saved / (m.total_context_input + m.total_output + m.tokens_saved)) * 100).toFixed(1)
          : '0',
      }));
      jsonOk(res, { by_model: formatted, by_compression_mode: compressionStats });
    } catch (err) {
      jsonErr(res, 500, err.message);
    }
  },

  'GET /api/dashboard/model-diagnostics': async (req, res, { analytics, pricingCalc }) => {
    try {
      const models = await analytics.getModelBreakdown(null, pricingCalc);
      jsonOk(res, {
        models: models.map(m => ({
          ...m,
          cost_usd: (m.total_cost_nano / 1e9).toFixed(6),
          cost_formatted: pricingCalc.formatCost(m.total_cost_nano),
        })),
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      jsonErr(res, 500, err.message);
    }
  },

  // === COST ANALYTICS TAB ===
  'GET /api/dashboard/cost-analytics': async (req, res, { analytics, pricingCalc }) => {
    try {
      const providerBreakdown = await analytics.getProviderBreakdown(null, pricingCalc);
      const modelBreakdown    = await analytics.getModelBreakdown(null, pricingCalc);
      const lifetimeStats     = await analytics.getLifetimeStats(pricingCalc);
      jsonOk(res, {
        by_provider: providerBreakdown.map(p => ({
          ...p,
          cost_usd: (p.total_cost_nano / 1e9).toFixed(6),
          cost_formatted: pricingCalc.formatCost(p.total_cost_nano),
        })),
        by_model: modelBreakdown.map(m => ({
          ...m,
          cost_usd: (m.total_cost_nano / 1e9).toFixed(6),
          cost_formatted: pricingCalc.formatCost(m.total_cost_nano),
        })),
        lifetime_summary: {
          total_cost_nano: lifetimeStats.total_cost_nano_usd || 0,
          total_cost_usd: ((lifetimeStats.total_cost_nano_usd || 0) / 1e9).toFixed(6),
          total_tokens_saved: lifetimeStats.total_tokens_saved || 0,
          estimated_savings_usd: (((lifetimeStats.total_tokens_saved || 0) * 3.0) / 1e6).toFixed(6),
        },
      });
    } catch (err) {
      jsonErr(res, 500, err.message);
    }
  },

  // Reference data consumed by the Optimization tab (read-only).
  'GET /api/dashboard/builtin-filters': (req, res) => {
    jsonOk(res, { available_filters: Object.keys(BUILTIN_FILTERS), filters: BUILTIN_FILTERS });
  },

  'GET /api/dashboard/supported-models': (req, res, { pricingCalc }) => {
    jsonOk(res, { models: pricingCalc.listModels() });
  },

  // === OPTIMIZATION SUGGESTIONS TAB ===
  'GET /api/dashboard/optimization-opportunities': async (req, res, { analytics }) => {
    try {
      const opportunities = await analytics.getOptimizationOpportunities(20);
      jsonOk(res, {
        opportunities,
        total_potential_savings: opportunities.reduce((sum, opp) => sum + opp.savings_pct, 0),
      });
    } catch (err) {
      jsonErr(res, 500, err.message);
    }
  },

  // === SESSION HISTORY TAB ===
  'GET /api/dashboard/session-history': async (req, res, { analytics }) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const limit = parseInt(url.searchParams.get('limit') || '50', 10);
      const history = await analytics.getRequestHistory(null, limit);
      jsonOk(res, { history, count: history.length });
    } catch (err) {
      jsonErr(res, 500, err.message);
    }
  },

  // === STATS TAB ===
  'GET /api/dashboard/stats': async (req, res, { analytics }) => {
    try {
      const [sessionStats, lifetimeStats, compressionStats, providerBreakdown] = await Promise.all([
        analytics.getSessionStats(),
        analytics.getLifetimeStats(),
        analytics.getCompressionStats(),
        analytics.getProviderBreakdown(),
      ]);
      jsonOk(res, {
        current_session: sessionStats,
        lifetime:        lifetimeStats,
        compression:     compressionStats,
        providers:       providerBreakdown,
      });
    } catch (err) {
      jsonErr(res, 500, err.message);
    }
  },

};

module.exports = DASHBOARD_ROUTES;
