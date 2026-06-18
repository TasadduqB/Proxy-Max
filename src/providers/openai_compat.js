// OpenAI-compatible providers (Azure AI Foundry + NVIDIA NIM).
// Both expose /v1/chat/completions; only auth + URL shape differ.
// Azure also supports the newer Responses API at /openai/responses.

// Auto-install undici if it's not available as a standalone module.
// Node.js bundles undici internally (powers the global fetch) but doesn't expose
// it via require('undici') without installation. We need it to create an Agent
// with rejectUnauthorized:false for corporate SSL inspection proxy support.
(function ensureUndici() {
  try { require('undici'); return; } catch {}
  const { spawnSync } = require('child_process');
  const projectRoot = require('path').join(__dirname, '..', '..');
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  process.stdout.write('[proxy] undici not found — installing (one-time setup)…\n');
  const r = spawnSync(npm, ['install', 'undici', '--save'], { cwd: projectRoot, stdio: 'inherit' });
  if (r.status !== 0) process.stderr.write('[proxy] undici install failed — TLS fallback will use NODE_TLS_REJECT_UNAUTHORIZED\n');
  else process.stdout.write('[proxy] undici installed\n');
})();

// Support PROXY_INSECURE=1 or NODE_TLS_REJECT_UNAUTHORIZED=0 for corporate SSL inspection proxies
// that inject a self-signed cert into the chain (SELF_SIGNED_CERT_IN_CHAIN error).
let _insecureDispatcher = null;
let _keepAliveDispatcher = null;
let _undiciUnavailable = false;
function getUndiciAgent(opts = {}) {
  if (_undiciUnavailable) return null;
  try {
    const { Agent } = require('undici');
    return new Agent({
      keepAliveTimeout: 60000,
      keepAliveMaxTimeout: 120000,
      // Must be >= PROXY_MAX_CONCURRENCY_PER_MEMBER (500) so undici never internally
      // queues requests that the proxy already counted as in-flight.
      connections: Math.max(16, Number(process.env.PROXY_MAX_UPSTREAM_CONNECTIONS || 500)),
      pipelining: 1,
      ...opts
    });
  } catch {
    _undiciUnavailable = true;
    return null;
  }
}
function getKeepAliveDispatcher() {
  if (_keepAliveDispatcher) return _keepAliveDispatcher;
  _keepAliveDispatcher = getUndiciAgent();
  return _keepAliveDispatcher;
}
function getInsecureDispatcher() {
  if (_insecureDispatcher) return _insecureDispatcher;
  _insecureDispatcher = getUndiciAgent({ connect: { rejectUnauthorized: false } });
  return _insecureDispatcher;
}
function dispatcherForRequest() {
  return ALLOW_INSECURE ? getInsecureDispatcher() : getKeepAliveDispatcher();
}

// When undici is unavailable, disable TLS verification process-wide via env var.
// This is the safe fallback for corporate SSL inspection proxies.
function enableInsecureTlsFallback(reason) {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') return;
  console.warn(`[proxy] ${reason} — enabling NODE_TLS_REJECT_UNAUTHORIZED=0 (undici not available as standalone module)`);
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

const ALLOW_INSECURE = process.env.PROXY_INSECURE === '1' || process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0';
// If PROXY_INSECURE=1 is set but undici isn't available, activate the env-var fallback immediately.
if (ALLOW_INSECURE && !getInsecureDispatcher()) {
  enableInsecureTlsFallback('PROXY_INSECURE=1 requested');
}

// TLS error codes thrown by Node.js/undici when a corporate SSL inspection proxy
// injects a self-signed cert into the chain.
const CERT_ERROR_CODES = new Set([
  'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'
]);
function isCertError(err) {
  const code = err?.cause?.code || err?.code || '';
  return CERT_ERROR_CODES.has(code);
}

// Fetch with automatic insecure retry on TLS cert errors.
async function fetchWithCertFallback(url, opts) {
  const dispatcher = opts.dispatcher || dispatcherForRequest();
  const firstOpts = dispatcher ? { ...opts, dispatcher } : opts;
  try {
    return await fetch(url, firstOpts);
  } catch (err) {
    if (!isCertError(err)) throw err;
    const insecureDispatcher = getInsecureDispatcher();
    console.warn(`[proxy] TLS cert error (${err?.cause?.code}) — retrying with rejectUnauthorized=false for ${url}`);
    if (insecureDispatcher) {
      return await fetch(url, { ...opts, dispatcher: insecureDispatcher });
    }
    // undici not available as standalone module — fall back to process-level env var
    enableInsecureTlsFallback(`TLS cert error (${err?.cause?.code})`);
    return await fetch(url, opts);
  }
}

const {
  anthropicToOpenAIMessages,
  anthropicToolsToOpenAI,
  COMPUTER_USE_SCHEMAS,
  sanitizeForUpstream,
  createAnthropicSSEEmitter,
  buildAnthropicResponse,
  iterSSE,
  newId
} = require('./_common');

const fs = require('fs');
const path = require('path');

let fablePrompt = '';
try {
  fablePrompt = fs.readFileSync(path.join(__dirname, 'fable_prompt.txt'), 'utf8').trim() + '\n\n';
} catch (e) {
  // Ignored if missing
}

// Returns true if the request uses Anthropic-native computer-use tools
// (type like "bash_20241022") rather than Claude Code CLI tool definitions
// (which always have an input_schema). The fable computer-use system prompt
// must ONLY be injected for computer-use sessions, not for Claude Code CLI.
function isComputerUseSession(tools) {
  if (!tools || tools.length === 0) return false;
  return tools.some(t => t.type && !t.input_schema && (
    t.type.startsWith('bash_') ||
    t.type.startsWith('text_editor_') ||
    t.type.startsWith('computer_')
  ));
}

// Returns true if the request contains a web_search tool.
function hasWebSearchTool(tools) {
  if (!tools || tools.length === 0) return false;
  return tools.some(t => t.name === 'web_search' || (t.type && t.type.startsWith('web_search')));
}

// Lightweight web search using DuckDuckGo (no key required).
// Tries three endpoints in order: DDG HTML, DDG Lite, DDG instant-answer JSON.
// Cloud VMs sometimes have their IPs blocked by DDG — all fallbacks still attempt
// different endpoints so at least one is more likely to succeed.
const DDG_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function _stripHtml(s) {
  return String(s || '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
}

async function _ddgHtml(query) {
  const r = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    headers: { 'User-Agent': DDG_UA, 'Accept-Language': 'en-US,en;q=0.9' },
    signal: AbortSignal.timeout(9000)
  });
  if (!r.ok) throw new Error(`DDG HTML ${r.status}`);
  const t = await r.text();
  const results = [];
  // Pattern 1: uddg= redirect links (classic DDG)
  const re1 = /<a[^>]+href="[^"]*?uddg=([^"&]+)[^"]*"[^>]*class="result__a[^"]*"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re1.exec(t)) !== null && results.length < 5) {
    results.push({ url: decodeURIComponent(m[1]), title: _stripHtml(m[2]), snippet: _stripHtml(m[3]) });
  }
  // Pattern 2: newer DDG HTML — direct hrefs
  if (results.length === 0) {
    const re2 = /class="result__a"[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    while ((m = re2.exec(t)) !== null && results.length < 5) {
      results.push({ url: m[1], title: _stripHtml(m[2]), snippet: _stripHtml(m[3]) });
    }
  }
  return results;
}

