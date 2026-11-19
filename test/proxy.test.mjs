import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, utimes, unlink, rmdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { gzipSync, zstdCompressSync } from 'node:zlib';
import test from 'node:test';
import sharp from 'sharp';
import { DEFAULT_CONFIG } from '../src/config.mjs';
import { createProxyServer } from '../src/server.mjs';
import { createLogger } from '../src/logging.mjs';
import { VERSION } from '../src/version.mjs';

const TEST_TIMEOUT = 10_000;
const MiB = 1024 * 1024;

test('forwards Responses SSE bytes and upstream accounting headers unchanged', { timeout: TEST_TIMEOUT }, async (t) => {
  const event = 'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":692,"output_tokens":5,"total_tokens":697}}}\n\n';
  const payload = '{ "model": "gpt-6-astra", "stream": true, "input": [] }';
  for (const value of [undefined, 'true', 'false']) {
    const env = await setup(t, {
      handle: (_req, res) => {
        const headers = { 'content-type': 'text/event-stream; charset=utf-8' };
        if (value !== undefined) headers['x-reasoning-included'] = value;
        res.writeHead(200, headers); res.end(event);
      },
    });
    for (const path of ['/responses', '/v1/responses?trace=test']) {
      const result = await send(env.url, { path, body: payload });
      assert.equal(result.headers['x-reasoning-included'], value);
      assert.equal(result.body.toString(), event);
      assert.equal(env.requests.at(-1).body.toString(), payload);
    }
  }
});

test('streams an upstream invalid-request event with its original HTTP status', { timeout: TEST_TIMEOUT }, async (t) => {
  const failure = 'data: {"type":"response.failed","response":{"error":{"code":"invalid_request_error","message":"fixture"}}}\n\n';
  const env = await setup(t, { handle: (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(failure);
  } });
  const result = await send(env.url, { path: '/v1/responses', body: '{"model":"gpt-6.1-sol","stream":true,"input":[]}' });
  assert.equal(result.status, 200);
  assert.equal(result.body.toString(), failure);
  assert.equal(env.requests.length, 1);
});

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

async function stop(server) {
  if (!server.listening) return;
  const closed = new Promise((resolve) => server.close(resolve));
  server.closeAllConnections();
  await closed;
}

async function readBody(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function setup(t, { config = {}, handle } = {}) {
  const requests = [];
  const logs = [];
  let resolveFirstLog;
  const firstLog = new Promise((resolve) => { resolveFirstLog = resolve; });
  const upstream = http.createServer(async (req, res) => {
    try {
      const entry = { method: req.method, url: req.url, headers: req.headers, body: await readBody(req) };
      requests.push(entry);
      if (handle) {
        await handle(req, res, entry);
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      }
    } catch (error) {
      if (!res.destroyed) res.destroy(error);
    }
  });
  const upstreamUrl = await listen(upstream);
  t.after(() => stop(upstream));
  const proxyConfig = { ...DEFAULT_CONFIG, logLevel: 'debug', host: '127.0.0.1', port: 4142, upstream: upstreamUrl, ...config };
  const log = createLogger({ level: proxyConfig.logLevel, write: (entry) => { logs.push(entry); resolveFirstLog(entry); } });
  const proxy = createProxyServer({ config: proxyConfig, log });
  const url = await listen(proxy);
  t.after(() => stop(proxy));
  return { proxy, upstream, url, upstreamUrl, requests, logs, firstLog };
}

function send(url, { method = 'POST', path = '/responses', headers = {}, body = '' } = {}) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(path, url), {
      method,
      headers: { ...(method === 'POST' ? { 'content-type': 'application/json' } : {}), ...headers },
      signal: AbortSignal.timeout(TEST_TIMEOUT - 1000),
    }, async (res) => {
      try {
        resolve({ status: res.statusCode, headers: res.headers, body: await readBody(res) });
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
    req.end(bytes);
  });
}

async function fixtureImage() {
  const png = await sharp({ create: { width: 2048, height: 1024, channels: 3, background: '#527d9c' } })
    .png().toBuffer();
  return `data:image/png;base64,${png.toString('base64')}`;
}

function imagePayload(imageUrl) {
  return {
    model: 'test-vision-model',
    instructions: 'Keep all model-visible fields.',
    stream: true,
    tools: [{ type: 'function', name: 'inspect', parameters: { type: 'object', properties: {} } }],
    reasoning: { effort: 'high', summary: 'auto' },
    input: [
      { type: 'message', role: 'user', content: [
        { type: 'input_text', text: 'Inspect these screenshots.' },
        { type: 'input_image', image_url: imageUrl, detail: 'original' },
      ] },
      { type: 'function_call_output', call_id: 'call_function', output: [
        { type: 'input_text', text: 'Function result metadata.' },
        { type: 'input_image', image_url: imageUrl, detail: 'high' },
      ] },
      { type: 'custom_tool_call_output', call_id: 'call_custom', output: [
        { type: 'input_image', image_url: imageUrl },
        { type: 'input_text', text: 'Custom result metadata.' },
      ] },
    ],
    metadata: { dataUrlAsText: imageUrl, nested: { image_url: 'https://example.invalid/reference.png' } },
    include: ['reasoning.encrypted_content'],
    store: false,
  };
}

function imageItems(payload) {
  return [payload.input[0].content[1], payload.input[1].output[1], payload.input[2].output[0]];
}

