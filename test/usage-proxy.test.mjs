import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createProxyServer } from '../src/server.mjs';
import { createUsageDb } from './helpers/usage-db.mjs';

const routes = ['/token-usage', '/token-usage/daily', '/token-usage/events', '/token-usage/sessions'];

async function serve(t, config) {
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
    requests.push(req.url);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ forwarded: req.url }));
  }));
  const proxy = createProxyServer({ config: { ...config, upstream }, useWorker: false });
  return { url: await listen(proxy), requests };
}

async function missingDatabase(t) {
  const directory = await mkdtemp(join(tmpdir(), 'copilot-nday-missing-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, 'missing.sqlite');
}

test('four HTTP usage endpoints select the same single natural day in each timezone', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-04T12:00:00Z') });
  for (const [usageTimezone, startUtc] of [
    ['+08:00', '2026-11-02T16:00:00Z'], ['Z', '2026-11-03T00:00:00Z'],
    ['-05:00', '2026-11-03T05:00:00Z'], ['+05:30', '2026-11-02T18:30:00Z'],
  ]) {
    await t.test(usageTimezone, async (t) => {
      const start = Date.parse(startUtc);
      const end = start + 86400000;
      const fixture = await createUsageDb(t, [
        { created_at_ms: start - 1, session_id: 'outside-before', input_tokens: 100 },
        { created_at_ms: start, session_id: 'inside-start', input_tokens: 10 },
        { created_at_ms: end - 1, session_id: 'inside-end', input_tokens: 20 },
        { created_at_ms: end, session_id: 'outside-after', input_tokens: 100 },
      ]);
      const env = await serve(t, { sqliteDbPath: fixture.path, usageTimezone });
      let expectedRange;
      for (const route of routes) {
        const response = await fetch(`${env.url}${route}?period=-1+Day`);
        assert.equal(response.status, 200, route);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        const body = await response.json();
        assert.equal(body.period, 'custom');
        assert.equal(body.range.start_ms, start);
        assert.equal(body.range.end_ms, end);
        assert.equal(body.range.display_label, '2026-11-03 (-1 Day)');
        if (expectedRange) assert.deepEqual(body.range, expectedRange);
        expectedRange = body.range;
        if (body.totals) {
          assert.equal(body.totals.request_count, 2);
          assert.equal(body.totals.input_tokens, 30);
        } else {
          assert.equal(body.total, 2);
          assert.deepEqual(body.items.map((row) => row.session_id).sort(), ['inside-end', 'inside-start']);
        }
        if (route.endsWith('/daily')) {
          assert.equal(body.days.length, 1);
          assert.equal(body.days[0].date, '2026-11-03');
          assert.equal(body.days[0].start_ms, start);
          assert.equal(body.days[0].end_ms, end);
          assert.deepEqual(body.days[0].totals, body.totals);
        }
      }
      assert.equal(env.requests.length, 0);
    });
  }
});

test('encoded relative periods and -10day are accepted through HTTP with the default timezone', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-04T00:00:00Z') });
  const fixture = await createUsageDb(t);
  const env = await serve(t, { sqliteDbPath: fixture.path });
  for (const period of ['-1day', '-1DAY', '-1%20Day', '-1+Day', '-1_day', '-10day']) {
    const response = await fetch(`${env.url}/token-usage?period=${period}`);
    assert.equal(response.status, 200, period);
    const body = await response.json();
    const expected = period === '-10day' ? '2026-10-24T16:00:00.000Z' : '2026-11-02T16:00:00.000Z';
    assert.equal(body.range.start_utc, expected);
    assert.equal(body.totals.request_count, 0);
  }
  assert.equal(env.requests.length, 0);
});

