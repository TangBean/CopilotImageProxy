import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { createProxyServer } from '../src/server.mjs';
import { createLogger } from '../src/logging.mjs';
import { createUsageDb } from './helpers/usage-db.mjs';

const start = Date.parse('2026-11-09T05:00:00Z');
const range = { start_ms: start, end_ms: start + 4500000 };
const origin = 'http://localhost:43000';
const scopePath = '/base/token-usage/events?period=today&page_size=1';
const todayPage = { period: 'today', range, items: [] };

async function serve(t, config = {}, respond = (_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(todayPage));
}) {
  const requests = [];
  const listen = async (server) => {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(async () => {
      const closed = new Promise((resolve) => server.close(resolve));
      server.closeAllConnections();
      await closed;
    });
    return `http://127.0.0.1:${server.address().port}`;
  };
  const upstream = await listen(http.createServer((req, res) => {
    requests.push({ url: req.url, headers: req.headers });
    respond(req, res);
  }));
  const logs = [];
  const server = createProxyServer({ config: { ...config, upstream: `${upstream}/base` }, useWorker: false,
    log: createLogger({ level: 'debug', write: entry => logs.push(entry) }) });
  return { url: await listen(server), requests, logs };
}

test('hourly HTTP queries use the authenticated upstream Today boundary and preserve native daily responses', async (t) => {
  const { path } = await createUsageDb(t, [
    { created_at_ms: start + 3600000, request_id: 'current', request_outcome: 'completed',
      output_tokens: 30, first_token_ms: 100, duration_ms: 2100 },
  ]);
  const native = JSON.stringify({ period: 'today', range, byModel: [{ model: 'native-daily' }], days: [] }, null, 2);
  const env = await serve(t, { sqliteDbPath: path, usageTimezone: '+08:00' }, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', etag: 'upstream-daily', 'x-api-key-usage-isolated': 'false' });
    res.end(req.url === scopePath ? JSON.stringify(todayPage) : native);
  });
  for (const suffix of ['', '?period=today']) {
    const response = await fetch(`${env.url}/token-usage/hourly${suffix}`, {
      headers: { origin, authorization: 'Bearer fixture-key', 'x-api-key': 'fixture-api-key', 'accept-encoding': 'gzip' },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('access-control-allow-origin'), origin);
    assert.equal(response.headers.get('etag'), null);
    assert.equal(response.headers.get('x-api-key-usage-isolated'), 'false');
    assert.match(response.headers.get('access-control-expose-headers'), /x-api-key-usage-isolated/i);
    const result = await response.json();
    assert.equal(result.range.start_ms, start);
    assert.equal(result.range.end_ms, range.end_ms);
    assert.equal(result.hours.length, 24);
    assert.deepEqual(result.hours[1].byModel, [{ model: 'model-a', output_tokens_per_second: 15 }]);
    assert.ok(result.hours.slice(2).every((hour) => !hour.byModel.length));
    const upstream = env.requests.at(-1);
    assert.equal(upstream.url, scopePath);
    assert.equal(upstream.headers.authorization, 'Bearer fixture-key');
    assert.equal(upstream.headers['x-api-key'], 'fixture-api-key');
    assert.equal(upstream.headers['accept-encoding'], 'identity');
  }
  const daily = await fetch(`${env.url}/token-usage/daily?period=today&keep=unaltered`);
  assert.equal(await daily.text(), native);
  assert.equal(daily.headers.get('etag'), 'upstream-daily');
  assert.equal(env.requests.at(-1).url, '/base/token-usage/daily?period=today&keep=unaltered');
});

test('hourly validates periods, explicit dates, methods and preflight before reaching upstream or SQLite', async (t) => {
  const fixture = await createUsageDb(t);
  const missing = join(dirname(fixture.path), 'missing.sqlite');
  const env = await serve(t, { sqliteDbPath: missing });
  for (const query of ['period=last_7_days', 'period=-1day', 'period=', 'period=today&period=today', 'from=', 'to=']) {
    const response = await fetch(`${env.url}/token-usage/hourly?${query}`, { headers: { origin } });
    assert.equal(response.status, 400, query);
    assert.equal(response.headers.get('access-control-allow-origin'), origin);
    assert.equal((await response.json()).error.type, 'invalid_request_error');
  }
  for (const method of ['POST', 'HEAD', 'DELETE']) {
    const response = await fetch(`${env.url}/token-usage/hourly?period=today`, { method, headers: { origin } });
    assert.equal(response.status, 405, method);
    assert.equal(response.headers.get('access-control-allow-origin'), origin);
  }
  const preflight = await fetch(`${env.url}/token-usage/hourly?period=today`, { method: 'OPTIONS', headers: {
    origin, 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization,x-api-key',
  } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), origin);
  assert.equal(preflight.headers.get('access-control-allow-methods'), 'GET');
  assert.match(preflight.headers.get('access-control-allow-headers'), /authorization/);
  assert.equal(env.requests.length, 0);
  await assert.rejects(access(missing), { code: 'ENOENT' });
});