test('healthz identifies the proxy without reaching the upstream', { timeout: TEST_TIMEOUT }, async (t) => {
  const env = await setup(t);
  const result = await send(env.url, { method: 'GET', path: '/healthz' });
  assert.equal(result.status, 200);
  const health = JSON.parse(result.body);
  assert.equal(typeof health.service, 'string');
  assert.ok(health.service.length > 0);
  assert.equal(health.version, VERSION);
  assert.equal(env.requests.length, 0);
});

test('transforms three typed image containers and preserves native Responses fields and replies', { timeout: TEST_TIMEOUT }, async (t) => {
  const reply = '{ "output": [{"type":"function_call","namespace":"collaboration","name":"send_message","arguments":"{}","encrypted_function_args":["message"]}] }';
  const env = await setup(t, { handle: (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', etag: '"native-response"' });
    res.end(reply);
  } });
  const original = imagePayload(await fixtureImage());
  original.model = 'gpt-6-astra';
  original.stream = false;
  original.tools.push({ type: 'namespace', name: 'collaboration', tools: [{
    type: 'function', name: 'send_message', parameters: { type: 'object', properties: { message: { type: 'string', encrypted: true } } },
  }] });
  original.input.push({ type: 'agent_message', content: [{ type: 'encrypted_content', encrypted_content: 'opaque-fixture' }] });
  original.include.push('output.encrypted_content');
  const result = await send(env.url, { body: JSON.stringify(original) });
  assert.equal(result.status, 200);
  assert.equal(result.body.toString(), reply);
  assert.equal(result.headers.etag, '"native-response"');
  assert.equal(env.requests.length, 1);
  const forwarded = JSON.parse(env.requests[0].body);
  const expected = structuredClone(original);
  const actualImages = imageItems(forwarded);
  const expectedImages = imageItems(expected);
  for (let i = 0; i < actualImages.length; i++) {
    assert.match(actualImages[i].image_url, /^data:image\/jpeg;base64,/);
    const metadata = await sharp(Buffer.from(actualImages[i].image_url.split(',')[1], 'base64')).metadata();
    assert.equal(metadata.width, 1280);
    assert.equal(metadata.height, 640);
    expectedImages[i].image_url = actualImages[i].image_url;
  }
  assert.deepEqual(forwarded, expected);
  assert.equal(Number(env.requests[0].headers['content-length']), env.requests[0].body.length);
});

test('handles Responses and compact routes with and without the v1 prefix', { timeout: TEST_TIMEOUT }, async (t) => {
  const env = await setup(t);
  const payload = imagePayload(await fixtureImage());
  for (const path of ['/responses', '/responses/compact', '/v1/responses', '/v1/responses/compact?mode=test']) {
    const result = await send(env.url, { path, body: JSON.stringify(payload) });
    assert.equal(result.status, 200, path);
    const request = env.requests.at(-1);
    assert.equal(request.url, path);
    assert.match(imageItems(JSON.parse(request.body))[0].image_url, /^data:image\/jpeg;base64,/);
  }
  assert.equal(env.requests.length, 4);
});

test('keeps original JSON bytes when no typed image is present', { timeout: TEST_TIMEOUT }, async (t) => {
  const env = await setup(t);
  const raw = Buffer.from(' {\n  "model" : "test", "input" : "中文  keep spacing", "n":1e2 } \n');
  const result = await send(env.url, { body: raw });
  assert.equal(result.status, 200);
  assert.deepEqual(env.requests[0].body, raw);
  assert.equal(Number(env.requests[0].headers['content-length']), raw.length);
  assert.equal(env.logs.at(-1).imageFastPath, true);
});

test('image-free requests skip JSON.parse even with ordinary JSON escapes', { timeout: TEST_TIMEOUT }, async (t) => {
  const env = await setup(t);
  const raw = JSON.stringify({ model: 'test', input: 'line one\nline two\t"quoted"\\path', nested: { value: '中文' } });
  const originalParse = JSON.parse;
  let parses = 0;
  JSON.parse = function (...args) {
    parses += 1;
    return Reflect.apply(originalParse, JSON, args);
  };
  let result;
  try { result = await send(env.url, { body: raw }); }
  finally { JSON.parse = originalParse; }
  assert.equal(result.status, 200);
  assert.equal(parses, 0);
  assert.equal(env.requests[0].body.toString(), raw);
  assert.equal(env.logs.at(-1).imageFastPath, true);
});

test('Unicode-escaped image types and keys always fall back to image processing', { timeout: TEST_TIMEOUT }, async (t) => {
  const env = await setup(t);
  const original = imagePayload(await fixtureImage());
  const encoded = JSON.stringify(original, null, 2);
  const variants = [
    encoded.replaceAll('input_image', '\\u0069nput_image'),
    encoded.replaceAll('input_image', 'input\\u005fimage'),
    encoded.replaceAll('input_image', '\\u0069\\u006e\\u0070\\u0075\\u0074\\u005f\\u0069\\u006d\\u0061\\u0067\\u0065'),
    encoded.replaceAll('"type"', '"\\u0074ype"'),
  ];
  assert(!variants[0].includes('input_image'));
  for (const raw of variants) {
    const result = await send(env.url, { body: raw });
    assert.equal(result.status, 200);
    const forwarded = JSON.parse(env.requests.at(-1).body);
    for (const image of imageItems(forwarded)) assert.match(image.image_url, /^data:image\/jpeg;base64,/);
    assert.equal(env.logs.at(-1).imageFastPath, false);
    assert.equal(env.logs.at(-1).images.transformed, 3);
  }
});

