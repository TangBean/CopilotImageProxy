import assert from 'node:assert/strict';
import { access, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  createRelativeDayRange, createUsageRangeReader, parseRelativeDayPeriod, UsageRangeError,
} from '../src/usage-range.mjs';
import { createUsageDb } from './helpers/usage-db.mjs';

const DAY = 86400000;
const now = Date.parse('2026-01-03T06:34:56Z');
const start = Date.parse('2026-01-01T16:00:00Z');
const end = start + DAY;
const routes = ['/token-usage', '/token-usage/daily', '/token-usage/events', '/token-usage/sessions'];
const query = (extra = {}) => new URLSearchParams({ period: '-1day', ...extra });
const invalidRequest = (error) => error instanceof UsageRangeError && error.status === 400 && error.type === 'invalid_request_error';
const unavailable = (error) => error instanceof UsageRangeError && error.status === 501 && error.type === 'usage_range_unavailable';

async function fixture(t) {
  const result = await createUsageDb(t, [
    { created_at_ms: start - 1, total_tokens: 10000, model: 'outside', session_id: 'outside' },
    { created_at_ms: start, model: 'model-a', session_id: 'a', input_tokens: 10, output_tokens: 2,
      cache_read_input_tokens: 3, cache_creation_input_tokens: 4, total_tokens: 99,
      cost_currency: 'USD', total_cost_nanos: 100000000, cost_source: 'price',
      request_id: 'request-a', first_token_ms: 100, duration_ms: 1100, request_outcome: 'completed' },
    { created_at_ms: start + 1000, model: 'model-b', session_id: 'b', input_tokens: 20, output_tokens: 3,
      total_nano_aiu: 5, cost_currency: 'EUR', total_cost_nanos: 2000000000, cost_source: 'price',
      request_id: 'request-b', first_token_ms: 200, duration_ms: 2200, request_outcome: 'completed' },
    { created_at_ms: end - 2, model: 'model-a', session_id: 'a', input_tokens: 30, output_tokens: 5,
      total_nano_aiu: 7, cost_currency: 'USD', total_cost_nanos: 300000000, cost_source: 'price' },
    { created_at_ms: end - 1, model: 'model-b', session_id: '', input_tokens: 40, output_tokens: 7,
      cost_currency: 'USD', total_cost_nanos: 600000000, cost_source: 'price' },
    { created_at_ms: end, total_tokens: 20000, model: 'outside', session_id: 'outside' },
  ]);
  return { ...result, read: createUsageRangeReader({ sqliteDbPath: result.path }, { now: () => now }) };
}

test('relative-day periods accept exact spellings and canonicalize case and one separator', () => {
  for (let day = 1; day <= 10; day++) {
    for (const separator of ['', ' ', '_']) {
      for (const suffix of ['day', 'Day', 'DAY']) {
        assert.equal(parseRelativeDayPeriod(`-${day}${separator}${suffix}`), `-${day}day`);
      }
    }
  }
  for (const value of [null, undefined, '', 'today', 'yesterday', 'week', 'month', 'all', 'last30days']) {
    assert.equal(parseRelativeDayPeriod(value), null);
  }
});

test('malformed relative-day candidates fail without trimming or accepting numeric lookalikes', () => {
  for (const value of ['-', '-0day', '-11day', '-01day', '-00day', '-1', '-1.0day', '-1.5day',
    '-1e0day', '-oneday', '-nday', '-1days', '-1dayago', '--1day', '-today', '- 1day',
    '-1  day', '-1__day', '-1 _day', '-1day ', ' -1day', '-1day\n', '\t-1day', '-1\tday', '-1\u00a0day']) {
    assert.throws(() => parseRelativeDayPeriod(value), invalidRequest, JSON.stringify(value));
  }
});

test('URL decoding preserves the accepted space and underscore spellings and rejects extra characters', () => {
  for (const encoded of ['-1day', '-1%20day', '-1+day', '-1_day', '%2D10%20DAY']) {
    const params = new URLSearchParams(`period=${encoded}`);
    assert.equal(parseRelativeDayPeriod(params.get('period')), encoded.includes('10') ? '-10day' : '-1day');
  }
  for (const encoded of ['-0day', '-11day', '-01day', '-1%20%20day', '-1day%20', '%20-1day',
    '-1%2Bday', '-1%2Fday', '-1day%0A']) {
    assert.throws(() => parseRelativeDayPeriod(new URLSearchParams(`period=${encoded}`).get('period')), invalidRequest);
  }
});

