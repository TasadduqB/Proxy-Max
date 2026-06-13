// One-shot launcher: ensures node + claude are present, starts the proxy server
// in the background, then exec()s `claude` with ANTHROPIC_BASE_URL pointed at the proxy.
// Usable as `node src/launch.js [args passed to claude]`.

const path = require('path');
const { spawn } = require('child_process');
const { ensureNode, ensureClaude, detectNode, detectClaude } = require('./install');

const PORT = parseInt(process.env.PORT || '8787', 10);
const HOST = process.env.HOST || '127.0.0.1';

(async () => {
  // 1. Make sure node + npm are usable.
  let nodeInfo = detectNode();
  if (!nodeInfo.node || !nodeInfo.npm) nodeInfo = await ensureNode();

  // 2. Boot the proxy as a child process.
  const serverPath = path.resolve(__dirname, 'server.js');
  const server = spawn(nodeInfo.node, [serverPath], {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, PORT: String(PORT), HOST }
  });
  server.unref();

  // 3. Make sure the Anthropic CLI is installed.
  let claude = detectClaude();
  if (!claude) claude = await ensureClaude(nodeInfo.npm);

  // 4. Wait briefly for the server to start listening.
  await waitForPort(HOST, PORT, 5000);

  // 5. Hand off to claude.
  const args = process.argv.slice(2);
  const env = {
    ...process.env,
    ANTHROPIC_BASE_URL: `http://${HOST}:${PORT}`,
    ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN || 'proxy-max'
  };
  console.log(`\n→ Routing ${claude} through Proxy-Max at http://${HOST}:${PORT}\n`);
  const child = spawn(claude, args, { stdio: 'inherit', env });
  child.on('exit', code => {
    server.kill();
    process.exit(code || 0);
  });
})().catch(err => {
  console.error('[launch] failed:', err.message);
  process.exit(1);
});

function waitForPort(host, port, timeoutMs) {
  const net = require('net');
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const s = net.createConnection({ host, port }, () => { s.end(); resolve(); });
      s.on('error', () => {
        if (Date.now() - start > timeoutMs) reject(new Error('proxy did not start in time'));
        else setTimeout(tick, 150);
      });
    };
    tick();
  });
}
