/**
 * Pricing Database - All major LLM provider model prices
 * Prices in $/1M tokens (USD)
 * Updated: June 2026
 */

const UNKNOWN_MODEL_FALLBACK = Object.freeze({
  input: 3.00,
  output: 15.00,
  cached_input: 0.30,
  estimated: true,
});

const PRICING_MODELS = {
  // OpenAI - GPT-4o series
  'gpt-4o': {
    input: 2.50,
    output: 10.00,
    cached_input: 1.25,
    long_context_threshold: 272000,
    long_input: 7.50,
    long_output: 30.00,
  },
  'gpt-4o-2024-11-20': {
    input: 2.50,
    output: 10.00,
    cached_input: 1.25,
  },
  'gpt-4o-mini': {
    input: 0.15,
    output: 0.60,
    cached_input: 0.075,
  },
  'gpt-4-turbo': {
    input: 10.00,
    output: 30.00,
    cached_input: 5.00,
  },
  'gpt-3.5-turbo': {
    input: 0.50,
    output: 1.50,
  },

  // Anthropic - Claude series
  'claude-fable-5': {
    input: 10.00,
    output: 50.00,
    cached_input: 1.00,
    cache_write_5m: 12.50,
    cache_write_1h: 20.00,
  },
  'claude-opus-4': {
    input: 5.00,
    output: 25.00,
    cached_input: 0.50,
    cache_write_5m: 6.25,
    cache_write_1h: 10.00,
  },
  'claude-opus-4-8': {
    input: 5.00,
    output: 25.00,
    cached_input: 0.50,
    cache_write_5m: 6.25,
    cache_write_1h: 10.00,
  },
  'claude-opus-4-7': {
    input: 5.00,
    output: 25.00,
    cached_input: 0.50,
    cache_write_5m: 6.25,
    cache_write_1h: 10.00,
  },
  'claude-opus-4-6': {
    input: 5.00,
    output: 25.00,
    cached_input: 0.50,
    cache_write_5m: 6.25,
    cache_write_1h: 10.00,
  },
  'claude-sonnet-4': {
    input: 3.00,
    output: 15.00,
    cached_input: 0.30,
    cache_write_5m: 3.75,
    cache_write_1h: 6.00,
  },
  'claude-sonnet-4-6': {
    input: 3.00,
    output: 15.00,
    cached_input: 0.30,
    cache_write_5m: 3.75,
    cache_write_1h: 6.00,
  },
  'claude-haiku-4-5': {
    input: 1.00,
    output: 5.00,
    cached_input: 0.10,
    cache_write_5m: 1.25,
    cache_write_1h: 2.00,
  },
  'claude-3-5-sonnet': {
    input: 3.00,
    output: 15.00,
    cached_input: 0.30,
    long_context_threshold: 200000,
    long_input: 9.00,
    long_output: 45.00,
  },
  'claude-3-5-sonnet-20241022': {
    input: 3.00,
    output: 15.00,
    cached_input: 0.30,
  },
  'claude-3-opus': {
    input: 15.00,
    output: 75.00,
    cached_input: 1.50,
  },
  'claude-3-sonnet': {
    input: 3.00,
    output: 15.00,
    cached_input: 0.30,
  },
  'claude-3-haiku': {
    input: 0.80,
    output: 4.00,
    cached_input: 0.08,
  },

  // Google Gemini
  'gemini-2-flash': {
    input: 0.075,
    output: 0.30,
    cached_input: 0.0225,
  },
  'gemini-1-5-pro': {
    input: 1.25,
    output: 5.00,
    cached_input: 0.3125,
  },
  'gemini-1-5-flash': {
    input: 0.075,
    output: 0.30,
    cached_input: 0.0225,
  },

  // Reasoning models (o1, o3)
  'o1': {
    input: 15.00,
    output: 60.00,
  },
  'o3': {
    input: 40.00,
    output: 160.00,
  },
  'o3-mini': {
    input: 2.00,
    output: 8.00,
  },

  // AWS Bedrock (Claude via Bedrock)
  'us.anthropic.claude-opus-4': {
    input: 5.00,
    output: 25.00,
    cached_input: 0.50,
    cache_write_5m: 6.25,
    cache_write_1h: 10.00,
  },
  'anthropic.claude-opus-4': {
    input: 5.00,
    output: 25.00,
    cached_input: 0.50,
    cache_write_5m: 6.25,
    cache_write_1h: 10.00,
  },
  'us.anthropic.claude-sonnet-4': {
    input: 3.00,
    output: 15.00,
    cached_input: 0.30,
    cache_write_5m: 3.75,
    cache_write_1h: 6.00,
  },
  'anthropic.claude-sonnet-4': {
    input: 3.00,
    output: 15.00,
    cached_input: 0.30,
    cache_write_5m: 3.75,
    cache_write_1h: 6.00,
  },
  'us.anthropic.claude-haiku-4': {
    input: 1.00,
    output: 5.00,
    cached_input: 0.10,
    cache_write_5m: 1.25,
    cache_write_1h: 2.00,
  },
  'anthropic.claude-haiku-4': {
    input: 1.00,
    output: 5.00,
    cached_input: 0.10,
    cache_write_5m: 1.25,
    cache_write_1h: 2.00,
  },
  'bedrock-claude-3-5-sonnet': {
    input: 3.00,
    output: 15.00,
    cached_input: 0.30,
  },
  'bedrock-claude-3-opus': {
    input: 15.00,
    output: 75.00,
    cached_input: 1.50,
  },
  'bedrock-claude-3-haiku': {
    input: 0.80,
    output: 4.00,
    cached_input: 0.08,
  },

  // Azure Foundry (hosted models)
  'gpt-4-turbo-azure': {
    input: 12.00,
    output: 36.00,
  },
  'gpt-35-turbo-azure': {
    input: 0.50,
    output: 1.50,
  },

  // NVIDIA NIM
  'nvidia-llama-2-70b': {
    input: 0.5,
    output: 1.5,
  },
  'nvidia-mistral-7b': {
    input: 0.2,
    output: 0.6,
  },
};

