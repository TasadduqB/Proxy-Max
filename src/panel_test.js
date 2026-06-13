const http = require('http');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = parseInt(process.env.PORT || '8787', 10);
const BASE = `http://${HOST}:${PORT}`;

function req(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(
      {
        host: HOST,
        port: PORT,
        path: pathname,
        method,
        headers: {
          ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {})
        }
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const txt = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = txt ? JSON.parse(txt) : null; } catch {}
          resolve({ status: res.statusCode, text: txt, json });
        });
      }
    );
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function run() {
  console.log(`Panel test target: ${BASE}`);

  const reset = await req('POST', '/api/panel/reset');
  if (reset.status !== 200 || !reset.json?.ok) throw new Error(`reset failed: ${reset.text}`);

  const impPayload = {
    type: 'impression',
    adId: 'ad-test-1',
    impressionId: 'imp-test-1001',
    sessionId: 'session-test-1',
    watchMs: 6000,
    source: 'panel-test-script'
  };
  const clkPayload = {
    type: 'click',
    adId: 'ad-test-1',
    impressionId: 'imp-test-1001',
    sessionId: 'session-test-1',
    watchMs: 0,
    source: 'panel-test-script'
  };

  const imp = await req('POST', '/api/panel/event', impPayload);
  if (imp.status !== 200 || !imp.json?.ok) throw new Error(`impression post failed: ${imp.text}`);

  const clk = await req('POST', '/api/panel/event', clkPayload);
  if (clk.status !== 200 || !clk.json?.ok) throw new Error(`click post failed: ${clk.text}`);

  const summaryRes = await req('GET', '/api/panel/summary');
  if (summaryRes.status !== 200 || !summaryRes.json?.ok) throw new Error(`summary failed: ${summaryRes.text}`);

  const eventsRes = await req('GET', '/api/panel/events?limit=10');
  if (eventsRes.status !== 200 || !eventsRes.json?.ok) throw new Error(`events failed: ${eventsRes.text}`);

  const s = summaryRes.json.summary || {};
  const events = eventsRes.json.events || [];

  const okSummary = s.total === 2 && s.impressions === 1 && s.clicks === 1 && s.watchMsTotal === 6000 && s.ctr === 1;
  const hasImp = events.some((e) => e.type === 'impression' && e.impressionId === 'imp-test-1001');
  const hasClk = events.some((e) => e.type === 'click' && e.impressionId === 'imp-test-1001');

  if (!okSummary) throw new Error(`summary mismatch: ${JSON.stringify(s)}`);
  if (!hasImp || !hasClk) throw new Error(`events mismatch: ${JSON.stringify(events)}`);

  console.log('Panel test passed.');
  console.log(JSON.stringify({ summary: s, latestEvents: events.slice(0, 2) }, null, 2));
}

run().catch((err) => {
  console.error('Panel test failed:', err.message || err);
  process.exit(1);
});
