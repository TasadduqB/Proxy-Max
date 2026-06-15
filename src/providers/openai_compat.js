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
let _undiciUnavailable = false;
function getInsecureDispatcher() {
  if (_insecureDispatcher) return _insecureDispatcher;
  if (_undiciUnavailable) return null;
  try {
    const { Agent } = require('undici');
    _insecureDispatcher = new Agent({ connect: { rejectUnauthorized: false } });
  } catch {
    _undiciUnavailable = true;
  }
  return _insecureDispatcher;
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
  try {
    return await fetch(url, opts);
  } catch (err) {
    if (!isCertError(err)) throw err;
    const dispatcher = getInsecureDispatcher();
    console.warn(`[proxy] TLS cert error (${err?.cause?.code}) — retrying with rejectUnauthorized=false for ${url}`);
    if (dispatcher) {
      return await fetch(url, { ...opts, dispatcher });
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

// Lightweight web search using DuckDuckGo's instant-answer API (no key required).
// Falls back gracefully if the API is unavailable.
async function performWebSearch(query) {
  if (!query) return [{ title: 'No query', url: '', snippet: 'No search query was provided.' }];
  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ProxyMax/1.0; +web-search)' },
      signal: AbortSignal.timeout(8000)
    });
    if (!r.ok) throw new Error(`DuckDuckGo API ${r.status}`);
    const data = await r.json();
    const results = [];
    if (data.AbstractText) {
      results.push({
        title: data.Heading || query,
        url: data.AbstractURL || `https://duckduckgo.com/?q=${encodeURIComponent(query)}`,
        snippet: data.AbstractText
      });
    }
    if (data.Answer) {
      results.push({ title: 'Instant Answer', url: data.AnswerURL || '', snippet: data.Answer });
    }
    for (const topic of (data.RelatedTopics || []).slice(0, 5)) {
      if (topic.Text && topic.FirstURL) {
        results.push({
          title: topic.Text.split(' - ')[0].slice(0, 100),
          url: topic.FirstURL,
          snippet: topic.Text
        });
      }
    }
    if (results.length === 0) {
      results.push({
        title: 'No instant results',
        url: `https://duckduckgo.com/?q=${encodeURIComponent(query)}`,
        snippet: `No instant results for "${query}". Visit: https://duckduckgo.com/?q=${encodeURIComponent(query)}`
      });
    }
    return results.slice(0, 5);
  } catch (e) {
    console.warn('[proxy] [web_search] error:', e.message);
    return [{ title: 'Search Error', url: '', snippet: `Web search failed: ${e.message}` }];
  }
}

