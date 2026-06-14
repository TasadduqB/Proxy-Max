// Shared helpers used by every provider.
// All providers consume an Anthropic Messages-API payload and yield Anthropic SSE
// events (message_start / content_block_start / content_block_delta /
// content_block_stop / message_delta / message_stop) so the Anthropic CLI is happy.

const crypto = require('crypto');

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
}

// Anthropic content can be a string or an array of blocks.
// Convert it into a flat OpenAI-style {role, content:string} list, preserving
// system, user, assistant, and tool_result -> user(text) collapses.
function anthropicToOpenAIMessages(body) {
  const out = [];
  if (body.system) {
    const sys = typeof body.system === 'string'
      ? body.system
      : body.system.map(b => b.text || '').join('\n');
    if (sys) out.push({ role: 'system', content: sys });
  }
  for (const m of body.messages || []) {
    const role = m.role;
    if (typeof m.content === 'string') {
      out.push({ role, content: m.content });
      continue;
    }
    const parts = [];
    const toolCalls = [];
    for (const block of m.content || []) {
      if (block.type === 'text') parts.push(block.text);
      else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: { name: block.name, arguments: JSON.stringify(block.input || {}) }
        });
      } else if (block.type === 'tool_result') {
        const rawContent = typeof block.content === 'string'
          ? block.content
          : (block.content || []).map(c => c.text || c.data || '').join('\n');
        // Prefix error results so non-Claude models know the tool call failed.
        const content = block.is_error ? `[Tool error] ${rawContent}` : rawContent;
        out.push({ role: 'tool', tool_call_id: block.tool_use_id, content });
      } else if (block.type === 'image' && block.source) {
        // OpenAI-style multimodal
        const url = block.source.type === 'base64'
          ? `data:${block.source.media_type};base64,${block.source.data}`
          : block.source.url;
        parts.push({ type: 'image_url', image_url: { url } });
      }
    }
    if (parts.length || toolCalls.length) {
      const msg = { role };
      if (parts.length > 0) {
        const allText = parts.every(p => typeof p === 'string');
        msg.content = allText ? parts.join('\n') : parts.map(p =>
          typeof p === 'string' ? { type: 'text', text: p } : p);
      } else {
        // OpenAI spec: content must be null (not "") when only tool_calls are present.
        msg.content = null;
      }
      if (toolCalls.length) msg.tool_calls = toolCalls;
      out.push(msg);
    }
  }
  return out;
}

// Claude Code internal tool names that only work with Claude models (UI commands or
// computer-use primitives). Forwarding them to non-Claude models either causes
// "UI command" errors (Skill) or nonsensical tool calls (computer).
const CLAUDE_CODE_INTERNAL_TOOLS = new Set(['Skill', 'computer']);

// Anthropic-specific request fields that OpenAI-compatible APIs reject with 400.
const ANTHROPIC_ONLY_FIELDS = new Set([
  'betas',        // beta feature flags array
  'metadata',     // user_id / session metadata
  'top_k',        // not in OpenAI spec
  'service_tier', // Anthropic infra routing
]);

// Strip every field and nested structure that only Anthropic's own API understands
// before forwarding to Azure / NVIDIA / other OpenAI-compatible endpoints.
function sanitizeForUpstream(body) {
  const out = { ...body };

  // Drop Anthropic-only root fields
  for (const f of ANTHROPIC_ONLY_FIELDS) delete out[f];

  // thinking: type='disabled' → drop entirely.
  // type='adaptive'           → normalize to {type:'enabled'} so NVIDIA translation works.
  // type='enabled'            → keep as-is (budget_tokens handled downstream).
  if (out.thinking) {
    if (out.thinking.type === 'disabled') {
      delete out.thinking;
    } else if (out.thinking.type === 'adaptive') {
      // Adaptive is the new Sonnet 4.6+ style; map to enabled with no budget for NVIDIA.
      out.thinking = { type: 'enabled', budget_tokens: out.thinking.budget_tokens };
      if (!out.thinking.budget_tokens) delete out.thinking.budget_tokens;
    } else if (out.thinking.type === 'enabled') {
      // Drop display hint — not relevant for non-Claude models.
      if (out.thinking.display != null) {
        out.thinking = { ...out.thinking };
        delete out.thinking.display;
      }
    }
  }

  // Strip cache_control from system blocks (array form).
  if (Array.isArray(out.system)) {
    out.system = out.system.map(blk => {
      if (!blk.cache_control) return blk;
      const { cache_control: _, ...rest } = blk;
      return rest;
    });
  }

  // Sanitize message content blocks:
  //  - strip cache_control
  //  - drop redacted_thinking (Anthropic-signed; non-Claude models can't replay it)
  //  - thinking blocks in assistant history: keep as text marker so the model has
  //    context that reasoning happened, but don't forward the raw thinking block
  //    (it confuses non-Claude models and leaks internal reasoning)
  if (Array.isArray(out.messages)) {
    out.messages = out.messages.map(msg => {
      if (!Array.isArray(msg.content)) return msg;
      const content = [];
      for (const blk of msg.content) {
        if (blk.type === 'redacted_thinking') continue; // drop silently
        if (blk.type === 'thinking') continue;           // drop; reflected in text output
        const { cache_control: _, ...clean } = blk;
        content.push(clean);
      }
      if (content.length === 0 && msg.role === 'assistant') {
        // Keep at least an empty text block so the message isn't invalid.
        content.push({ type: 'text', text: '' });
      }
      return { ...msg, content };
    });
  }

  return out;
}

