import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable, Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { SseDecoder, adaptSse, preflightSse, readJsonResponse, writeStream, EARLY_ERROR_LIMITS, MAX_SSE_EVENT_BYTES, MAX_JSON_RESPONSE_BYTES } from '../src/responses-stream.mjs';

const sse = (value) => Buffer.from(`data: ${JSON.stringify(value)}\n\n`);
const created = sse({ type: 'response.created', response: { output: [] } });
const failed = sse({ type: 'response.failed', response: { error: null, output: [] } });
const diagnostic = sse({ type: 'error', error: { code: 'invalid_request_body', message: 'known failure', param: 'input' } });
const collect = async (source) => { const chunks = []; for await (const chunk of source) chunks.push(chunk); return Buffer.concat(chunks); };
const options = { limits: { ...EARLY_ERROR_LIMITS, timeoutMs: 120, detailTimeoutMs: 35 } };

test('SSE framing preserves every byte across CRLF, UTF-8 and one-byte chunks', () => {
  const raw = Buffer.from(': 心跳\r\nevent: response.output_item.done\r\nid: 9\r\ndata: {"type":"example",\r\ndata: "text":"中文 λ"}\r\n\r\ndata: [DONE]\n\n');
  const decoder = new SseDecoder();
  const frames = [];
  for (const byte of raw) frames.push(...decoder.feed(Buffer.from([byte])));
  frames.push(...decoder.finish());
  assert.equal(frames.length, 2);
  assert.deepEqual(Buffer.concat(frames), raw);
});

test('shared decoder rewrites JSON data while preserving metadata and unrelated frames', async () => {
  const first = Buffer.from(': keep\r\nevent: example\r\nid: same\r\nretry: 50\r\ndata: {"type":"target",\r\ndata: "text":"λ 中文"}\r\n\r\n');
  const untouched = Buffer.from(': comment\n\ndata: [DONE]\n\n');
  const adapter = { restoreEvent: (event) => event.type === 'target' ? { ...event, extra: true } : event };
  const raw = Buffer.concat([first, untouched]);
  const bytes = await collect(adaptSse(Readable.from([...raw].map((b) => Buffer.from([b]))), adapter));
  assert.ok(bytes.toString().includes(': keep\r\nevent: example\r\nid: same\r\nretry: 50\r\n'));
  assert.ok(bytes.toString().includes('"text":"λ 中文","extra":true'));
  assert.ok(bytes.subarray(-untouched.length).equals(untouched));
});

test('normal EOF processes a complete final JSON frame but never repairs malformed JSON', async () => {
  const adapter = { restoreEvent: (value) => ({ ...value, changed: true }) };
  assert.match((await collect(adaptSse(Readable.from([Buffer.from('data: {"type":"last"}')]), adapter))).toString(), /"changed":true/);
  await assert.rejects(collect(adaptSse(Readable.from([Buffer.from('data: {"type":')]), adapter)), { code: 'proxy_sse_invalid_json' });
  await assert.rejects(collect(adaptSse(Readable.from([Buffer.from([100, 97, 116, 97, 58, 32, 255, 10, 10])]), adapter)), { code: 'proxy_sse_invalid_utf8' });
});

test('only rewritten SSE and JSON responses have the declared size limits', async () => {
  const decoder = new SseDecoder();
  assert.throws(() => decoder.feed(Buffer.alloc(MAX_SSE_EVENT_BYTES + 1, 65)), { code: 'proxy_sse_event_limit' });
  await assert.rejects(readJsonResponse(Readable.from([Buffer.alloc(MAX_JSON_RESPONSE_BYTES + 1, 32)])), { code: 'proxy_json_response_limit' });
  await assert.rejects(readJsonResponse(Readable.from([Buffer.from('{bad}')])), { code: 'proxy_response_invalid_json' });
  assert.deepEqual(await readJsonResponse(Readable.from([Buffer.from('{"ok":'), Buffer.from('true}') ])), { ok: true });
});

test('empty failed followed by an explicit diagnostic is classified before headers', async () => {
  const result = await preflightSse(Readable.from([created, failed, diagnostic]), options);
  assert.deepEqual(result.error, { code: 'invalid_request_body', message: 'known failure', param: 'input', type: 'invalid_request_error' });
  assert.equal(result.stats.inspectedEvents, 3);
  await result.close();
});