test('invalid periods and explicit date parameters fail locally even without a database', async (t) => {
  const env = await serve(t, { sqliteDbPath: await missingDatabase(t) });
  for (const route of [...routes, '/usage-viewer']) {
    for (const query of [
      'period=-0day', 'period=-11day', 'period=-01day', 'period=-1', 'period=-1.5day',
      'period=-xday', 'period=-1days', 'period=-1__day', 'period=-1++day',
      'period=-1day&from=20261101000000', 'period=today&to=20261102000000',
      'from=', 'to=', 'period=today&period=-1day', 'period=-1day&period=today',
    ]) {
      const response = await fetch(`${env.url}${route}?${query}`);
      assert.equal(response.status, 400, `${route}?${query}`);
      assert.equal((await response.json()).error.type, 'invalid_request_error');
    }
    for (const method of ['POST', 'HEAD']) {
      const response = await fetch(`${env.url}${route}?from=20261101000000`, { method });
      assert.equal(response.status, 400, `${method} ${route}`);
    }
  }
  assert.equal(env.requests.length, 0);
});

test('relative usage returns 501 on all endpoints when SQLite is unavailable', async (t) => {
  const env = await serve(t, { sqliteDbPath: await missingDatabase(t) });
  for (const route of routes) {
    const response = await fetch(`${env.url}${route}?period=-2day`);
    assert.equal(response.status, 501, route);
    assert.equal((await response.json()).error.type, 'usage_range_unavailable');
  }
  assert.equal(env.requests.length, 0);
});

test('ordinary periods keep their complete upstream URLs without requiring SQLite', async (t) => {
  const env = await serve(t, { sqliteDbPath: await missingDatabase(t) });
  for (const route of routes) {
    for (const query of ['', '?period=today', '?period=week&page=2&page_size=5', '?period=month', '?period=all']) {
      const path = `${route}${query}`;
      const response = await fetch(`${env.url}${path}`);
      assert.equal(response.status, 200, path);
      assert.deepEqual(await response.json(), { forwarded: path });
      assert.equal(env.requests.at(-1), path);
    }
  }
});

test('relative usage supports loopback CORS, including preflight and local errors', async (t) => {
  const fixture = await createUsageDb(t);
  const env = await serve(t, { sqliteDbPath: fixture.path });
  for (const origin of ['http://localhost:43000', 'http://127.0.0.1:43001', 'https://[::1]:43002']) {
    for (const route of routes) {
      const url = `${env.url}${route}?period=-1day`;
      const preflight = await fetch(url, { method: 'OPTIONS', headers: {
        origin, 'access-control-request-method': 'GET', 'access-control-request-headers': 'x-api-key',
      } });
      assert.equal(preflight.status, 204);
      assert.equal(preflight.headers.get('access-control-allow-origin'), origin);
      assert.equal(preflight.headers.get('access-control-allow-methods'), 'GET');
      assert.match(preflight.headers.get('access-control-allow-headers'), /x-api-key/);
      const response = await fetch(url, { headers: { origin } });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('access-control-allow-origin'), origin);
      assert.equal(response.headers.get('vary'), 'Origin');
    }
  }
  for (const origin of ['https://example.invalid', 'http://localhost.example.invalid', 'null', 'http://user@localhost:43000']) {
    const response = await fetch(`${env.url}/token-usage?period=-1day`, { headers: { origin } });
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  }
  assert.equal(env.requests.length, 0);

  const unavailable = await serve(t, { sqliteDbPath: await missingDatabase(t) });
  const origin = 'http://localhost:43000';
  for (const route of routes) {
    for (const [period, status] of [['-1day', 501], ['-11day', 400]]) {
      const response = await fetch(`${unavailable.url}${route}?period=${period}`, { headers: { origin } });
      assert.equal(response.status, status);
      assert.equal(response.headers.get('access-control-allow-origin'), origin);
    }
    const preflight = await fetch(`${unavailable.url}${route}?period=-1day`, { method: 'OPTIONS', headers: { origin } });
    assert.equal(preflight.status, 204, 'Preflight must not open SQLite');
  }
  assert.equal(unavailable.requests.length, 0);
});