test('conservative marker matches do not rewrite nested metadata or text', { timeout: TEST_TIMEOUT }, async (t) => {
  const env = await setup(t);
  const payloads = [
    { input: 'A string containing input_image is ordinary text.' },
    { input: [{ role: 'user', content: [{ type: 'input_text', text: '\\u0069nput_image' }] }] },
    { input: [{ role: 'user', content: [{ type: 'input_text', nested: { type: 'input_image', image_url: await fixtureImage() } }] }] },
  ];
  for (const payload of payloads) {
    const raw = JSON.stringify(payload, null, 2);
    assert.equal((await send(env.url, { body: raw })).status, 200);
    assert.equal(env.requests.at(-1).body.toString(), raw);
    assert.equal(env.logs.at(-1).imageFastPath, false);
    assert.equal(env.logs.at(-1).images.transformed, 0);
  }
});

test('decodes zstd and forwards ordinary JSON with correct length and headers', { timeout: TEST_TIMEOUT }, async (t) => {
  const env = await setup(t);
  const original = imagePayload(await fixtureImage());
  const compressed = zstdCompressSync(Buffer.from(JSON.stringify(original)));
  const result = await send(env.url, {
    headers: { 'content-encoding': 'zstd', 'content-length': String(compressed.length) },
    body: compressed,
  });
  assert.equal(result.status, 200);
  const request = env.requests[0];
  assert.equal(request.headers['content-encoding'], undefined);
  assert.equal(Number(request.headers['content-length']), request.body.length);
  assert.match(imageItems(JSON.parse(request.body))[0].image_url, /^data:image\/jpeg;base64,/);
});

test('passes other endpoints through byte-for-byte and removes hop-by-hop headers', { timeout: TEST_TIMEOUT }, async (t) => {
  const returned = Buffer.from([0, 255, 128, 65, 13, 10]);
  const env = await setup(t, { handle: (_req, res) => {
    res.writeHead(207, {
      'content-type': 'application/octet-stream',
      'content-length': returned.length,
      'x-upstream-marker': 'kept',
      connection: 'x-private-upstream',
      'x-private-upstream': 'remove-me',
    });
    res.end(returned);
  } });
  const result = await send(env.url, {
    method: 'GET', path: '/v1/models?limit=2',
    headers: {
      authorization: 'Bearer test-authorization-sentinel',
      connection: 'x-private-client',
      'x-private-client': 'remove-me',
      'x-client-marker': 'kept',
    },
  });
  assert.equal(result.status, 207);
  assert.deepEqual(result.body, returned);
  assert.equal(result.headers['x-upstream-marker'], 'kept');
  assert.equal(result.headers['x-private-upstream'], undefined);
  assert.equal(env.requests[0].method, 'GET');
  assert.equal(env.requests[0].url, '/v1/models?limit=2');
  assert.equal(env.requests[0].headers.authorization, 'Bearer test-authorization-sentinel');
  assert.equal(env.requests[0].headers['x-client-marker'], 'kept');
  assert.equal(env.requests[0].headers['x-private-client'], undefined);
});

test('streams unknown POST endpoints without parsing their non-JSON body', { timeout: TEST_TIMEOUT }, async (t) => {
  const env = await setup(t);
  const raw = Buffer.from([255, 0, 1, 2, 3, 128]);
  const result = await send(env.url, { path: '/opaque', headers: { 'content-type': 'application/octet-stream' }, body: raw });
  assert.equal(result.status, 200);
  assert.deepEqual(env.requests[0].body, raw);
});

test('forwards the first SSE chunk before the upstream finishes', { timeout: TEST_TIMEOUT }, async (t) => {
  let finishUpstream;
  const canFinish = new Promise((resolve) => { finishUpstream = resolve; });
  const first = 'event: response.output_text.delta\ndata: {"delta":"first"}\n\n';
  const last = 'data: [DONE]\n\n';
  const env = await setup(t, { handle: async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.write(first);
    await canFinish;
    res.end(last);
  } });
  t.after(finishUpstream);
  const observed = await new Promise((resolve, reject) => {
    const req = http.request(new URL('/responses', env.url), {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(3000),
    }, (res) => {
      const chunks = [];
      let firstSeen = false;
      res.on('data', (chunk) => {
        chunks.push(chunk);
        const received = Buffer.concat(chunks).toString();
        if (!firstSeen && Buffer.byteLength(received) >= Buffer.byteLength(first)) {
          firstSeen = true;
          try {
            assert.equal(res.statusCode, 200);
            assert.match(res.headers['content-type'], /text\/event-stream/);
            assert.equal(received, first);
            finishUpstream();
          } catch (error) { reject(error); req.destroy(); }
        }
      });
      res.on('end', () => resolve(Buffer.concat(chunks).toString()));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end('{"model":"test","input":"stream"}');
  });
  assert.equal(observed, first + last);
});

test('destroys the upstream response when the client cancels an SSE stream', { timeout: TEST_TIMEOUT }, async (t) => {
  let resolveUpstreamClosed;
  const upstreamClosed = new Promise((resolve) => { resolveUpstreamClosed = resolve; });
  const env = await setup(t, { handle: (_req, res) => {
    res.on('close', resolveUpstreamClosed);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: first\n\n');
  } });
  await new Promise((resolve, reject) => {
    const req = http.request(new URL('/responses', env.url), {
      method: 'POST', signal: AbortSignal.timeout(3000),
      headers: { 'content-type': 'application/json' },
    }, (res) => {
      res.once('data', () => { res.destroy(); req.destroy(); resolve(); });
      res.on('error', () => {});
    });
    req.on('error', reject);
    req.end('{"model":"test","input":"cancel"}');
  });
  await Promise.race([
    upstreamClosed,
    delay(2000, undefined, { ref: false }).then(() => { throw new Error('The upstream stream remained open after client cancellation'); }),
  ]);
  await env.firstLog;
  assert.equal(env.requests.length, 1);
  assert.equal(env.logs.length, 1);
  assert.equal(env.logs[0].level, 'debug');
  assert.equal(env.logs[0].abortSource, 'client');
  assert.equal(env.logs[0].aborted, true);
  assert.equal(env.logs[0].error, undefined);
});

test('does not reuse its connect timeout as an SSE read timeout', { timeout: TEST_TIMEOUT }, async (t) => {
  const env = await setup(t, { config: { connectTimeoutMs: 50 }, handle: async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: first\n\n');
    await delay(200);
    res.end('data: last\n\n');
  } });
  const result = await send(env.url, { body: '{"model":"test","input":"wait for stream"}' });
  assert.equal(result.status, 200);
  assert.equal(result.body.toString(), 'data: first\n\ndata: last\n\n');
  assert.equal(env.requests.length, 1);
});

