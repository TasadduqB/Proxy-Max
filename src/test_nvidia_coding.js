// Comprehensive NVIDIA NIM coding-model compatibility tester.
// Tests: basic chat, streaming SSE, tool use, multi-turn with tool_result.
// These are the exact patterns Claude Code uses in agentic mode.
//
// Usage: node src/test_nvidia_coding.js <nvapi-key>

'use strict';

const http  = require('http');
const https = require('https');

const PROXY  = 'http://127.0.0.1:8787';
const NVAPI  = 'https://integrate.api.nvidia.com/v1';
const API_KEY = process.argv[2];

if (!API_KEY || !API_KEY.startsWith('nvapi-')) {
  console.error('Usage: node src/test_nvidia_coding.js nvapi-<key>');
  process.exit(1);
}

// Best coding models on NVIDIA NIM – ordered by likely capability
const MODELS = [
  { id: 'deepseek-ai/deepseek-v4-pro',              label: 'DeepSeek V4 Pro' },
  { id: 'deepseek-ai/deepseek-v4-flash',            label: 'DeepSeek V4 Flash' },
  { id: 'nvidia/llama-3.1-nemotron-ultra-253b-v1',  label: 'Nemotron Ultra 253B (reasoning)' },
  { id: 'nvidia/nemotron-3-super-120b-a12b',         label: 'Nemotron 3 Super 120B (reasoning)' },
  { id: 'nvidia/llama-3.3-nemotron-super-49b-v1.5', label: 'Nemotron Super 49B v1.5' },
  { id: 'mistralai/codestral-22b-instruct-v0.1',    label: 'Codestral 22B' },
  { id: 'meta/llama-4-maverick-17b-128e-instruct',  label: 'Llama 4 Maverick 17B' },
  { id: 'qwen/qwen3.5-122b-a10b',                   label: 'Qwen 3.5 122B' },
  { id: 'moonshotai/kimi-k2.6',                     label: 'Kimi K2.6' },
  { id: 'mistralai/mistral-large-3-675b-instruct-2512', label: 'Mistral Large 3 675B' },
  { id: 'ibm/granite-34b-code-instruct',            label: 'Granite 34B Code' },
  { id: 'bigcode/starcoder2-15b',                   label: 'StarCoder2 15B' },
];

// Tool definition (simulates what Claude Code sends)
const TOOLS = [{
  name: 'execute_bash',
  description: 'Run a bash command and return its output',
  input_schema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The bash command to execute' },
      restart:  { type: 'boolean', description: 'Restart the shell session' }
    },
    required: ['command']
  }
}, {
  name: 'read_file',
  description: 'Read the contents of a file at a given path',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute path to the file' }
    },
    required: ['path']
  }
}];

// ─── HTTP helpers ───────────────────────────────────────────────────────────

function request(url, opts, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const raw = body ? JSON.stringify(body) : undefined;
    const req = lib.request({
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method:   opts.method || 'GET',
      headers:  {
        'Content-Type': 'application/json',
        ...(raw ? { 'Content-Length': Buffer.byteLength(raw) } : {}),
        ...opts.headers
      },
      timeout: opts.timeout || 45000
    }, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end',  () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error',   reject);
    if (raw) req.write(raw);
    req.end();
  });
}

function requestStream(url, opts, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const raw = JSON.stringify(body);
    const req = http.request({
      hostname: parsed.hostname,
      port:     parsed.port || 80,
      path:     parsed.pathname,
      method:   'POST',
      headers:  {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(raw),
        ...opts.headers
      },
      timeout: opts.timeout || 45000
    }, resolve);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error',   reject);
    req.write(raw);
    req.end();
  });
}

// ─── Configure proxy ────────────────────────────────────────────────────────

async function configureModel(modelId) {
  const r = await request(`${PROXY}/api/config`, { method: 'POST' }, {
    provider: 'nvidia',
    config: { model: modelId, endpoint: NVAPI, apiKey: API_KEY }
  });
  if (r.status !== 200) throw new Error(`config failed: ${r.status} ${r.body}`);
}

// ─── Tests ──────────────────────────────────────────────────────────────────

async function testBasicChat(modelId) {
  const r = await request(`${PROXY}/v1/messages`, { method: 'POST' }, {
    model: modelId, max_tokens: 200, stream: false,
    messages: [{ role: 'user', content: 'Write a Python function that reverses a string. Just the code, no explanation.' }]
  });
  if (r.status !== 200) return { ok: false, reason: `HTTP ${r.status}`, detail: r.body.slice(0,200) };
  let j;
  try { j = JSON.parse(r.body); } catch { return { ok: false, reason: 'bad JSON', detail: r.body.slice(0,200) }; }
  if (j.type === 'error') return { ok: false, reason: j.error?.type || 'api_error', detail: j.error?.message?.slice(0,200) };
  const text = (j.content || []).find(b => b.type === 'text')?.text || '';
  const hasCode = text.includes('def ') || text.includes('return') || text.includes('[::-1]');
  return { ok: hasCode, reason: hasCode ? 'coherent code response' : 'response lacks code', detail: text.slice(0,120) };
}