function anthropicToolsToOpenAI(tools) {
  if (!tools) return undefined;
  const filtered = tools.filter(t => !CLAUDE_CODE_INTERNAL_TOOLS.has(t.name));
  if (filtered.length === 0) return undefined;
  return filtered.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema || { type: 'object', properties: {} }
    }
  }));
}

// Build an SSE writer that emits canonical Anthropic events.
function createAnthropicSSEEmitter(res, model) {
  const messageId = newId('msg');
  let started = false;
  let textBlockOpen = false;
  let textIndex = 0;
  let thinkingBlockOpen = false;
  let thinkingIndex = 0;
  // Tool blocks keyed by upstream tool_call index -> our content block index.
  const toolBlocks = new Map();
  let nextBlockIndex = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let stopReason = 'end_turn';

  function send(event, data) {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  function start(usage = {}) {
    if (started) return;
    started = true;
    inputTokens = usage.input_tokens || 0;
    send('message_start', {
      type: 'message_start',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: inputTokens, output_tokens: 0 }
      }
    });
    send('ping', { type: 'ping' });
  }

  // Reasoning models emit a chain of thought before the answer; represent it as
  // an Anthropic thinking block, which must precede the text/tool blocks.
  function ensureThinkingBlock() {
    if (thinkingBlockOpen) return;
    thinkingIndex = nextBlockIndex++;
    thinkingBlockOpen = true;
    send('content_block_start', {
      type: 'content_block_start',
      index: thinkingIndex,
      content_block: { type: 'thinking', thinking: '' }
    });
  }

  function closeThinkingBlock() {
    if (!thinkingBlockOpen) return;
    send('content_block_delta', {
      type: 'content_block_delta',
      index: thinkingIndex,
      delta: { type: 'signature_delta', signature: Buffer.from('proxy-max').toString('base64') }
    });
    send('content_block_stop', { type: 'content_block_stop', index: thinkingIndex });
    thinkingBlockOpen = false;
  }

  function deltaThinking(text) {
    if (!text) return;
    start();
    ensureThinkingBlock();
    send('content_block_delta', {
      type: 'content_block_delta',
      index: thinkingIndex,
      delta: { type: 'thinking_delta', thinking: text }
    });
  }

  function ensureTextBlock() {
    if (textBlockOpen) return;
    closeThinkingBlock();
    textIndex = nextBlockIndex++;
    textBlockOpen = true;
    send('content_block_start', {
      type: 'content_block_start',
      index: textIndex,
      content_block: { type: 'text', text: '' }
    });
  }

  function deltaText(text) {
    if (!text) return;
    start();
    ensureTextBlock();
    send('content_block_delta', {
      type: 'content_block_delta',
      index: textIndex,
      delta: { type: 'text_delta', text }
    });
  }

  function deltaToolCall(idx, tc) {
    start();
    let block = toolBlocks.get(idx);
    if (!block) {
      // Close thinking + text blocks first if open, to keep ordering tidy.
      closeThinkingBlock();
      if (textBlockOpen) {
        send('content_block_stop', { type: 'content_block_stop', index: textIndex });
        textBlockOpen = false;
      }
      const blockIndex = nextBlockIndex++;
      block = {
        index: blockIndex,
        id: tc.id || newId('toolu'),
        name: tc.function?.name || '',
        argsBuf: ''
      };
      toolBlocks.set(idx, block);
      send('content_block_start', {
        type: 'content_block_start',
        index: blockIndex,
        content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} }
      });
    }
    if (tc.function?.name && !block.name) block.name = tc.function.name;
    if (tc.function?.arguments) {
      block.argsBuf += tc.function.arguments;
      send('content_block_delta', {
        type: 'content_block_delta',
        index: block.index,
        delta: { type: 'input_json_delta', partial_json: tc.function.arguments }
      });
    }
  }

  function setStopReason(r) {
    if (!r) return;
    const map = {
      stop: 'end_turn',
      length: 'max_tokens',
      tool_calls: 'tool_use',
      tool_use: 'tool_use',
      end_turn: 'end_turn',
      max_tokens: 'max_tokens',
      stop_sequence: 'stop_sequence'
    };
    stopReason = map[r] || 'end_turn';
  }

  function setUsage(usage) {
    if (!usage) return;
    if (usage.input_tokens != null) inputTokens = usage.input_tokens;
    if (usage.output_tokens != null) outputTokens = usage.output_tokens;
    if (usage.prompt_tokens != null) inputTokens = usage.prompt_tokens;
    if (usage.completion_tokens != null) outputTokens = usage.completion_tokens;
  }

  function end() {
    start();
    closeThinkingBlock();
    if (textBlockOpen) {
      send('content_block_stop', { type: 'content_block_stop', index: textIndex });
      textBlockOpen = false;
    }
    for (const block of toolBlocks.values()) {
      send('content_block_stop', { type: 'content_block_stop', index: block.index });
    }
    if (toolBlocks.size > 0) stopReason = 'tool_use';
    send('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: outputTokens }
    });
    send('message_stop', { type: 'message_stop' });
    res.end();
  }

  function fail(err) {
    if (!started) {
      res.write(`event: error\ndata: ${JSON.stringify({
        type: 'error',
        error: { type: 'api_error', message: String(err && err.message || err) }
      })}\n\n`);
      res.end();
      return;
    }
    end();
  }

  return { send, start, deltaText, deltaThinking, deltaToolCall, setStopReason, setUsage, end, fail };
}

