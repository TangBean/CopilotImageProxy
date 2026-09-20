import test from 'node:test';
import assert from 'node:assert/strict';
import { createLogger } from '../src/logging.mjs';

function loggedRequest(entry, level) {
  let result;
  createLogger({ level, write: value => { result = value; } })(entry);
  return result;
}

test('normal logging retains lifecycle and failures without formatting debug records', () => {
  const entries = [];
  const log = createLogger({ write: (entry) => entries.push(entry) });
  log({ event: 'upstream-package', phase: 'resolve-latest', get payload() { throw new Error('Debug record was formatted'); } });
  log({ event: 'ready', proxyPort: 4142 });
  log({ event: 'stopping' });
  log({ event: 'startup_error', message: 'Cannot connect' });
  log({ event: 'upstream_exited', code: 1 });
  assert.deepEqual(entries.map(({ event, level }) => [event, level]), [
    ['ready', 'info'], ['stopping', 'info'], ['startup_error', 'error'], ['upstream_exited', 'error'],
  ]);
  assert.ok(entries.every((entry) => !Number.isNaN(Date.parse(entry.time))));
  assert.doesNotThrow(() => createLogger({ write: () => { throw new Error('Closed log sink'); } })({ event: 'ready' }));
});

test('configured severity filters warnings and errors and silent suppresses every record', () => {
  for (const [minimum, expected] of [
    ['debug', ['debug', 'info', 'warn', 'error']], ['info', ['info', 'warn', 'error']],
    ['warn', ['warn', 'error']], ['error', ['error']], ['silent', []],
  ]) {
    const entries = [];
    const log = createLogger({ level: minimum, write: (entry) => entries.push(entry) });
    for (const level of ['debug', 'info', 'warn', 'error']) log({ event: 'test', level });
    assert.deepEqual(entries.map(({ level }) => level), expected);
  }
});

test('client disconnects are debug-only while upstream failures retain their severity and compact metadata', () => {
  const cancelled = { event: 'request', status: 200, aborted: true, abortSource: 'client' };
  assert.equal(loggedRequest(cancelled, 'info'), undefined);
  assert.equal(loggedRequest(cancelled, 'debug').level, 'debug');
  const upstream = { ...cancelled, abortSource: 'upstream', error: 'proxy_upstream_stream_aborted',
    images: { cacheHits: 24 }, outputBytes: 5700000 };
  assert.equal(loggedRequest(upstream, 'info').level, 'error');
  assert.equal(loggedRequest(upstream, 'info').outputBytes, 5700000);
  assert.equal(loggedRequest(upstream, 'info').images, undefined);
  assert.deepEqual(loggedRequest(upstream, 'debug').images, { cacheHits: 24 });
  assert.equal(loggedRequest(upstream, 'silent'), undefined);
  assert.equal(loggedRequest({ ...upstream, status: 413 }, 'error').level, 'error');
  assert.equal(loggedRequest({ event: 'request', status: 413 }, 'info').level, 'warn');
  assert.equal(loggedRequest({ event: 'request', status: 413 }, 'error'), undefined);
  assert.equal(loggedRequest({ event: 'request', status: 503 }, 'info').level, 'error');
});
