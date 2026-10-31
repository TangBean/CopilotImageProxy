import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { zstdCompressSync, gzipSync } from 'node:zlib';
import sharp from 'sharp';
import { createProxyServer } from '../src/server.mjs';
import { UPSTREAM_NAMESPACE } from '../src/collaboration-plaintext.mjs';

const targetModels = ['gpt-6-astra', 'gpt-6.1-sol'];
const instruction = '阅读 λ 和中文，保持 "引号"。\nFollow up on the same child.';
const args = JSON.stringify({ message: instruction, task_name: 'child', model: 'gpt-6.1-sol', reasoning_effort: 'xhigh' });
const declaration = { type: 'namespace', name: 'collaboration', tools: [{ type: 'function', name: 'spawn_agent', parameters: { type: 'object', properties: { message: { type: 'string', encrypted: true } } } }] };
const payload = (extra = {}) => ({ model: 'gpt-6-astra', reasoning: { effort: 'ultra' }, tools: [declaration], input: [{ role: 'user', content: 'Review the material independently.' }], ...extra });
const call = (namespace = UPSTREAM_NAMESPACE, extra = {}) => ({ type: 'function_call', namespace, name: 'spawn_agent', call_id: 'call_1', id: 'fc_1', arguments: args, ...extra });
const event = (value) => `data: ${JSON.stringify(value)}\n\n`;
const created = event({ type: 'response.created', response: { output: [] } });
const failed = event({ type: 'response.failed', response: { error: null, output: [] } });
const bad = event({ type: 'error', error: { code: 'invalid_request_body', message: 'upstream diagnostic', param: 'input' } });

async function listen(server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return `http://127.0.0.1:${server.address().port}`; }
async function read(stream) { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return Buffer.concat(chunks); }
async function stop(server) { if (!server.listening) return; const done = once(server, 'close'); server.close(); server.closeAllConnections(); await done; }
async function setup(t, config = {}, handle = (_req, res, entry) => {
  const body = JSON.parse(entry.body);
  const response = JSON.stringify({ output: [call(body.tools?.[0]?.name)], usage: { input_tokens: 11 }, keep: 'metadata' });
  res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(response), 'x-reasoning-included': 'true', etag: 'old' }); res.end(response);
}) {
  const requests = []; const logs = [];
  const upstream = http.createServer(async (req, res) => {
    try { const entry = { headers: req.headers, body: await read(req), url: req.url }; requests.push(entry); await handle(req, res, entry); }
    catch (error) { if (!res.destroyed) res.destroy(error); }
  });
  const upstreamUrl = await listen(upstream); t.after(() => stop(upstream));
  const proxy = createProxyServer({ config: { upstream: upstreamUrl, ...config }, log: (entry) => logs.push(entry) });
  const url = await listen(proxy); t.after(() => stop(proxy));
  return { url, requests, logs, proxy, upstream };
}
function send(url, body, { path = '/responses', headers = {}, onHeaders } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(path, url), { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, signal: AbortSignal.timeout(10000) }, async (res) => {
      onHeaders?.(res);
      try { resolve({ status: res.statusCode, headers: res.headers, body: await read(res) }); }
      catch (error) { reject(error); }
    });
    req.once('error', reject); req.end(body);
  });
}

