import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createProxyServer } from '../src/server.mjs';
import { createUsageDb } from './helpers/usage-db.mjs';

const routes = ['/token-usage', '/token-usage/daily', '/token-usage/events', '/token-usage/sessions'];
const scopePath = '/token-usage/events?period=today&page_size=1';
const viewerHtml = readFileSync(new URL('./fixtures/usage-viewer.v2.9.15.html', import.meta.url));

const todayPage = JSON.stringify({ period: 'today', range: { start_ms: 0, end_ms: 100 }, items: [] });

async function serve(t, config, responseBody = url => url === scopePath ? todayPage : JSON.stringify({ forwarded: url })) {
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
    if (req.url.startsWith('/usage-viewer?')) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(viewerHtml);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(responseBody(req.url));
  }));
  const proxy = createProxyServer({ config: { ...config, upstream }, useWorker: false });
  return { url: await listen(proxy), requests };
}

async function missingDatabase(t) {
  const directory = await mkdtemp(join(tmpdir(), 'copilot-nday-missing-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, 'missing.sqlite');
}

test('relative-day queries keep the day selected before upstream authorization crosses midnight', async (t) => {
  const midnight = Date.parse('2026-11-18T16:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now: midnight - 1 });
  const fixture = await createUsageDb(t, [
    { created_at_ms: midnight - 2 * 86400000, total_tokens: 17 },
    { created_at_ms: midnight - 86400000, total_tokens: 18 },
  ]);
  const env = await serve(t, { sqliteDbPath: fixture.path, usageTimezone: '+08:00' }, () => {
    t.mock.timers.tick(1);
    return todayPage;
  });
  const result = await fetch(env.url + '/token-usage/daily?period=-1d');
  assert.equal(result.status, 200);
  const daily = await result.json();
  assert.deepEqual(daily.days.map(day => day.date), ['2026-11-17']);
  assert.equal(daily.totals.total_tokens, 17);
  assert.deepEqual(env.requests, [scopePath]);
});

test('four HTTP usage endpoints select the same day beyond ten days ago in each timezone', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-04T12:00:00Z') });
  for (const [usageTimezone, startUtc] of [
    ['+08:00', '2026-09-30T16:00:00Z'], ['Z', '2026-10-01T00:00:00Z'],
    ['-05:00', '2026-10-01T05:00:00Z'], ['+05:30', '2026-09-30T18:30:00Z'],
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
        const response = await fetch(`${env.url}${route}?period=-34+d`);
        assert.equal(response.status, 200, route);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        const body = await response.json();
        assert.equal(body.period, 'custom');
        assert.equal(body.range.start_ms, start);
        assert.equal(body.range.end_ms, end);
        assert.equal(body.range.display_label, '2026-10-01 (-34 Day)');
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
          assert.equal(body.days[0].date, '2026-10-01');
          assert.equal(body.days[0].start_ms, start);
          assert.equal(body.days[0].end_ms, end);
          assert.deepEqual(body.days[0].totals, body.totals);
        }
      }
      assert.deepEqual(env.requests, routes.map(() => scopePath));
    });
  }
});

test('relative-day aliases and arbitrary day counts agree across all four HTTP endpoints', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-04T00:00:00Z') });
  const fixture = await createUsageDb(t);
  const env = await serve(t, { sqliteDbPath: fixture.path });
  for (const [days, startUtc] of [
    [1, '2026-11-02T16:00:00.000Z'], [10, '2026-10-24T16:00:00.000Z'],
    [11, '2026-10-23T16:00:00.000Z'], [34, '2026-09-30T16:00:00.000Z'],
    [365, '2025-11-03T16:00:00.000Z'],
  ]) {
    let expectedRange;
    for (const suffix of ['d', 'D', 'day', 'DAY', '%20d', '+D', '_d', '%20Day', '+DAY', '_day']) {
      const period = `-${days}${suffix}`;
      for (const route of routes) {
        const response = await fetch(`${env.url}${route}?period=${period}`);
        assert.equal(response.status, 200, `${route}: ${period}`);
        const body = await response.json();
        assert.equal(body.range.start_utc, startUtc);
        assert.equal(body.range.end_ms - body.range.start_ms, 86400000);
        if (expectedRange) assert.deepEqual(body.range, expectedRange);
        expectedRange = body.range;
        if (body.totals) assert.equal(body.totals.request_count, 0);
        else assert.deepEqual(body.items, []);
      }
    }
  }
  assert.equal(env.requests.length, 5 * 10 * routes.length);
  assert.ok(env.requests.every((path) => path === scopePath));
});

