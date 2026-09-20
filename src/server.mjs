import http from 'node:http';
import https from 'node:https';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { zstdDecompress, gunzip, inflate } from 'node:zlib';
import { createBodyTransformer, BodyTransformError } from './body-transformer.mjs';
import { validateConfig } from './config.mjs';
import { VERSION } from './version.mjs';

const decompressors = { zstd: promisify(zstdDecompress), gzip: promisify(gunzip), deflate: promisify(inflate) };
const transformedRoutes = new Set(['/responses', '/responses/compact', '/v1/responses', '/v1/responses/compact']);
const imageMarker = Buffer.from('input_image');
const unicodeEscapeMarker = Buffer.from([0x5c, 0x75]);
const hopHeaders = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'proxy-connection']);

class ProxyError extends Error {
  constructor(status, code, message, details = {}) {
    super(message); Object.assign(this, { status, code, details });
  }
}

function headersWithoutHopByHop(headers) {
  const excluded = new Set(hopHeaders);
  for (const name of String(headers.connection || '').split(',')) excluded.add(name.trim().toLowerCase());
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !excluded.has(name.toLowerCase())));
}

function readBody(req, limit, signal) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    const cleanup = () => {
      req.off('data', data); req.off('end', end); req.off('error', error);
      signal.removeEventListener('abort', abort);
    };
    const fail = (err) => { cleanup(); req.resume(); reject(err); };
    const data = (chunk) => {
      size += chunk.length;
      if (size > limit) fail(new ProxyError(413, 'proxy_input_limit_exceeded',
        '入站请求超过本地上限，请调整 maxInputMiB 或减少图片。', { bytes: size, limitBytes: limit }));
      else chunks.push(chunk);
    };
    const end = () => { cleanup(); resolve(Buffer.concat(chunks, size)); };
    const error = () => fail(new ProxyError(400, 'proxy_incomplete_request', '请求上传未完成。'));
    const abort = () => fail(signal.reason);
    if (signal.aborted) return reject(signal.reason);
    req.on('data', data); req.once('end', end); req.once('error', error);
    signal.addEventListener('abort', abort, { once: true });
  });
}

async function decodeBody(raw, encoding, limit) {
  if (!encoding || encoding === 'identity') return raw;
  const decode = decompressors[encoding];
  if (!decode) throw new ProxyError(415, 'proxy_unsupported_content_encoding', '仅支持 identity、zstd、gzip 和 deflate 请求编码。');
  try { return await decode(raw, { maxOutputLength: limit }); }
  catch (error) {
    if (error.code === 'ERR_BUFFER_TOO_LARGE') throw new ProxyError(413, 'proxy_input_limit_exceeded',
      '解压后请求超过本地上限，请调整 maxInputMiB 或减少图片。', { limitBytes: limit });
    throw new ProxyError(400, 'proxy_invalid_compressed_body', '无法解压请求体。');
  }
}