// Execute proxy-handled tool calls (currently: web_search).
// Returns array of {tool_use_id, content, is_error}.
async function executeProxyTools(toolCalls) {
  const results = [];
  for (const tc of toolCalls) {
    if (tc.name === 'web_search') {
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

// Azure /openai/responses uses a different request shape than chat/completions:
//   - `input` (list of items) instead of `messages`
//   - system prompt goes in `instructions`
//   - `max_output_tokens` instead of max_tokens
//   - tools are flat ({type, name, description, parameters}), not nested under `function`
//   - tool calls / results are top-level items, not message fields
function buildResponsesPayload(body, model) {
  const { instructions, input } = buildResponsesInput(body);
  const payload = {
    model,
    input,
    stream: !!body.stream,
    temperature: body.temperature,
    top_p: body.top_p
  };
  if (instructions) payload.instructions = instructions;
  if (body.max_tokens != null) payload.max_output_tokens = body.max_tokens;

  if (body.tools && body.tools.length > 0) {
    payload.tools = body.tools.map(t => ({
      type: 'function',
      name: t.name,
      description: t.description || `Native computer use tool: ${t.name}`,
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

// Convert an Anthropic Messages body into Responses-API { instructions, input }.
function buildResponsesInput(body) {
  let instructions = '';
  if (body.system) {
    instructions = typeof body.system === 'string'
      ? body.system
      : body.system.map(b => b.text || '').join('\n');
  }
  const input = [];
  for (const m of body.messages || []) {
    if (typeof m.content === 'string') {
      input.push({ role: m.role, content: m.content });
      continue;
    }
    const parts = [];
    for (const block of m.content || []) {
      if (block.type === 'text') {
        if (block.text) parts.push({ type: m.role === 'assistant' ? 'output_text' : 'input_text', text: block.text });
      } else if (block.type === 'tool_use' || block.type === 'server_tool_use') {
        input.push({ type: 'function_call', call_id: block.id, name: block.name, arguments: JSON.stringify(block.input || {}) });
      } else if (block.type === 'tool_result') {
        const out = typeof block.content === 'string'
          ? block.content
          : (block.content || []).map(c => c.text || c.data || '').join('\n');
        input.push({ type: 'function_call_output', call_id: block.tool_use_id, output: out });
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
      }
    }
    if (parts.length) input.push({ role: m.role, content: parts });
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
    const timer = setTimeout(() => controller.abort(), connectTimeoutMs);
    let upstream;
    try {
      upstream = await fetchWithCertFallback(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(payloadNonStream),
        signal: controller.signal,
        ...(ALLOW_INSECURE && getInsecureDispatcher() ? { dispatcher: getInsecureDispatcher() } : {})
      });
    } catch (err) {
      clearTimeout(timer);
      if (err.name === 'AbortError') throw new Error(`Upstream timed out (${connectTimeoutMs}ms)`);
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

    const searchCalls = (toolCalls || []).filter(tc => tc.name === 'web_search');
    const otherCalls  = (toolCalls || []).filter(tc => tc.name !== 'web_search');
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
    const emitter = createAnthropicSSEEmitter(res, requestedModel);
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
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(buildAnthropicResponse({
      model: requestedModel,
      text: lastText,
      thinking: lastThinking,
      toolCalls: lastToolCalls,
      stopReason: lastStopReason,
      usage: lastJson && lastJson.usage
    })));
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
      ...(ALLOW_INSECURE && getInsecureDispatcher() ? { dispatcher: getInsecureDispatcher() } : {})
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
    const emitter = createAnthropicSSEEmitter(res, body._requestedModel || cfg.model);
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
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(buildAnthropicResponse({
    model: body._requestedModel || cfg.model,
    text,
    thinking,
    toolCalls,
    stopReason,
    usage: json.usage
  })));
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

// Azure /openai/responses SSE streaming (Responses API event format).
async function streamResponsesApi(upstream, emitter, idleTimeoutMs) {
  for await (const evt of iterSSE(upstream, idleTimeoutMs)) {
    if (!evt.type) {
      // Fallback: treat as chat completions event if it has choices
      if (evt.choices) {
        const choice = evt.choices[0];
        const delta = choice?.delta || {};
        if (delta.content) emitter.deltaText(delta.content);
        if (choice?.finish_reason) emitter.setStopReason(choice.finish_reason);
      }
      if (evt.usage) emitter.setUsage(evt.usage);
      continue;
    }
    switch (evt.type) {
      case 'response.output_text.delta':
        emitter.deltaText(evt.delta || '');
        break;
      case 'response.output_item.added':
        // tool call block started
        if (evt.item?.type === 'function_call') {
          emitter.deltaToolCall(evt.output_index ?? 0, {
            id: evt.item.id,
            function: { name: evt.item.name || '', arguments: '' }
          });
        }
        break;
      case 'response.function_call_arguments.delta':
        emitter.deltaToolCall(evt.output_index ?? 0, {
          function: { arguments: evt.delta || '' }
        });
        break;
      case 'response.completed':
      case 'response.incomplete': {
        const resp = evt.response || {};
        if (resp.usage) emitter.setUsage(resp.usage);
        // Truncation (e.g. reasoning model hitting the token cap) -> max_tokens.
        const truncated = resp.status === 'incomplete' ||
          resp.incomplete_details?.reason === 'max_output_tokens';
        emitter.setStopReason(truncated ? 'length' : 'stop');
        break;
      }
    }
  }
}

// Parse non-streaming response — handles both chat/completions and Responses API formats.
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
    const outputMsg = json.output.find(o => o.type === 'message');
    const textPart = outputMsg?.content?.find(c => c.type === 'output_text');
    const toolItems = (json.output || []).filter(o => o.type === 'function_call');
    const truncated = json.status === 'incomplete' ||
      json.incomplete_details?.reason === 'max_output_tokens';
    return {
      text: textPart?.text || '',
      toolCalls: toolItems.map(tc => ({
        id: tc.id, name: tc.name, arguments: tc.arguments
      })),
      // The Responses API has no per-message finish_reason; infer tool_use from
      // the presence of function_call items, and length when truncated.
      stopReason: toolItems.length ? 'tool_calls' : (truncated ? 'length' : 'stop')
    };
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
const RESPONSES_API_MODELS = new Set(['gpt-5.5', 'gpt-5.2', 'gpt-5.1', 'gpt-5', 'o3', 'o4-mini']);
// Also detect by model-id prefix/suffix patterns (deployment names often end in a suffix like -TVS).
function requiresResponsesApi(modelId) {
  if (!modelId) return false;
  const m = modelId.toLowerCase();
  if (RESPONSES_API_MODELS.has(m)) return true;
  // Match deployment names like "gpt-5.2-TVS" — strip trailing alphanumeric suffix and check base
  const base = m.replace(/-[a-z0-9]+$/i, '');
  return RESPONSES_API_MODELS.has(base);
}

function buildRequest(cfg) {
  if (cfg.kind === 'azure') {
    // Three flavors:
    //   1) Passthrough: endpoint already contains a full API path — use as-is.
    //   2) Responses API: model requires /openai/responses (e.g. gpt-5.5)
    //   3) AOAI deployment: {endpoint}/openai/deployments/{deployment}/chat/completions?api-version=...
    //   4) Direct Foundry inference: {endpoint}/chat/completions?api-version=...
    const endpoint = (cfg.endpoint || '').trim().replace(/\/+$/, '');
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

module.exports = { callOpenAICompatible };
