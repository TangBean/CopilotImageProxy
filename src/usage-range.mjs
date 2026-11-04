import { homedir } from 'node:os';
import { join } from 'node:path';

const DAY_MS = 86400000;
const COST_NANOS_PER_UNIT = 1e9;
const requiredColumns = [
  'id', 'created_at_ms', 'created_at_utc', 'trace_id', 'session_id', 'user_id', 'user_agent',
  'source', 'endpoint', 'provider_name', 'model', 'input_tokens', 'output_tokens',
  'cache_read_input_tokens', 'cache_creation_input_tokens', 'total_tokens', 'total_nano_aiu',
  'cost_currency', 'total_cost_nanos', 'cost_source', 'request_id', 'first_token_ms',
  'duration_ms', 'request_outcome',
];

export class UsageRangeError extends Error {
  constructor(status, type, message) {
    super(message);
    this.name = 'UsageRangeError';
    Object.assign(this, { status, type });
  }
}

function invalid(message) {
  return new UsageRangeError(400, 'invalid_request_error', message);
}

export function parseRelativeDayPeriod(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw invalid('period must be a named period or -1day through -10day.');
  const match = /^-([1-9]|10)[ _]?day$/i.exec(value);
  if (match?.[0] === value) return `-${match[1]}day`;
  if (/^\s*-/.test(value)) throw invalid('Relative-day period must be -1day through -10day, with one optional space or underscore before day.');
  return null;
}

function offsetMinutes(value) {
  if (value === 'Z') return 0;
  const match = typeof value === 'string' && /^([+-])(\d{2}):?(\d{2})$/.exec(value);
  if (!match || match[0] !== value || Number(match[2]) > 14 || Number(match[3]) > 59 ||
      (Number(match[2]) === 14 && Number(match[3]) !== 0)) {
    throw invalid('Timezone must be Z or a UTC offset between -14:00 and +14:00.');
  }
  return (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3]));
}

export function createRelativeDayRange(period, timezone = '+08:00', now = Date.now()) {
  const canonical = parseRelativeDayPeriod(period);
  if (canonical === null) throw invalid('A relative-day period between -1day and -10day is required.');
  const offsetMs = offsetMinutes(timezone) * 60000;
  if (!Number.isFinite(now) || !Number.isFinite(new Date(now).getTime())) throw invalid('Current time is invalid.');
  const days = Number(canonical.slice(1, -3));
  const startMs = Math.floor((now + offsetMs) / DAY_MS) * DAY_MS - offsetMs - days * DAY_MS;
  const endMs = startMs + DAY_MS;
  const date = new Date(startMs + offsetMs).toISOString().slice(0, 10);
  return { startMs, endMs, date, displayLabel: `${date} (-${days} Day)` };
}

async function openUsageDatabase(path, options) {
  const { DatabaseSync } = await import('node:sqlite');
  return new DatabaseSync(path, options);
}

export function createUsageRangeReader({ sqliteDbPath = null, usageTimezone = '+08:00' } = {}, {
  now = () => Date.now(), openDatabase = openUsageDatabase,
} = {}) {
  return async (pathname, params) => {
    if (params.has('from') || params.has('to')) throw invalid('from and to are not supported. Use period=-1day through period=-10day.');
    if (params.getAll('period').length > 1) throw invalid('period must be specified at most once.');
    const period = parseRelativeDayPeriod(params.get('period'));
    if (period === null) return null;
    const range = createRelativeDayRange(period, usageTimezone, now());
    let db;
    try {
      const dbPath = sqliteDbPath ?? process.env.COPILOT_API_SQLITE_DB_PATH ??
        join(homedir(), '.local', 'share', 'copilot-api', 'copilot-api.sqlite');
      db = await openDatabase(dbPath, { readOnly: true });
      db.exec('PRAGMA busy_timeout = 1000');
      db.exec('BEGIN');
      const columns = new Set(db.prepare('PRAGMA table_info(token_usage_events)').all().map((row) => row.name));
      if (requiredColumns.some((column) => !columns.has(column))) {
        throw new UsageRangeError(501, 'usage_range_unavailable',
          'Relative-day usage requires a compatible token_usage_events schema.');
      }
      const dataStartMs = db.prepare('SELECT MIN(created_at_ms) AS start_ms FROM token_usage_events').get().start_ms;
      const base = { period: 'custom', range: rangePayload(range), data_start_ms: dataStartMs };
      let result;
      if (pathname === '/token-usage/events' || pathname === '/token-usage/sessions') {
        result = { ...base, ...getUsagePage(db, range, params, pathname.endsWith('/sessions')) };
      } else {
        result = {
          ...base, byModel: getModelSummaries(db, range),
          totals: totalsFromRow(getTotalsRow(db, range), getCostRows(db, range)),
        };
        if (pathname === '/token-usage/daily') {
          result.days = [{
            date: range.date, start_ms: range.startMs, end_ms: range.endMs,
            byModel: result.byModel, totals: result.totals,
          }];
        }
      }
      db.exec('COMMIT');
      return result;
    } catch (error) {
      if (error instanceof UsageRangeError) throw error;
      throw new UsageRangeError(501, 'usage_range_unavailable',
        'Cannot read the usage SQLite database. Check sqliteDbPath, database availability and schema.');
    } finally {
      db?.close();
    }
  };
}