test('relative-day ranges select one natural day across month, year and leap-day boundaries', () => {
  for (const [clock, period, date] of [
    ['2026-03-01T08:00:00Z', '-1day', '2026-02-28'],
    ['2024-03-01T08:00:00Z', '-1day', '2024-02-29'],
    ['2027-01-01T08:00:00Z', '-1day', '2026-12-31'],
    ['2026-01-05T08:00:00Z', '-10day', '2025-12-26'],
  ]) {
    const range = createRelativeDayRange(period, 'Z', Date.parse(clock));
    assert.equal(range.date, date);
    assert.equal(range.startMs, Date.parse(`${date}T00:00:00Z`));
    assert.equal(range.endMs - range.startMs, DAY);
    assert.equal(range.displayLabel, `${date} (${period.replace('day', ' Day')})`);
  }
  const beforeMidnight = createRelativeDayRange('-1day', '+08:00', Date.parse('2026-11-03T15:59:59.999Z'));
  const atMidnight = createRelativeDayRange('-1day', '+08:00', Date.parse('2026-11-03T16:00:00Z'));
  assert.equal(beforeMidnight.date, '2026-11-02');
  assert.equal(atMidnight.date, '2026-11-03');
});

test('relative-day range boundaries follow +08:00, Z, -05:00 and +05:30', () => {
  const clock = Date.parse('2026-11-03T18:45:00Z');
  for (const [timezone, date, startUtc] of [
    ['+08:00', '2026-11-02', '2026-11-01T16:00:00Z'],
    ['Z', '2026-11-01', '2026-11-01T00:00:00Z'],
    ['-05:00', '2026-11-01', '2026-11-01T05:00:00Z'],
    ['+05:30', '2026-11-02', '2026-11-01T18:30:00Z'],
  ]) {
    assert.deepEqual(createRelativeDayRange('-2 Day', timezone, clock), {
      startMs: Date.parse(startUtc), endMs: Date.parse(startUtc) + DAY,
      date, displayLabel: `${date} (-2 Day)`,
    });
  }
});

test('invalid periods, from/to and timezone fail before opening any database', async () => {
  let opens = 0;
  const options = { now: () => now, openDatabase: () => { opens++; throw new Error('must not open'); } };
  const read = createUsageRangeReader({}, options);
  for (const route of routes) {
    for (const params of [query({ period: '-0day' }), query({ period: '-11day' }),
      query({ period: '-01day' }), query({ period: '-1' }), query({ period: '-1.5day' }),
      query({ period: '-oneday' }), query({ period: '-1days' }), query({ period: '-1day ' }),
      query({ from: '' }), query({ to: '' }), query({ from: '20260102000000', to: '20260103000000' }),
      new URLSearchParams('period=-1day&period=-2day'), new URLSearchParams('period=today&period=today'),
      new URLSearchParams('period=today&from=invalid'), new URLSearchParams('to=invalid')]) {
      await assert.rejects(read(route, params), invalidRequest);
    }
  }
  for (const usageTimezone of ['', 'UTC', '+15:00', '-14:01', '+08:60', '+08:00\n']) {
    await assert.rejects(createUsageRangeReader({ usageTimezone }, options)('/token-usage', query()), invalidRequest);
  }
  assert.equal(opens, 0);
});

test('ordinary named periods return null without consulting the clock or opening a database', async () => {
  let opens = 0;
  let clockCalls = 0;
  const read = createUsageRangeReader({}, {
    now: () => { clockCalls++; return now; },
    openDatabase: () => { opens++; throw new Error('must not open'); },
  });
  for (const route of routes) {
    for (const period of ['today', 'week', 'month', 'all']) {
      assert.equal(await read(route, new URLSearchParams({ period })), null);
    }
    assert.equal(await read(route, new URLSearchParams()), null);
  }
  assert.equal(opens, 0);
  assert.equal(clockCalls, 0);
});