async function _ddgLite(query) {
  const r = await fetch(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`, {
    headers: { 'User-Agent': DDG_UA },
    signal: AbortSignal.timeout(9000)
  });
  if (!r.ok) throw new Error(`DDG Lite ${r.status}`);
  const t = await r.text();
  const results = [];
  // DDG Lite: <td class="result-link"><a href="...">Title</a></td> then <td class="result-snippet">...</td>
  const re = /<td class="result-link">\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<td class="result-snippet">([\s\S]*?)<\/td>/g;
  let m;
  while ((m = re.exec(t)) !== null && results.length < 5) {
    results.push({ url: m[1], title: _stripHtml(m[2]), snippet: _stripHtml(m[3]) });
  }
  return results;
}

async function _ddgJson(query) {
  const r = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&no_redirect=1`, {
    headers: { 'User-Agent': DDG_UA },
    signal: AbortSignal.timeout(9000)
  });
  if (!r.ok) throw new Error(`DDG JSON ${r.status}`);
  const j = await r.json();
  const results = [];
  if (j.AbstractText) results.push({ url: j.AbstractURL || '', title: j.Heading || query, snippet: j.AbstractText });
  for (const t of (j.RelatedTopics || [])) {
    if (results.length >= 5) break;
    if (t.Text && t.FirstURL) results.push({ url: t.FirstURL, title: t.Text.split(' - ')[0] || query, snippet: t.Text });
  }
  return results;
}

async function performWebSearch(query) {
  if (!query) return [{ title: 'No query', url: '', snippet: 'No search query was provided.' }];

  const attempts = [
    { name: 'ddg-html',  fn: () => _ddgHtml(query)  },
    { name: 'ddg-lite',  fn: () => _ddgLite(query)  },
    { name: 'ddg-json',  fn: () => _ddgJson(query)  },
  ];

  for (const attempt of attempts) {
    try {
      const results = await attempt.fn();
      if (results.length > 0) {
        console.log(`[proxy] [web_search] "${query.slice(0, 60)}" — ${results.length} result(s) via ${attempt.name}`);
        return results;
      }
    } catch (e) {
      console.warn(`[proxy] [web_search] ${attempt.name} failed: ${e.message}`);
    }
  }

  console.warn(`[proxy] [web_search] all sources exhausted for: "${query.slice(0, 80)}"`);
  return [{
    title: 'Search Unavailable',
    url: `https://duckduckgo.com/?q=${encodeURIComponent(query)}`,
    snippet: `Web search unavailable from this environment (all DuckDuckGo endpoints failed). Try searching manually: https://duckduckgo.com/?q=${encodeURIComponent(query)}`
  }];
}

// Execute proxy-handled tool calls (currently: web_search).
// Returns array of {tool_use_id, content, is_error}.
async function executeProxyTools(toolCalls) {
  const results = [];
  for (const tc of toolCalls) {
    // Accept both 'web_search' (Claude Code CLI tool name) and
    // 'web_search_20250305' (Anthropic server tool type used as name).
    if (tc.name === 'web_search' || tc.name?.startsWith('web_search')) {
      let args = {};
      try { args = JSON.parse(tc.arguments || '{}'); } catch {}
      const searchResults = await performWebSearch(args.query || '');
      const content = searchResults
        .map(r => `**${r.title}**\n${r.url ? `URL: ${r.url}\n` : ''}${r.snippet}`)
        .join('\n\n---\n\n');
      results.push({ tool_use_id: tc.id, content, is_error: false });
    }
  }
  return results;
}

// Known model context window sizes (total tokens = input + output).
// Used to clamp max_tokens so we never send a value that, combined with the
// input, exceeds the model's limit.  Models not listed default to 131072.
const MODEL_MAX_CONTEXT = {
  // GPT-5.x / Azure deployments (1M token context)
  'gpt-5.5':                                  1048576,
  'gpt-5.1':                                  1048576,
  'gpt-5.1-codex-max':                        1048576,
  'gpt-5':                                    1048576,
  'gpt-chat-latest':                          1048576,
  'GPT-5.5-Max-Proxy':                        1048576,
  // NVIDIA models
  'nvidia/nemotron-3-super-120b-a12b':        131072,
  'nvidia/nemotron-3-ultra-550b-a55b':        131072,
  'nvidia/llama-3.3-nemotron-super-49b-v1':   131072,
  'nvidia/llama-3.3-nemotron-super-49b-v1.5': 131072,
  'nvidia/llama-3.1-nemotron-ultra-253b-v1':  131072,
  'nvidia/llama-3.1-nemotron-70b-instruct':   131072,
  'moonshotai/kimi-k2.6':                     131072,
  'openai/gpt-oss-120b':                      131072,
  'openai/gpt-oss-20b':                       131072,
  'qwen/qwen3.5-397b-a17b':                   131072,
  'qwen/qwen3.5-122b-a10b':                   131072,
  'deepseek-ai/deepseek-r2':                  131072,
  'deepseek-ai/deepseek-v4-flash':            1048576,
  'meta/llama-3.3-70b-instruct':              131072,
  'meta/llama-3.1-70b-instruct':              131072,
  'meta/llama-3.1-8b-instruct':               131072,
  'meta/codellama-70b':                       16384,
  'mistralai/mistral-large-3-675b-instruct-2512': 131072,
  'google/gemma-4-31b-it':                    131072,
};
const DEFAULT_MAX_CONTEXT = 131072;