class PricingCalculator {
  constructor() {
    this.models = PRICING_MODELS;
    this.version = 'jun-2026-1';
  }

  /**
   * Find pricing tier for a model (longest prefix match)
   */
  findModelPricing(modelName, exact = false) {
    if (!modelName) return null;

    // Exact match first
    if (this.models[modelName]) {
      return this.models[modelName];
    }

    if (exact) return null;

    // Longest prefix match (e.g., "gpt-4o-2024-11-20" matches "gpt-4o")
    const sorted = Object.keys(this.models).sort((a, b) => b.length - a.length);
    for (const key of sorted) {
      if (modelName.includes(key) || key.includes(modelName)) {
        return this.models[key];
      }
    }

    // Family fallbacks for current/Foundry model names that often appear as
    // deployments or aliases. Prefer conservative public-list pricing over zero.
    const lower = String(modelName).toLowerCase();
    if (lower.includes('gpt-4o-mini')) return this.models['gpt-4o-mini'];
    if (lower.includes('gpt-4o')) return this.models['gpt-4o'];
    if (lower.includes('gpt-4.1') || lower.includes('gpt-4-1')) return this.models['gpt-4o'];
    if (lower.includes('gpt-5')) return this.models['gpt-4o'];
    if (lower.includes('claude-opus')) return this.models['claude-opus-4-8'];
    if (lower.includes('claude-sonnet')) return this.models['claude-sonnet-4-6'];
    if (lower.includes('claude-haiku')) return this.models['claude-haiku-4-5'];

    return null;
  }

  fallbackPricing(_modelName) {
    return UNKNOWN_MODEL_FALLBACK;
  }