test('all four endpoints use the same inclusive-start, exclusive-end range and capture now once', async (t) => {
  const { path } = await fixture(t);
  let clockCalls = 0;
  const read = createUsageRangeReader({ sqliteDbPath: path }, { now: () => { clockCalls++; return now; } });
  for (const route of routes) {
    const result = await read(route, query());
    assert.equal(result.period, 'custom');
    assert.deepEqual(result.range, {
      start_ms: start, end_ms: end,
      start_utc: '2026-01-01T16:00:00.000Z', end_utc: '2026-01-02T16:00:00.000Z',
      display_label: '2026-01-02 (-1 Day)',
    });
    assert.equal(result.data_start_ms, start - 1);
    if (result.totals) assert.equal(result.totals.request_count, 4);
    if (route.endsWith('/events')) assert.deepEqual(result.items.map((row) => row.id), [5, 4, 3, 2]);
    if (route.endsWith('/sessions')) assert.deepEqual(result.items.map((row) => row.session_id), ['a', '', 'b']);
  }
  assert.equal(clockCalls, routes.length);
});

test('totals, costs, model ordering and request timing retain upstream semantics', async (t) => {
  const { read } = await fixture(t);
  const result = await read('/token-usage', query());
  assert.deepEqual(result.totals, {
    request_count: 4, input_tokens: 100, output_tokens: 17, cache_read_input_tokens: 3,
    cache_creation_input_tokens: 4, total_tokens: 204, total_nano_aiu: 12,
    costs: [
      { amount: 2, currency: 'EUR', total_cost_nanos: 2000000000 },
      { amount: 1, currency: 'USD', total_cost_nanos: 1000000000 },
    ],
  });
  assert.deepEqual(result.byModel.map((model) => [model.model, model.total_tokens, model.average_first_token_ms,
    model.output_tokens_per_second]), [['model-a', 134, 100, 2], ['model-b', 70, 200, 1.5]]);
  assert.deepEqual(result.byModel[0].costs, [{ amount: 0.4, currency: 'USD', total_cost_nanos: 400000000 }]);
});

test('daily returns one complete natural-day bucket, including an empty day before retained data', async (t) => {
  const { read } = await fixture(t);
  const result = await read('/token-usage/daily', query());
  assert.deepEqual(result.days, [{
    date: '2026-01-02', start_ms: start, end_ms: end,
    byModel: result.byModel, totals: result.totals,
  }]);
  const empty = await read('/token-usage/daily', query({ period: '-10day' }));
  assert.equal(empty.days.length, 1);
  assert.equal(empty.days[0].date, '2025-12-24');
  assert.equal(empty.range.end_ms - empty.range.start_ms, DAY);
  assert.equal(empty.days[0].totals.request_count, 0);
  assert.deepEqual(empty.days[0].byModel, []);
  assert.equal(empty.totals.total_nano_aiu, null);
  assert.deepEqual(empty.totals.costs, []);
  assert.equal(empty.data_start_ms, start - 1);
});

test('configured timezones change the exact natural day read by all endpoints', async (t) => {
  const clock = Date.parse('2026-11-03T18:45:00Z');
  for (const usageTimezone of ['+08:00', 'Z', '-05:00', '+05:30']) {
    const range = createRelativeDayRange('-2day', usageTimezone, clock);
    const { path } = await createUsageDb(t, [
      { created_at_ms: range.startMs - 1, total_tokens: 100 },
      { created_at_ms: range.startMs, total_tokens: 1 },
      { created_at_ms: range.endMs - 1, total_tokens: 2 },
      { created_at_ms: range.endMs, total_tokens: 1000 },
    ]);
    const read = createUsageRangeReader({ sqliteDbPath: path, usageTimezone }, { now: () => clock });
    for (const route of routes) {
      const result = await read(route, query({ period: '-2day' }));
      assert.equal(result.range.start_ms, range.startMs);
      assert.equal(result.range.end_ms, range.endMs);
      assert.equal(result.totals?.total_tokens ?? result.items.reduce((sum, item) => sum + item.total_tokens, 0), 3);
      if (result.days) assert.equal(result.days[0].date, range.date);
    }
  }
});