// Very rough token estimate: ~4 chars per token for English text.
// Used only for the max_tokens safety clamp — doesn't need to be precise.
function estimateInputTokens(body) {
  let chars = 0;
  // System prompt
  if (body.system) {
    chars += typeof body.system === 'string'
      ? body.system.length
      : body.system.reduce((s, b) => s + (b.text || '').length, 0);
  }
  // Messages
  for (const m of body.messages || []) {
    if (typeof m.content === 'string') { chars += m.content.length; continue; }
    for (const blk of m.content || []) {
      if (blk.text) chars += blk.text.length;
      else if (blk.input) chars += JSON.stringify(blk.input).length;
      else if (blk.content) chars += typeof blk.content === 'string' ? blk.content.length : 200;
    }
  }
  // Tools definitions
  if (body.tools) chars += JSON.stringify(body.tools).length;
  return Math.ceil(chars / 4);
}

// Clamp max_tokens so input + output never exceeds the model context window.
// Returns a safe value ≥ MIN_OUTPUT (1024) or the original if it already fits.
function clampMaxTokens(body, model) {
  const requested = body.max_tokens;
  if (requested == null) return undefined;

  const contextLimit = MODEL_MAX_CONTEXT[model] || DEFAULT_MAX_CONTEXT;
  const estInput = estimateInputTokens(body);
  const headroom = contextLimit - estInput;
  const MIN_OUTPUT = 1024;

  // If even MIN_OUTPUT doesn't fit, still send MIN_OUTPUT and let the
  // upstream reject with a clear error rather than sending a negative value.
  if (headroom < MIN_OUTPUT) {
    console.warn(`[proxy] [max_tokens] model=${model} context=${contextLimit} estInput=${estInput} headroom=${headroom} → clamped to ${MIN_OUTPUT}`);
    return MIN_OUTPUT;
  }

  const clamped = Math.min(requested, headroom);
  if (clamped < requested) {
    console.log(`[proxy] [max_tokens] model=${model} context=${contextLimit} estInput=${estInput} requested=${requested} → clamped to ${clamped}`);
  }
  return clamped;
}

function buildPayload(body, model, cfg, isResponsesApi) {
  const isAzure = cfg?.kind === 'azure';
  if (isResponsesApi) return buildResponsesPayload(body, model);

  const payload = {
    model,
    messages: anthropicToOpenAIMessages(body),
    stream: !!body.stream,
    temperature: body.temperature,
    top_p: body.top_p,
    stop: body.stop_sequences
  };

  // Azure newer models (chat/completions) require max_completion_tokens;
  // legacy AOAI / non-Azure use max_tokens.
  // Clamp to model context window to avoid negative / oversized values.
  const safeMaxTokens = clampMaxTokens(body, model);
  if (safeMaxTokens != null) {
    if (isAzure) payload.max_completion_tokens = safeMaxTokens;
    else payload.max_tokens = safeMaxTokens;
  }

  const tools = anthropicToolsToOpenAI(body.tools);
  if (tools) payload.tools = tools;
  if (body.tool_choice) {
    // 'auto' is the default — most NVIDIA models reject it if sent explicitly.
    if (body.tool_choice.type === 'any')  payload.tool_choice = 'required';
    else if (body.tool_choice.type === 'none') payload.tool_choice = 'none';
    else if (body.tool_choice.type === 'tool') {
      payload.tool_choice = { type: 'function', function: { name: body.tool_choice.name } };
    }
  }

  const hasTools = !!(tools && tools.length > 0);

  // NVIDIA reasoning models gate reasoning behind chat_template_kwargs.enable_thinking.
  // CRITICAL: only enable thinking when NO tools are present — enabling thinking while
  // tools are defined causes NVIDIA models to text-simulate tool calls instead of
  // emitting structured tool_calls (the root cause of "simulation mode" behavior).
  if (cfg?.kind === 'nvidia' && body.thinking && body.thinking.type === 'enabled' && !hasTools) {
    payload.chat_template_kwargs = { enable_thinking: true };
    if (body.thinking.budget_tokens != null) payload.reasoning_budget = body.thinking.budget_tokens;
  }

  // Inject a tool-use enforcement system prompt for non-Claude models.
  // IMPORTANT: The fable computer-use prompt (which describes a Linux sandbox at
  // /home/claude) must ONLY be injected for actual computer-use sessions, never for
  // Claude Code CLI sessions. Injecting it in CLI sessions causes the model to think
  // it's inside a sandboxed VM and hallucinate filesystem paths and command results.
  if (hasTools && payload.messages && payload.messages.length > 0) {
    const compUse = isComputerUseSession(body.tools);
    const sysIdx = payload.messages.findIndex(m => m.role === 'system');

    // Core anti-simulation instruction — mandatory for every tool-using request.
    const toolHint = `\n\n[MANDATORY — READ BEFORE RESPONDING]
You are connected via an API that supports native function/tool calling.
RULES — violation causes immediate failure:
1. ALWAYS call tools via the API's structured tool_calls mechanism. NEVER write tool calls as text, XML (<tool_use>), markdown code blocks, or embedded JSON.
2. NEVER fabricate, simulate, or role-play tool execution. If you need to run a command or search, CALL the tool — do not describe what you would do.
3. NEVER invent file contents, command outputs, or search results. Wait for real tool results.
4. Prohibited patterns: <tool_use>...</tool_use> · \`\`\`json {"name":...}\`\`\` · any narrative like "I will now run..." without an actual tool call.
5. If a tool call fails, report the actual error message — do not guess the result.
[END MANDATORY]`;

    let systemAddition = toolHint;
    // Only prepend the Fable computer-use environment description for real computer-use sessions.
    if (fablePrompt && compUse) {
      systemAddition = '\n\n' + fablePrompt + toolHint;
    }

    if (sysIdx >= 0) {
      payload.messages[sysIdx].content += systemAddition;
    } else {
      payload.messages.unshift({ role: 'system', content: systemAddition.trim() });
    }
  }

  for (const k of Object.keys(payload)) if (payload[k] === undefined) delete payload[k];
  return payload;
}

function isReasoningModel(model) {
  return /(^|[-_/])(o[1-9]|gpt-5|reasoning|deepseek-r|nemotron|qwen3)/i.test(String(model || ''));
}