test('hourly reports database and upstream range failures with readable loopback CORS errors', async (t) => {
  const fixture = await createUsageDb(t);
  const missing = join(dirname(fixture.path), 'missing.sqlite');
  const absent = await serve(t, { sqliteDbPath: missing });
  const unavailable = await fetch(`${absent.url}/token-usage/hourly?period=today`, { headers: { origin } });
  assert.equal(unavailable.status, 501);
  assert.equal(unavailable.headers.get('access-control-allow-origin'), origin);
  assert.equal((await unavailable.json()).error.type, 'usage_range_unavailable');
  await assert.rejects(access(missing), { code: 'ENOENT' });

  for (const [status, headers, body] of [
    [200, { 'content-type': 'application/json' }, '{}'],
    [200, { 'content-type': 'application/json' }, '{invalid'],
    [200, { 'content-type': 'text/html' }, '<p>Not usage</p>'],
    [200, { 'content-type': 'application/json', 'content-encoding': 'gzip' }, '{}'],
    [204, {}, ''],
  ]) {
    const env = await serve(t, { sqliteDbPath: missing }, (_req, res) => { res.writeHead(status, headers); res.end(body); });
    const response = await fetch(`${env.url}/token-usage/hourly?period=today`, { headers: { origin } });
    assert.equal(response.status, 502);
    assert.equal(response.headers.get('access-control-allow-origin'), origin);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.ok((await response.json()).error.message);
  }
});

test('local dashboard endpoints check each key with upstream and refuse global data for isolated keys', async (t) => {
  const fixture = await createUsageDb(t);
  const env = await serve(t, { sqliteDbPath: fixture.path, sessionIndexPath: join(dirname(fixture.path), 'unused.jsonl') }, (req, res) => {
    assert.equal(req.url, scopePath);
    const isolated = req.headers['x-api-key'] === 'isolated-fixture-key';
    const valid = isolated || req.headers.authorization === 'Bearer shared-fixture-key';
    res.writeHead(valid ? 200 : 401, {
      'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-expose-headers': '*',
      ...(valid ? { 'x-api-key-usage-isolated': String(isolated) } : { 'www-authenticate': 'Bearer realm="fixture"' }),
    });
    res.end(valid ? JSON.stringify(todayPage) : '{"error":{"message":"Unauthorized"}}');
  });
  for (const path of ['/__session-titles', '/token-usage/hourly?period=today', '/token-usage?period=-1d',
    '/token-usage/daily?period=-1d', '/token-usage/events?period=-1d', '/token-usage/sessions?period=-1d']) {
    const url = env.url + path;
    const sameOriginOnly = path === '/__session-titles';
    const allowedOrigin = sameOriginOnly ? null : origin;
    const preflight = await fetch(url, { method: 'OPTIONS', headers: { origin, 'access-control-request-headers': 'x-api-key' } });
    assert.equal(preflight.status, 204, path);
    assert.equal(preflight.headers.get('access-control-allow-origin'), allowedOrigin);
    if (sameOriginOnly) {
      assert.equal(preflight.headers.get('access-control-allow-headers'), null);
      assert.equal(preflight.headers.get('access-control-allow-methods'), null);
    } else assert.match(preflight.headers.get('access-control-allow-headers'), /x-api-key/);
    const shared = await fetch(url, { headers: { origin, authorization: 'Bearer shared-fixture-key' } });
    assert.equal(shared.status, 200, path);
    assert.equal(shared.headers.get('access-control-allow-origin'), allowedOrigin);
    assert.equal(shared.headers.get('x-api-key-usage-isolated'), 'false');
    const scoped = await fetch(url, { headers: {
      origin, 'x-api-key': 'isolated-fixture-key', 'x-api-key-usage-isolated': 'false',
    } });
    assert.equal(scoped.status, 403, path);
    assert.equal(scoped.headers.get('x-api-key-usage-isolated'), 'true');
    assert.equal(scoped.headers.get('access-control-allow-origin'), allowedOrigin);
    assert.equal(scoped.headers.get('access-control-expose-headers'), sameOriginOnly ? null : 'x-api-key-usage-isolated');
    assert.equal((await scoped.json()).error.type, 'usage_scope_unavailable');
    const log = env.logs.at(-1);
    assert.equal(log.status, 403);
    assert.equal(log.error, 'usage_scope_unavailable');
    assert.equal(log.level, 'warn');
    assert.equal(log.aborted, false);
    assert.equal(log.abortSource, undefined);
    const denied = await fetch(url, { headers: { origin: sameOriginOnly ? origin : 'https://example.invalid' } });
    assert.equal(denied.status, 401, path);
    assert.equal(denied.headers.get('www-authenticate'), 'Bearer realm="fixture"');
    assert.equal(denied.headers.get('access-control-allow-origin'), null);
    if (sameOriginOnly) assert.equal(denied.headers.get('access-control-expose-headers'), null);
    assert.deepEqual(await denied.json(), { error: { message: 'Unauthorized' } });
  }
});

test('hourly allows only loopback origins for local SQLite results', async (t) => {
  const fixture = await createUsageDb(t);
  const env = await serve(t, { sqliteDbPath: fixture.path });
  for (const origin of ['http://127.0.0.1:43000', 'https://[::1]:43001', 'https://example.invalid', 'http://localhost.example.invalid', 'null']) {
    const response = await fetch(`${env.url}/token-usage/hourly?period=today`, { headers: { origin } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), ['http://127.0.0.1:43000', 'https://[::1]:43001'].includes(origin) ? origin : null);
  }
});

test('an isolation denial releases the unfinished scope response without waiting for its body', { timeout: 5000 }, async (t) => {
  let release;
  const closed = new Promise(resolve => { release = resolve; });
  const env = await serve(t, {}, (_req, res) => {
    res.once('close', release);
    res.writeHead(200, { 'content-type': 'application/json', 'x-api-key-usage-isolated': 'true' });
    res.flushHeaders();
  });
  const response = await fetch(env.url + '/token-usage/hourly', { signal: AbortSignal.timeout(3000) });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.type, 'usage_scope_unavailable');
  await closed;
});