test('event pages preserve descending time/id order, fields, costs and pagination', async (t) => {
  const { read, insert } = await fixture(t);
  insert({ created_at_ms: end - 1, model: 'tie', total_tokens: 1, user_id: 'user', user_agent: 'test-agent',
    provider_name: 'provider', trace_id: 'specific-trace', endpoint: '/chat/completions' });
  const page = await read('/token-usage/events', query({ page: '2', page_size: '2' }));
  assert.equal(page.total, 5);
  assert.equal(page.total_pages, 3);
  assert.equal(page.page, 2);
  assert.equal(page.page_size, 2);
  assert.deepEqual(page.items.map((row) => row.id), [4, 3]);
  assert.deepEqual(page.items[1].cost, { amount: 2, currency: 'EUR', total_cost_nanos: 2000000000, source: 'price' });
  assert.equal(page.items[1].output_tokens_per_second, 1.5);
  const first = await read('/token-usage/events', query({ page_size: '2' }));
  assert.deepEqual(first.items.map((row) => row.id), [7, 5]);
  assert.equal(first.items[0].user_agent, 'test-agent');
  assert.equal(first.items[0].user_id, 'user');
  assert.equal(first.items[0].provider_name, 'provider');
  assert.equal(first.items[0].trace_id, 'specific-trace');
  assert.equal(first.items[0].endpoint, '/chat/completions');
  assert.equal(first.items[0].cost, null);
  assert.equal(first.items[0].output_tokens_per_second, null);
});

test('session pages include empty session IDs and sort by totals, then session ID', async (t) => {
  const { read, insert } = await fixture(t);
  insert({ created_at_ms: start, session_id: 'aa', total_tokens: 134 });
  const first = await read('/token-usage/sessions', query({ page_size: '2' }));
  assert.equal(first.total, 4);
  assert.equal(first.total_pages, 2);
  assert.deepEqual(first.items.map((row) => [row.session_id, row.total_tokens]), [['a', 134], ['aa', 134]]);
  assert.deepEqual(first.items[0].costs, [{ amount: 0.4, currency: 'USD', total_cost_nanos: 400000000 }]);
  const second = await read('/token-usage/sessions', query({ page_size: '2', page: '2' }));
  assert.deepEqual(second.items.map((row) => [row.session_id, row.total_tokens]), [['', 47], ['b', 23]]);
});

test('pagination follows upstream defaults and size cap, with empty out-of-range pages', async (t) => {
  const { read } = await fixture(t);
  for (const route of ['/token-usage/events', '/token-usage/sessions']) {
    const defaults = await read(route, query({ page: '-2', page_size: 'nope' }));
    assert.equal(defaults.page, 1);
    assert.equal(defaults.page_size, 20);
    const capped = await read(route, query({ page: '2extra', page_size: '200' }));
    assert.equal(capped.page, 2);
    assert.equal(capped.page_size, 100);
    assert.deepEqual(capped.items, []);
    const huge = await read(route, query({ page: '9'.repeat(100) }));
    assert.deepEqual(huge.items, []);
    const nonfinite = await read(route, query({ page: '9'.repeat(400), page_size: '9'.repeat(400) }));
    assert.equal(nonfinite.page, 1);
    assert.equal(nonfinite.page_size, 20);
  }
});

