// OpenAI-compatible providers (Azure AI Foundry + NVIDIA NIM).
// Both expose /v1/chat/completions; only auth + URL shape differ.

const {
  anthropicToOpenAIMessages,
  anthropicToolsToOpenAI,
  createAnthropicSSEEmitter,
  buildAnthropicResponse,
  iterSSE
} = require('./_common');

function buildPayload(body, model) {
  const payload = {
    model,
    messages: anthropicToOpenAIMessages(body),
    stream: !!body.stream,
    max_tokens: body.max_tokens,
    temperature: body.temperature,
    top_p: body.top_p,
    stop: body.stop_sequences
  };
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

// providerCfg = { kind: 'azure'|'nvidia', endpoint, apiKey, model, apiVersion?, deployment? }
async function callOpenAICompatible(providerCfg, body, res) {
  const { url, headers } = buildRequest(providerCfg);
  const payload = buildPayload(body, modelForUpstream(providerCfg));

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
    if (err.name === 'AbortError') throw new Error(`Upstream request timed out after ${timeoutMs}ms`);
    throw err;
  } finally {
    if (!body.stream) clearTimeout(timer);
  }

  if (!upstream.ok) {
    clearTimeout(timer);
    const errText = await upstream.text();
    throw new Error(`Upstream ${upstream.status}: ${errText.slice(0, 600)}`);
  }

  if (body.stream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    const emitter = createAnthropicSSEEmitter(res, providerCfg.model);
    try {
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
      emitter.end();
    } catch (err) {
      emitter.fail(err);
    } finally {
      clearTimeout(timer);
    }
    return;
  }

  const json = await upstream.json();
  const choice = json.choices && json.choices[0];
  const msg = choice?.message || {};
  const toolCalls = (msg.tool_calls || []).map(tc => ({
    id: tc.id, name: tc.function?.name, arguments: tc.function?.arguments
  }));
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(buildAnthropicResponse({
    model: providerCfg.model,
    text: msg.content || '',
    toolCalls,
    stopReason: choice?.finish_reason,
    usage: json.usage
  })));
}

function modelForUpstream(cfg) {
  // Azure: deployment is the URL segment, payload model is informational.
  if (cfg.kind === 'azure') return cfg.deployment || cfg.model;
  return cfg.model;
}

function buildRequest(cfg) {
  if (cfg.kind === 'azure') {
    // Two flavors:
    //   1) Foundry / AOAI: {endpoint}/openai/deployments/{deployment}/chat/completions?api-version=...
    //   2) Foundry models direct (Azure AI inference): {endpoint}/chat/completions?api-version=...
    const endpoint = cfg.endpoint.replace(/\/+$/, '');
    const apiVersion = cfg.apiVersion || '2024-10-21';
    let url;
    if (cfg.deployment) {
      url = `${endpoint}/openai/deployments/${encodeURIComponent(cfg.deployment)}/chat/completions?api-version=${encodeURIComponent(apiVersion)}`;
    } else {
      url = `${endpoint}/chat/completions?api-version=${encodeURIComponent(apiVersion)}`;
    }
    return {
      url,
      headers: { 'api-key': cfg.apiKey, Authorization: `Bearer ${cfg.apiKey}` }
    };
  }
  // NVIDIA NIM (build.nvidia.com): https://integrate.api.nvidia.com/v1
  const base = (cfg.endpoint || 'https://integrate.api.nvidia.com/v1').replace(/\/+$/, '');
  return {
    url: `${base}/chat/completions`,
    headers: { Authorization: `Bearer ${cfg.apiKey}` }
  };
}

module.exports = { callOpenAICompatible };