// Build a non-stream Anthropic Messages response from accumulated parts.
function buildAnthropicResponse({ model, text, thinking, toolCalls, stopReason, usage }) {
  const content = [];
  if (thinking) content.push({ type: 'thinking', thinking, signature: Buffer.from('proxy-max').toString('base64') });
  if (text) content.push({ type: 'text', text });
  for (const tc of toolCalls || []) {
    let input = {};
    try { input = tc.arguments ? JSON.parse(tc.arguments) : {}; } catch { input = { _raw: tc.arguments }; }
    content.push({ type: 'tool_use', id: tc.id || newId('toolu'), name: tc.name, input });
  }
  if (content.length === 0) content.push({ type: 'text', text: '' });
  const map = {
    stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use',
    tool_use: 'tool_use', end_turn: 'end_turn', max_tokens: 'max_tokens',
    stop_sequence: 'stop_sequence'
  };
  return {
    id: newId('msg'),
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: map[stopReason] || (toolCalls && toolCalls.length ? 'tool_use' : 'end_turn'),
    stop_sequence: null,
    usage: {
      input_tokens: usage?.input_tokens ?? usage?.prompt_tokens ?? 0,
      output_tokens: usage?.output_tokens ?? usage?.completion_tokens ?? 0
    }
  };
}

// Iterate `data: ...` SSE lines from a Response body (Node fetch ReadableStream).
// idleTimeoutMs: if no bytes arrive within this window the stream is considered
// stalled and an error is thrown. Default 90s. Set to 0 to disable.
async function* iterSSE(response, idleTimeoutMs = 90000) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  // Wrap each read() in a per-chunk deadline so a stalled upstream is detected
  // quickly instead of hanging the connection indefinitely.
  function readChunk() {
    return new Promise((resolve, reject) => {
      const t = idleTimeoutMs > 0
        ? setTimeout(() => {
            reader.cancel().catch(() => {});
            reject(new Error(`Stream stalled — no data for ${Math.round(idleTimeoutMs / 1000)}s`));
          }, idleTimeoutMs)
        : null;
      reader.read().then(
        r => { if (t) clearTimeout(t); resolve(r); },
        e => { if (t) clearTimeout(t); reject(e); }
      );
    });
  }

  try {
    while (true) {
      const { value, done } = await readChunk();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const dataLines = chunk.split('\n')
          .filter(l => l.startsWith('data:'))
          .map(l => l.slice(5).trimStart());
        if (dataLines.length === 0) continue;
        const data = dataLines.join('\n');
        if (data === '[DONE]') return;
        try { yield JSON.parse(data); } catch { /* skip non-JSON keepalives */ }
      }
    }
  } finally {
    try { reader.cancel(); } catch {}
  }
}

module.exports = {
  newId,
  CLAUDE_CODE_INTERNAL_TOOLS,
  sanitizeForUpstream,
  anthropicToOpenAIMessages,
  anthropicToolsToOpenAI,
  createAnthropicSSEEmitter,
  buildAnthropicResponse,
  iterSSE
};
