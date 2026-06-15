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
      if (block.type === 'text') {
        // Skip empty text blocks (can appear after thinking-only turns are sanitized).
        if (block.text) parts.push(block.text);
      } else if (block.type === 'tool_use' || block.type === 'server_tool_use') {
        // server_tool_use = Anthropic server-executed tool (e.g. web_search via native API).
        // Treat it the same as tool_use when it appears in conversation history.
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: { name: block.name, arguments: JSON.stringify(block.input || {}) }
        });
      } else if (block.type === 'tool_result') {
        let rawContent;
        if (typeof block.content === 'string') {
          rawContent = block.content;
        } else {
          rawContent = (block.content || []).map(c => {
            if (c.type === 'web_search_result' || c.type === 'web_search_tool_result') {
              // Anthropic web_search result blocks: render as a readable citation.
              return `[${c.title || 'Result'}](${c.url || ''}): ${c.encrypted_content ? '(encrypted)' : (c.text || '')}`;
            }
            return c.text || c.data || '';
          }).join('\n');
        }
        // Prefix error results so non-Claude models know the tool call failed.
        const content = block.is_error ? `[Tool error] ${rawContent}` : rawContent;
        out.push({ role: 'tool', tool_call_id: block.tool_use_id, content });
      } else if (block.type === 'image' && block.source) {
        // OpenAI-style multimodal
        const url = block.source.type === 'base64'
          ? `data:${block.source.media_type};base64,${block.source.data}`
          : block.source.url;
        parts.push({ type: 'image_url', image_url: { url } });
      } else if (block.type === 'document' && block.source) {
        // Non-Anthropic APIs don't have native document support.
        // Convert to a text representation, preserving title and context.
        const titlePart = block.title ? `[Document: ${block.title}]` : '[Document]';
        const contextPart = block.context ? `\nContext: ${block.context}` : '';
        if (block.source.type === 'text') {
          parts.push(`${titlePart}\n${block.source.data}${contextPart}`);
        } else if (block.source.type === 'base64' && block.source.media_type?.startsWith('text/')) {
          try {
            const decoded = Buffer.from(block.source.data, 'base64').toString('utf8');
            parts.push(`${titlePart}\n${decoded}${contextPart}`);
          } catch {
            parts.push(titlePart + contextPart);
          }
        } else {
          // Binary document (PDF, etc.) — content cannot be transcoded; preserve metadata only.
          parts.push(titlePart + contextPart);
        }
      } else if (block.type === 'web_search_tool_result') {
        // Anthropic native web_search returns these as top-level blocks in the assistant turn.
        // Convert to readable text so the conversation history makes sense to non-Claude models.
        const results = (block.content || []).map(r => {
          if (r.encrypted_content) return `[Search result (encrypted)]`;
          return `**${r.title || 'Result'}**\nURL: ${r.url || ''}\n${r.text || ''}`;
        }).join('\n\n');
        if (results) parts.push(`[Web Search Results]\n${results}`);
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

// Descriptions for Anthropic built-in tools (no description field in the API payload).
const BUILTIN_TOOL_DESCRIPTIONS = {
  web_search:         'Search the internet for current information. Use when you need up-to-date facts, news, documentation, or any information not reliably in your training data. Always pass a concise, specific query.',
  bash:               'Execute a bash shell command and return its stdout/stderr output. Use for file operations, running scripts, reading system state, or any shell task.',
  str_replace_editor: 'View and edit files by replacing exact strings. Commands: view, create, str_replace, insert, undo_edit.',
  computer:           'Control the computer screen, keyboard, and mouse for GUI automation.',
};

// Anthropic computer use tools don't come with an explicit input_schema.
// If we pass them to OpenAI, we must inject their implicit schemas so the model knows how to call them.
const COMPUTER_USE_SCHEMAS = {
  'web_search_20250305': {
    type: 'object',
    required: ['query'],
    properties: {
      query: { type: 'string', description: 'The search query to execute. Be specific for best results.' }
    },
    additionalProperties: false
  },
  'bash_20241022': {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The bash command to run. Required unless restart is true.' },
      restart: { type: 'boolean', description: 'If true, restarts the tool state. Cannot be used with command.' }
    },
    additionalProperties: false
  },
  'text_editor_20241022': {
    type: 'object',
    required: ['command', 'path'],
    properties: {
      command: { type: 'string', enum: ['view', 'create', 'str_replace', 'insert', 'undo'], description: 'The command to run.' },
      path: { type: 'string', description: 'Absolute path to file.' },
      file_text: { type: 'string', description: 'Required for create.' },
      insert_line: { type: 'integer', description: 'Required for insert.' },
      new_str: { type: 'string' },
      old_str: { type: 'string' },
      view_range: { type: 'array', items: { type: 'integer' } }
    },
    additionalProperties: false
  },
  'computer_20241022': {
    type: 'object',
    required: ['action'],
    properties: {
      action: { type: 'string', enum: ['key', 'type', 'mouse_move', 'left_click', 'left_click_drag', 'right_click', 'middle_click', 'double_click', 'screenshot', 'cursor_position'] },
      coordinate: { type: 'array', items: { type: 'integer' } },
      text: { type: 'string' }
    },
    additionalProperties: false
  }
};