async function testStreaming(modelId) {
  const body = {
    model: modelId, max_tokens: 80, stream: true,
    messages: [{ role: 'user', content: 'Say "stream_ok" and nothing else.' }]
  };
  const res = await requestStream(`${PROXY}/v1/messages`, {}, body);
  if (res.statusCode !== 200) {
    const buf = await new Promise(r => { const c=[]; res.on('data',d=>c.push(d)); res.on('end',()=>r(Buffer.concat(c).toString())); });
    return { ok: false, reason: `HTTP ${res.statusCode}`, detail: buf.slice(0,200) };
  }

  return new Promise((resolve) => {
    let buf = '';
    let events = [];
    let text = '';
    let sawContentStart = false;
    let sawDelta = false;
    let sawStop = false;
    const timer = setTimeout(() => resolve({ ok: false, reason: 'stream timeout', detail: `${events.length} events, text=${text.slice(0,60)}` }), 20000);

    res.on('data', chunk => {
      buf += chunk.toString();
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, idx); buf = buf.slice(idx + 2);
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) { events.push(line.slice(6).trim()); }
          if (line.startsWith('data:')) {
            const d = line.slice(5).trim();
            if (d === '[DONE]') continue;
            try {
              const ev = JSON.parse(d);
              if (ev.type === 'content_block_start') sawContentStart = true;
              if (ev.type === 'content_block_delta') { sawDelta = true; text += ev.delta?.text || ''; }
              if (ev.type === 'message_stop') sawStop = true;
            } catch {}
          }
        }
      }
    });
    res.on('end', () => {
      clearTimeout(timer);
      const ok = sawContentStart && sawDelta && sawStop;
      resolve({ ok, reason: ok ? 'SSE events well-formed' : `missing events (start=${sawContentStart} delta=${sawDelta} stop=${sawStop})`, detail: `events=[${events.slice(0,8).join(',')}] text="${text.slice(0,60)}"` });
    });
    res.on('error', e => { clearTimeout(timer); resolve({ ok: false, reason: e.message }); });
  });
}

async function testToolUse(modelId) {
  const r = await request(`${PROXY}/v1/messages`, { method: 'POST' }, {
    model: modelId, max_tokens: 500, stream: false,
    tools: TOOLS,
    messages: [{
      role: 'user',
      content: 'Use the execute_bash tool to run: echo "hello from tool"'
    }]
  });
  if (r.status !== 200) return { ok: false, reason: `HTTP ${r.status}`, detail: r.body.slice(0,200) };
  let j;
  try { j = JSON.parse(r.body); } catch { return { ok: false, reason: 'bad JSON', detail: r.body.slice(0,200) }; }
  if (j.type === 'error') return { ok: false, reason: j.error?.type || 'api_error', detail: j.error?.message?.slice(0,200) };

  const toolUse = (j.content || []).find(b => b.type === 'tool_use');
  if (!toolUse) {
    const text = (j.content||[]).find(b=>b.type==='text')?.text || '';
    return { ok: false, reason: `no tool_use block (stop_reason=${j.stop_reason})`, detail: text.slice(0,120) };
  }
  const hasCommand = typeof toolUse.input?.command === 'string';
  return {
    ok: hasCommand,
    reason: hasCommand ? `called ${toolUse.name}()` : `tool_use block missing .input.command`,
    detail: JSON.stringify(toolUse.input).slice(0,120)
  };
}

async function testMultiTurnWithToolResult(modelId) {
  // Simulate a full agentic round-trip: user → tool_use → tool_result → final answer
  // Step 1: initial request
  const r1 = await request(`${PROXY}/v1/messages`, { method: 'POST' }, {
    model: modelId, max_tokens: 500, stream: false,
    tools: TOOLS,
    messages: [{
      role: 'user',
      content: 'Read the file at path /etc/hostname using the read_file tool.'
    }]
  });
  if (r1.status !== 200) return { ok: false, reason: `HTTP ${r1.status}`, detail: r1.body.slice(0,200) };
  let j1;
  try { j1 = JSON.parse(r1.body); } catch { return { ok: false, reason: 'bad JSON step1' }; }
  if (j1.type === 'error') return { ok: false, reason: `api_error step1: ${j1.error?.message?.slice(0,100)}` };

  const tu = (j1.content || []).find(b => b.type === 'tool_use');
  if (!tu) return { ok: false, reason: `step1: no tool_use (stop=${j1.stop_reason})`, detail: (j1.content||[]).map(b=>b.type).join(',') };

  // Step 2: send tool_result and ask for final answer
  const r2 = await request(`${PROXY}/v1/messages`, { method: 'POST' }, {
    model: modelId, max_tokens: 150, stream: false,
    tools: TOOLS,
    messages: [
      { role: 'user',      content: 'Read the file at path /etc/hostname using the read_file tool.' },
      { role: 'assistant', content: j1.content },
      { role: 'user',      content: [{ type: 'tool_result', tool_use_id: tu.id, content: 'myserver.local' }] }
    ]
  });
  if (r2.status !== 200) return { ok: false, reason: `HTTP ${r2.status} step2`, detail: r2.body.slice(0,200) };
  let j2;
  try { j2 = JSON.parse(r2.body); } catch { return { ok: false, reason: 'bad JSON step2' }; }
  if (j2.type === 'error') return { ok: false, reason: `api_error step2: ${j2.error?.message?.slice(0,100)}` };

  const text = (j2.content||[]).find(b=>b.type==='text')?.text || '';
  const ok = text.length > 5;
  return { ok, reason: ok ? 'multi-turn tool round-trip complete' : 'empty response in step2', detail: text.slice(0,120) };
}