// Azure /openai/responses uses a different request shape than chat/completions:
//   - `input` (list of items) instead of `messages`
//   - system prompt goes in `instructions`
//   - `max_output_tokens` instead of max_tokens
//   - tools are flat ({type, name, description, parameters}), not nested under `function`
//   - tool calls / results are top-level items, not message fields
function buildResponsesPayload(body, model) {
  const { instructions, input } = buildResponsesInput(body);
  const reasoningModel = isReasoningModel(model);
  const payload = {
    model,
    input,
    stream: !!body.stream,
    ...(reasoningModel ? {} : { temperature: body.temperature, top_p: body.top_p })
  };
  if (instructions) payload.instructions = instructions;
  if (body.tools && body.tools.length > 0) {
    const toolHint = `[MANDATORY TOOL USE]
Use native Responses API function calls only. Never write tool calls as text/XML/JSON/code blocks.
If shell Python is needed, prefer this portable pattern instead of bare python3: command -v python3 >/dev/null 2>&1 && PY=python3 || PY=python; $PY -m pytest ...
On Windows use python or py -3. If python3 is missing, try python or py before failing.`;
    payload.instructions = payload.instructions ? `${payload.instructions}\n\n${toolHint}` : toolHint;
  }
  const safeMaxTokens = clampMaxTokens(body, model);
  if (safeMaxTokens != null) payload.max_output_tokens = safeMaxTokens;
  if (body.stop_sequences && body.stop_sequences.length) payload.stop = body.stop_sequences;

  if (body.tools && body.tools.length > 0) {
    payload.tools = body.tools.map((t, i) => ({
      type: 'function',
      name: toolNameForOpenAI(t, i),
      description: /^(Bash|bash)$/.test(t.name || '')
        ? `${t.description || `Native computer use tool: ${t.name}`}\nPython portability: do not assume python3 exists. In Bash use: command -v python3 >/dev/null 2>&1 && PY=python3 || PY=python; $PY -m pytest ... . On Windows use python or py -3.`
        : (t.description || `Native computer use tool: ${t.name || t.type || `tool_${i}`}`),
      parameters: t.input_schema || COMPUTER_USE_SCHEMAS[t.type] || { type: 'object', properties: {} }
    }));
  }
  if (body.tool_choice) {
    if (body.tool_choice.type === 'any') payload.tool_choice = 'required';
    else if (body.tool_choice.type === 'tool') {
      payload.tool_choice = { type: 'function', name: body.tool_choice.name };
    }
  }
  for (const k of Object.keys(payload)) if (payload[k] === undefined) delete payload[k];
  return payload;
}

function toolNameForOpenAI(tool, idx = 0) {
  const raw = String(tool?.name || tool?.type || `tool_${idx}`);
  return raw.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || `tool_${idx}`;
}

function responsesTextPart(role, text) {
  return { type: role === 'assistant' ? 'output_text' : 'input_text', text };
}

function isResponsesOutputItemId(id) {
  return typeof id === 'string' && id.startsWith('fc_');
}

function normalizeResponsesCallId(id) {
  if (isResponsesOutputItemId(id)) return null;
  return typeof id === 'string' && id ? id : null;
}

function safeResponsesCallId(id, idx) {
  const normalized = normalizeResponsesCallId(id);
  return normalized || newId(`call${idx ?? 0}`);
}

function stringifyToolResultContent(block) {
  const raw = typeof block.content === 'string'
    ? block.content
    : (block.content || []).map(c => {
      if (!c) return '';
      if (c.type === 'web_search_result' || c.type === 'web_search_tool_result') {
        return `[${c.title || 'Result'}](${c.url || ''}): ${c.encrypted_content ? '(encrypted)' : (c.text || '')}`;
      }
      return c.text || c.data || '';
    }).join('\n');
  return block.is_error ? `[Tool error] ${raw}` : raw;
}

// Convert an Anthropic Messages body into Responses-API { instructions, input }.
function buildResponsesInput(body) {
  let instructions = '';
  if (body.system) {
    instructions = typeof body.system === 'string'
      ? body.system
      : body.system.map(b => b.text || '').join('\n');
  }
  const input = [];
  const seenFunctionCalls = new Set();
  const functionCallIdsByToolUseId = new Map();
  const orphanToolResultIds = [];

  for (const m of body.messages || []) {
    if (m.role === 'system') {
      const systemText = typeof m.content === 'string'
        ? m.content
        : (m.content || []).map(b => b?.text || '').filter(Boolean).join('\n');
      input.push({ role: 'user', content: systemText ? `[System update]\n${systemText}` : '[System update]' });
      continue;
    }
    if (typeof m.content === 'string') {
      input.push({ role: m.role, content: m.content });
      continue;
    }
    const parts = [];
    for (const block of m.content || []) {
      if (!block) continue;
      if (block.type === 'text') {
        if (block.text) parts.push(responsesTextPart(m.role, block.text));
      } else if (block.type === 'tool_use' || block.type === 'server_tool_use') {
        if (!block.id) continue;
        const replayId = block.call_id || block.id;
        const callId = block.call_id
          ? safeResponsesCallId(block.call_id, seenFunctionCalls.size)
          : isResponsesOutputItemId(block.id)
            ? null
            : safeResponsesCallId(block.id, seenFunctionCalls.size);
        if (!callId) continue;
        const normalizedId = normalizeResponsesCallId(block.id);
        const normalizedReplayId = normalizeResponsesCallId(replayId);
        seenFunctionCalls.add(callId);
        functionCallIdsByToolUseId.set(block.id, callId);
        functionCallIdsByToolUseId.set(replayId, callId);
        functionCallIdsByToolUseId.set(callId, callId);
        if (normalizedId) functionCallIdsByToolUseId.set(normalizedId, callId);
        if (normalizedReplayId) functionCallIdsByToolUseId.set(normalizedReplayId, callId);
        input.push({ type: 'function_call', call_id: callId, name: toolNameForOpenAI(block), arguments: JSON.stringify(block.input || {}) });
      } else if (block.type === 'tool_result') {
        const out = stringifyToolResultContent(block);
        const normalizedToolUseId = normalizeResponsesCallId(block.tool_use_id);
        const callId = functionCallIdsByToolUseId.get(block.tool_use_id) || functionCallIdsByToolUseId.get(normalizedToolUseId);
        if (callId && seenFunctionCalls.has(callId)) {
          input.push({ type: 'function_call_output', call_id: callId, output: out });
        } else {
          orphanToolResultIds.push(block.tool_use_id || '(missing)');
          parts.push(responsesTextPart(m.role, `[Tool result for omitted tool call ${block.tool_use_id || '(missing id)'}]\n${out}`));
        }
      } else if (block.type === 'image' && block.source) {
        const url = block.source.type === 'base64'
          ? `data:${block.source.media_type};base64,${block.source.data}`
          : block.source.url;
        parts.push({ type: 'input_image', image_url: url });
      } else if (block.type === 'document' && block.source) {
        const titlePart = block.title ? `[Document: ${block.title}]` : '[Document]';
        const contextPart = block.context ? `\nContext: ${block.context}` : '';
        if (block.source.type === 'text') {
          parts.push({ type: 'input_text', text: `${titlePart}\n${block.source.data}${contextPart}` });
        } else {
          parts.push({ type: 'input_text', text: titlePart + contextPart });
        }
      } else if (block.type === 'server_tool_result') {
        // Result of Anthropic server-executed tool (e.g. native web_search from Anthropic API).
        const rawContent = typeof block.content === 'string'
          ? block.content
          : (block.content || []).map(c => {
              if (c.encrypted_content) return '[Encrypted search result]';
              return `**${c.title || 'Result'}**\nURL: ${c.url || ''}\n${c.text || ''}`;
            }).join('\n\n');
        const out2 = block.is_error ? `[Server tool error] ${rawContent}` : rawContent;
        const normalizedId = normalizeResponsesCallId(block.tool_use_id);
        const callId = functionCallIdsByToolUseId.get(block.tool_use_id) || functionCallIdsByToolUseId.get(normalizedId);
        if (callId && seenFunctionCalls.has(callId)) {
          input.push({ type: 'function_call_output', call_id: callId, output: out2 });
        } else {
          parts.push({ type: 'input_text', text: `[Server tool result for ${block.tool_use_id || 'unknown'}]\n${out2}` });
        }
      } else if (block.type === 'web_search_tool_result') {
        // Anthropic-native web_search result block in conversation history.
        const results = (block.content || []).map(r => {
          if (r.encrypted_content) return '[Encrypted search result]';
          return `**${r.title || 'Result'}**\nURL: ${r.url || ''}\n${r.text || ''}`;
        }).join('\n\n');
        if (results) parts.push({ type: 'input_text', text: `[Web Search Results]\n${results}` });
      }
    }
    if (parts.length) input.push({ role: m.role, content: parts });
  }

  if (orphanToolResultIds.length) {
    const preview = orphanToolResultIds.slice(0, 5).join(', ');
    const suffix = orphanToolResultIds.length > 5 ? `, +${orphanToolResultIds.length - 5} more` : '';
    console.warn(`[proxy] [responses] converted ${orphanToolResultIds.length} orphan tool_result block(s) to text (${preview}${suffix})`);
  }

  return { instructions, input };
}