for (const plain of [false, true]) for (const early of [false, true]) test(`independent flags: plaintext=${plain}, early=${early}`, async (t) => {
  const env = await setup(t, { plaintextCollaborationModels: plain ? targetModels : [], earlyResponseErrorModels: early ? targetModels : [] });
  const original = JSON.stringify(payload());
  const result = await send(env.url, original);
  assert.equal(result.status, 200);
  const received = JSON.parse(env.requests[0].body);
  const response = JSON.parse(result.body);
  assert.equal(received.tools[0].name, plain ? UPSTREAM_NAMESPACE : 'collaboration');
  assert.equal(received.reasoning.effort, 'ultra');
  assert.equal(response.output[0].namespace, 'collaboration');
  assert.equal(response.output[0].arguments, args);
  assert.deepEqual(response.output[0].encrypted_function_args, plain ? [] : undefined);
  assert.equal(result.headers['x-reasoning-included'], 'true');
  assert.equal(result.headers.etag, plain ? undefined : 'old');
  assert.equal(Number(result.headers['content-length']), result.body.length);
  assert.equal(env.requests.length, 1);
  assert.equal(env.requests[0].headers['accept-encoding'], plain || early ? 'identity' : undefined);
  if (!plain) assert.equal(env.requests[0].body.toString(), original);
  assert.ok(!JSON.stringify(env.logs).includes(instruction));
});

test('opt-ins do not touch compact, other paths, non-target models or unrelated schemas', async (t) => {
  const rawResponse = Buffer.from(' original arbitrary upstream bytes ');
  const env = await setup(t, { plaintextCollaborationModels: targetModels, earlyResponseErrorModels: targetModels }, (_req, res) => res.end(rawResponse));
  const cases = [
    { path: '/responses/compact', body: JSON.stringify(payload()) },
    { path: '/v1/responses/compact?mode=test', body: JSON.stringify(payload()) },
    { path: '/other', body: 'not JSON' },
    { path: '/responses', body: JSON.stringify(payload({ model: 'gpt-6-luna' })) },
  ];
  for (const item of cases) {
    const result = await send(env.url, item.body, item);
    assert.deepEqual(result.body, rawResponse);
    assert.equal(env.requests.at(-1).body.toString(), item.body);
    assert.equal(env.requests.at(-1).headers['accept-encoding'], undefined);
  }
  const ordinary = JSON.stringify(payload({ tools: [{ ...declaration, tools: [] }], model: 'gpt-6-astra' }));
  assert.deepEqual((await send(env.url, ordinary)).body, rawResponse);
});

test('request contract failures make zero upstream requests and do not leak arguments', async (t) => {
  const env = await setup(t, { plaintextCollaborationModels: targetModels });
  for (const extra of [{ store: true }, { previous_response_id: 'opaque' }, { conversation: { id: 'c' } }, { tools: [declaration, { type: 'namespace', name: UPSTREAM_NAMESPACE }] }]) {
    const result = await send(env.url, JSON.stringify(payload(extra)));
    assert.equal(result.status, 400);
    assert.match(JSON.parse(result.body).error.code, /^proxy_collaboration_/);
  }
  assert.equal(env.requests.length, 0);
});

test('non-success responses remain byte-for-byte unchanged despite active adaptation', async (t) => {
  const bytes = gzipSync(Buffer.from('{"error":{"code":"upstream_limit","message":"keep original"}}'));
  const env = await setup(t, { plaintextCollaborationModels: targetModels, earlyResponseErrorModels: targetModels }, (_req, res) => {
    res.writeHead(429, { 'content-type': 'application/json', 'content-encoding': 'gzip', 'retry-after': '8', 'content-length': bytes.length }); res.end(bytes);
  });
  const result = await send(env.url, JSON.stringify(payload()));
  assert.equal(result.status, 429);
  assert.equal(result.headers['retry-after'], '8');
  assert.equal(result.headers['content-encoding'], 'gzip');
  assert.deepEqual(result.body, bytes);
  assert.equal(env.requests.length, 1);
});

test('early invalid-request events become 400 only when independently enabled', async (t) => {
  for (const enabled of [false, true]) {
    const env = await setup(t, { earlyResponseErrorModels: enabled ? targetModels : [] }, async (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(created + failed); await delay(10); res.end(bad);
    });
    const result = await send(env.url, JSON.stringify(payload({ tools: [] })), { path: '/v1/responses?case=early' });
    assert.equal(result.status, enabled ? 400 : 200);
    if (enabled) assert.deepEqual(JSON.parse(result.body).error, { code: 'invalid_request_body', message: 'upstream diagnostic', param: 'input', type: 'invalid_request_error' });
    else assert.equal(result.body.toString(), created + failed + bad);
    assert.equal(env.requests.length, 1);
  }
});