// Anthropic-specific request fields that OpenAI-compatible APIs reject with 400.
const ANTHROPIC_ONLY_FIELDS = new Set([
  'betas',           // beta feature flags array
  'metadata',        // user_id / session metadata
  'top_k',           // not in OpenAI spec
  'service_tier',    // Anthropic infra routing
  '_requestedModel', // proxy-internal tracking field
]);

// Strip every field and nested structure that only Anthropic's own API understands
// before forwarding to Azure / NVIDIA / other OpenAI-compatible endpoints.
function sanitizeForUpstream(body, opts = {}) {
  const { preserveCacheControl = false } = opts;
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

  // Strip cache_control from system blocks (array form) unless preserved.
  if (!preserveCacheControl && Array.isArray(out.system)) {
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
        if (!preserveCacheControl && blk.cache_control) {
          const { cache_control: _, ...clean } = blk;
          content.push(clean);
        } else {
          content.push(blk);
        }
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

// Intercepts and parses simulated tool calls (plain text) into structured tool calls.
function parseSimulatedTools(text) {
  if (!text) return [];
  const tools = [];
  let match;

  // Pattern 1: <tool_use><name>bash</name><input>{"command":"ls"}</input></tool_use>
  const xmlRegex = /<tool_use>[\s\S]*?<name>(.*?)<\/name>[\s\S]*?(?:<input>([\s\S]*?)<\/input>|<([\w]+)>([\s\S]*?)<\/\3>)[\s\S]*?<\/tool_use>/g;
  while ((match = xmlRegex.exec(text)) !== null) {
    let argsStr = '{}';
    if (match[2]) argsStr = match[2].trim();
    else if (match[3] && match[4]) argsStr = JSON.stringify({ [match[3]]: match[4].trim() });
    tools.push({ name: match[1].trim(), arguments: argsStr });
  }

  // Pattern 2: <tool_call>{"name":"bash","arguments":{...}}</tool_call>  (used by some models)
  const toolCallRegex = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
  while ((match = toolCallRegex.exec(text)) !== null) {
    try {
      const obj = JSON.parse(match[1]);
      if (obj.name) {
        const args = obj.arguments || obj.input || obj.params || {};
        tools.push({ name: obj.name, arguments: typeof args === 'string' ? args : JSON.stringify(args) });
      }
    } catch {}
  }

  // Pattern 3: <function_calls><invoke name="bash"><command>ls</command></invoke></function_calls>
  const fnCallsRegex = /<invoke\s+name="([^"]+)">([\s\S]*?)<\/invoke>/g;
  while ((match = fnCallsRegex.exec(text)) !== null) {
    const name = match[1];
    const inner = match[2];
    const params = {};
    const paramRegex = /<(\w+)>([\s\S]*?)<\/\1>/g;
    let pm;
    while ((pm = paramRegex.exec(inner)) !== null) params[pm[1]] = pm[2].trim();
    tools.push({ name, arguments: JSON.stringify(params) });
  }

  // Pattern 4: ```json\n{ "name": "bash", "arguments": {...} }\n```
  const mdJsonRegex = /```(?:json)?\s*(\{\s*"name"\s*:\s*"[^"]+"\s*(?:,\s*"(?:arguments|input|params)"\s*:\s*(?:\{[\s\S]*?\}|"[^"]*"))?\s*\})\s*```/g;
  while ((match = mdJsonRegex.exec(text)) !== null) {
    try {
      const obj = JSON.parse(match[1]);
      if (obj.name) {
        const args = obj.arguments || obj.input || obj.params || {};
        tools.push({ name: obj.name, arguments: typeof args === 'string' ? args : JSON.stringify(args) });
      }
    } catch {}
  }

  // Pattern 5: bare JSON at start of text {"name": "bash", "arguments": {...}}
  const nakedJsonRegex = /^\{\s*"name"\s*:\s*"[^"]+"\s*(?:,\s*"(?:arguments|input|params)"\s*:\s*\{[\s\S]*?\})?\s*\}/m;
  match = nakedJsonRegex.exec(text);
  if (match) {
    try {
      const obj = JSON.parse(match[0]);
      if (obj.name) {
        const args = obj.arguments || obj.input || obj.params || {};
        tools.push({ name: obj.name, arguments: typeof args === 'string' ? args : JSON.stringify(args) });
      }
    } catch {}
  }

  return tools;
}