// Query and result semantics follow @jeffreycao/copilot-api v2.7.43 token-usage/store.ts.
function rangePayload(range) {
  return {
    end_ms: range.endMs,
    end_utc: new Date(range.endMs).toISOString(),
    start_ms: range.startMs,
    start_utc: new Date(range.startMs).toISOString(),
    display_label: range.displayLabel,
  };
}
function numberFromRow(row, key) {
  const value = row?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
function nullableNumberFromRow(row, key) {
  const value = row?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
function createCost(currency, totalCostNanos) {
  return {
    amount: totalCostNanos / COST_NANOS_PER_UNIT,
    currency,
    total_cost_nanos: totalCostNanos,
  };
}
function costFromRow(row) {
  const currency = row.cost_currency;
  const totalCostNanos = row.total_cost_nanos;
  if (typeof currency !== 'string' || !currency || typeof totalCostNanos !== 'number' || !Number.isFinite(totalCostNanos)) return null;
  return createCost(currency, totalCostNanos);
}
function eventCostFromRow(row) {
  const cost = costFromRow(row);
  const source = row.cost_source;
  if (!cost || typeof source !== 'string' || !source) return null;
  return { ...cost, source };
}
function totalsFromRow(row, costs = []) {
  return {
    cache_creation_input_tokens: numberFromRow(row, 'cache_creation_input_tokens'),
    cache_read_input_tokens: numberFromRow(row, 'cache_read_input_tokens'),
    costs,
    input_tokens: numberFromRow(row, 'input_tokens'),
    output_tokens: numberFromRow(row, 'output_tokens'),
    request_count: numberFromRow(row, 'request_count'),
    total_nano_aiu: nullableNumberFromRow(row, 'total_nano_aiu'),
    total_tokens: numberFromRow(row, 'total_tokens'),
  };
}
function modelSummaryFromRow(row, costs = []) {
  return {
    ...totalsFromRow(row, costs),
    average_first_token_ms: nullableNumberFromRow(row, 'average_first_token_ms'),
    output_tokens_per_second: nullableNumberFromRow(row, 'output_tokens_per_second'),
    model: typeof row.model === 'string' ? row.model : 'unknown',
  };
}
function stringFromRow(row, key) {
  const value = row[key];
  return typeof value === 'string' ? value : '';
}
function nullableStringFromRow(row, key) {
  const value = row[key];
  return typeof value === 'string' ? value : null;
}
function outputTokensPerSecond(row) {
  const first = nullableNumberFromRow(row, 'first_token_ms');
  const duration = nullableNumberFromRow(row, 'duration_ms');
  const output = numberFromRow(row, 'output_tokens');
  if (row.request_outcome !== 'completed' || row.usage_event_count !== 1 || first === null || first < 0 || duration === null || duration <= first || output <= 0) return null;
  const rate = output * 1e3 / (duration - first);
  return Number.isFinite(rate) ? rate : null;
}
function usageEventFromRow(row) {
  return {
    request_id: nullableStringFromRow(row, 'request_id'),
    first_token_ms: nullableNumberFromRow(row, 'first_token_ms'),
    duration_ms: nullableNumberFromRow(row, 'duration_ms'),
    request_outcome: nullableStringFromRow(row, 'request_outcome'),
    output_tokens_per_second: outputTokensPerSecond(row),
    cache_creation_input_tokens: numberFromRow(row, 'cache_creation_input_tokens'),
    cache_read_input_tokens: numberFromRow(row, 'cache_read_input_tokens'),
    cost: eventCostFromRow(row),
    created_at_ms: numberFromRow(row, 'created_at_ms'),
    created_at_utc: stringFromRow(row, 'created_at_utc'),
    endpoint: stringFromRow(row, 'endpoint'),
    id: numberFromRow(row, 'id'),
    input_tokens: numberFromRow(row, 'input_tokens'),
    model: stringFromRow(row, 'model') || 'unknown',
    output_tokens: numberFromRow(row, 'output_tokens'),
    provider_name: nullableStringFromRow(row, 'provider_name'),
    session_id: stringFromRow(row, 'session_id'),
    source: stringFromRow(row, 'source'),
    total_nano_aiu: nullableNumberFromRow(row, 'total_nano_aiu'),
    total_tokens: numberFromRow(row, 'total_tokens'),
    trace_id: stringFromRow(row, 'trace_id'),
    user_id: stringFromRow(row, 'user_id'),
    user_agent: stringFromRow(row, 'user_agent'),
  };
}
function getTotalsRow(db, range) {
  return db.prepare(`
    SELECT
      COUNT(*) AS request_count,
      COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(cache_read_input_tokens), 0) AS cache_read_input_tokens,
      COALESCE(SUM(cache_creation_input_tokens), 0) AS cache_creation_input_tokens,
      SUM(total_nano_aiu) AS total_nano_aiu,
      COALESCE(SUM(total_tokens), 0) AS total_tokens
    FROM token_usage_events
    WHERE created_at_ms >= ? AND created_at_ms < ?
  `).get(range.startMs, range.endMs);
}
function getModelRows(db, range) {
  return db.prepare(`
    SELECT
      model,
      COUNT(*) AS request_count,
      COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(cache_read_input_tokens), 0) AS cache_read_input_tokens,
      COALESCE(SUM(cache_creation_input_tokens), 0) AS cache_creation_input_tokens,
      SUM(total_nano_aiu) AS total_nano_aiu,
      COALESCE(SUM(total_tokens), 0) AS total_tokens
    FROM token_usage_events
    WHERE created_at_ms >= ? AND created_at_ms < ?
    GROUP BY model
    ORDER BY total_tokens DESC, model ASC
  `).all(range.startMs, range.endMs);
}
function getCostRows(db, range) {
  return db.prepare(`
    SELECT cost_currency, COALESCE(SUM(total_cost_nanos), 0) AS total_cost_nanos
    FROM token_usage_events
    WHERE created_at_ms >= ? AND created_at_ms < ?
      AND cost_currency IS NOT NULL AND total_cost_nanos IS NOT NULL
    GROUP BY cost_currency
    ORDER BY cost_currency ASC
  `).all(range.startMs, range.endMs).flatMap((row) => {
    const cost = costFromRow(row);
    return cost ? [cost] : [];
  });
}
function getModelCostMap(db, range) {
  const rows = db.prepare(`
    SELECT model, cost_currency, COALESCE(SUM(total_cost_nanos), 0) AS total_cost_nanos
    FROM token_usage_events
    WHERE created_at_ms >= ? AND created_at_ms < ?
      AND cost_currency IS NOT NULL AND total_cost_nanos IS NOT NULL
    GROUP BY model, cost_currency
    ORDER BY model ASC, cost_currency ASC
  `).all(range.startMs, range.endMs);
  const costMap = new Map();
  for (const row of rows) {
    const model = stringFromRow(row, 'model') || 'unknown';
    const cost = costFromRow(row);
    if (cost) costMap.set(model, [...costMap.get(model) ?? [], cost]);
  }
  return costMap;
}
function getSessionSummaries(db, range, limit, offset) {
  const rows = db.prepare(`
    SELECT
      session_id,
      COUNT(*) AS request_count,
      COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(cache_read_input_tokens), 0) AS cache_read_input_tokens,
      COALESCE(SUM(cache_creation_input_tokens), 0) AS cache_creation_input_tokens,
      SUM(total_nano_aiu) AS total_nano_aiu,
      COALESCE(SUM(total_tokens), 0) AS total_tokens
    FROM token_usage_events
    WHERE created_at_ms >= ? AND created_at_ms < ?
    GROUP BY session_id
    ORDER BY total_tokens DESC, session_id ASC
    LIMIT ? OFFSET ?
  `).all(range.startMs, range.endMs, limit, offset);
  const sessionIds = rows.map((row) => stringFromRow(row, 'session_id'));
  const costRows = db.prepare(`
    SELECT session_id, cost_currency, COALESCE(SUM(total_cost_nanos), 0) AS total_cost_nanos
    FROM token_usage_events
    WHERE created_at_ms >= ? AND created_at_ms < ?
      AND session_id IN (${sessionIds.map(() => '?').join(', ')})
      AND cost_currency IS NOT NULL AND total_cost_nanos IS NOT NULL
    GROUP BY session_id, cost_currency
    ORDER BY session_id ASC, cost_currency ASC
  `).all(range.startMs, range.endMs, ...sessionIds);
  const costMap = new Map();
  for (const row of costRows) {
    const cost = costFromRow(row);
    if (cost) {
      const id = stringFromRow(row, 'session_id');
      costMap.set(id, [...costMap.get(id) ?? [], cost]);
    }
  }
  return rows.map((row) => {
    const session_id = stringFromRow(row, 'session_id');
    return { ...totalsFromRow(row, costMap.get(session_id) ?? []), session_id };
  });
}
function getModelTimingRows(db, range) {
  return db.prepare(`
    WITH selected_requests AS (
      SELECT DISTINCT request_id FROM token_usage_events
      WHERE created_at_ms >= ? AND created_at_ms < ? AND request_id IS NOT NULL
    ), requests AS (
      SELECT e.request_id, MIN(e.model) AS model,
        MIN(e.created_at_ms) AS first_usage_at_ms,
        MAX(e.created_at_ms) AS last_usage_at_ms,
        SUM(e.output_tokens) AS output_tokens,
        MAX(e.first_token_ms) AS first_token_ms,
        MAX(e.duration_ms) AS duration_ms
      FROM selected_requests r JOIN token_usage_events e USING (request_id)
      GROUP BY e.request_id
      HAVING COUNT(DISTINCT e.model) = 1
        AND COUNT(e.first_token_ms) = COUNT(*)
        AND COUNT(e.duration_ms) = COUNT(*)
        AND COUNT(e.request_outcome) = COUNT(*)
        AND MIN(e.request_outcome) = 'completed'
        AND MAX(e.request_outcome) = 'completed'
        AND MIN(e.first_token_ms) >= 0
        AND MIN(e.duration_ms) >= MAX(e.first_token_ms)
    )
    SELECT model, AVG(first_token_ms) AS average_first_token_ms,
      1000.0 * SUM(CASE WHEN duration_ms > first_token_ms AND output_tokens > 0 THEN output_tokens END)
        / SUM(CASE WHEN duration_ms > first_token_ms AND output_tokens > 0 THEN duration_ms - first_token_ms END)
        AS output_tokens_per_second
    FROM requests
    WHERE first_usage_at_ms >= ? AND last_usage_at_ms < ?
    GROUP BY model
  `).all(range.startMs, range.endMs, range.startMs, range.endMs);
}
function getModelSummaries(db, range) {
  const costMap = getModelCostMap(db, range);
  const timings = new Map(getModelTimingRows(db, range).map((row) => [stringFromRow(row, 'model'), row]));
  return getModelRows(db, range).map((row) => {
    const model = stringFromRow(row, 'model') || 'unknown';
    return modelSummaryFromRow({ ...row, ...timings.get(model) }, costMap.get(model) ?? []);
  });
}
function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
function getUsagePage(db, range, params, sessions) {
  const page = parsePositiveInt(params.get('page'), 1);
  const pageSize = Math.min(100, parsePositiveInt(params.get('page_size'), 20));
  const total = db.prepare(`
    SELECT ${sessions ? 'COUNT(DISTINCT session_id)' : 'COUNT(*)'} AS total
    FROM token_usage_events WHERE created_at_ms >= ? AND created_at_ms < ?
  `).get(range.startMs, range.endMs).total;
  const offset = (page - 1) * pageSize;
  let items = [];
  if (offset < total) {
    items = sessions ? getSessionSummaries(db, range, pageSize, offset) : db.prepare(`
      SELECT id, created_at_ms, created_at_utc, trace_id, session_id, user_id, source,
        endpoint, provider_name, model, input_tokens, output_tokens,
        cache_read_input_tokens, cache_creation_input_tokens, total_nano_aiu, total_tokens,
        cost_currency, total_cost_nanos, cost_source, request_id, first_token_ms,
        duration_ms, request_outcome, user_agent,
        (SELECT COUNT(*) FROM token_usage_events sibling
          WHERE sibling.request_id = token_usage_events.request_id) AS usage_event_count
      FROM token_usage_events
      WHERE created_at_ms >= ? AND created_at_ms < ?
      ORDER BY created_at_ms DESC, id DESC
      LIMIT ? OFFSET ?
    `).all(range.startMs, range.endMs, pageSize, offset).map(usageEventFromRow);
  }
  return { items, page, page_size: pageSize, total, total_pages: Math.max(1, Math.ceil(total / pageSize)) };
}