// Multi-turn web search loop.
// When the upstream model calls web_search, the proxy executes the search itself
// and feeds results back, repeating until no more web searches are requested.
// This is transparent to Claude Code — it only sees the final answer.
// Internally all calls in the loop are non-streaming so we can inspect tool calls.
// Only the FINAL response (no more web_search calls) is emitted to the client,
// and then in the client's requested format (stream or not).
async function callWithWebSearchLoop(providerCfg, sanitizedBody, originalBody, res, cfg, url, headers, isResponsesApi, connectTimeoutMs, idleTimeoutMs) {
  const MAX_SEARCH_LOOPS = 5;
  let currentBody = sanitizedBody;
  const requestedModel = originalBody._requestedModel || cfg.model;
  let lastJson = null;
  let lastText = '', lastThinking = '', lastToolCalls = [], lastStopReason = 'end_turn';

  for (let loop = 0; loop < MAX_SEARCH_LOOPS; loop++) {
    const payload = buildPayload(currentBody, modelForUpstream(cfg), cfg, isResponsesApi);
    // All internal calls are non-streaming so we can inspect results before forwarding.
    const payloadNonStream = { ...payload, stream: false };

    const controller = new AbortController();
    // Non-streaming calls in the web search loop need a generous timeout —
    // models taking 10+ minutes to respond mid-loop should not abort.
    // Configurable via providerCfg.webSearchTimeoutMs; defaults to 10 min.
    const webSearchTimeoutMs = Number(providerCfg.webSearchTimeoutMs) > 0
      ? Number(providerCfg.webSearchTimeoutMs)
      : Math.max(connectTimeoutMs, 600000);
    const timer = setTimeout(() => controller.abort(), webSearchTimeoutMs);
    let upstream;
    try {
      upstream = await fetchWithCertFallback(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(payloadNonStream),
        signal: controller.signal,
        });
    } catch (err) {
      clearTimeout(timer);
      if (err.name === 'AbortError') throw new Error(`Upstream timed out after ${webSearchTimeoutMs}ms in web-search loop`);
      throw err;
    }
    clearTimeout(timer);

    if (!upstream.ok) {
      const errText = await upstream.text();
      const err = new Error(`Upstream ${upstream.status}: ${errText.slice(0, 600)}`);
      err.status = upstream.status;
      err.stage = 'web-search-loop';
      err.debug = { responsePreview: errText.slice(0, 2000) };
      throw err;
    }

    const raw = await upstream.text();
    let json;
    try { json = raw ? JSON.parse(raw) : {}; } catch (e) {
      throw Object.assign(new Error(`Upstream invalid JSON: ${e.message}`), { stage: 'web-search-loop-json' });
    }

    const { text, thinking, toolCalls, stopReason } = parseResponse(json, isResponsesApi);
    lastJson = json; lastText = text; lastThinking = thinking;
    lastStopReason = stopReason;

    const searchCalls = (toolCalls || []).filter(tc => tc.name === 'web_search' || tc.name?.startsWith('web_search'));
    const otherCalls  = (toolCalls || []).filter(tc => tc.name !== 'web_search' && !tc.name?.startsWith('web_search'));
    lastToolCalls = otherCalls;

    if (searchCalls.length === 0) break; // done — emit below

    // Execute web searches and continue.
    console.log(`[proxy] [web_search] loop=${loop} searches=${searchCalls.length}`);
    const searchResults = await executeProxyTools(searchCalls);

    const assistantContent = [];
    if (thinking) assistantContent.push({ type: 'thinking', thinking });
    if (text)     assistantContent.push({ type: 'text', text });
    for (const tc of [...searchCalls, ...otherCalls]) {
      let input = {};
      try { input = JSON.parse(tc.arguments || '{}'); } catch {}
      assistantContent.push({ type: 'tool_use', id: tc.id, name: tc.name, input });
    }
    const userContent = searchResults.map(r => ({
      type: 'tool_result', tool_use_id: r.tool_use_id, content: r.content, is_error: r.is_error
    }));

    currentBody = {
      ...currentBody,
      messages: [...(currentBody.messages || []),
        { role: 'assistant', content: assistantContent },
        { role: 'user',      content: userContent }
      ]
    };
  }

  // Emit the final accumulated response to the client.
  if (originalBody.stream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    const emitter = createAnthropicSSEEmitter(res, requestedModel, originalBody.tools);
    emitter.start((lastJson && lastJson.usage) || {});
    if (lastThinking) emitter.deltaThinking(lastThinking);
    if (lastText)     emitter.deltaText(lastText);
    lastToolCalls.forEach((tc, i) => {
      emitter.deltaToolCall(i, { id: tc.id, function: { name: tc.name, arguments: tc.arguments } });
    });
    emitter.setStopReason(lastStopReason);
    emitter.setUsage((lastJson && lastJson.usage) || {});
    emitter.end();
  } else {
    const repairs = [];
    const responseBody = buildAnthropicResponse({
      model: requestedModel,
      text: lastText,
      thinking: lastThinking,
      toolCalls: lastToolCalls,
      stopReason: lastStopReason,
      usage: lastJson && lastJson.usage,
      repairs,
      toolDefs: originalBody.tools,
    });
    if (repairs.length) res._toolRepairs = (res._toolRepairs || []).concat(repairs);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(responseBody));
  }
}