function anthropicToolsToOpenAI(tools) {
  if (!tools || tools.length === 0) return undefined;
  return tools.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description
        || BUILTIN_TOOL_DESCRIPTIONS[t.name]
        || `Tool: ${t.name}`,
      parameters: t.input_schema
        || COMPUTER_USE_SCHEMAS[t.type]
        || { type: 'object', properties: {} }
    }
  }));
}

// Lightweight, zero-dependency heuristic JSON repair for LLM tool hallucinations.
function repairJSON(str) {
  if (!str) return "{}";
  str = str.trim();
  if (str === "") return "{}";
  try {
    return JSON.stringify(JSON.parse(str));
  } catch (e) {
    let fixed = str;
    // 1. Fix trailing commas before closing braces/brackets
    fixed = fixed.replace(/,\s*([}\]])/g, '$1');
    // 2. Count unclosed brackets/braces
    let openBraces = (fixed.match(/{/g) || []).length - (fixed.match(/}/g) || []).length;
    let openBrackets = (fixed.match(/\[/g) || []).length - (fixed.match(/\]/g) || []).length;
    // 3. Close open string quotes
    let inString = false;
    let escape = false;
    for (let i = 0; i < fixed.length; i++) {
      if (fixed[i] === '\\' && !escape) escape = true;
      else if (fixed[i] === '"' && !escape) inString = !inString;
      else escape = false;
    }
    if (inString) fixed += '"';
    // 4. Append missing closing brackets/braces
    for (let i = 0; i < openBrackets; i++) fixed += ']';
    for (let i = 0; i < openBraces; i++) fixed += '}';
    try {
      return JSON.stringify(JSON.parse(fixed));
    } catch (e2) {
      // If we completely fail, return {} to prevent fatal parser crash.
      return "{}";
    }
  }
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

  // Simulation Interceptor state
  let textBuffer = '';
  let simMode = false;
  let simFlushed = false;

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

    if (simMode) {
      textBuffer += text;
      return;
    }

    if (!simFlushed) {
      textBuffer += text;
      const t = textBuffer.trimStart();

      // Detect simulation patterns at the start of the response.
      // We use a 200-char window so preambles like "Sure!\n\n" don't
      // prematurely flush and hide a simulation that follows.
      const isSim = t.startsWith('<tool_use')
        || t.startsWith('<tool_call')
        || t.startsWith('<function_calls')
        || t.startsWith('```json\n{"name"')
        || t.startsWith('```\n{"name"')
        || t.startsWith('{"name"');
      if (isSim) {
        simMode = true;
        return;
      }

      // Once we have 200 chars OR clear non-simulation text, commit to normal mode.
      const clearlyNotSim = !t.startsWith('<') && !t.startsWith('`') && !t.startsWith('{') && t.length > 8;
      if (textBuffer.length >= 200 || clearlyNotSim) {
        simFlushed = true;
        ensureTextBlock();
        send('content_block_delta', {
          type: 'content_block_delta',
          index: textIndex,
          delta: { type: 'text_delta', text: textBuffer }
        });
        textBuffer = '';
      }
      return;
    }

    // Normal streaming mode.
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
      // Buffer the JSON rather than streaming it immediately, allowing us to repair it at the end.
      block.argsBuf += tc.function.arguments;
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
    if (res.__proxyTrace) res.__proxyTrace.note({ stopReason });
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

    // Flush any text stuck in the simulation detection buffer.
    // This happens when the full response is short (< 8 chars, e.g. "4", "ok")
    // and never satisfied the clearlyNotSim or 200-char thresholds.
    if (!simFlushed && !simMode && textBuffer) {
      simFlushed = true;
      ensureTextBlock();
      send('content_block_delta', {
        type: 'content_block_delta',
        index: textIndex,
        delta: { type: 'text_delta', text: textBuffer }
      });
      textBuffer = '';
    }

    if (textBlockOpen) {
      send('content_block_stop', { type: 'content_block_stop', index: textIndex });
      textBlockOpen = false;
    }

    // Process intercepted simulation if any
    if (simMode && textBuffer) {
      const simTools = parseSimulatedTools(textBuffer);
      if (simTools.length > 0) {
        for (const st of simTools) {
          const bIndex = nextBlockIndex++;
          send('content_block_start', {
            type: 'content_block_start',
            index: bIndex,
            content_block: { type: 'tool_use', id: newId('toolu'), name: st.name, input: {} }
          });
          const repArgs = repairJSON(st.arguments);
          send('content_block_delta', {
            type: 'content_block_delta',
            index: bIndex,
            delta: { type: 'input_json_delta', partial_json: repArgs }
          });
          send('content_block_stop', { type: 'content_block_stop', index: bIndex });
          toolBlocks.set(bIndex, { index: bIndex }); // Keep track so tool_use is reported
        }
      } else {
        // False alarm, flush it as text
        ensureTextBlock();
        send('content_block_delta', {
          type: 'content_block_delta',
          index: textIndex,
          delta: { type: 'text_delta', text: textBuffer }
        });
        send('content_block_stop', { type: 'content_block_stop', index: textIndex });
        textBlockOpen = false;
      }
    }

    for (const block of toolBlocks.values()) {
      if (block.argsBuf !== undefined) {
        const repairedArgs = repairJSON(block.argsBuf);
        send('content_block_delta', {
          type: 'content_block_delta',
          index: block.index,
          delta: { type: 'input_json_delta', partial_json: repairedArgs }
        });
      }
      send('content_block_stop', { type: 'content_block_stop', index: block.index });
    }
    if (toolBlocks.size > 0) stopReason = 'tool_use';
    send('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: outputTokens }
    });
    send('message_stop', { type: 'message_stop' });
    if (res.__proxyTrace) {
      res.__proxyTrace.note({
        stopReason,
        streamEnded: true,
        outputTokens,
        textBlockOpen,
        thinkingBlockOpen,
        toolCallCount: toolBlocks.size
      });
    }
    res.end();
  }

  function fail(err) {
    const message = String(err && err.message || err);
    if (res.__proxyTrace) {
      res.__proxyTrace.note({
        streamEnded: false,
        streamError: {
          name: err && err.name || 'Error',
          message
        }
      });
    }
    if (!started) {
      res.write(`event: error\ndata: ${JSON.stringify({
        type: 'error',
        error: { type: 'api_error', message }
      })}\n\n`);
      res.end();
      return;
    }
    send('error', {
      type: 'error',
      error: { type: 'api_error', message }
    });
    res.end();
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
    try { input = JSON.parse(repairJSON(tc.arguments)); } catch { input = {}; }
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
async function* iterSSE(response, idleTimeoutMs = 300000) {
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
        try {
          yield JSON.parse(data);
        } catch (e) {
          if (data.trim()) {
            console.warn(`[proxy] [sse] invalid JSON from upstream: ${data.slice(0, 200).replace(/\n/g, ' ')} (${e.message})`);
            // If the upstream has emitted an error payload as plain text, surface it
            if (/error/i.test(data) || /<!DOCTYPE html>/i.test(data)) {
              const err = new Error(`Upstream SSE invalid JSON: ${data.slice(0, 200)}`);
              err.stage = 'sse-json';
              err.debug = { responsePreview: data.slice(0, 2000) };
              throw err;
            }
          }
          // skip non-JSON keepalive/heartbeat lines
        }
      }
    }
  } finally {
    try { reader.cancel(); } catch {}
  }
}

module.exports = {
  newId,
  COMPUTER_USE_SCHEMAS,
  BUILTIN_TOOL_DESCRIPTIONS,
  sanitizeForUpstream,
  anthropicToOpenAIMessages,
  anthropicToolsToOpenAI,
  createAnthropicSSEEmitter,
  buildAnthropicResponse,
  iterSSE
};
