# Cloudflare Workers AI — Integration Design

**Date:** 2026-06-23
**Status:** Approved

## Goal

Add Cloudflare Workers AI as a 4th provider in Proxy-Max alongside AWS Bedrock, Azure AI Foundry, and NVIDIA NIM. Users configure an account ID + API token and can then select from a curated catalog of Workers AI models — or type any `@cf/vendor/model` ID freely.

---

## Architecture

### Request flow (unchanged)

```
Claude Code (Anthropic format)
  → Proxy-Max server.js  (Anthropic → OpenAI conversion)
  → callOpenAICompatible(cfg, body, res)
  → https://api.cloudflare.com/client/v4/accounts/{accountId}/ai/v1/chat/completions
  → Workers AI model
```

Workers AI exposes a `/v1/chat/completions` OpenAI-compatible endpoint, so it slots directly into the existing `callOpenAICompatible` path with no new provider file needed.

### Config shape

```json
{
  "provider": "cloudflare",
  "providers": {
    "cloudflare": {
      "accountId": "597da16ae229e4ec55b2eb7c8efeab6a",
      "apiKey": "cfut_...",
      "model": "@cf/moonshotai/kimi-k2.6"
    }
  }
}
```

---

## Files Changed

### 1. `src/providers/openai_compat.js`

Add `cloudflare` branch in the URL/header builder (around the `buildProviderUrl` logic at line ~1113):

```js
if (cfg.kind === 'cloudflare') {
  return {
    url: `https://api.cloudflare.com/client/v4/accounts/${cfg.accountId}/ai/v1/chat/completions`,
    headers: { Authorization: `Bearer ${cfg.apiKey}` },
    model: cfg.model,
  };
}
```

`resolveModel()` for cloudflare: return `cfg.model` as-is (the `@cf/vendor/model` string goes in the request body's `model` field, same as NIM).

No other changes to `openai_compat.js` — streaming, tool calls, and all other features pass through unchanged.

### 2. `src/models.js`

Add `cloudflare` key with verified model IDs grouped by vendor:

| Group | Model ID | Notes |
|-------|----------|-------|
| Kimi — Moonshot AI | `@cf/moonshotai/kimi-k2.7-code` | 262k ctx, coding |
| | `@cf/moonshotai/kimi-k2.6` | 1T param, 262k ctx, vision + tools |
| | `@cf/moonshotai/kimi-k2.5` | 256k ctx |
| GLM — Z.ai | `@cf/zai-org/glm-5.2` | agentic coding |
| | `@cf/zai-org/glm-4.7-flash` | 131k ctx |
| Meta — Llama 4 | `@cf/meta/llama-4-scout-17b-16e-instruct` | multimodal |
| Meta — Llama 3.x | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | fast |
| | `@cf/meta/llama-3.1-70b-instruct` | |
| | `@cf/meta/llama-3.1-8b-instruct-fp8` | |
| | `@cf/meta/llama-3.1-8b-instruct` | |
| | `@cf/meta/llama-3.2-3b-instruct` | |
| | `@cf/meta/llama-3.2-1b-instruct` | |
| Reasoning | `@cf/qwen/qwq-32b` | o1-mini class |
| | `@cf/deepseek-ai/deepseek-r1-distill-qwen-32b` | |
| Qwen | `@cf/qwen/qwen3-30b-a3b-fp8` | MoE |
| | `@cf/qwen/qwen2.5-coder-32b-instruct` | coding |
| NVIDIA | `@cf/nvidia/nemotron-3-120b-a12b` | agentic |
| OpenAI OSS | `@cf/openai/gpt-oss-120b` | |
| | `@cf/openai/gpt-oss-20b` | |
| Mistral | `@cf/mistralai/mistral-small-3.1-24b-instruct` | 128k ctx |
| Google | `@cf/google/gemma-4-26b-a4b-it` | |
| IBM | `@cf/ibm/granite-4.0-h-micro` | |

### 3. `src/server.js`

**`inferModelProfile()`**: Add `cloudflare` to provider tag recognition (same `p.includes('cloudflare')` pattern as other providers).

**Capabilities block** (lines ~2264-2269):
```js
const supportsComputerUse   = provider === 'bedrock';
const supportsThinking      = true;   // pass through for all
const supportsPromptCaching = provider !== 'nvidia' && provider !== 'cloudflare';
const supportsVision        = true;   // pass through for all
```

No artificial gating beyond prompt-caching (not a CF feature). Tool calls, streaming, vision, thinking all pass through — the upstream returns an error if the specific model doesn't support a feature.

**Config save endpoint** (`/api/config`): already generic — `body.provider = 'cloudflare'` works with existing logic. No changes needed.

**Config test endpoint** (`/api/test`): hits `callOpenAICompatible` which already handles `cloudflare` after the URL builder change. No changes needed.

**API key masking** in `/api/config GET`: add `cloudflare` to the providers whose `apiKey` gets redacted (same pattern as azure/nvidia).

### 4. `ui/index.html`

**CSS** — add Cloudflare orange alongside the existing provider colors:
```css
--cloudflare: #f38020;
.src[data-p="cloudflare"] { --src-accent: var(--cloudflare); }
.pool-prov.cloudflare { background: var(--cloudflare); }
```

**Provider picker card**:
```html
<div class="src" data-p="cloudflare">
  <strong>Cloudflare Workers AI</strong>
  <div class="desc">Kimi, Llama 4, GLM, QwQ, DeepSeek, Mistral, Gemma…</div>
</div>
```

**Config panel** (`cloudflareFields`):
```html
<div id="cloudflareFields" class="hide">
  <div><label>Account ID</label>
    <input id="cf_accountId" placeholder="597da16ae229e4ec55b2eb7c8efeab6a" /></div>
  <div><label>API Token</label>
    <input id="cf_apiKey" type="password" placeholder="cfut_..." /></div>
  <!-- model picker wired to models.js cloudflare catalog + free-text -->
</div>
```

**Pool provider `<select>`**:
```html
<option value="cloudflare">Cloudflare Workers AI</option>
```

**JS show/hide**: add `cloudflare` to the provider-panel switch so `cloudflareFields` shows when the Cloudflare card is selected, same pattern as `azureFields` / `nvidiaFields` / `bedrockFields`.

**`diagProviderFilter`**: add `<option value="cloudflare">Cloudflare</option>` to diagnostics filter dropdown.

---

## Capabilities Summary

| Feature | Cloudflare Workers AI |
|---------|----------------------|
| Streaming (SSE) | Yes |
| Tool / function calling | Yes (model-dependent) |
| Vision | Yes (model-dependent) |
| Extended thinking | Pass-through |
| Prompt caching | No |
| Computer use | No (Bedrock-exclusive) |
| Custom model IDs | Yes — free-text `@cf/vendor/model` |

---

## Out of Scope

- Cloudflare AI Gateway pass-through (routing existing providers via CF edge) — separate feature
- Workers AI binding (Cloudflare Worker runtime) — REST API only
- Image / audio / embedding Workers AI models — text generation only
