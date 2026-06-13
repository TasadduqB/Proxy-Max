// OpenAI-compatible providers (Azure AI Foundry + NVIDIA NIM).
// Both expose /v1/chat/completions; only auth + URL shape differ.
// Azure also supports the newer Responses API at /openai/responses.

const {
  anthropicToOpenAIMessages,
  anthropicToolsToOpenAI,
  createAnthropicSSEEmitter,
  buildAnthropicResponse,
  iterSSE
} = require('./_common');

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
  if (body.max_tokens != null) {
    if (isAzure) payload.max_completion_tokens = body.max_tokens;
    else payload.max_tokens = body.max_tokens;
  }

  const tools = anthropicToolsToOpenAI(body.tools);
  if (tools) payload.tools = tools;
  if (body.tool_choice) {
    if (body.tool_choice.type === 'auto') payload.tool_choice = 'auto';
    else if (body.tool_choice.type === 'any') payload.tool_choice = 'required';
    else if (body.tool_choice.type === 'tool') {
      payload.tool_choice = { type: 'function', function: { name: body.tool_choice.name } };
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

  if (body.tools) {
    payload.tools = body.tools.map(t => ({
      type: 'function',
      name: t.name,
      description: t.description,
      parameters: t.input_schema || { type: 'object', properties: {} }
    }));
  }
  if (body.tool_choice) {
    if (body.tool_choice.type === 'auto') payload.tool_choice = 'auto';
    else if (body.tool_choice.type === 'any') payload.tool_choice = 'required';
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
        parts.push({ type: m.role === 'assistant' ? 'output_text' : 'input_text', text: block.text });
      } else if (block.type === 'tool_use') {
        input.push({ type: 'function_call', call_id: block.id, name: block.name, arguments: JSON.stringify(block.input || {}) });
      } else if (block.type === 'tool_result') {
        const out = typeof block.content === 'string'
          ? block.content
          : (block.content || []).map(c => c.text || '').join('\n');
        input.push({ type: 'function_call_output', call_id: block.tool_use_id, output: out });
      } else if (block.type === 'image' && block.source) {
        const url = block.source.type === 'base64'
          ? `data:${block.source.media_type};base64,${block.source.data}`
          : block.source.url;
        parts.push({ type: 'input_image', image_url: url });
      }
    }
    if (parts.length) input.push({ role: m.role, content: parts });
  }
  return { instructions, input };
}

// providerCfg = { kind: 'azure'|'nvidia', endpoint, apiKey, model, apiVersion?, deployment? }
async function callOpenAICompatible(providerCfg, body, res) {
  const cfg = providerCfg.kind === 'nvidia' ? resolveNvidiaConfig(providerCfg) : providerCfg;
  const { url, headers, isResponsesApi } = buildRequest(cfg);
  const payload = buildPayload(body, modelForUpstream(cfg), cfg, isResponsesApi);

  const timeoutMs = Number(providerCfg.timeoutMs) > 0 ? Number(providerCfg.timeoutMs) : 60000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let upstream;
  try {
    upstream = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') throw new Error(`Upstream request timed out after ${timeoutMs}ms (URL: ${url})`);
    throw Object.assign(err, { message: `${err.message} (URL: ${url})` });
  } finally {
    if (!body.stream) clearTimeout(timer);
  }

  if (!upstream.ok) {
    clearTimeout(timer);
    const errText = await upstream.text();
    throw new Error(`Upstream ${upstream.status} from ${url}: ${errText.slice(0, 600)}`);
  }

  if (body.stream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    const emitter = createAnthropicSSEEmitter(res, cfg.model);
    try {
      if (isResponsesApi) {
        await streamResponsesApi(upstream, emitter);
      } else {
        await streamChatCompletions(upstream, emitter);
      }
      emitter.end();
    } catch (err) {
      emitter.fail(err);
    } finally {
      clearTimeout(timer);
    }
    return;
  }

  const json = await upstream.json();
  const { text, toolCalls, stopReason } = parseResponse(json, isResponsesApi);
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(buildAnthropicResponse({
    model: cfg.model,
    text,
    toolCalls,
    stopReason,
    usage: json.usage
  })));
}

// Standard chat/completions SSE streaming.
async function streamChatCompletions(upstream, emitter) {
  for await (const evt of iterSSE(upstream)) {
    const choice = evt.choices && evt.choices[0];
    if (!choice) {
      if (evt.usage) emitter.setUsage(evt.usage);
      continue;
    }
    const delta = choice.delta || {};
    if (delta.content) emitter.deltaText(delta.content);
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) emitter.deltaToolCall(tc.index ?? 0, tc);
    }
    if (choice.finish_reason) emitter.setStopReason(choice.finish_reason);
    if (evt.usage) emitter.setUsage(evt.usage);
  }
}

// Azure /openai/responses SSE streaming (Responses API event format).
async function streamResponsesApi(upstream, emitter) {
  for await (const evt of iterSSE(upstream)) {
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
      case 'response.completed': {
        const resp = evt.response || {};
        if (resp.usage) emitter.setUsage(resp.usage);
        const status = resp.status;
        emitter.setStopReason(status === 'completed' ? 'stop' : 'stop');
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
    return {
      text: textPart?.text || '',
      toolCalls: toolItems.map(tc => ({
        id: tc.id, name: tc.name, arguments: tc.arguments
      })),
      // The Responses API has no per-message finish_reason; infer tool_use from
      // the presence of function_call items so the CLI knows to run the tool.
      stopReason: toolItems.length ? 'tool_calls' : 'stop'
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

function buildRequest(cfg) {
  if (cfg.kind === 'azure') {
    // Three flavors:
    //   1) Passthrough: endpoint already contains a full API path — use as-is.
    //   2) AOAI deployment: {endpoint}/openai/deployments/{deployment}/chat/completions?api-version=...
    //   3) Direct Foundry inference: {endpoint}/chat/completions?api-version=...
    const endpoint = (cfg.endpoint || '').trim().replace(/\/+$/, '');
    const apiVersion = cfg.apiVersion || '2024-10-21';

    let pathname = '';
    try { pathname = new URL(endpoint).pathname; } catch {}
    const isFullPath = /\/(chat\/completions|openai\/responses|openai\/deployments\/.+)/.test(pathname);

    let url, isResponsesApi = false;
    if (isFullPath) {
      // Endpoint already has the full path — just append api-version.
      const sep = endpoint.includes('?') ? '&' : '?';
      url = `${endpoint}${sep}api-version=${encodeURIComponent(apiVersion)}`;
      isResponsesApi = pathname.includes('/openai/responses');
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