test('propagates an interrupted upstream stream without appending a JSON error', { timeout: TEST_TIMEOUT }, async (t) => {
  const first = 'data: partial-upstream-output\n\n';
  const env = await setup(t, { config: { logLevel: 'info' }, handle: async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(first);
    await delay(30);
    res.destroy();
  } });
  const result = await new Promise((resolve, reject) => {
    const req = http.request(new URL('/responses', env.url), {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(3000),
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('error', () => {});
      res.once('close', () => resolve({ status: res.statusCode, complete: res.complete, text: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end('{"model":"test","input":"upstream disconnect"}');
  });
  assert.equal(result.status, 200);
  assert.equal(result.complete, false);
  assert.equal(result.text, first);
  await env.firstLog;
  assert.equal(env.requests.length, 1);
  assert.equal(env.logs.length, 1);
  assert.equal(env.logs[0].level, 'error');
  assert.equal(env.logs[0].abortSource, 'upstream');
  assert.equal(env.logs[0].error, 'proxy_upstream_stream_aborted');
  assert.equal(env.logs[0].status, 200);
  assert.equal(env.logs[0].aborted, true);
});

test('default logging hides successful requests and health checks but keeps compact failures', { timeout: TEST_TIMEOUT }, async (t) => {
  const env = await setup(t, { config: { logLevel: DEFAULT_CONFIG.logLevel, maxOutputMiB: 0.001 } });
  assert.equal((await send(env.url, { body: '{"input":"input_image candidate"}' })).status, 200);
  assert.equal((await send(env.url, { method: 'GET', path: '/healthz' })).status, 200);
  assert.equal(env.logs.length, 0);
  const result = await send(env.url, { body: JSON.stringify({ input: 'input_image ' + 'x'.repeat(4096) }) });
  assert.equal(result.status, 413);
  assert.equal(env.logs.length, 1);
  const [entry] = env.logs;
  assert.equal(entry.level, 'warn');
  assert.equal(entry.error, 'proxy_payload_budget_exceeded');
  assert.equal(entry.upstreamRequests, 0);
  assert.equal(entry.images, undefined);
  assert.equal(entry.imageFastPath, undefined);
  assert.ok(entry.outputBytes > 1024);
  assert.ok(entry.requestId);
});

test('preserves an upstream 413 response and makes exactly one attempt', { timeout: TEST_TIMEOUT }, async (t) => {
  const upstreamBody = '{"error":{"code":"upstream_too_large","message":"test 413"}}';
  const env = await setup(t, { handle: (_req, res) => {
    res.writeHead(413, { 'content-type': 'application/json', 'x-upstream-marker': 'rejected' });
    res.end(upstreamBody);
  } });
  const result = await send(env.url, { body: '{"model":"test","input":"request"}' });
  assert.equal(result.status, 413);
  assert.equal(result.body.toString(), upstreamBody);
  assert.equal(result.headers['x-upstream-marker'], 'rejected');
  await delay(100);
  assert.equal(env.requests.length, 1);
});

test('rejects the complete oversized outgoing JSON before contacting upstream', { timeout: TEST_TIMEOUT }, async (t) => {
  const limit = 0.001;
  const env = await setup(t, { config: { maxOutputMiB: limit } });
  const result = await send(env.url, { body: JSON.stringify({ model: 'test', input: 'x'.repeat(4096) }) });
  assert.equal(result.status, 413);
  const error = JSON.parse(result.body).error;
  assert.equal(error.code, 'proxy_payload_budget_exceeded');
  assert.equal(error.limitBytes, Math.floor(limit * MiB));
  assert.ok(error.bytes > error.limitBytes);
  assert.equal(env.requests.length, 0);
});

test('full image-worker admission returns 503 before upstream while no-image fast paths bypass the image queue', { timeout: TEST_TIMEOUT }, async (t) => {
  const env = await setup(t, { config: { maxImageQueueMiB: 1 / MiB } });
  const result = await send(env.url, { body: '{"input":"input_image candidate"}' });
  assert.equal(result.status, 503);
  assert.equal(JSON.parse(result.body).error.code, 'proxy_image_queue_full');
  assert.equal(env.requests.length, 0);
  assert.equal(env.logs.at(-1).upstreamRequests, 0);
  assert.equal((await send(env.url, { body: '{}' })).status, 200);
  assert.equal(env.requests.length, 1);
});

test('checks the budget after image compression rather than on the original JSON', { timeout: TEST_TIMEOUT }, async (t) => {
  const imageUrl = await fixtureImage();
  const original = { model: 'test', input: [{ type: 'message', role: 'user', content: [{ type: 'input_image', image_url: imageUrl }] }] };
  const raw = JSON.stringify(original);
  const jpeg = await sharp(Buffer.from(imageUrl.split(',')[1], 'base64')).resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
  const approxOutput = 300 + Buffer.byteLength(jpeg.toString('base64'));
  assert.ok(Buffer.byteLength(raw) > approxOutput, 'Fixture must be larger before conversion');
  const env = await setup(t, { config: { maxOutputMiB: (approxOutput + 512) / MiB } });
  const result = await send(env.url, { body: raw });
  assert.equal(result.status, 200);
  assert.equal(env.requests.length, 1);
  assert.ok(env.requests[0].body.length < raw.length);
});

test('caps both compressed input bytes and decompressed JSON bytes', { timeout: TEST_TIMEOUT }, async (t) => {
  const env = await setup(t, { config: { maxInputMiB: 0.001 } });
  const raw = Buffer.from(JSON.stringify({ model: 'test', input: 'x'.repeat(16_384) }));
  const direct = await send(env.url, { body: raw });
  assert.equal(direct.status, 413);
  const compressed = zstdCompressSync(raw);
  assert.ok(compressed.length < 1024);
  const inflated = await send(env.url, { headers: { 'content-encoding': 'zstd' }, body: compressed });
  assert.equal(inflated.status, 413);
  assert.equal(env.requests.length, 0);
});

test('rejects malformed JSON that may contain images and unsupported encodings locally', { timeout: TEST_TIMEOUT }, async (t) => {
  const env = await setup(t);
  const malformed = await send(env.url, { body: '{"input_image":invalid-json}' });
  assert.equal(malformed.status, 400);
  const encoding = await send(env.url, { headers: { 'content-encoding': 'x-unsupported-test' }, body: '{}' });
  assert.equal(encoding.status, 415);
  assert.equal(env.requests.length, 0);
});

test('delegates image-free malformed JSON validation to the upstream', { timeout: TEST_TIMEOUT }, async (t) => {
  const upstreamError = '{"error":{"code":"upstream_invalid_json"}}';
  const env = await setup(t, { handle: (_req, res, entry) => {
    assert.throws(() => JSON.parse(entry.body));
    res.writeHead(400, { 'content-type': 'application/json', 'x-error-origin': 'upstream' });
    res.end(upstreamError);
  } });
  const raw = '{"input":invalid-json}';
  const result = await send(env.url, { body: raw });
  assert.equal(result.status, 400);
  assert.equal(result.body.toString(), upstreamError);
  assert.equal(result.headers['x-error-origin'], 'upstream');
  assert.equal(env.requests.length, 1);
  assert.equal(env.requests[0].body.toString(), raw);
  assert.equal(env.logs.at(-1).imageFastPath, true);
});

test('returns 502 when an upstream connection fails', { timeout: TEST_TIMEOUT }, async (t) => {
  const env = await setup(t);
  await stop(env.upstream);
  const result = await send(env.url, { body: '{"model":"test","input":"request"}' });
  assert.equal(result.status, 502);
  assert.equal(typeof JSON.parse(result.body).error.code, 'string');
});

test('never logs prompt content, credentials, or image data on success or parse errors', { timeout: TEST_TIMEOUT }, async (t) => {
  const env = await setup(t);
  const imageUrl = await fixtureImage();
  const payload = imagePayload(imageUrl);
  payload.instructions = 'PROMPT_SECRET_SENTINEL_123';
  await send(env.url, {
    headers: { authorization: 'Bearer AUTH_SECRET_SENTINEL_456', cookie: 'session=COOKIE_SECRET_SENTINEL_789' },
    body: JSON.stringify(payload),
  });
  await send(env.url, { body: '{"input_image":"MALFORMED_SECRET_SENTINEL_ABC", broken' });
  assert.ok(env.logs.length > 0, 'Metadata events should be emitted');
  const logged = JSON.stringify(env.logs);
  for (const secret of ['PROMPT_SECRET_SENTINEL_123', 'AUTH_SECRET_SENTINEL_456', 'COOKIE_SECRET_SENTINEL_789', 'MALFORMED_SECRET_SENTINEL_ABC', imageUrl.slice(0, 100)]) {
    assert.ok(!logged.includes(secret), `A sensitive sentinel appeared in log output: ${secret.slice(0, 20)}`);
  }
  assert.ok(env.logs.every((entry) => entry && typeof entry === 'object' && !Buffer.isBuffer(entry)));
});

test('isolates concurrent requests while keeping one upstream attempt per request', { timeout: TEST_TIMEOUT }, async (t) => {
  const env = await setup(t, { handle: async (_req, res, entry) => {
    const payload = JSON.parse(entry.body);
    await delay((4 - payload.metadata.index) * 10);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ index: payload.metadata.index }));
  } });
  const imageUrl = await fixtureImage();
  const results = await Promise.all(Array.from({ length: 4 }, (_, index) => {
    const payload = imagePayload(imageUrl);
    payload.metadata.index = index;
    return send(env.url, { body: JSON.stringify(payload) });
  }));
  assert.deepEqual(results.map((result) => JSON.parse(result.body).index), [0, 1, 2, 3]);
  assert.ok(results.every((result) => result.status === 200));
  assert.equal(env.requests.length, 4);
  assert.deepEqual(env.requests.map((entry) => JSON.parse(entry.body).metadata.index).sort(), [0, 1, 2, 3]);
});

async function sessionIndexFixture(t, contents) {
  const directory = await mkdtemp(join(tmpdir(), 'copilot-proxy-session-titles-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'session_index.jsonl');
  if (contents !== undefined) await writeFile(path, contents);
  return path;
}

const titleScopePath = '/token-usage/events?period=today&page_size=1';

function setupSessionTitles(t, sessionIndexPath) {
  return setup(t, { config: { sessionIndexPath }, handle: (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(req.url === titleScopePath
      ? JSON.stringify({ period: 'today', range: { start_ms: 0, end_ms: 100 }, items: [] })
      : '{"ok":true}');
  } });
}

test('session titles use the latest timestamp and skip corrupt records after upstream authentication', { timeout: TEST_TIMEOUT }, async (t) => {
  const rows = [
    { id: 'thread-1', thread_name: '最新中文标题', updated_at: '2026-10-31T10:00:00Z' },
    { id: 'thread-1', thread_name: 'older last line', updated_at: '2026-10-30T10:00:00Z' },
    { id: 'thread-2', thread_name: 'preserve whitespace ', updated_at: '2026-10-31T10:00:00Z' },
    { id: 'cleared', thread_name: 'old title', updated_at: '2026-10-30T10:00:00Z' },
    { id: 'cleared', thread_name: ' \t ', updated_at: '2026-10-31T10:00:00Z' },
    { id: 'invalid-date', thread_name: 'ignored', updated_at: 'invalid' },
    { id: '__proto__', thread_name: 'ordinary ID', updated_at: '2026-10-31T10:00:00Z' },
    null,
  ];
  const sessionIndexPath = await sessionIndexFixture(t, rows.map((row) => JSON.stringify(row)).join('\n') + '\n{broken\n');
  const env = await setupSessionTitles(t, sessionIndexPath);
  const result = await send(env.url, { method: 'GET', path: '/__session-titles?refresh=1', headers: { authorization: 'Bearer fixture-title-key' } });
  assert.equal(result.status, 200);
  assert.match(result.headers['content-type'], /^application\/json/);
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.deepEqual(JSON.parse(result.body), {
    'thread-1': '最新中文标题', 'thread-2': 'preserve whitespace ', ['__proto__']: 'ordinary ID',
  });
  assert.deepEqual(env.requests.map((req) => req.url), [titleScopePath]);
  assert.equal(env.requests[0].headers.authorization, 'Bearer fixture-title-key');
});

test('session title cache refreshes on mtime or size changes', { timeout: TEST_TIMEOUT }, async (t) => {
  const contents = (title) => JSON.stringify({ id: 'thread', thread_name: title, updated_at: '2026-10-31T10:00:00Z' });
  const sessionIndexPath = await sessionIndexFixture(t, contents('before'));
  const firstTime = new Date('2026-10-31T10:00:00Z');
  const nextTime = new Date('2026-10-31T10:01:00Z');
  await utimes(sessionIndexPath, firstTime, firstTime);
  const env = await setupSessionTitles(t, sessionIndexPath);
  const read = async () => JSON.parse((await send(env.url, { method: 'GET', path: '/__session-titles' })).body);
  assert.deepEqual(await read(), { thread: 'before' });
  await writeFile(sessionIndexPath, contents('after!'));
  await utimes(sessionIndexPath, firstTime, firstTime);
  assert.deepEqual(await read(), { thread: 'before' }, 'same mtime and size must use the cached mapping');
  await utimes(sessionIndexPath, nextTime, nextTime);
  assert.deepEqual(await read(), { thread: 'after!' });
  await writeFile(sessionIndexPath, contents('longer title'));
  await utimes(sessionIndexPath, nextTime, nextTime);
  assert.deepEqual(await read(), { thread: 'longer title' });
  assert.deepEqual(env.requests.map((req) => req.url), Array(4).fill(titleScopePath));
});

test('missing or unreadable session indexes return empty mappings and recover without affecting other routes', { timeout: TEST_TIMEOUT }, async (t) => {
  const sessionIndexPath = await sessionIndexFixture(t);
  const env = await setupSessionTitles(t, sessionIndexPath);
  const read = async () => {
    const result = await send(env.url, { method: 'GET', path: '/__session-titles' });
    assert.equal(result.status, 200);
    return JSON.parse(result.body);
  };
  assert.deepEqual(await read(), {});
  await mkdir(sessionIndexPath);
  assert.deepEqual(await read(), {});
  await rmdir(sessionIndexPath);
  await writeFile(sessionIndexPath, JSON.stringify({ id: 'thread', thread_name: 'recovered', updated_at: '2026-10-31T10:00:00Z' }));
  assert.deepEqual(await read(), { thread: 'recovered' });
  await unlink(sessionIndexPath);
  assert.deepEqual(await read(), {});
  assert.deepEqual(env.requests.map((req) => req.url), Array(4).fill(titleScopePath));
  const ordinary = await send(env.url, { method: 'GET', path: '/token-usage/sessions?period=week' });
  assert.deepEqual(JSON.parse(ordinary.body), { ok: true });
  assert.equal(env.requests.length, 5);
});

const usageViewerHtml = await readFile(new URL('./fixtures/usage-viewer.v2.9.15.html', import.meta.url), 'utf8');
const viewerValidators = {
  etag: '"upstream-html"', 'content-md5': 'upstream-md5', digest: 'sha-256=upstream-digest',
  'content-digest': 'sha-256=:upstream-digest:', 'repr-digest': 'sha-256=:upstream-digest:',
  'last-modified': 'Sat, 31 Oct 2026 10:00:00 GMT',
};

test('usage viewer preserves non-UTF-8 bytes outside its ASCII edits', { timeout: TEST_TIMEOUT }, async (t) => {
  assert.ok(usageViewerHtml.includes('<title>Copilot API Dashboard</title>'));
  const bytes = Buffer.from(usageViewerHtml.replace('<title>Copilot API Dashboard</title>', '<title>caf\u00e9</title>'), 'latin1');
  const env = await setup(t, { config: { port: 18042 }, handle: (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=iso-8859-1', 'content-length': String(bytes.length) });
    res.end(bytes);
  } });
  const result = await send(env.url, { method: 'GET', path: '/usage-viewer' });
  assert.equal(result.status, 200);
  assert.equal(result.headers['content-type'], 'text/html; charset=iso-8859-1');
  assert.ok(result.body.includes(Buffer.from('caf\u00e9', 'latin1')));
  assert.ok(result.body.includes('http://127.0.0.1:18042/usage'));
  assert.ok(result.body.includes('/__session-titles'));
  assert.equal(Number(result.headers['content-length']), result.body.length);
  assert.deepEqual(result.body.subarray(0, result.body.indexOf('<script>')), bytes.subarray(0, bytes.indexOf('<script>')));
  assert.deepEqual(result.body.subarray(result.body.lastIndexOf('</body>')), bytes.subarray(bytes.lastIndexOf('</body>')));
});

test('usage viewer rewrites the configured origin and injects a static script with correct headers', { timeout: TEST_TIMEOUT }, async (t) => {
  const bytes = Buffer.from(usageViewerHtml);
  const sessionIndexPath = await sessionIndexFixture(t, JSON.stringify({ id: 'thread', thread_name: 'TITLE_MUST_NOT_BE_EMBEDDED', updated_at: '2026-10-31T10:00:00Z' }));
  for (const host of ['127.0.0.1', '::1']) {
    const env = await setup(t, { config: { sessionIndexPath, host, port: 18042 }, handle: (_req, res) => {
      res.writeHead(200, {
        'content-type': 'text/html; charset=UTF-8', 'content-encoding': 'identity',
        'content-length': String(bytes.length), ...viewerValidators, 'x-upstream-marker': 'kept',
      });
      res.write(bytes.subarray(0, 70)); res.end(bytes.subarray(70));
    } });
    const path = '/usage-viewer?endpoint=http%3A%2F%2Fexample.invalid%2Fusage';
    const result = await send(env.url, { method: 'GET', path, headers: { host: 'untrusted.invalid:9999', 'accept-encoding': 'gzip, deflate' } });
    const html = result.body.toString();
    const originHost = host === '::1' ? '[::1]' : host;
    assert.equal(result.status, 200);
    assert.ok(html.includes(`"http://${originHost}:18042/usage"`));
    assert.ok(!html.includes('const DEFAULT_ENDPOINT = "http://localhost:4141/usage";'));
    assert.ok(!html.includes('TITLE_MUST_NOT_BE_EMBEDDED'));
    assert.ok(html.includes('/__session-titles'));
    assert.equal(Number(result.headers['content-length']), result.body.length);
    assert.notEqual(result.body.length, html.length, 'UTF-8 length must count bytes');
    assert.equal(result.headers['content-type'], 'text/html; charset=UTF-8');
    assert.equal(result.headers['x-upstream-marker'], 'kept');
    for (const header of Object.keys(viewerValidators)) assert.equal(result.headers[header], undefined, header);
    assert.equal(env.requests[0].url, path);
    assert.equal(env.requests[0].headers['accept-encoding'], 'identity');
  }
});

test('usage viewer passes unsupported responses through with original status, headers, and bytes', { timeout: TEST_TIMEOUT }, async (t) => {
  const cases = [
    { name: 'non-html', type: 'text/plain', body: Buffer.from(usageViewerHtml) },
    { name: 'non-200', status: 503, body: Buffer.from(usageViewerHtml) },
    { name: 'compressed', encoding: 'gzip', body: gzipSync(usageViewerHtml) },
    { name: 'missing-content-type', type: null, body: Buffer.from(usageViewerHtml) },
  ];
  const env = await setup(t, { handle: (req, res) => {
    const fixture = cases.find((item) => req.url.endsWith(item.name));
    const headers = { 'content-length': String(fixture.body.length), ...viewerValidators, 'x-upstream-marker': fixture.name };
    if (fixture.type !== null) headers['content-type'] = fixture.type ?? 'text/html; charset=UTF-8';
    if (fixture.encoding) headers['content-encoding'] = fixture.encoding;
    res.writeHead(fixture.status ?? 200, headers); res.end(fixture.body);
  } });
  for (const fixture of cases) {
    const result = await send(env.url, { method: 'GET', path: `/usage-viewer?case=${fixture.name}`, headers: { 'accept-encoding': 'gzip' } });
    assert.equal(result.status, fixture.status ?? 200, fixture.name);
    assert.deepEqual(result.body, fixture.body, fixture.name);
    assert.equal(Number(result.headers['content-length']), fixture.body.length);
    assert.equal(result.headers['content-type'], fixture.type === null ? undefined : fixture.type ?? 'text/html; charset=UTF-8');
    assert.equal(result.headers['content-encoding'], fixture.encoding);
    assert.equal(result.headers['x-upstream-marker'], fixture.name);
    for (const [header, value] of Object.entries(viewerValidators)) assert.equal(result.headers[header], value, `${fixture.name}: ${header}`);
    assert.equal(env.requests.at(-1).headers['accept-encoding'], 'identity');
  }
});

test('relative-day viewer rejects incompatible successful responses instead of serving an unpatched page', { timeout: TEST_TIMEOUT }, async (t) => {
  for (const fixture of [
    { type: 'text/html', encoding: 'gzip', body: gzipSync(usageViewerHtml) },
    { type: 'text/plain', body: Buffer.from(usageViewerHtml) },
    { body: Buffer.from(usageViewerHtml) },
    { type: 'text/html', status: 201, body: Buffer.from(usageViewerHtml) },
  ]) {
    const env = await setup(t, { handle: (_req, res) => {
      const headers = { 'content-length': String(fixture.body.length) };
      if (fixture.type) headers['content-type'] = fixture.type;
      if (fixture.encoding) headers['content-encoding'] = fixture.encoding;
      res.writeHead(fixture.status ?? 200, headers);
      res.end(fixture.body);
    } });
    const result = await send(env.url, { method: 'GET', path: '/usage-viewer?period=-1day' });
    assert.equal(result.status, 502);
    assert.equal(JSON.parse(result.body).error.code, 'proxy_usage_viewer_incompatible');
    assert.equal(env.requests.length, 1);
  }
});

test('usage viewer returns 502 for missing dashboard integration points', { timeout: TEST_TIMEOUT }, async (t) => {
  const cases = [
    usageViewerHtml.replace('const DEFAULT_ENDPOINT', 'const CHANGED_ENDPOINT'),
    usageViewerHtml.replace('function normalizePeriod(', 'function changedNormalizePeriod('),
    usageViewerHtml.replace('function renderTokenUsageDailyTrend(', 'function changedDailyTrend('),
    usageViewerHtml.replace('${renderTokenUsageDailyTrend(', '${changedDailyTrend('),
    usageViewerHtml.replace('function getCostAmount(', 'function changedCostAmount('),
  ];
  for (const body of cases) {
    const env = await setup(t, { handle: (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(body);
    } });
    const result = await send(env.url, { method: 'GET', path: '/usage-viewer?period=-1day' });
    assert.equal(result.status, 502);
    const error = JSON.parse(result.body).error;
    assert.equal(error.code, 'proxy_usage_viewer_incompatible');
    assert.match(error.message, /marker|upstream/i);
  }
});

test('usage viewer returns 502 when an eligible HTML response ends prematurely', { timeout: TEST_TIMEOUT }, async (t) => {
  const bytes = Buffer.from(usageViewerHtml);
  const env = await setup(t, { handle: async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html', 'content-length': String(bytes.length) });
    res.write(bytes.subarray(0, 60));
    await delay(30);
    res.destroy();
  } });
  const result = await send(env.url, { method: 'GET', path: '/usage-viewer' });
  assert.equal(result.status, 502);
  assert.equal(JSON.parse(result.body).error.code, 'proxy_upstream_stream_error');
  assert.equal((await send(env.url, { method: 'GET', path: '/healthz' })).status, 200);
});

test('viewer and title additions do not intercept other methods or routes', { timeout: TEST_TIMEOUT }, async (t) => {
  const bytes = Buffer.from(usageViewerHtml);
  const env = await setup(t, { handle: (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html', 'content-length': String(bytes.length), ...viewerValidators });
    res.end(bytes);
  } });
  const cases = [
    ['GET', '/usage-viewer/'], ['GET', '/v1/usage-viewer'], ['GET', '/token-usage/sessions?period=week'],
    ['GET', '/__session-titles-extra'], ['POST', '/usage-viewer'], ['POST', '/__session-titles'],
    ['HEAD', '/usage-viewer'], ['HEAD', '/__session-titles'],
  ];
  for (const [method, path] of cases) {
    const body = method === 'POST' ? 'opaque non-JSON bytes' : '';
    const result = await send(env.url, { method, path, body, headers: { 'accept-encoding': 'gzip' } });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, method === 'HEAD' ? Buffer.alloc(0) : bytes, `${method} ${path}`);
    assert.equal(Number(result.headers['content-length']), bytes.length);
    for (const [header, value] of Object.entries(viewerValidators)) assert.equal(result.headers[header], value);
    assert.equal(env.requests.at(-1).method, method);
    assert.equal(env.requests.at(-1).url, path);
    assert.equal(env.requests.at(-1).body.toString(), body);
    assert.equal(env.requests.at(-1).headers['accept-encoding'], 'gzip');
  }
});
