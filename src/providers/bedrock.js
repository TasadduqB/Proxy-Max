// AWS Bedrock provider for Anthropic Claude models.
// Bedrock supports the Anthropic native payload directly, so translation is mostly a passthrough.
// We sign requests with SigV4 (no AWS SDK dependency).

const crypto = require('crypto');
const {
  createAnthropicSSEEmitter,
  buildAnthropicResponse,
  sanitizeForUpstream
} = require('./_common');

function hmac(key, str) { return crypto.createHmac('sha256', key).update(str).digest(); }
function sha256Hex(str) { return crypto.createHash('sha256').update(str).digest('hex'); }

function sigv4Sign({ method, host, path, query = '', body, region, service, accessKeyId, secretAccessKey, sessionToken }) {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);

  const headers = {
    host,
    'x-amz-date': amzDate,
    'content-type': 'application/json'
  };
  if (sessionToken) headers['x-amz-security-token'] = sessionToken;

  const sortedHeaderKeys = Object.keys(headers).sort();
  const canonicalHeaders = sortedHeaderKeys.map(k => `${k}:${headers[k]}`).join('\n') + '\n';
  const signedHeaders = sortedHeaderKeys.join(';');
  const payloadHash = sha256Hex(body || '');

  const canonicalRequest = [
    method, path, query, canonicalHeaders, signedHeaders, payloadHash
  ].join('\n');

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest)
  ].join('\n');

  const kDate = hmac('AWS4' + secretAccessKey, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  headers.Authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return headers;
}

function buildBedrockPayload(body) {
  const payload = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: body.max_tokens || 4096,
    messages: body.messages,
    system: body.system,
    temperature: body.temperature,
    top_p: body.top_p,
    stop_sequences: body.stop_sequences,
    tools: body.tools,
    tool_choice: body.tool_choice
  };
  // Bedrock supports extended thinking natively.
  if (body.thinking && body.thinking.type === 'enabled') payload.thinking = body.thinking;
  for (const k of Object.keys(payload)) if (payload[k] === undefined) delete payload[k];
  return payload;
}

// Parse the AWS event-stream binary frames.
// Frame layout: [TotalLen 4B][HeadersLen 4B][PreludeCRC 4B][Headers][Payload][MessageCRC 4B]
function* parseEventStream(buf) {
  let offset = 0;
  while (offset + 16 <= buf.length) {
    const totalLen = buf.readUInt32BE(offset);
    if (offset + totalLen > buf.length) return { rest: buf.slice(offset) };
    const headersLen = buf.readUInt32BE(offset + 4);
    const headersStart = offset + 12;
    const headersEnd = headersStart + headersLen;
    const payloadStart = headersEnd;
    const payloadEnd = offset + totalLen - 4;
    const payload = buf.slice(payloadStart, payloadEnd);

    // Parse headers (we only need :event-type / :message-type)
    const headers = {};
    let p = headersStart;
    while (p < headersEnd) {
      const nameLen = buf.readUInt8(p); p += 1;
      const name = buf.slice(p, p + nameLen).toString('utf8'); p += nameLen;
      const type = buf.readUInt8(p); p += 1;
      if (type === 7) { // string
        const valLen = buf.readUInt16BE(p); p += 2;
        headers[name] = buf.slice(p, p + valLen).toString('utf8'); p += valLen;
      } else { p = headersEnd; break; } // skip unknown header types
    }
    yield { headers, payload };
    offset += totalLen;
  }
  return { rest: buf.slice(offset) };
}