test('model output ends preflight and preserves subsequent failure semantics', async (t) => {
  const first = event({ type: 'response.output_text.delta', delta: 'started' });
  const raw = created + first + failed + bad;
  const env = await setup(t, { earlyResponseErrorModels: targetModels }, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(raw);
  });
  const result = await send(env.url, JSON.stringify(payload({ tools: [] })));
  assert.equal(result.status, 200);
  assert.equal(result.body.toString(), raw);
});

test('combined mode commits headers after preflight deadline without waiting for an event', { timeout: 7000 }, async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  t.after(() => release());
  const env = await setup(t, { plaintextCollaborationModels: targetModels, earlyResponseErrorModels: targetModels }, async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders();
    await gate;
    res.end(event({ type: 'response.completed', response: { output: [call()] } }));
  });
  const result = await send(env.url, JSON.stringify(payload()), { onHeaders: () => release() });
  assert.equal(result.status, 200);
  assert.match(result.body.toString(), /"encrypted_function_args":\[\]/);
});

test('SSE fragments and sparse snapshots restore original identities and task text', async (t) => {
  const raw = ': comment\r\n\r\n' + created
    + event({ type: 'response.output_item.added', output_index: 0, item: call(UPSTREAM_NAMESPACE, { arguments: '' }) })
    + event({ type: 'response.function_call_arguments.delta', output_index: 0, delta: args.slice(0, 12) })
    + event({ type: 'response.function_call_arguments.delta', output_index: 0, delta: args.slice(12) })
    + event({ type: 'response.function_call_arguments.done', output_index: 0, arguments: args })
    + event({ type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', name: null, namespace: '', arguments: args } })
    + event({ type: 'response.completed', response: { output: [call()], usage: { output_tokens: 12 } } })
    + 'data: [DONE]\n\n';
  const env = await setup(t, { plaintextCollaborationModels: targetModels, earlyResponseErrorModels: targetModels }, async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'x-reasoning-included': 'true' });
    const bytes = Buffer.from(raw);
    for (let i = 0; i < bytes.length; i += 7) { if (!res.write(bytes.subarray(i, i + 7))) await once(res, 'drain'); }
    res.end();
  });
  const result = await send(env.url, JSON.stringify(payload()));
  const events = result.body.toString().split(/\r?\n/).filter((line) => line.startsWith('data: {')).map((line) => JSON.parse(line.slice(6)));
  const done = events.find((item) => item.type === 'response.output_item.done').item;
  assert.equal(done.namespace, 'collaboration'); assert.equal(done.call_id, 'call_1');
  assert.equal(done.arguments, args); assert.deepEqual(done.encrypted_function_args, []);
  assert.equal(events.filter((x) => x.type === 'response.function_call_arguments.delta').map((x) => x.delta).join(''), args);
  assert.equal(result.headers['x-reasoning-included'], 'true');
  assert.equal(events.at(-1).response.usage.output_tokens, 12);
  assert.equal(env.requests.length, 1);
});

test('invalid JSON, encoding and encrypted markers fail explicitly before JSON headers', async (t) => {
  for (const mode of ['json', 'encoding', 'marker', 'oversize']) {
    const env = await setup(t, { plaintextCollaborationModels: targetModels }, (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', ...(mode === 'encoding' ? { 'content-encoding': 'gzip' } : {}) });
      if (mode === 'oversize') { res.end(Buffer.alloc(32 * 1024 * 1024 + 1, 32)); return; }
      res.end(mode === 'json' ? '{bad}' : JSON.stringify({ output: [call(UPSTREAM_NAMESPACE, { encrypted_function_args: ['message'] })] }));
    });
    const result = await send(env.url, JSON.stringify(payload()));
    assert.equal(result.status, 502, mode);
    assert.match(JSON.parse(result.body).error.code, /^proxy_/);
    assert.equal(env.requests.length, 1);
  }
});