export function createProxyServer({ config: overrides = {}, log = () => {}, managedUpstream = false, useWorker = true } = {}) {
  const config = validateConfig(overrides, { managedUpstream });
  const upstreamBase = new URL(config.upstream);
  const transformer = createBodyTransformer({ config, useWorker });
  const agents = { 'http:': new http.Agent({ keepAlive: true }), 'https:': new https.Agent({ keepAlive: true }) };
  const safeLog = (entry) => { try { log(entry); } catch { /* logging must not interrupt requests */ } };

  const server = http.createServer(async (req, res) => {
    const started = performance.now();
    const requestId = randomUUID();
    const controller = new AbortController();
    const { signal } = controller;
    let upstreamRequest; let upstreamResponse;
    const metrics = { requestId, method: req.method, upstreamRequests: 0 };
    let logged = false;
    const finishLog = () => {
      if (logged) return; logged = true;
      safeLog({ event: 'request', ...metrics, status: res.headersSent ? res.statusCode : null,
        aborted: signal.aborted, durationMs: Math.round(performance.now() - started) });
    };
    const abort = () => {
      metrics.abortSource ||= 'client';
      if (!signal.aborted) controller.abort(new DOMException('Request disconnected', 'AbortError'));
      upstreamRequest?.destroy(); upstreamResponse?.destroy();
    };
    const upstreamStreamFailed = (code) => {
      // Destroying the upstream after a client disconnect also emits aborted/error.
      // Record the first observed cause, not the cleanup events that follow it.
      if (signal.aborted || res.destroyed) return;
      metrics.abortSource ||= 'upstream';
      metrics.error ||= code;
      res.destroy();
    };
    req.once('aborted', abort);
    res.once('close', () => { if (!res.writableFinished) abort(); finishLog(); });
    res.once('finish', finishLog);
    try {
      if (!req.url?.startsWith('/')) throw new ProxyError(400, 'proxy_invalid_target', '请求路径必须使用 origin form。');
      const route = req.url.split('?')[0];
      metrics.route = transformedRoutes.has(route) || route === '/healthz' ? route : 'passthrough';
      if (req.method === 'GET' && route === '/healthz') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ service: 'copilot-image-proxy', status: 'ok', pid: process.pid, version: VERSION }));
        return;
      }
      let body;
      const headers = headersWithoutHopByHop(req.headers);
      delete headers.host;
      if (req.method === 'POST' && transformedRoutes.has(route)) {
        const inputLimit = Math.floor(config.maxInputMiB * 1048576);
        const raw = await readBody(req, inputLimit, signal);
        metrics.inputBytes = raw.length;
        const decoded = await decodeBody(raw, String(req.headers['content-encoding'] || '').trim().toLowerCase(), inputLimit);
        signal.throwIfAborted();
        metrics.decodedInputBytes = decoded.length;
        // A JSON string can spell input_image literally or with Unicode escapes.
        // Any \\u falls back to parsing; whitespace and nesting do not affect the
        // negative proof. Image-free malformed JSON is validated by upstream.
        metrics.imageFastPath = !decoded.includes(imageMarker) && !decoded.includes(unicodeEscapeMarker);
        body = decoded;
        if (!metrics.imageFastPath) {
          const transformed = await transformer.transform(decoded, { signal });
          signal.throwIfAborted();
          metrics.images = transformed.stats;
          body = transformed.body;
        }
        metrics.outputBytes = body.length;
        const outputLimit = Math.floor(config.maxOutputMiB * 1048576);
        if (body.length > outputLimit) throw new ProxyError(413, 'proxy_payload_budget_exceeded',
          `压缩后完整请求为 ${body.length} 字节，超过本地预算 ${outputLimit} 字节。请提前压缩上下文，或调整 maxEdge、jpegQuality、maxOutputMiB。代理未删图或继续降低画质。`,
          { bytes: body.length, limitBytes: outputLimit });
        delete headers['content-encoding']; delete headers['content-length'];
        delete headers['content-md5']; delete headers.digest;
        headers['content-type'] = 'application/json';
        headers['content-length'] = String(body.length);
      }
      signal.throwIfAborted();
      const transport = upstreamBase.protocol === 'https:' ? https : http;
      const upstreamPath = upstreamBase.pathname.replace(/\/$/, '') + req.url;
      upstreamRequest = transport.request(upstreamBase, { method: req.method, path: upstreamPath,
        headers, agent: agents[upstreamBase.protocol] });
      metrics.upstreamRequests = 1;
      let connectTimer;
      const clearConnectTimer = () => { clearTimeout(connectTimer); };
      upstreamRequest.once('socket', (socket) => {
        if (!socket.connecting) return;
        connectTimer = setTimeout(() => {
          metrics.error = 'proxy_upstream_connect_timeout';
          upstreamRequest.destroy(new Error('Upstream connection timed out'));
        }, config.connectTimeoutMs);
        connectTimer.unref();
        socket.once(upstreamBase.protocol === 'https:' ? 'secureConnect' : 'connect', clearConnectTimer);
      });
      upstreamRequest.once('close', clearConnectTimer);
      upstreamRequest.once('error', () => {
        clearConnectTimer();
        if (signal.aborted || res.destroyed) return;
        metrics.error ||= 'proxy_upstream_unavailable';
        if (res.headersSent) { metrics.abortSource ||= 'upstream'; res.destroy(); }
        else {
          res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: { code: metrics.error, message: '无法连接或读取原 copilot-api，请检查其运行状态。' } }));
        }
      });
      upstreamRequest.once('response', (incoming) => {
        clearConnectTimer(); upstreamResponse = incoming;
        if (signal.aborted) { incoming.destroy(); return; }
        res.writeHead(incoming.statusCode, headersWithoutHopByHop(incoming.headers));
        res.flushHeaders();
        incoming.once('error', () => upstreamStreamFailed('proxy_upstream_stream_error'));
        incoming.once('aborted', () => upstreamStreamFailed('proxy_upstream_stream_aborted'));
        incoming.pipe(res);
      });
      if (body) upstreamRequest.end(body);
      else {
        req.once('error', () => upstreamRequest.destroy());
        req.pipe(upstreamRequest);
      }
    } catch (error) {
      if (signal.aborted || res.destroyed) return;
      const local = error instanceof ProxyError ? error : error instanceof BodyTransformError
        ? new ProxyError(error.status, error.code, error.message, error.details)
        : new ProxyError(500, 'proxy_internal_error', '图片代理内部处理失败，请查看元数据日志。');
      metrics.error = local.code;
      if (res.headersSent) { metrics.abortSource ||= 'proxy'; res.destroy(); return; }
      res.writeHead(local.status, { 'content-type': 'application/json; charset=utf-8', 'connection': 'close' });
      res.end(JSON.stringify({ error: { code: local.code, message: local.message, ...local.details } }));
    }
  });
  server.requestTimeout = 0;
  server.on('close', () => { for (const agent of Object.values(agents)) agent.destroy(); void transformer.close(); });
  return server;
}