async function* iterEventStream(response) {
  const reader = response.body.getReader();
  let buf = Buffer.alloc(0);
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf = Buffer.concat([buf, Buffer.from(value)]);
    let consumed = 0;
    while (buf.length - consumed >= 16) {
      const totalLen = buf.readUInt32BE(consumed);
      if (buf.length - consumed < totalLen) break;
      const frame = buf.slice(consumed, consumed + totalLen);
      consumed += totalLen;
      const headersLen = frame.readUInt32BE(4);
      const headersBuf = frame.slice(12, 12 + headersLen);
      const payload = frame.slice(12 + headersLen, totalLen - 4);
      const headers = {};
      let p = 0;
      while (p < headersBuf.length) {
        const nameLen = headersBuf.readUInt8(p); p += 1;
        const name = headersBuf.slice(p, p + nameLen).toString('utf8'); p += nameLen;
        const type = headersBuf.readUInt8(p); p += 1;
        if (type === 7) {
          const valLen = headersBuf.readUInt16BE(p); p += 2;
          headers[name] = headersBuf.slice(p, p + valLen).toString('utf8'); p += valLen;
        } else { p = headersBuf.length; break; }
      }
      yield { headers, payload };
    }
    if (consumed > 0) buf = buf.slice(consumed);
  }
}

async function callBedrock(cfg, body, res) {
  // Bedrock uses native Anthropic format but doesn't support betas / cache_control /
  // redacted_thinking. Strip them to avoid upstream 400s.
  body = sanitizeForUpstream(body);
  const region = cfg.region || 'us-east-1';
  const accessKeyId = cfg.accessKeyId || process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = cfg.secretAccessKey || process.env.AWS_SECRET_ACCESS_KEY;
  const sessionToken = cfg.sessionToken || process.env.AWS_SESSION_TOKEN;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error('AWS credentials missing (accessKeyId / secretAccessKey).');
  }

  const stream = !!body.stream;
  const action = stream ? 'invoke-with-response-stream' : 'invoke';
  const modelId = encodeURIComponent(cfg.model);
  const host = cfg.endpoint
    ? new URL(cfg.endpoint).host
    : `bedrock-runtime.${region}.amazonaws.com`;
  const path = `/model/${modelId}/${action}`;
  const url = `https://${host}${path}`;

  const payload = JSON.stringify(buildBedrockPayload(body));
  const headers = sigv4Sign({
    method: 'POST', host, path, body: payload, region,
    service: 'bedrock', accessKeyId, secretAccessKey, sessionToken
  });
  if (stream) headers.Accept = 'application/vnd.amazon.eventstream';

  const upstream = await fetch(url, { method: 'POST', headers, body: payload });
  if (!upstream.ok) {
    const errText = await upstream.text();
    throw new Error(`Bedrock ${upstream.status}: ${errText.slice(0, 600)}`);
  }

  if (!stream) {
    const json = await upstream.json();
    res.setHeader('Content-Type', 'application/json');
    // Bedrock returns a near-Anthropic message; ensure model field reflects the requested id.
    json.model = cfg.model;
    res.end(JSON.stringify(json));
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  // For streaming, Bedrock already produces the Anthropic SSE event payloads
  // wrapped inside event-stream frames. We unwrap and forward verbatim, but
  // make sure model id is patched into message_start.
  try {
    for await (const frame of iterEventStream(upstream)) {
      const evtType = frame.headers[':event-type'];
      if (evtType === 'chunk') {
        let inner;
        try { inner = JSON.parse(frame.payload.toString('utf8')); } catch { continue; }
        if (inner.bytes) {
          const decoded = Buffer.from(inner.bytes, 'base64').toString('utf8');
          let evt;
          try { evt = JSON.parse(decoded); } catch { continue; }
          if (evt.type === 'message_start' && evt.message) evt.message.model = cfg.model;
          res.write(`event: ${evt.type}\n`);
          res.write(`data: ${JSON.stringify(evt)}\n\n`);
        }
      } else if (evtType === 'exception' || frame.headers[':message-type'] === 'exception') {
        res.write(`event: error\ndata: ${JSON.stringify({
          type: 'error',
          error: { type: 'api_error', message: frame.payload.toString('utf8') }
        })}\n\n`);
      }
    }
  } catch (err) {
    res.write(`event: error\ndata: ${JSON.stringify({
      type: 'error', error: { type: 'api_error', message: String(err.message || err) }
    })}\n\n`);
  }
  res.end();
}

module.exports = { callBedrock };