test('model timing aggregates whole completed requests and excludes requests crossing either boundary', async (t) => {
  const completed = { model: 'timed', first_token_ms: 100, duration_ms: 1100, request_outcome: 'completed' };
  const { path } = await createUsageDb(t, [
    { ...completed, created_at_ms: start, request_id: 'single', output_tokens: 10 },
    { ...completed, created_at_ms: start + 1, request_id: 'multi', output_tokens: 10, first_token_ms: 200, duration_ms: 2200 },
    { ...completed, created_at_ms: start + 2, request_id: 'multi', output_tokens: 20, first_token_ms: 200, duration_ms: 2200 },
    { ...completed, created_at_ms: start - 1, request_id: 'partial-start', output_tokens: 1000 },
    { ...completed, created_at_ms: start, request_id: 'partial-start', output_tokens: 1000 },
    { ...completed, created_at_ms: end - 1, request_id: 'partial-end', output_tokens: 1000 },
    { ...completed, created_at_ms: end, request_id: 'partial-end', output_tokens: 1000 },
    { ...completed, created_at_ms: start, request_id: 'cancelled', output_tokens: 1000, request_outcome: 'cancelled' },
    { ...completed, created_at_ms: start, request_id: 'missing', output_tokens: 1000, first_token_ms: null },
    { ...completed, created_at_ms: start, request_id: 'negative', output_tokens: 1000, first_token_ms: -1 },
    { ...completed, created_at_ms: start, request_id: 'models', output_tokens: 1000 },
    { ...completed, created_at_ms: start, request_id: 'models', output_tokens: 1000, model: 'other' },
  ]);
  const read = createUsageRangeReader({ sqliteDbPath: path }, { now: () => now });
  const result = await read('/token-usage/daily', query());
  const timed = result.byModel.find((row) => row.model === 'timed');
  assert.equal(timed.average_first_token_ms, 150);
  assert.equal(timed.output_tokens_per_second, 40 * 1000 / 3000);
  assert.deepEqual(result.days[0].byModel, result.byModel);
  const events = await read('/token-usage/events', query());
  assert.equal(events.items.find((row) => row.request_id === 'single').output_tokens_per_second, 10);
  for (const row of events.items.filter((row) => row.request_id !== 'single')) {
    assert.equal(row.output_tokens_per_second, null, row.request_id);
  }
});

test('empty databases preserve the requested full day without inventing data', async (t) => {
  const { path } = await createUsageDb(t);
  const read = createUsageRangeReader({ sqliteDbPath: path }, { now: () => now });
  for (const route of routes) {
    const result = await read(route, query());
    assert.equal(result.range.start_ms, start);
    assert.equal(result.range.end_ms, end);
    assert.equal(result.data_start_ms, null);
    if (result.totals) {
      assert.equal(result.totals.request_count, 0);
      assert.equal(result.totals.total_nano_aiu, null);
      assert.deepEqual(result.totals.costs, []);
      assert.deepEqual(result.byModel, []);
    } else {
      assert.deepEqual(result.items, []);
      assert.equal(result.total, 0);
      assert.equal(result.total_pages, 1);
    }
    if (result.days) assert.deepEqual(result.days.map((day) => day.date), ['2026-01-02']);
  }
});

test('missing database does not create a file and returns a recoverable 501', async (t) => {
  const { path } = await createUsageDb(t);
  const missing = join(dirname(path), 'missing.sqlite');
  const read = createUsageRangeReader({ sqliteDbPath: missing }, { now: () => now });
  await assert.rejects(read('/token-usage', query()), (error) => unavailable(error) && !error.message.includes(missing));
  await assert.rejects(access(missing), { code: 'ENOENT' });
  await writeFile(missing, await readFile(path));
  assert.equal((await read('/token-usage', query())).totals.request_count, 0);
});

test('incompatible schema returns 501, closes the reader and leaves the database unchanged', async (t) => {
  const { path, db } = await createUsageDb(t);
  db.exec('ALTER TABLE token_usage_events DROP COLUMN duration_ms');
  const before = await readFile(path);
  let connection;
  const read = createUsageRangeReader({ sqliteDbPath: path }, {
    now: () => now,
    openDatabase: (dbPath, options) => { connection = new DatabaseSync(dbPath, options); return connection; },
  });
  await assert.rejects(read('/token-usage', query()), (error) => unavailable(error) && /schema/.test(error.message));
  assert.equal(connection.isOpen, false);
  assert.deepEqual(await readFile(path), before);
  assert.ok(!db.prepare('PRAGMA table_info(token_usage_events)').all().some((column) => column.name === 'duration_ms'));
});

test('corrupt databases return 501 without changing bytes or exposing the path', async (t) => {
  const { path } = await createUsageDb(t);
  const corrupt = join(dirname(path), 'corrupt.sqlite');
  const contents = Buffer.from('not a SQLite database');
  await writeFile(corrupt, contents);
  const read = createUsageRangeReader({ sqliteDbPath: corrupt }, { now: () => now });
  await assert.rejects(read('/token-usage', query()), (error) => unavailable(error) && !error.message.includes(corrupt));
  assert.deepEqual(await readFile(corrupt), contents);
});