// providerCfg = { kind: 'azure'|'nvidia', endpoint, apiKey, model, apiVersion?, deployment? }
async function callOpenAICompatible(providerCfg, body, res) {
  // Strip Anthropic-only fields (betas, cache_control, redacted_thinking, etc.)
  const sanitizedBody = sanitizeForUpstream(body, { preserveCacheControl: false });
  const cfg = providerCfg.kind === 'nvidia' ? resolveNvidiaConfig(providerCfg) : providerCfg;
  const { url, headers, isResponsesApi } = buildRequest(cfg);

  const connectTimeoutMs = Number(providerCfg.timeoutMs) > 0 ? Number(providerCfg.timeoutMs) : 120000;
  const idleTimeoutMs = Number(providerCfg.idleTimeoutMs) > 0 ? Number(providerCfg.idleTimeoutMs) : 300000;

  // If request contains a web_search tool, run the proxy-side search loop.
  // The proxy intercepts the model's web_search calls, executes real searches
  // via DuckDuckGo, and feeds results back — Claude Code only sees the final answer.
  if (hasWebSearchTool(body.tools)) {
    return await callWithWebSearchLoop(providerCfg, sanitizedBody, body, res, cfg, url, headers, isResponsesApi, connectTimeoutMs, idleTimeoutMs);
  }

  const payload = buildPayload(sanitizedBody, modelForUpstream(cfg), cfg, isResponsesApi);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), connectTimeoutMs);

  let upstream;
  try {
    upstream = await fetchWithCertFallback(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') throw new Error(`Upstream connection timed out after ${connectTimeoutMs}ms (URL: ${url})`);
    const cause = err.cause ? ` — ${err.cause.code || err.cause.message || err.cause}` : '';
    throw Object.assign(err, { message: `${err.message}${cause} (URL: ${url})` });
  } finally {
    // Streaming: clear the connection timer once headers arrive — per-chunk
    // idle timeout in iterSSE takes over. Non-streaming: keep it running so
    // the body read is also covered by the same deadline.
    if (body.stream) clearTimeout(timer);
  }

  if (!upstream.ok) {
    clearTimeout(timer);
    const errText = await upstream.text();
    const err = new Error(`Upstream ${upstream.status} from ${url}: ${errText.slice(0, 600)}`);
    err.status = upstream.status;
    err.contentType = upstream.headers.get('content-type') || null;
    err.stage = 'upstream-response';
    err.debug = {
      responsePreview: errText.slice(0, 2000)
    };
    throw err;
  }

  if (body.stream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    const emitter = createAnthropicSSEEmitter(res, body._requestedModel || cfg.model, body.tools);
    try {
      if (isResponsesApi) {
        await streamResponsesApi(upstream, emitter, idleTimeoutMs);
      } else {
        await streamChatCompletions(upstream, emitter, idleTimeoutMs);
      }
      emitter.end();
    } catch (err) {
      if (res.__proxyTrace) {
        res.__proxyTrace.note({
          streamError: {
            name: err.name || 'Error',
            message: String(err.message || err)
          }
        });
        res.__proxyTrace.finalize('mid-stream-err', {
          error: {
            name: err.name || 'Error',
            message: String(err.message || err)
          },
          stage: err.stage || 'stream',
          upstreamUrl: url,
          contentType: upstream.headers.get('content-type') || null,
          responsePreview: err.debug?.responsePreview || null
        });
      }
      emitter.fail(err);
    }
    return;
  }

  clearTimeout(timer);
  const raw = await upstream.text();
  let json;
  try {
    json = raw ? JSON.parse(raw) : {};
  } catch (parseErr) {
    const err = new Error(`Upstream invalid JSON from ${url}: ${parseErr.message}`);
    err.status = upstream.status;
    err.contentType = upstream.headers.get('content-type') || null;
    err.stage = 'non-stream-json';
    err.debug = { responsePreview: raw.slice(0, 2000) };
    throw err;
  }
  const { text, thinking, toolCalls, stopReason } = parseResponse(json, isResponsesApi);
  const repairs = [];
  const responseBody = buildAnthropicResponse({
    model: body._requestedModel || cfg.model,
    text,
    thinking,
    toolCalls,
    stopReason,
    usage: json.usage,
    repairs,
    toolDefs: body.tools,
  });
  if (repairs.length) res._toolRepairs = (res._toolRepairs || []).concat(repairs);
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(responseBody));
}

// Standard chat/completions SSE streaming.
async function streamChatCompletions(upstream, emitter, idleTimeoutMs) {
  for await (const evt of iterSSE(upstream, idleTimeoutMs)) {
    const choice = evt.choices && evt.choices[0];
    if (!choice) {
      if (evt.usage) emitter.setUsage(evt.usage);
      continue;
    }
    const delta = choice.delta || {};
    // Reasoning models (NVIDIA Nemotron, DeepSeek R1, etc.) stream the chain of
    // thought separately in reasoning_content -> surface as Anthropic thinking.
    if (delta.reasoning_content) emitter.deltaThinking(delta.reasoning_content);
    if (delta.content) emitter.deltaText(delta.content);
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) emitter.deltaToolCall(tc.index ?? 0, tc);
    }
    if (choice.finish_reason) emitter.setStopReason(choice.finish_reason);
    if (evt.usage) emitter.setUsage(evt.usage);
  }
}