test('a conflicting first SSE frame returns 502 before headers', async (t) => {
  for (const early of [false, true]) {
    const env = await setup(t, { plaintextCollaborationModels: targetModels, earlyResponseErrorModels: early ? targetModels : [] }, (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(event({ type: 'response.output_item.done', output_index: 0, item: call(UPSTREAM_NAMESPACE, { encrypted_function_args: ['message'] }) }));
    });
    const result = await send(env.url, JSON.stringify(payload()));
    assert.equal(result.status, 502);
    assert.equal(JSON.parse(result.body).error.code, 'proxy_collaboration_encrypted_arguments');
    assert.equal(env.requests.length, 1);
  }
});

test('SSE conflicts after headers abort without appending JSON or leaking private text', async (t) => {
  const env = await setup(t, { plaintextCollaborationModels: targetModels }, async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(event({ type: 'response.output_item.added', output_index: 0, item: call() }));
    await delay(10);
    res.end(event({ type: 'response.output_item.done', output_index: 0, item: call(UPSTREAM_NAMESPACE, { call_id: 'conflict' }) }));
  });
  await assert.rejects(send(env.url, JSON.stringify(payload())));
  await delay(5);
  assert.equal(env.logs.at(-1).error, 'proxy_collaboration_identity_conflict');
  assert.ok(!JSON.stringify(env.logs).includes(instruction));
});

test('client cancellation records already restored calls', async (t) => {
  const env = await setup(t, { plaintextCollaborationModels: targetModels }, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(event({ type: 'response.output_item.done', output_index: 0, item: call() }));
  });
  await new Promise((resolve, reject) => {
    const req = http.request(new URL('/responses', env.url), { method: 'POST' }, (res) => {
      res.once('data', () => { res.destroy(); resolve(); });
    });
    req.once('error', reject); req.end(JSON.stringify(payload()));
  });
  for (let i = 0; !env.logs.length && i < 100; i++) await delay(10);
  assert.equal(env.logs[0].plaintextCollaboration.restoredCalls, 1);
  assert.equal(env.logs[0].abortSource, 'client');
  assert.equal(env.requests.length, 1);
});

test('client cancellation during preflight closes upstream promptly', async (t) => {
  let closed;
  const upstreamClosed = new Promise((resolve) => { closed = resolve; });
  let ready;
  const upstreamReady = new Promise((resolve) => { ready = resolve; });
  const env = await setup(t, { plaintextCollaborationModels: targetModels, earlyResponseErrorModels: targetModels }, (_req, res) => {
    res.once('close', closed); res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(created); ready();
  });
  const req = http.request(env.url + '/responses', { method: 'POST' }); req.on('error', () => {}); req.end(JSON.stringify(payload()));
  await upstreamReady; req.destroy();
  await Promise.race([upstreamClosed, delay(1000).then(() => { throw new Error('Upstream was not cancelled'); })]);
  await delay(5);
  assert.equal(env.logs.at(-1).abortSource, 'client');
  assert.equal(env.requests.length, 1);
});