test('all endpoints leave database and WAL bytes unchanged while reading beside a writer', async (t) => {
  const { path, db, insert } = await createUsageDb(t, [{ created_at_ms: start, total_tokens: 10 }], { wal: true });
  const before = await readFile(path);
  const walBefore = await readFile(`${path}-wal`);
  const read = createUsageRangeReader({ sqliteDbPath: path }, { now: () => now });
  for (const route of routes) {
    const result = await read(route, query());
    assert.equal(result.totals?.total_tokens ?? result.items[0].total_tokens, 10);
  }
  assert.deepEqual(await readFile(path), before);
  assert.deepEqual(await readFile(`${path}-wal`), walBefore);
  db.exec('BEGIN');
  insert({ created_at_ms: start + 1, total_tokens: 20 });
  assert.equal((await read('/token-usage', query())).totals.total_tokens, 10);
  db.exec('COMMIT');
  assert.equal((await read('/token-usage', query())).totals.total_tokens, 30);
});

test('one read-only transaction provides a stable snapshot and closes after success', async (t) => {
  const { path, insert } = await createUsageDb(t, [{ created_at_ms: start, total_tokens: 10 }], { wal: true });
  const statements = [];
  let connection;
  let closeCalls = 0;
  const read = createUsageRangeReader({ sqliteDbPath: path }, {
    now: () => now,
    openDatabase: (dbPath, options) => {
      assert.equal(dbPath, path);
      assert.deepEqual(options, { readOnly: true });
      connection = new DatabaseSync(dbPath, options);
      return {
        exec: (sql) => { statements.push(sql); return connection.exec(sql); },
        prepare: (sql) => {
          const statement = connection.prepare(sql);
          if (sql.startsWith('SELECT MIN(created_at_ms)')) {
            return { get: () => { const result = statement.get(); insert({ created_at_ms: start + 1, total_tokens: 20 }); return result; } };
          }
          return statement;
        },
        close: () => { closeCalls++; connection.close(); },
      };
    },
  });
  assert.equal((await read('/token-usage', query())).totals.total_tokens, 10);
  assert.deepEqual(statements, ['PRAGMA busy_timeout = 1000', 'BEGIN', 'COMMIT']);
  assert.equal(closeCalls, 1);
  assert.equal(connection.isOpen, false);
  const after = createUsageRangeReader({ sqliteDbPath: path }, { now: () => now });
  assert.equal((await after('/token-usage', query())).totals.total_tokens, 30);
});

test('database path override precedes the lazily resolved environment and default path', async (t) => {
  const first = await createUsageDb(t, [{ created_at_ms: start, total_tokens: 10 }]);
  const second = await createUsageDb(t, [{ created_at_ms: start, total_tokens: 20 }]);
  const previous = process.env.COPILOT_API_SQLITE_DB_PATH;
  t.after(() => {
    if (previous === undefined) delete process.env.COPILOT_API_SQLITE_DB_PATH;
    else process.env.COPILOT_API_SQLITE_DB_PATH = previous;
  });
  const lazy = createUsageRangeReader({}, { now: () => now });
  process.env.COPILOT_API_SQLITE_DB_PATH = first.path;
  assert.equal((await lazy('/token-usage', query())).totals.total_tokens, 10);
  process.env.COPILOT_API_SQLITE_DB_PATH = second.path;
  assert.equal((await lazy('/token-usage', query())).totals.total_tokens, 20);
  const explicit = createUsageRangeReader({ sqliteDbPath: first.path }, { now: () => now });
  assert.equal((await explicit('/token-usage', query())).totals.total_tokens, 10);
  delete process.env.COPILOT_API_SQLITE_DB_PATH;
  let attemptedPath;
  const defaultPath = createUsageRangeReader({}, {
    now: () => now,
    openDatabase: (dbPath) => { attemptedPath = dbPath; throw new Error('injected unavailable'); },
  });
  await assert.rejects(defaultPath('/token-usage', query()), unavailable);
  assert.equal(attemptedPath, join(homedir(), '.local', 'share', 'copilot-api', 'copilot-api.sqlite'));
});