function responsesToolUseId(item, idx) {
  const callId = typeof item?.call_id === 'string' ? item.call_id : null;
  // Responses API has two IDs for function calls: the output item id (`fc_*`) and
  // the replay id (`call_id`). Only `call_id` is valid for the next turn's
  // `function_call_output.call_id`; never synthesize one from `fc_*` because
  // Azure rejects tool outputs that reference unknown call IDs.
  if (callId) return callId;

  const outputId = item?.id || item?.outputId;
  if (isResponsesOutputItemId(outputId)) return null;
  return safeResponsesCallId(outputId, idx);
}

function emitResponsesFunctionCall(emitter, idx, item) {
  const id = responsesToolUseId(item, idx);
  if (!id) return false;
  emitter.deltaToolCall(idx, {
    id,
    function: { name: item.name || '', arguments: item.arguments || item.argsBuf || '' }
  });
  return true;
}

// Azure /openai/responses SSE streaming (Responses API event format).
async function streamResponsesApi(upstream, emitter, idleTimeoutMs) {
  // Responses streams may expose the output item id (fc_...) before the real
  // call_id is available. Anthropic history replays tool_result.tool_use_id back
  // as function_call_output.call_id, and Azure rejects fc_* there. Buffer each
  // function call until its done event so we only expose a replay-safe id.
  const pending = new Map(); // output_index → { id, outputId, call_id, name, argsBuf }
  const emittedFunctionCallIndexes = new Set();
  let sawFunctionCall = false;

  for await (const evt of iterSSE(upstream, idleTimeoutMs)) {
    if (!evt.type) {
      // Fallback: some Azure versions emit chat-completion-shaped chunks.
      if (evt.choices) {
        const choice = evt.choices[0];
        const delta = choice?.delta || {};
        if (delta.content) emitter.deltaText(delta.content);
        if (delta.tool_calls) {
          sawFunctionCall = true;
          for (const tc of delta.tool_calls) emitter.deltaToolCall(tc.index ?? 0, tc);
        }
        if (choice?.finish_reason) emitter.setStopReason(choice.finish_reason);
      }
      if (evt.usage) emitter.setUsage(evt.usage);
      continue;
    }
    switch (evt.type) {
      case 'response.output_text.delta':
        emitter.deltaText(evt.delta || '');
        break;
      case 'response.output_text.done':
        break; // already accumulated via delta
      case 'response.output_item.added':
        if (evt.item?.type === 'function_call') {
          const idx = evt.output_index ?? 0;
          sawFunctionCall = true;
          pending.set(idx, {
            id: evt.item.id,
            outputId: evt.item.id,
            call_id: evt.item.call_id,
            name: evt.item.name || '',
            argsBuf: ''
          });
        }
        break;
      case 'response.output_item.done':
        if (evt.item?.type === 'function_call') {
          const idx = evt.output_index ?? 0;
          sawFunctionCall = true;
          const p = pending.get(idx) || {};
          const doneItem = {
            ...p,
            ...evt.item,
            outputId: p.outputId || evt.item.id,
            name: evt.item.name || p.name || '',
            arguments: evt.item.arguments != null ? String(evt.item.arguments) : p.argsBuf
          };
          if (doneItem.call_id || doneItem.id || doneItem.outputId) {
            if (emitResponsesFunctionCall(emitter, idx, doneItem)) emittedFunctionCallIndexes.add(idx);
          } else {
            pending.set(idx, doneItem);
          }
        }
        break;
      case 'response.function_call_arguments.delta': {
        const idx = evt.output_index ?? 0;
        const chunk = evt.delta || '';
        const p = pending.get(idx) || { argsBuf: '' };
        p.argsBuf = (p.argsBuf || '') + chunk;
        pending.set(idx, p);
        const id = responsesToolUseId(p, idx) || safeResponsesCallId(p.outputId || p.id, idx);
        emitter.deltaToolCall(idx, {
          id,
          function: { name: p.name || '', arguments: chunk }
        });
        break;
      }
      case 'response.function_call_arguments.done': {
        if (evt.arguments != null) {
          const idx = evt.output_index ?? 0;
          const p = pending.get(idx) || {};
          p.argsBuf = String(evt.arguments);
          pending.set(idx, p);
        }
        break;
      }
      case 'response.completed':
      case 'response.incomplete': {
        const resp = evt.response || {};
        if (resp.usage) emitter.setUsage(resp.usage);
        for (const item of resp.output || []) {
          if (item.type === 'function_call') {
            const idx = item.output_index ?? item.index ?? 0;
            if (pending.has(idx) && !emittedFunctionCallIndexes.has(idx)) {
              sawFunctionCall = true;
              const p = pending.get(idx);
              if (emitResponsesFunctionCall(emitter, idx, {
                ...p,
                ...item,
                outputId: p.outputId || item.id,
                arguments: item.arguments != null ? String(item.arguments) : p.argsBuf
              })) emittedFunctionCallIndexes.add(idx);
              pending.delete(idx);
            }
          }
        }
        for (const [idx, p] of pending) {
          if (emittedFunctionCallIndexes.has(idx)) continue;
          if (emitResponsesFunctionCall(emitter, idx, p)) emittedFunctionCallIndexes.add(idx);
        }
        pending.clear();
        const truncated = resp.status === 'incomplete' ||
          resp.incomplete_details?.reason === 'max_output_tokens';
        const hasTools = sawFunctionCall ||
          (resp.output || []).some(o => o.type === 'function_call');
        emitter.setStopReason(truncated ? 'length' : hasTools ? 'tool_calls' : 'stop');
        break;
      }
      case 'error':
        throw Object.assign(
          new Error(`Responses API stream error: ${evt.message || evt.code || JSON.stringify(evt)}`),
          { stage: 'responses-api-stream' }
        );
      // response.created, response.in_progress — informational, skip
    }
  }
}

// Parse non-streaming response — handles both chat/completions and Responses API formats.
function parseResponsesText(item) {
  if (!item) return '';
  if (typeof item.output_text === 'string') return item.output_text;
  if (Array.isArray(item.content)) {
    return item.content
      .map(c => c?.text || c?.output_text || '')
      .filter(Boolean)
      .join('');
  }
  return '';
}