// ─── Runner ─────────────────────────────────────────────────────────────────

const COL = { reset:'\x1b[0m', bold:'\x1b[1m', green:'\x1b[32m', red:'\x1b[31m', yellow:'\x1b[33m', cyan:'\x1b[36m', dim:'\x1b[2m' };
const ok  = s => `${COL.green}✓${COL.reset} ${s}`;
const fail = s => `${COL.red}✗${COL.reset} ${s}`;
const warn = s => `${COL.yellow}~${COL.reset} ${s}`;

async function runModel(m) {
  process.stdout.write(`\n${COL.bold}${COL.cyan}▸ ${m.label}${COL.reset}  ${COL.dim}${m.id}${COL.reset}\n`);

  try { await configureModel(m.id); }
  catch (e) { console.log(`  ${fail('config: ' + e.message)}`); return null; }

  const results = {};

  for (const [name, fn] of [
    ['basic_chat',  () => testBasicChat(m.id)],
    ['streaming',   () => testStreaming(m.id)],
    ['tool_use',    () => testToolUse(m.id)],
    ['multi_turn',  () => testMultiTurnWithToolResult(m.id)],
  ]) {
    process.stdout.write(`  ${COL.dim}${name.padEnd(14)}${COL.reset}`);
    let res;
    try { res = await fn(); }
    catch (e) { res = { ok: false, reason: e.message }; }

    results[name] = res;
    if (res.ok) {
      process.stdout.write(`${ok(res.reason)}\n`);
    } else {
      process.stdout.write(`${fail(res.reason)}\n`);
      if (res.detail) process.stdout.write(`${COL.dim}               ${res.detail}${COL.reset}\n`);
    }
  }

  const passed = Object.values(results).filter(r=>r.ok).length;
  const total  = Object.keys(results).length;
  const score  = passed === total ? `${COL.green}${passed}/${total} all pass${COL.reset}` :
                 passed > 0       ? `${COL.yellow}${passed}/${total} partial${COL.reset}` :
                                    `${COL.red}${passed}/${total} fail${COL.reset}`;
  console.log(`  → ${score}`);
  return { model: m.id, label: m.label, passed, total, results };
}

async function main() {
  console.log(`\n${COL.bold}Proxy-Max NVIDIA NIM Coding Model Test Suite${COL.reset}`);
  console.log(`Proxy: ${PROXY}  |  Testing ${MODELS.length} models\n`);
  console.log(`Tests: basic_chat  •  streaming  •  tool_use  •  multi_turn\n`);
  console.log('─'.repeat(68));

  const summary = [];
  for (const m of MODELS) {
    const r = await runModel(m);
    if (r) summary.push(r);
  }

  // ── Summary table ──
  console.log('\n' + '─'.repeat(68));
  console.log(`${COL.bold}SUMMARY — Best models for Claude Code agentic use${COL.reset}\n`);
  const cols = ['basic_chat','streaming','tool_use','multi_turn'];
  console.log(`${'Model'.padEnd(38)} ${cols.map(c=>c.slice(0,6).padEnd(7)).join(' ')} Score`);
  console.log('─'.repeat(68));

  const sorted = [...summary].sort((a,b) => b.passed - a.passed);
  for (const r of sorted) {
    const cells = cols.map(c => {
      const res = r.results[c];
      if (!res) return COL.dim + ' skip  ' + COL.reset;
      return res.ok ? COL.green + ' PASS  ' + COL.reset : COL.red + ' FAIL  ' + COL.reset;
    });
    const bar = r.passed === r.total ? COL.green : r.passed > 0 ? COL.yellow : COL.red;
    console.log(`${r.label.slice(0,37).padEnd(38)} ${cells.join('')} ${bar}${r.passed}/${r.total}${COL.reset}`);
  }

  const fullyCompatible = sorted.filter(r => r.passed === r.total);
  const toolCompatible  = sorted.filter(r => r.results.tool_use?.ok && r.results.multi_turn?.ok);

  console.log('\n' + '─'.repeat(68));
  if (fullyCompatible.length) {
    console.log(`${COL.green}${COL.bold}Fully compatible (all 4 tests):${COL.reset}`);
    for (const r of fullyCompatible) console.log(`  ✓ ${r.label} (${r.id})`);
  }
  if (toolCompatible.length && toolCompatible.some(r => !fullyCompatible.includes(r))) {
    console.log(`\n${COL.yellow}${COL.bold}Agentic-capable (tool_use + multi_turn pass):${COL.reset}`);
    for (const r of toolCompatible) {
      if (!fullyCompatible.includes(r)) console.log(`  ~ ${r.label} (${r.id})`);
    }
  }

  console.log('');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
