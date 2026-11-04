import { homedir } from 'node:os';
import { join } from 'node:path';

const DAY_MS = 86400000;
const MAX_RANGE_MS = 366 * DAY_MS;
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

function offsetMinutes(value) {
  if (value === 'Z') return 0;
  const match = /^([+-])(\d{2}):?(\d{2})$/.exec(value);
  if (!match || Number(match[2]) > 14 || Number(match[3]) > 59 ||
      (Number(match[2]) === 14 && Number(match[3]) !== 0)) {
    throw invalid('Timezone must be Z or a UTC offset between -14:00 and +14:00.');
  }
  return (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3]));
}

export function parseUsageTimestamp(value, timezone = '+08:00', name = 'timestamp') {
  const match = typeof value === 'string' && /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(Z|[+-]\d{4})?$/.exec(value);
  if (!match) throw invalid(`${name} must use YYYYMMDDHHmmss with optional Z or ±HHMM.`);
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day || date.getUTCHours() !== hour ||
      date.getUTCMinutes() !== minute || date.getUTCSeconds() !== second) {
    throw invalid(`${name} is not a valid calendar date and time.`);
  }
  return date.getTime() - offsetMinutes(match[7] ?? timezone) * 60000;
}

function validateRange(startMs, endMs) {
  if (startMs >= endMs) throw invalid('from must be earlier than to. The range is [from, to).');
  if (endMs - startMs > MAX_RANGE_MS) throw invalid('Custom usage ranges must not exceed 366 days.');
}

function createDailyIntervals(range, timezone) {
  const offsetMs = offsetMinutes(timezone) * 60000;
  const intervals = [];
  for (let cursor = Math.floor((range.startMs + offsetMs) / DAY_MS) * DAY_MS - offsetMs;
    cursor < range.endMs; cursor += DAY_MS) {
    const startMs = Math.max(cursor, range.startMs);
    const endMs = Math.min(cursor + DAY_MS, range.endMs);
    if (startMs < endMs) intervals.push({
      date: new Date(cursor + offsetMs).toISOString().slice(0, 10), startMs, endMs,
    });
  }
  return intervals;
}

