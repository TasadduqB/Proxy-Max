const assert = require('assert');
const http = require('http');

const { _test: openaiCompat } = require('./src/providers/openai_compat');
const HistoryTrimmer = require('./src/optimizers/history-trimmer');
const ResponseCache = require('./src/cache/response-cache');

function testResponsesCallIdRoundTrip() {
  const parsed = openaiCompat.parseResponse({
    id: 'resp_1',
    status: 'completed',
    output: [{
      type: 'function_call',
      id: 'fc_06ee34f4c18f0e8f006a3172642a6c81939c459c4917e7385e',
      call_id: 'call_real_123',
      name: 'Bash',
      arguments: '{"command":"pwd"}'
    }]
  }, true);

  assert.strictEqual(parsed.toolCalls[0].id, 'call_real_123');

  const { input } = openaiCompat.buildResponsesInput({
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: parsed.toolCalls[0].id, name: 'Bash', input: { command: 'pwd' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: parsed.toolCalls[0].id, content: 'ok' }] },
    ]
  });

  assert.deepStrictEqual(input.filter(x => x.type === 'function_call').map(x => x.call_id), ['call_real_123']);
  assert.deepStrictEqual(input.filter(x => x.type === 'function_call_output').map(x => x.call_id), ['call_real_123']);
}

function testResponsesDoesNotSynthesizeFcCallId() {
  const parsed = openaiCompat.parseResponse({
    id: 'resp_2', status: 'completed',
    output: [{ type: 'function_call', id: 'fc_deadbeef', name: 'Bash', arguments: '{"command":"pwd"}' }]
  }, true);
  assert.strictEqual(parsed.toolCalls.length, 0, 'fc_* output item ids must not become replay call_id values');
}

function testResponsesParallelCallIdsRemainDistinct() {
  const parsed = openaiCompat.parseResponse({
    id: 'resp_3', status: 'completed',
    output: [
      { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'Bash', arguments: '{}' },
      { type: 'function_call', id: 'fc_b', call_id: 'call_b', name: 'Read', arguments: '{}' },
    ]
  }, true);
  assert.deepStrictEqual(parsed.toolCalls.map(t => t.id), ['call_a', 'call_b']);
}

function testHistoryTrimmerKeepsToolPairs() {
  const messages = [
    { role: 'user', content: 'start' },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: 'run tool' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_a', name: 'Bash', input: { command: 'pwd' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_a', content: 'C:/repo' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    { role: 'user', content: 'next' },
  ];
  const trimmer = new HistoryTrimmer();
  const result = trimmer.trim(messages, { maxMessages: 4, keepFirstN: 1 });
  assert.strictEqual(trimmer.validate(result.messages).ok, true);
  assert(result.messages.some(m => Array.isArray(m.content) && m.content.some(b => b.id === 'toolu_a')));
  assert(result.messages.some(m => Array.isArray(m.content) && m.content.some(b => b.tool_use_id === 'toolu_a')));
}

function testCacheKeepsToolIdsDistinct() {
  const cache = new ResponseCache({ cacheGet(){}, cacheSet(){} });
  const a = cache.makeKey('claude-opus-4-8', {
    stream: true,
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_a', name: 'Bash', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_a', content: 'ok' }] },
    ]
  }, { provider: 'azure:gpt-5.5' });
  const b = cache.makeKey('claude-opus-4-8', {
    stream: true,
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_b', name: 'Bash', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_b', content: 'ok' }] },
    ]
  }, { provider: 'azure:gpt-5.5' });
  assert.notStrictEqual(a, b);
}

async function postJSON(port, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, method: 'POST', path: '/v1/messages',
      headers: { 'content-type': 'application/json' }
    }, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

async function testFanoutHandlesParallelRequests() {
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', d => chunks.push(d));
    req.on('end', () => {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'chatcmpl_test', choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
      }, 120);
    });
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamPort = upstream.address().port;
  const oldEnv = { ...process.env };
  process.env.PORT = '0';
  process.env.PROXY_MAX_CONFIG_JSON = JSON.stringify({
    provider: 'azure',
    providers: { azure: { model: 'gpt-test', endpoint: `http://127.0.0.1:${upstreamPort}`, apiKey: 'test', apiVersion: '2025-04-01-preview' } },
    limits: { enabled: false },
    optimization: { responseCache: { enabled: false }, toolResults: { enabled: false }, historyTrim: { enabled: false }, toolCompress: { enabled: false }, compression: { enabled: false } }
  });
  process.env.PROXY_MAX_CONCURRENCY_PER_MEMBER = '1';
  process.env.PROXY_MAX_QUEUE_MS = '2000';
  delete require.cache[require.resolve('./src/server')];
  const proxy = require('./src/server');
  await new Promise(resolve => proxy.server.once('listening', resolve));
  const proxyPort = proxy.server.address().port;
  const body = { model: 'claude-opus-4-8', max_tokens: 16, stream: false, messages: [{ role: 'user', content: 'hi' }] };
  const started = Date.now();
  const results = await Promise.all([postJSON(proxyPort, body), postJSON(proxyPort, body), postJSON(proxyPort, body)]);
  assert(results.every(r => r.status === 200), results.map(r => r.status).join(','));
  assert(Date.now() - started >= 220, 'queued requests should serialize through one slot');
  await new Promise(resolve => proxy.server.close(resolve));
  await new Promise(resolve => upstream.close(resolve));
  process.env = oldEnv;
}

async function main() {
  testResponsesCallIdRoundTrip();
testResponsesDoesNotSynthesizeFcCallId();
testResponsesParallelCallIdsRemainDistinct();
  testHistoryTrimmerKeepsToolPairs();
  testCacheKeepsToolIdsDistinct();
  await testFanoutHandlesParallelRequests();
  console.log('compat tests passed');
}

main().catch(err => { console.error(err); process.exit(1); });