for (const error of [{ code: 'rate_limit_exceeded', message: 'slow' }, { code: 'policy_violation', message: 'denied' }, { code: 'invalid_request_body', message: '' }]) {
  test(`does not reclassify ${error.code} with message ${JSON.stringify(error.message)}`, async () => {
    const raw = Buffer.concat([created, sse({ type: 'error', error })]);
    const result = await preflightSse(Readable.from([raw]), options);
    assert.equal(result.error, undefined);
    assert.deepEqual(await collect(result.stream), raw);
  });
}

test('first model output protects every later event even within the same chunk', async () => {
  for (const event of [
    { type: 'response.output_item.added', item: { type: 'reasoning' } },
    { type: 'response.function_call_arguments.delta', delta: 'part' },
    { type: 'response.failed', response: { error: { code: 'invalid_request_body', message: 'late' }, output: [{ type: 'message' }] } },
  ]) {
    const raw = Buffer.concat([created, sse(event), diagnostic]);
    const result = await preflightSse(Readable.from([raw]), options);
    assert.equal(result.error, undefined);
    assert.deepEqual(await collect(result.stream), raw);
  }
});

test('timeout preserves exactly one pending upstream read and every byte', async () => {
  let reads = 0;
  let unblock;
  const gate = new Promise((resolve) => { unblock = resolve; });
  const source = { [Symbol.asyncIterator]() { return this; }, async next() {
    reads++;
    if (reads === 1) return { value: created, done: false };
    if (reads === 2) { await gate; return { value: diagnostic, done: false }; }
    return { done: true };
  } };
  const result = await preflightSse(source, { limits: { ...EARLY_ERROR_LIMITS, timeoutMs: 20 } });
  assert.equal(result.error, undefined);
  assert.equal(reads, 2);
  unblock();
  assert.deepEqual(await collect(result.stream), Buffer.concat([created, diagnostic]));
  assert.equal(reads, 3);
});

test('empty failure detail deadline leaves a late diagnostic in the original stream', async () => {
  async function* source() { yield failed; await delay(55); yield diagnostic; }
  const result = await preflightSse(source(), options);
  assert.equal(result.error, undefined);
  assert.deepEqual(await collect(result.stream), Buffer.concat([failed, diagnostic]));
});

test('event and byte budgets stop classification while preserving the rest', async () => {
  const eventRaw = Buffer.concat([created, created, diagnostic]);
  const events = await preflightSse(Readable.from([eventRaw]), { limits: { ...EARLY_ERROR_LIMITS, maxEvents: 2 } });
  assert.equal(events.error, undefined);
  assert.deepEqual(await collect(events.stream), eventRaw);
  const raw = Buffer.concat([Buffer.from(': ' + 'x'.repeat(200) + '\n\n'), diagnostic]);
  const bytes = await preflightSse(Readable.from([raw]), { limits: { ...EARLY_ERROR_LIMITS, maxBytes: 80 } });
  assert.equal(bytes.error, undefined);
  assert.deepEqual(await collect(bytes.stream), raw);
});

test('preflight cancellation rejects promptly and closes the iterator', async () => {
  const controller = new AbortController();
  let closeCount = 0;
  const source = { [Symbol.asyncIterator]() { return this; }, next: () => new Promise(() => {}), return: async () => { closeCount++; return { done: true }; } };
  const promise = preflightSse(source, { signal: controller.signal });
  controller.abort(new Error('cancelled'));
  await assert.rejects(promise, /cancelled/);
  assert.equal(closeCount, 1);
});

test('writeStream respects slow-consumer backpressure', async () => {
  let sent = 0;
  let received = 0;
  let greatestLead = 0;
  const sink = new Writable({ highWaterMark: 1, write(_chunk, _encoding, callback) {
    greatestLead = Math.max(greatestLead, sent - received);
    setTimeout(() => { received++; callback(); }, 2);
  } });
  async function* source() { for (let i = 0; i < 12; i++) { sent++; yield Buffer.alloc(100); } }
  await writeStream(sink, source());
  assert.equal(received, 12);
  assert.equal(greatestLead, 1);
});