test('image processing and zstd decoding compose with collaboration before the final size check', async (t) => {
  const png = await sharp({ create: { width: 2048, height: 1024, channels: 3, background: '#526f97' } }).png().toBuffer();
  const original = payload({ input: [{ role: 'user', content: [{ type: 'input_text', text: 'inspect' }, { type: 'input_image', image_url: `data:image/png;base64,${png.toString('base64')}` }] }] });
  const env = await setup(t, { plaintextCollaborationModels: targetModels });
  const result = await send(env.url, zstdCompressSync(Buffer.from(JSON.stringify(original))), { headers: { 'content-encoding': 'zstd' } });
  assert.equal(result.status, 200);
  const forwarded = JSON.parse(env.requests[0].body);
  assert.equal(forwarded.tools[0].name, UPSTREAM_NAMESPACE);
  assert.match(forwarded.input[0].content[1].image_url, /^data:image\/jpeg;/);
  assert.equal(Number(env.requests[0].headers['content-length']), env.requests[0].body.length);
  assert.equal(env.requests[0].headers['content-encoding'], undefined);
  const limited = await setup(t, { plaintextCollaborationModels: targetModels, maxOutputMiB: 0.0001 });
  assert.equal((await send(limited.url, JSON.stringify(payload()))).status, 413);
  assert.equal(limited.requests.length, 0);
});

test('adapted loopback streams respect a paused client and preserve all bytes', async (t) => {
  const frame = event({type:'response.output_text.delta',output_index:0,delta:'a'.repeat(64*1024)});
  const count = 192;
  let backpressure = 0;
  const env = await setup(t, { plaintextCollaborationModels: targetModels }, async (_req,res) => {
    res.writeHead(200, {'content-type':'text/event-stream'});
    for(let i=0;i<count;i++) if(!res.write(frame)) await once(res,'drain');
    res.end('data: [DONE]\n\n');
  });
  env.proxy.on('request', (_req,res) => {
    const write=res.write.bind(res);
    res.write=(...args)=>{const accepted=write(...args);if(!accepted)backpressure++;return accepted;};
  });
  const result=await send(env.url,JSON.stringify(payload()),{onHeaders:(res)=>{res.pause();setTimeout(()=>res.resume(),150);}});
  assert.equal(result.body.length,Buffer.byteLength(frame)*count+Buffer.byteLength('data: [DONE]\n\n'));
  assert.equal(result.body.toString(),frame.repeat(count)+'data: [DONE]\n\n');
  assert.ok(backpressure>0);
  assert.equal(env.requests.length,1);
});

test('an oversized SSE event fails only on the adapted loopback path', async (t) => {
  const raw=Buffer.alloc(8*1024*1024+1,32);
  for(const enabled of [false,true]){
    const env=await setup(t,{plaintextCollaborationModels:enabled?targetModels:[]},(_req,res)=>{
      res.writeHead(200,{'content-type':'text/event-stream'});res.end(raw);
    });
    const result=await send(env.url,JSON.stringify(payload()));
    assert.equal(result.status,enabled?502:200);
    if(enabled)assert.equal(JSON.parse(result.body).error.code,'proxy_sse_event_limit');
    else assert.deepEqual(result.body,raw);
    assert.equal(env.requests.length,1);
  }
});

test('upstream disconnect after adapted output aborts the downstream stream', async(t)=>{
  const env=await setup(t,{plaintextCollaborationModels:targetModels},async(_req,res)=>{
    res.writeHead(200,{'content-type':'text/event-stream'});res.write(created);
    await delay(25);res.destroy();
  });
  await assert.rejects(send(env.url,JSON.stringify(payload())));
  for(let i=0;!env.logs.length&&i<100;i++)await delay(10);
  assert.equal(env.logs[0].abortSource,'upstream');
  assert.equal(env.logs[0].error,'proxy_upstream_stream_error');
  assert.equal(env.requests.length,1);
});

test('empty failure without a diagnostic releases headers after the grace period', async(t)=>{
  let release;const gate=new Promise(resolve=>{release=resolve;});t.after(()=>release());
  const env=await setup(t,{earlyResponseErrorModels:targetModels},async(_req,res)=>{
    res.writeHead(200,{'content-type':'text/event-stream'});res.write(failed);
    await gate;res.end();
  });
  const result=await send(env.url,JSON.stringify(payload()),{onHeaders:()=>release()});
  assert.equal(result.status,200);assert.equal(result.body.toString(),failed);
  assert.equal(env.requests.length,1);
});
