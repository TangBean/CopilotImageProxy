import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import sharp from 'sharp';
import { createBodyTransformer } from '../src/body-transformer.mjs';

const MiB = 1048576;

async function waitUntil(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for worker cleanup');
    await delay(10);
  }
}

test('worker is lazy and preserves original no-change bytes', async (t) => {
  const transformer = createBodyTransformer();
  t.after(() => transformer.close());
  assert.equal(transformer.getState().workerThreadId, null);
  const raw = Buffer.from('  { "input" : "\\u4e2d keep whitespace", "number": 1e2 } \n');
  const expected = Buffer.from(raw);
  const result = await transformer.transform(raw);
  assert.deepEqual(result.body, expected);
  assert.equal(result.stats.transformed, 0);
  assert.equal(typeof transformer.getState().workerThreadId, 'number');
  assert.equal(transformer.getState().queuedInputBytes, 0);
});

test('dedicated whole buffers transfer without a copy and come back unchanged', async (t) => {
  const transformer = createBodyTransformer();
  t.after(() => transformer.close());
  const text = JSON.stringify({ input: '\\u candidate ' + 'x'.repeat(32_000) });
  const raw = Buffer.allocUnsafeSlow(Buffer.byteLength(text));
  raw.write(text);
  const resultPromise = transformer.transform(raw);
  assert.equal(raw.byteLength, 0, 'transfer relinquishes the caller-owned input buffer');
  const result = await resultPromise;
  assert.equal(result.body.toString(), text);
  assert.equal(result.stats.workerInputCopiedBytes, 0);
  assert.equal(result.stats.workerOutputCopiedBytes, 0);
});

test('sliced buffers receive one bounded copy without detaching neighboring bytes', async (t) => {
  const transformer = createBodyTransformer();
  t.after(() => transformer.close());
  const text = '{"input":"input_image as text"}';
  const owner = Buffer.from('PREFIX' + text + 'SUFFIX');
  const input = owner.subarray(6, 6 + Buffer.byteLength(text));
  const result = await transformer.transform(input);
  assert.equal(owner.toString(), 'PREFIX' + text + 'SUFFIX');
  assert.equal(result.body.toString(), text);
  assert.equal(result.stats.workerInputCopiedBytes, Buffer.byteLength(text));
  assert.equal(result.stats.workerOutputCopiedBytes, 0);
});

test('queue admission counts concurrent active and queued input bytes', async (t) => {
  const raw = JSON.stringify({ input: 'input_image ' + 'x'.repeat(30_000) });
  const bytes = Buffer.byteLength(raw);
  const transformer = createBodyTransformer({ config: { maxImageQueueMiB: (bytes + 1) / MiB } });
  t.after(() => transformer.close());
  const first = transformer.transform(Buffer.from(raw));
  assert.equal(transformer.getState().queuedInputBytes, bytes);
  await assert.rejects(transformer.transform(Buffer.from(raw)), (error) => {
    assert.equal(error.status, 503);
    assert.equal(error.code, 'proxy_image_queue_full');
    assert.equal(error.details.queuedInputBytes, bytes);
    return true;
  });
  await first;
  assert.equal(transformer.getState().queuedInputBytes, 0);
  await transformer.transform(Buffer.from(raw));
});

test('cancellation rejects the caller immediately but retains admission until worker acknowledgement', async (t) => {
  const raw = JSON.stringify({ input: 'input_image ' + 'x'.repeat(30_000) });
  const bytes = Buffer.byteLength(raw);
  const transformer = createBodyTransformer({ config: { maxImageQueueMiB: (bytes + 1) / MiB } });
  t.after(() => transformer.close());
  const controller = new AbortController();
  const work = transformer.transform(Buffer.from(raw), { signal: controller.signal });
  controller.abort();
  await assert.rejects(work, { name: 'AbortError' });
  assert.equal(transformer.getState().queuedInputBytes, bytes);
  await assert.rejects(transformer.transform(Buffer.from(raw)), { code: 'proxy_image_queue_full' });
  await waitUntil(() => transformer.getState().pendingRequests === 0);
  assert.equal(transformer.getState().queuedInputBytes, 0);
  await transformer.transform(Buffer.from(raw));
});

test('closing rejects pending callers and terminates the worker', async () => {
  const transformer = createBodyTransformer();
  const work = transformer.transform(Buffer.from('{"input":"input_image"}'));
  const close = transformer.close();
  await assert.rejects(work, { code: 'proxy_image_worker_closed' });
  await close;
  assert.deepEqual(transformer.getState(), { queuedInputBytes: 0, pendingRequests: 0, workerThreadId: null, closed: true });
  await assert.rejects(transformer.transform(Buffer.from('{}')), { code: 'proxy_image_worker_closed' });
});

test('a real worker crash fails every pending caller with a sanitized error and allows a later fresh worker', async (t) => {
  const secret = 'WORKER_PRIVATE_PAYLOAD_SENTINEL';
  const workerUrl = new URL('data:text/javascript,' + encodeURIComponent(
    `import { parentPort } from 'node:worker_threads'; parentPort.on('message', () => { throw new Error('${secret}'); });`,
  ));
  const transformer = createBodyTransformer({ workerUrl });
  t.after(() => transformer.close());
  const attempts = await Promise.allSettled([
    transformer.transform(Buffer.from('{"input":"input_image"}')),
    transformer.transform(Buffer.from('{"input":"input_image"}')),
  ]);
  for (const result of attempts) {
    assert.equal(result.status, 'rejected');
    assert.equal(result.reason.code, 'proxy_image_worker_failed');
    assert.equal(result.reason.status, 500);
    assert(!String(result.reason.stack).includes(secret));
  }
  assert.equal(transformer.getState().queuedInputBytes, 0);
  assert.equal(transformer.getState().workerThreadId, null);
  await assert.rejects(transformer.transform(Buffer.from('{}')), { code: 'proxy_image_worker_failed' });
});

test('JSON parse failures do not echo request contents from either processing mode', async (t) => {
  for (const useWorker of [true, false]) {
    const transformer = createBodyTransformer({ useWorker });
    t.after(() => transformer.close());
    await assert.rejects(transformer.transform(Buffer.from('{"input_image":"PRIVATE_BAD_JSON", broken')), (error) => {
      assert.equal(error.code, 'proxy_invalid_json');
      assert.equal(error.status, 400);
      assert(!String(error.stack).includes('PRIVATE_BAD_JSON'));
      return true;
    });
  }
});

test('one persistent worker owns and reuses its image cache across requests', async (t) => {
  const transformer = createBodyTransformer();
  t.after(() => transformer.close());
  const png = await sharp({ create: { width: 1500, height: 800, channels: 3, background: '#517f9d' } }).png().toBuffer();
  const raw = JSON.stringify({ input: [{ role: 'user', content: [{ type: 'input_image', image_url: `data:image/png;base64,${png.toString('base64')}` }] }] });
  const first = await transformer.transform(Buffer.from(raw));
  const workerId = transformer.getState().workerThreadId;
  const second = await transformer.transform(Buffer.from(raw));
  assert.equal(transformer.getState().workerThreadId, workerId);
  assert.equal(first.stats.transformed, 1);
  assert.deepEqual(second.body, first.body);
  assert.equal(second.stats.wireCacheHits, 1);
  assert.equal(second.stats.base64Decodes, 0);
  assert.equal(second.stats.base64Encodes, 0);
  assert.equal(second.stats.imageEncodeOperations, 0);
});