function parseResponse(json, isResponsesApi) {
  // Detect format at runtime so we handle format-mismatches gracefully.
  if (!isResponsesApi && json.choices) {
    const choice = json.choices[0];
    const msg = choice?.message || {};
    return {
      text: msg.content || '',
      thinking: msg.reasoning_content || '',
      toolCalls: (msg.tool_calls || []).map(tc => ({
        id: tc.id, name: tc.function?.name, arguments: tc.function?.arguments
      })),
      stopReason: choice?.finish_reason
    };
  }

  // Responses API: { output: [ { type:'message', content: [{type:'output_text', text:'...'}] } ] }
  if (json.output) {
    const outputMessages = json.output.filter(o => o.type === 'message');
    const text = outputMessages.map(parseResponsesText).filter(Boolean).join('');
    const thinkingParts = outputMessages.flatMap(o => o.content || [])
      .filter(c => c.type === 'reasoning' || c.type === 'thinking');
    const thinking = thinkingParts
      .map(c => c.text || c.summary?.map(s => s.text || '').join('') || '')
      .filter(Boolean)
      .join('');
    const toolItems = (json.output || []).filter(o => o.type === 'function_call');
    const truncated = json.status === 'incomplete' ||
      json.incomplete_details?.reason === 'max_output_tokens';
    return {
      text,
      thinking,
      toolCalls: toolItems.map((tc, i) => ({
        id: responsesToolUseId(tc, i), name: tc.name, arguments: tc.arguments
      })).filter(tc => tc.id),
      stopReason: toolItems.length ? 'tool_calls' : (truncated ? 'length' : 'stop')
    };
  }

  if (json.usage || json.error) {
    return { text: json.output_text || '', toolCalls: [], stopReason: json.status === 'incomplete' ? 'length' : 'stop' };
  }

  // Unexpected format — return empty rather than crash.
  return { text: '', toolCalls: [], stopReason: 'end_turn' };
}

// Normalise NVIDIA config: a build.nvidia.com model page URL in the endpoint
// field is converted to the integrate.api.nvidia.com base URL, and the model
// ID is extracted from the path (e.g. /deepseek-ai/deepseek-v4-pro).
// This lets users paste a build.nvidia.com URL directly without manually
// converting it to an API model string.
function resolveNvidiaConfig(cfg) {
  const raw = (cfg.endpoint || '').trim();
  const m = raw.match(/^https?:\/\/build\.nvidia\.com\/([^?#]+?)\/?$/);
  if (!m) return cfg;
  const modelFromUrl = m[1]; // e.g. "deepseek-ai/deepseek-v4-pro"
  return {
    ...cfg,
    model: cfg.model || modelFromUrl,
    endpoint: 'https://integrate.api.nvidia.com/v1'
  };
}

function modelForUpstream(cfg) {
  // Azure: deployment is the URL segment, payload model is informational.
  if (cfg.kind === 'azure') return cfg.deployment || cfg.model;
  return cfg.model;
}

// Models whose Azure deployment Target URI points to /openai/responses (not Chat Completions).
// When users enter a base URL, route these to /openai/responses automatically.
// Only models that exclusively use the Responses API (no chat/completions endpoint).
// gpt-5.x models support standard chat/completions — only use responses when the
// user explicitly pastes a full /openai/responses Target URI as the endpoint.
const RESPONSES_API_MODELS = new Set(['o3', 'o4-mini']);
function requiresResponsesApi(modelId) {
  if (!modelId) return false;
  const m = modelId.toLowerCase();
  return RESPONSES_API_MODELS.has(m);
}

function buildRequest(cfg) {
  if (cfg.kind === 'azure') {
    // Three flavors:
    //   1) Passthrough: endpoint already contains a full API path — use as-is.
    //   2) Responses API: model requires /openai/responses (e.g. gpt-5.5)
    //   3) AOAI deployment: {endpoint}/openai/deployments/{deployment}/chat/completions?api-version=...
    //   4) Direct Foundry inference: {endpoint}/chat/completions?api-version=...
    // Azure portal often shows cognitiveservices.azure.com but the live DNS record
    // is under openai.azure.com — rewrite transparently so pasting the portal URL works.
    const endpoint = (cfg.endpoint || '').trim().replace(/\/+$/, '')
      .replace(/\.cognitiveservices\.azure\.com\b/, '.openai.azure.com');
    const apiVersion = cfg.apiVersion || '2024-10-21';

    let pathname = '';
    try { pathname = new URL(endpoint).pathname; } catch {}
    const isFullPath = /\/(chat\/completions|openai\/responses|openai\/deployments\/.+)/.test(pathname);

    let url, isResponsesApi = false;
    if (isFullPath) {
      // Endpoint already has the full path. Append api-version only if not already present.
      const alreadyHasVersion = /[?&]api-version=/.test(endpoint);
      if (alreadyHasVersion) {
        url = endpoint;
      } else {
        const sep = endpoint.includes('?') ? '&' : '?';
        url = `${endpoint}${sep}api-version=${encodeURIComponent(apiVersion)}`;
      }
      isResponsesApi = pathname.includes('/openai/responses');
    } else if (requiresResponsesApi(cfg.model) || requiresResponsesApi(cfg.deployment)) {
      // Model requires Responses API — route to /openai/responses regardless of deployment field.
      url = `${endpoint}/openai/responses?api-version=${encodeURIComponent(apiVersion)}`;
      isResponsesApi = true;
    } else if (cfg.deployment) {
      url = `${endpoint}/openai/deployments/${encodeURIComponent(cfg.deployment)}/chat/completions?api-version=${encodeURIComponent(apiVersion)}`;
    } else {
      url = `${endpoint}/chat/completions?api-version=${encodeURIComponent(apiVersion)}`;
    }

    return {
      url,
      headers: { 'api-key': cfg.apiKey, Authorization: `Bearer ${cfg.apiKey}` },
      isResponsesApi
    };
  }

  // NVIDIA NIM (build.nvidia.com): https://integrate.api.nvidia.com/v1
  const base = (cfg.endpoint || 'https://integrate.api.nvidia.com/v1').replace(/\/+$/, '');
  return {
    url: `${base}/chat/completions`,
    headers: { Authorization: `Bearer ${cfg.apiKey}` },
    isResponsesApi: false
  };
}

module.exports = {
  callOpenAICompatible,
  _test: {
    buildResponsesPayload,
    buildResponsesInput,
    parseResponse,
    responsesToolUseId,
  }
};