export function createUsageRangeReader({ sqliteDbPath = null, usageTimezone = '+08:00' } = {}, { now = () => Date.now() } = {}) {
  return async (pathname, params) => {
    const endMs = params.has('to') ? parseUsageTimestamp(params.get('to'), usageTimezone, 'to') : now();
    const explicitStart = params.has('from') ? parseUsageTimestamp(params.get('from'), usageTimezone, 'from') : null;
    if (explicitStart !== null) validateRange(explicitStart, endMs);
    let db;
    try {
      const { DatabaseSync } = await import('node:sqlite');
      const dbPath = sqliteDbPath ?? process.env.COPILOT_API_SQLITE_DB_PATH ??
        join(homedir(), '.local', 'share', 'copilot-api', 'copilot-api.sqlite');
      db = new DatabaseSync(dbPath, { readOnly: true });
      db.exec('PRAGMA busy_timeout = 1000');
      db.exec('BEGIN');
      const columns = new Set(db.prepare('PRAGMA table_info(token_usage_events)').all().map((row) => row.name));
      if (requiredColumns.some((column) => !columns.has(column))) {
        throw new UsageRangeError(501, 'usage_range_unavailable',
          'Custom usage ranges require the token_usage_events schema from copilot-api v2.7.43.');
      }
      const dataStartMs = db.prepare('SELECT MIN(created_at_ms) AS start_ms FROM token_usage_events').get().start_ms;
      const startMs = explicitStart ?? dataStartMs ?? endMs;
      if (explicitStart !== null || dataStartMs !== null) validateRange(startMs, endMs);
      const range = { startMs, endMs };
      const base = { period: 'custom', range: rangePayload(range), data_start_ms: dataStartMs };
      if (pathname === '/token-usage/events' || pathname === '/token-usage/sessions') {
        return { ...base, ...getUsagePage(db, range, params, pathname.endsWith('/sessions')) };
      }
      const summary = {
        ...base, byModel: getModelSummaries(db, range),
        totals: totalsFromRow(getTotalsRow(db, range), getCostRows(db, range)),
      };
      if (pathname === '/token-usage/daily') {
        const intervals = createDailyIntervals(range, usageTimezone);
        const daily = getDailyModelSummaries(db, intervals);
        summary.days = intervals.map((interval) => createDailyBucket(interval, daily.get(interval.date) ?? []));
      }
      return summary;
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
function createEmptyTotals() {
  return {
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    costs: [],
    input_tokens: 0,
    output_tokens: 0,
    request_count: 0,
    total_nano_aiu: null,
    total_tokens: 0
  };
}
function addTotals(target, next) {
  target.cache_creation_input_tokens += next.cache_creation_input_tokens;
  target.cache_read_input_tokens += next.cache_read_input_tokens;
  target.costs = mergeCosts(target.costs, next.costs);
  target.input_tokens += next.input_tokens;
  target.output_tokens += next.output_tokens;
  target.request_count += next.request_count;
  target.total_nano_aiu = addNullableNumbers(target.total_nano_aiu, next.total_nano_aiu);
  target.total_tokens += next.total_tokens;
}
function addNullableNumbers(current, next) {
  if (current === null) return next;
  if (next === null) return current;
  return current + next;
}
function mergeCosts(current, next) {
  const byCurrency = new Map();
  for (const cost of [...current, ...next]) byCurrency.set(cost.currency, (byCurrency.get(cost.currency) ?? 0) + cost.total_cost_nanos);
  return [...byCurrency.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([currency, totalCostNanos]) => createCost(currency, totalCostNanos));
}

function rangePayload(range) {
  return {
    end_ms: range.endMs,
    end_utc: new Date(range.endMs).toISOString(),
    start_ms: range.startMs,
    start_utc: new Date(range.startMs).toISOString()
  };
}
function numberFromRow(row, key) {
  const value = row?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
function nullableNumberFromRow(row, key) {
  const value = row?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function createCost(currency, totalCostNanos) {
  return {
    amount: totalCostNanos / COST_NANOS_PER_UNIT,
    currency,
    total_cost_nanos: totalCostNanos
  };
}
function costFromRow(row) {
  const currency = row.cost_currency;
  const totalCostNanos = row.total_cost_nanos;
  if (typeof currency !== "string" || !currency || typeof totalCostNanos !== "number" || !Number.isFinite(totalCostNanos)) return null;
  return createCost(currency, totalCostNanos);
}
function eventCostFromRow(row) {
  const cost = costFromRow(row);
  const source = row.cost_source;
  if (!cost || typeof source !== "string" || !source) return null;
  return {
    ...cost,
    source
  };
}
function totalsFromRow(row, costs = []) {
  return {
    cache_creation_input_tokens: numberFromRow(row, "cache_creation_input_tokens"),
    cache_read_input_tokens: numberFromRow(row, "cache_read_input_tokens"),
    costs,
    input_tokens: numberFromRow(row, "input_tokens"),
    output_tokens: numberFromRow(row, "output_tokens"),
    request_count: numberFromRow(row, "request_count"),
    total_nano_aiu: nullableNumberFromRow(row, "total_nano_aiu"),
    total_tokens: numberFromRow(row, "total_tokens")
  };
}
function modelSummaryFromRow(row, costs = []) {
  return {
    ...totalsFromRow(row, costs),
    average_first_token_ms: nullableNumberFromRow(row, "average_first_token_ms"),
    output_tokens_per_second: nullableNumberFromRow(row, "output_tokens_per_second"),
    model: typeof row.model === "string" ? row.model : "unknown"
  };
}
function stringFromRow(row, key) {
  const value = row[key];
  return typeof value === "string" ? value : "";
}
function nullableStringFromRow(row, key) {
  const value = row[key];
  return typeof value === "string" ? value : null;
}
function outputTokensPerSecond(row) {
  const first = nullableNumberFromRow(row, "first_token_ms");
  const duration = nullableNumberFromRow(row, "duration_ms");
  const output = numberFromRow(row, "output_tokens");
  if (row.request_outcome !== "completed" || row.usage_event_count !== 1 || first === null || first < 0 || duration === null || duration <= first || output <= 0) return null;
  const rate = output * 1e3 / (duration - first);
  return Number.isFinite(rate) ? rate : null;
}
function usageEventFromRow(row) {
  return {
    request_id: nullableStringFromRow(row, "request_id"),
    first_token_ms: nullableNumberFromRow(row, "first_token_ms"),
    duration_ms: nullableNumberFromRow(row, "duration_ms"),
    request_outcome: nullableStringFromRow(row, "request_outcome"),
    output_tokens_per_second: outputTokensPerSecond(row),
    cache_creation_input_tokens: numberFromRow(row, "cache_creation_input_tokens"),
    cache_read_input_tokens: numberFromRow(row, "cache_read_input_tokens"),
    cost: eventCostFromRow(row),
    created_at_ms: numberFromRow(row, "created_at_ms"),
    created_at_utc: stringFromRow(row, "created_at_utc"),
    endpoint: stringFromRow(row, "endpoint"),
    id: numberFromRow(row, "id"),
    input_tokens: numberFromRow(row, "input_tokens"),
    model: stringFromRow(row, "model") || "unknown",
    output_tokens: numberFromRow(row, "output_tokens"),
    provider_name: nullableStringFromRow(row, "provider_name"),
    session_id: stringFromRow(row, "session_id"),
    source: stringFromRow(row, "source"),
    total_nano_aiu: nullableNumberFromRow(row, "total_nano_aiu"),
    total_tokens: numberFromRow(row, "total_tokens"),
    trace_id: stringFromRow(row, "trace_id"),
    user_id: stringFromRow(row, "user_id"),
    user_agent: stringFromRow(row, "user_agent")
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
    ORDER BY
      total_tokens DESC,
      model ASC
  `).all(range.startMs, range.endMs);
}
function getCostRows(db, range) {
  return db.prepare(`
    SELECT
      cost_currency,
      COALESCE(SUM(total_cost_nanos), 0) AS total_cost_nanos
    FROM token_usage_events
    WHERE
      created_at_ms >= ?
      AND created_at_ms < ?
      AND cost_currency IS NOT NULL
      AND total_cost_nanos IS NOT NULL
    GROUP BY cost_currency
    ORDER BY cost_currency ASC
  `).all(range.startMs, range.endMs).flatMap((row) => {
    const cost = costFromRow(row);
    return cost ? [cost] : [];
  });
}
function getModelCostMap(db, range) {
  const rows = db.prepare(`
    SELECT
      model,
      cost_currency,
      COALESCE(SUM(total_cost_nanos), 0) AS total_cost_nanos
    FROM token_usage_events
    WHERE
      created_at_ms >= ?
      AND created_at_ms < ?
      AND cost_currency IS NOT NULL
      AND total_cost_nanos IS NOT NULL
    GROUP BY model, cost_currency
    ORDER BY model ASC, cost_currency ASC
  `).all(range.startMs, range.endMs);
  const costMap = new Map();
  for (const row of rows) {
    const model = stringFromRow(row, "model") || "unknown";
    const cost = costFromRow(row);
    if (!cost) continue;
    costMap.set(model, [...costMap.get(model) ?? [], cost]);
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
  const sessionIds = rows.map((row) => stringFromRow(row, "session_id"));
  const costRows = db.prepare(`
    SELECT
      session_id,
      cost_currency,
      COALESCE(SUM(total_cost_nanos), 0) AS total_cost_nanos
    FROM token_usage_events
    WHERE
      created_at_ms >= ?
      AND created_at_ms < ?
      AND session_id IN (${sessionIds.map(() => "?").join(", ")})
      AND cost_currency IS NOT NULL
      AND total_cost_nanos IS NOT NULL
    GROUP BY session_id, cost_currency
    ORDER BY session_id ASC, cost_currency ASC
  `).all(range.startMs, range.endMs, ...sessionIds);
  const costMap = new Map();
  for (const row of costRows) {
    const cost = costFromRow(row);
    if (cost) {
      const id = stringFromRow(row, "session_id");
      costMap.set(id, [...costMap.get(id) ?? [], cost]);
    }
  }
  return rows.map((row) => {
    const session_id = stringFromRow(row, "session_id");
    return {
      ...totalsFromRow(row, costMap.get(session_id) ?? []),
      session_id
    };
  });
}
function getModelTimingRows(db, intervals) {
  if (intervals.length === 0) return [];
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
    ), buckets(usage_date, start_ms, end_ms) AS (VALUES ${intervals.map(() => "(?, ?, ?)").join(", ")})
    SELECT buckets.usage_date, model,
      AVG(first_token_ms) AS average_first_token_ms,
      1000.0 * SUM(CASE WHEN duration_ms > first_token_ms AND output_tokens > 0 THEN output_tokens END)
        / SUM(CASE WHEN duration_ms > first_token_ms AND output_tokens > 0 THEN duration_ms - first_token_ms END)
        AS output_tokens_per_second
    FROM requests JOIN buckets
      ON first_usage_at_ms >= start_ms AND last_usage_at_ms < end_ms
    GROUP BY buckets.usage_date, model
  `).all(intervals[0].startMs, intervals[intervals.length - 1].endMs, ...intervals.flatMap(({ date, startMs, endMs }) => [
    date,
    startMs,
    endMs
  ]));
}
function getModelSummaries(db, range) {
  const costMap = getModelCostMap(db, range);
  const timings = new Map(getModelTimingRows(db, [{
    date: "",
    ...range
  }]).map((row) => [stringFromRow(row, "model"), row]));
  return getModelRows(db, range).map((row) => {
    const model = stringFromRow(row, "model") || "unknown";
    return modelSummaryFromRow({
      ...row,
      ...timings.get(model)
    }, costMap.get(model) ?? []);
  });
}
function getDailyModelSummaries(db, intervals) {
  if (intervals.length === 0) return new Map();
  const usageDays = `usage_days(usage_date, day_start_ms, day_end_ms) AS (VALUES ${intervals.map(() => "(?, ?, ?)").join(", ")})`;
  const dayParams = intervals.flatMap((interval) => [
    interval.date,
    interval.startMs,
    interval.endMs
  ]);
  const rows = db.prepare(`
    WITH ${usageDays}
    SELECT
      usage_days.usage_date AS usage_date,
      model,
      COUNT(*) AS request_count,
      COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(cache_read_input_tokens), 0) AS cache_read_input_tokens,
      COALESCE(SUM(cache_creation_input_tokens), 0) AS cache_creation_input_tokens,
      SUM(total_nano_aiu) AS total_nano_aiu,
      COALESCE(SUM(total_tokens), 0) AS total_tokens
    FROM usage_days
    JOIN token_usage_events
      ON created_at_ms >= usage_days.day_start_ms
      AND created_at_ms < usage_days.day_end_ms
    GROUP BY usage_days.usage_date, model
    ORDER BY usage_days.usage_date ASC, total_tokens DESC, model ASC
  `).all(...dayParams);
  const costRows = db.prepare(`
    WITH ${usageDays}
    SELECT
      usage_days.usage_date AS usage_date,
      model,
      cost_currency,
      COALESCE(SUM(total_cost_nanos), 0) AS total_cost_nanos
    FROM usage_days
    JOIN token_usage_events
      ON created_at_ms >= usage_days.day_start_ms
      AND created_at_ms < usage_days.day_end_ms
    WHERE cost_currency IS NOT NULL
      AND total_cost_nanos IS NOT NULL
    GROUP BY usage_days.usage_date, model, cost_currency
    ORDER BY usage_days.usage_date ASC, model ASC, cost_currency ASC
  `).all(...dayParams);
  const costsByDateAndModel = new Map();
  for (const row of costRows) {
    const date = stringFromRow(row, "usage_date");
    const model = stringFromRow(row, "model") || "unknown";
    const cost = costFromRow(row);
    if (!date || !cost) continue;
    const key = `${date}\u0000${model}`;
    costsByDateAndModel.set(key, [...costsByDateAndModel.get(key) ?? [], cost]);
  }
  const timings = new Map(getModelTimingRows(db, intervals).map((row) => [`${stringFromRow(row, "usage_date")}\u0000${stringFromRow(row, "model")}`, row]));
  const summariesByDate = new Map();
  for (const row of rows) {
    const date = stringFromRow(row, "usage_date");
    if (!date) continue;
    const model = stringFromRow(row, "model") || "unknown";
    const summaries = summariesByDate.get(date) ?? [];
    summaries.push(modelSummaryFromRow({
      ...row,
      ...timings.get(`${date}\u0000${model}`)
    }, costsByDateAndModel.get(`${date}\u0000${model}`) ?? []));
    summariesByDate.set(date, summaries);
  }
  return summariesByDate;
}
function createDailyBucket(interval, byModel) {
  const totals = createEmptyTotals();
  for (const model of byModel) addTotals(totals, model);
  return {
    byModel,
    date: interval.date,
    end_ms: interval.endMs,
    start_ms: interval.startMs,
    totals
  };
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