  /**
   * Calculate cost in nanoUSD (10^-9 USD) for atomic precision
   */
  calculateCostNano(inputTokens, outputTokens, modelName, options = {}) {
    const { isLongContext = false, cacheCreationTokens = 0, cacheTtl = '5m' } = options;
    inputTokens = Math.max(0, Number(inputTokens) || 0);
    outputTokens = Math.max(0, Number(outputTokens) || 0);
    const cachedTokens = Math.min(inputTokens, Math.max(0, Number(options.cachedTokens) || 0));
    const creationTokens = Math.max(0, Number(cacheCreationTokens) || 0);

    let pricing = this.findModelPricing(modelName);
    const estimatedPricing = !pricing;
    if (!pricing) pricing = this.fallbackPricing(modelName);

    const uncachedInput = Math.max(0, inputTokens - cachedTokens);
    const cachedRate = pricing.cached_input || pricing.input * 0.1;
    const writeRate = cacheTtl === '1h'
      ? (pricing.cache_write_1h || pricing.input * 2)
      : (pricing.cache_write_5m || pricing.input * 1.25);
    const outputRate = pricing.output;
    let inputCostUsd = 0;

    if (isLongContext && pricing.long_context_threshold && uncachedInput > pricing.long_context_threshold) {
      const longInput = uncachedInput - pricing.long_context_threshold;
      const shortInput = uncachedInput - longInput;
      inputCostUsd += (shortInput / 1e6) * pricing.input;
      inputCostUsd += (longInput / 1e6) * (pricing.long_input || pricing.input);
    } else {
      inputCostUsd += (uncachedInput / 1e6) * pricing.input;
    }

    const cachedCostUsd = (cachedTokens / 1e6) * cachedRate;
    const promptCacheWriteUsd = (creationTokens / 1e6) * writeRate;
    const outputCostUsd = (outputTokens / 1e6) * (isLongContext && pricing.long_output ? pricing.long_output : outputRate);
    const costUsd = inputCostUsd + cachedCostUsd + promptCacheWriteUsd + outputCostUsd;
    const promptCacheSavingsUsd = (cachedTokens / 1e6) * Math.max(0, pricing.input - cachedRate);

    // Convert to nanoUSD (avoid floating point precision issues)
    const costNano = Math.round(costUsd * 1e9);

    return {
      cost_usd: costUsd,
      cost_nano_usd: costNano,
      prompt_cache_savings_nano: Math.round(promptCacheSavingsUsd * 1e9),
      prompt_cache_write_nano: Math.round(promptCacheWriteUsd * 1e9),
      pricing_known: !estimatedPricing,
      pricing_estimated: estimatedPricing || !!pricing.estimated,
      breakdown: {
        input_cost: inputCostUsd,
        cached_cost: cachedCostUsd,
        prompt_cache_write_cost: promptCacheWriteUsd,
        output_cost: outputCostUsd,
        uncached_input_tokens: uncachedInput,
        cached_input_tokens: cachedTokens,
        cache_creation_input_tokens: creationTokens,
      },
    };
  }

  /**
   * Format nanoUSD to readable string
   */
  formatCost(nanoUsd) {
    const usd = nanoUsd / 1e9;
    if (usd < 0.001) return `$${(usd * 1e6).toFixed(2)}µ`; // Micro USD
    if (usd < 0.01) return `$${(usd * 1e3).toFixed(2)}m`; // Milli USD
    return `$${usd.toFixed(6)}`;
  }

  /**
   * Estimate savings from token reduction
   */
  calculateSavings(originalTokens, reducedTokens, modelName) {
    const full = this.calculateCostNano(originalTokens, 0, modelName);
    const reduced = this.calculateCostNano(reducedTokens, 0, modelName);

    if (full.error || reduced.error) return { error: 'Pricing lookup failed' };

    const savingsNano = full.cost_nano_usd - reduced.cost_nano_usd;
    const reductionPct = ((originalTokens - reducedTokens) / originalTokens) * 100;

    return {
      original_tokens: originalTokens,
      reduced_tokens: reducedTokens,
      tokens_saved: originalTokens - reducedTokens,
      reduction_pct: reductionPct.toFixed(1),
      original_cost: this.formatCost(full.cost_nano_usd),
      reduced_cost: this.formatCost(reduced.cost_nano_usd),
      savings_nano: savingsNano,
      savings: this.formatCost(savingsNano),
    };
  }

  /**
   * List all supported models
   */
  listModels() {
    return Object.keys(this.models).sort();
  }
}

module.exports = PricingCalculator;