test('invalid periods and explicit date parameters fail locally even without a database', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-04T00:00:00Z') });
  const env = await serve(t, { sqliteDbPath: await missingDatabase(t) });
  for (const route of [...routes, '/usage-viewer']) {
    for (const query of [
      'period=-0d', 'period=-0day', 'period=-01d', 'period=-01day', 'period=-1',
      'period=-1.5d', 'period=-1.5day', 'period=-xd', 'period=-xday', 'period=-1days',
      'period=-1dextra', 'period=-1__day', 'period=-1++day', 'period=-1%2Bd',
      'period=-99999999d', 'period=-9007199254740991d', 'period=-9007199254740992day',
      `period=-${'9'.repeat(400)}d`,
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

test('the 1970 local-date boundary applies to all endpoints and the viewer before retained data', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-04T18:45:00Z') });
  const dataStart = Date.parse('2026-01-01T00:00:00Z');
  for (const [usageTimezone, maxDays, startUtc] of [
    ['+08:00', 20762, '1969-12-31T16:00:00.000Z'],
    ['Z', 20761, '1970-01-01T00:00:00.000Z'],
    ['-05:00', 20761, '1970-01-01T05:00:00.000Z'],
    ['+05:30', 20762, '1969-12-31T18:30:00.000Z'],
    ['+14:00', 20762, '1969-12-31T10:00:00.000Z'],
    ['-14:00', 20761, '1970-01-01T14:00:00.000Z'],
  ]) {
    await t.test(usageTimezone, async (t) => {
      const fixture = await createUsageDb(t, [{ created_at_ms: dataStart, input_tokens: 100 }]);
      const env = await serve(t, { sqliteDbPath: fixture.path, usageTimezone });
      for (const route of routes) {
        const response = await fetch(`${env.url}${route}?period=-${maxDays}d`);
        assert.equal(response.status, 200, route);
        const body = await response.json();
        assert.equal(body.range.start_utc, startUtc);
        assert.equal(body.range.end_ms - body.range.start_ms, 86400000);
        assert.equal(body.range.display_label, `1970-01-01 (-${maxDays} Day)`);
        assert.equal(body.data_start_ms, dataStart);
        if (body.totals) {
          assert.equal(body.totals.request_count, 0);
          assert.equal(body.totals.total_tokens, 0);
          assert.deepEqual(body.byModel, []);
        } else {
          assert.deepEqual(body.items, []);
          assert.equal(body.total, 0);
        }
        if (body.days) assert.deepEqual(body.days.map((day) => day.date), ['1970-01-01']);
      }
      const pagePath = `/usage-viewer?period=-${maxDays}d`;
      const page = await fetch(`${env.url}${pagePath}`);
      assert.equal(page.status, 200);
      assert.match(await page.text(), /id="token-usage-period"/);
      for (const route of [...routes, '/usage-viewer']) {
        const response = await fetch(`${env.url}${route}?period=-${maxDays + 1}d`);
        assert.equal(response.status, 400, route);
        const body = await response.json();
        assert.equal(body.error.type, 'invalid_request_error');
        assert.match(body.error.message, /1970-01-01/);
      }
      assert.deepEqual(env.requests, [...routes.map(() => scopePath), pagePath]);
    });
  }
});

test('relative usage returns 501 on all endpoints when SQLite is unavailable', async (t) => {
  const env = await serve(t, { sqliteDbPath: await missingDatabase(t) });
  for (const route of routes) {
    const response = await fetch(`${env.url}${route}?period=-2day`);
    assert.equal(response.status, 501, route);
    assert.equal((await response.json()).error.type, 'usage_range_unavailable');
  }
  assert.deepEqual(env.requests, routes.map(() => scopePath));
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

test('native daily responses preserve model speeds and costs byte for byte without a local database', async (t) => {
  const sqliteDbPath = await missingDatabase(t);
  const model = {
    model: 'model-a', request_count: 2, input_tokens: 10, output_tokens: 40,
    cache_read_input_tokens: 0, cache_creation_input_tokens: 0, total_tokens: 50,
    total_nano_aiu: null, average_first_token_ms: 150,
    output_tokens_per_second: 40 * 1000 / 3000,
    costs: [{ amount: 0.000000001, currency: 'USD', total_cost_nanos: 1 }],
  };
  const unavailable = { ...model, model: 'model-b', output_tokens_per_second: null, costs: [] };
  const totals = { ...model, request_count: 4, input_tokens: 20, output_tokens: 80, total_tokens: 100 };
  delete totals.model;
  delete totals.average_first_token_ms;
  delete totals.output_tokens_per_second;
  const data = {
    range: { start_ms: 1793548800000, end_ms: 1793635200000 },
    byModel: [model, unavailable], totals,
    days: [{ date: '2026-11-02', start_ms: 1793548800000, end_ms: 1793635200000,
      byModel: [model, unavailable], totals }],
  };
  const bodyFor = (path) => JSON.stringify({
    ...data, period: new URL(path, 'http://localhost').searchParams.get('period'),
  }, null, 2) + '\n';
  const env = await serve(t, { sqliteDbPath }, bodyFor);
  for (const period of ['today', 'this_week', 'last_7_days', 'this_month', 'last_30_days', 'lifetime']) {
    const path = `/token-usage/daily?period=${period}&keep=unaltered`;
    const response = await fetch(`${env.url}${path}`);
    assert.equal(response.status, 200, period);
    assert.equal(response.headers.get('content-type'), 'application/json');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(bodyFor(path)), period);
    assert.equal(env.requests.at(-1), path);
  }
  assert.equal(env.requests.length, 6);
  await assert.rejects(access(sqliteDbPath), { code: 'ENOENT' });
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
  assert.ok(env.requests.every((path) => path === scopePath));
  assert.equal(env.requests.length, 3 * routes.length + 4);

  const unavailable = await serve(t, { sqliteDbPath: await missingDatabase(t) });
  const origin = 'http://localhost:43000';
  for (const route of routes) {
    for (const [period, status] of [['-34d', 501], ['-99999999d', 400]]) {
      const response = await fetch(`${unavailable.url}${route}?period=${period}`, { headers: { origin } });
      assert.equal(response.status, status);
      assert.equal(response.headers.get('access-control-allow-origin'), origin);
    }
    const preflight = await fetch(`${unavailable.url}${route}?period=-1day`, { method: 'OPTIONS', headers: { origin } });
    assert.equal(preflight.status, 204, 'Preflight must not open SQLite');
  }
  assert.deepEqual(unavailable.requests, routes.map(() => scopePath));
});
