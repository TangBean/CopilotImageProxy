import { createSessionTitleReader } from './session-titles.mjs';
import { createUsageHourlyReader, getUsagePeriod, parseRelativeDayPeriod, readUsageRange, resolveRelativeDayRange, UsageRangeError } from './usage-range.mjs';
import { readUsageResponse, UsageResponseError } from './usage-response.mjs';
import { rewriteUsageViewer, UsageViewerError } from './usage-viewer.mjs';

const rangePaths = new Set(['/token-usage', '/token-usage/daily', '/token-usage/events', '/token-usage/sessions']);
const scopeHeader = 'x-api-key-usage-isolated';
const scopePath = '/token-usage/events?period=today&page_size=1';

function usageHeaders(origin, preflight) {
  const headers = { vary: 'Origin', 'cache-control': 'no-store', 'access-control-expose-headers': scopeHeader };
  if (preflight) {
    headers['access-control-allow-methods'] = 'GET';
    headers['access-control-allow-headers'] = 'content-type, authorization, x-api-key';
  }
  try {
    const url = new URL(origin);
    if (url.origin === origin && ['http:', 'https:'].includes(url.protocol) &&
        ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
      headers['access-control-allow-origin'] = origin;
    }
  } catch { /* Missing or invalid origins get no cross-origin read permission. */ }
  return headers;
}

function jsonReply(status, headers, value) {
  return { status, headers: { ...headers, 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify(value) };
}

export function usageErrorReply(error, headers) {
  let detail;
  if (error instanceof UsageRangeError) detail = { type: error.type, message: error.message };
  else if (error instanceof UsageViewerError || error instanceof UsageResponseError) detail = { code: error.code, message: error.message };
  else return null;
  return { ...jsonReply(error.status, headers, { error: detail }), error: detail.type ?? detail.code };
}

function responseType(incoming) {
  return String(incoming.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
}

function isUncompressed(incoming) {
  const encoding = String(incoming.headers['content-encoding'] || '').trim().toLowerCase();
  return !encoding || encoding === 'identity';
}

async function viewerReply(incoming, headers, signal, config, relative) {
  if (incoming.statusCode < 200 || incoming.statusCode >= 300) return null;
  if (incoming.statusCode !== 200 || responseType(incoming) !== 'text/html' || !isUncompressed(incoming)) {
    if (relative) throw new UsageViewerError('Upstream usage viewer is incompatible: relative-day periods require an uncompressed 200 HTML response.');
    return null;
  }
  const chunks = [];
  for await (const chunk of incoming) chunks.push(chunk);
  signal.throwIfAborted();
  const body = rewriteUsageViewer(Buffer.concat(chunks), config);
  for (const name of ['content-length', 'content-encoding', 'content-md5', 'digest', 'content-digest', 'repr-digest', 'etag', 'last-modified']) delete headers[name];
  headers['content-length'] = String(body.length);
  return { status: 200, headers, body };
}

function localUsageRoute(read, headers, preflight) {
  if (preflight) return { reply: { status: 204, headers } };
  return {
    upstreamPath: scopePath, headers,
    async readResponse(incoming, relayHeaders, signal) {
      const isolation = incoming.headers[scopeHeader];
      if (isolation !== undefined) headers[scopeHeader] = isolation;
      if (incoming.statusCode < 200 || incoming.statusCode >= 300) {
        for (const name of Object.keys(relayHeaders)) if (name.startsWith('access-control-')) delete relayHeaders[name];
        Object.assign(relayHeaders, headers);
        return null;
      }
      if (isolation !== undefined && isolation !== 'false') {
        incoming.destroy();
        return usageErrorReply(new UsageRangeError(403, 'usage_scope_unavailable',
          'This dashboard feature uses local data and is unavailable for isolated API keys.'), headers);
      }
      if (incoming.statusCode !== 200 || !/(?:\/|\+)json$/.test(responseType(incoming)) || !isUncompressed(incoming)) {
        throw new UsageRangeError(502, 'usage_scope_unavailable', 'Expected an uncompressed 200 JSON Today usage response from upstream.');
      }
      const page = await readUsageResponse(incoming, { signal });
      if (page.period !== 'today' || !Array.isArray(page.items) ||
          !Number.isSafeInteger(page.range?.start_ms) || !Number.isSafeInteger(page.range?.end_ms)) {
        throw new UsageRangeError(502, 'usage_scope_unavailable', 'Upstream did not return a valid Today usage page.');
      }
      const usage = await read(page.range);
      signal.throwIfAborted();
      return jsonReply(200, headers, usage);
    },
  };
}

export function createUsageRouter(config) {
  const readTitles = createSessionTitleReader(config.sessionIndexPath);
  const readHourly = createUsageHourlyReader(config);
  return (req, path) => {
    const preflight = req.method === 'OPTIONS';
    const canRead = req.method === 'GET' || preflight;
    if (path === '/__session-titles') {
      return canRead ? localUsageRoute(readTitles, { 'cache-control': 'no-store' }, preflight) : null;
    }
    if (!rangePaths.has(path) && path !== '/token-usage/hourly' && path !== '/usage-viewer') return null;
    const params = new URL(req.url, 'http://localhost').searchParams;
    try {
      const period = getUsagePeriod(params);
      if (path === '/token-usage/hourly') {
        if (period !== null && period !== 'today') throw new UsageRangeError(400, 'invalid_request_error', 'Hourly usage supports period=today only.');
        if (!canRead) throw new UsageRangeError(405, 'invalid_request_error', 'Hourly usage supports GET only.');
        return localUsageRoute(readHourly, usageHeaders(req.headers.origin, preflight), preflight);
      }
      if (!canRead) {
        parseRelativeDayPeriod(period);
        return null;
      }
      const range = resolveRelativeDayRange(period, config.usageTimezone);
      if (path === '/usage-viewer') {
        return preflight ? null : { upstreamPath: req.url,
          readResponse: (incoming, headers, signal) => viewerReply(incoming, headers, signal, config, range !== null) };
      }
      if (range === null) return null;
      const read = () => readUsageRange(path, params, range, config.sqliteDbPath);
      return localUsageRoute(read, usageHeaders(req.headers.origin, preflight), preflight);
    } catch (error) {
      const reply = usageErrorReply(error, usageHeaders(req.headers.origin, false));
      if (!reply) throw error;
      return { reply };
    }
  };
}
