import { performance } from 'node:perf_hooks';

export const MAX_SSE_EVENT_BYTES = 8 * 1024 * 1024;
export const MAX_JSON_RESPONSE_BYTES = 32 * 1024 * 1024;
export const EARLY_ERROR_LIMITS = Object.freeze({ timeoutMs: 2000, detailTimeoutMs: 250, maxEvents: 16, maxBytes: 256 * 1024 });
const announcements = new Set(['response.created', 'response.in_progress', 'response.queued']);
const invalidCodes = new Set(['invalid_request_body', 'invalid_request_error']);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const timeout = Symbol('timeout');

export class ResponseStreamError extends Error {
  constructor(code, message) {
    super(message);
    Object.assign(this, { name: 'ResponseStreamError', status: 502, code });
  }
}

// Frame bytes remain untouched unless an adapter actually changes their JSON data.
// Carry line state across chunks so CRLF and UTF-8 splits do not alter framing.
export class SseDecoder {
  constructor(maxBytes = MAX_SSE_EVENT_BYTES) {
    this.maxBytes = maxBytes;
    this.parts = [];
    this.bytes = 0;
    this.lineBytes = 0;
    this.lastByte = undefined;
  }

  feed(chunk) {
    const frames = [];
    let start = 0;
    for (let index = 0; index < chunk.length; index++) {
      const byte = chunk[index];
      if (++this.bytes > this.maxBytes) throw new ResponseStreamError('proxy_sse_event_limit', '上游 SSE 单事件超过 8 MiB 限制。');
      if (byte === 10) {
        const empty = this.lineBytes === 0 || (this.lineBytes === 1 && this.lastByte === 13);
        this.lineBytes = 0;
        if (empty) {
          this.parts.push(chunk.subarray(start, index + 1));
          frames.push(Buffer.concat(this.parts, this.bytes));
          this.parts = [];
          this.bytes = 0;
          start = index + 1;
        }
      } else this.lineBytes++;
      this.lastByte = byte;
    }
    if (start < chunk.length) this.parts.push(chunk.subarray(start));
    return frames;
  }

  finish() {
    const frames = this.bytes ? [Buffer.concat(this.parts, this.bytes)] : [];
    this.parts = [];
    this.bytes = 0;
    this.lineBytes = 0;
    this.lastByte = undefined;
    return frames;
  }
}

function decodeFrame(raw, strict) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(raw); }
  catch {
    if (strict) throw new ResponseStreamError('proxy_sse_invalid_utf8', '上游 SSE 包含无效 UTF-8。');
    return { invalid: true };
  }
  const lines = text.replace(/^\uFEFF/, '').split(/\r\n|\n/);
  const data = [];
  let eventName;
  for (const line of lines) {
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'data') data.push(value);
    if (field === 'event') eventName = value;
  }
  if (!data.length) return { lines, eventName };
  const joined = data.join('\n');
  if (joined === '[DONE]') return { lines, eventName, done: true };
  try {
    const value = JSON.parse(joined);
    if (!record(value)) throw new Error('not an event');
    return { lines, eventName, value };
  } catch {
    if (strict) throw new ResponseStreamError('proxy_sse_invalid_json', '上游 SSE 数据不是有效的 JSON 事件。');
    return { invalid: true };
  }
}

function encodeFrame(raw, parsed, value) {
  if (value === parsed.value) return raw;
  const newline = raw.includes(Buffer.from('\r\n')) ? '\r\n' : '\n';
  const lines = [];
  let replaced = false;
  for (const line of parsed.lines) {
    if (line === 'data' || line.startsWith('data:')) {
      if (!replaced) lines.push(`data: ${JSON.stringify(value)}`);
      replaced = true;
    } else lines.push(line);
  }
  const text = lines.join(newline);
  const bytes = Buffer.from(text.endsWith(newline + newline) ? text : text + newline + newline);
  if (bytes.length > MAX_SSE_EVENT_BYTES) throw new ResponseStreamError('proxy_sse_event_limit', '改写后的 SSE 单事件超过 8 MiB 限制。');
  return bytes;
}

export async function* adaptSse(source, adapter, { signal } = {}) {
  const decoder = new SseDecoder();
  const transform = (raw) => {
    const parsed = decodeFrame(raw, true);
    return parsed.value ? encodeFrame(raw, parsed, adapter.restoreEvent(parsed.value)) : raw;
  };
  for await (const chunk of source) {
    signal?.throwIfAborted();
    for (const raw of decoder.feed(chunk)) yield transform(raw);
  }
  for (const raw of decoder.finish()) yield transform(raw);
}

function outputStarted(event, type) {
  return (Array.isArray(event?.response?.output) && event.response.output.length > 0)
    || (typeof type === 'string' && /^response\.(?:output_|content_part|function_call|custom_tool|reasoning)/.test(type));
}

function invalidRequest(event, type) {
  const error = type === 'error' ? (record(event?.error) ? event.error : event)
    : type === 'response.failed' ? event?.response?.error : undefined;
  if (!record(error) || !invalidCodes.has(error.code) || typeof error.message !== 'string' || !error.message.trim()) return undefined;
  return { ...error, type: 'invalid_request_error', param: error.param ?? null };
}

// A timed-out next() remains owned by the returned stream. Only that stream may
// consume it, so prefix inspection cannot lose data or start a concurrent read.
export async function preflightSse(source, { signal, limits = EARLY_ERROR_LIMITS } = {}) {
  const iterator = source[Symbol.asyncIterator]();
  const prefix = [];
  const decoder = new SseDecoder(limits.maxBytes);
  const deadline = performance.now() + limits.timeoutMs;
  let readDeadline = deadline;
  let pending;
  let ended = false;
  let closed = false;
  let byteCount = 0;
  let eventCount = 0;
  let finished = false;
  let hasFrames = false;
  let error;
  const stats = { bufferedBytes: 0, inspectedEvents: 0, outcome: 'passthrough' };

  const close = async () => {
    if (closed) return;
    closed = true;
    await iterator.return?.();
  };

  const next = async () => {
    const value = await (pending ??= Promise.resolve().then(() => iterator.next()));
    pending = undefined;
    if (value.done) ended = true;
    return value;
  };

  const readBefore = async () => {
    signal?.throwIfAborted();
    const remaining = readDeadline - performance.now();
    if (remaining <= 0) return timeout;
    pending ??= Promise.resolve().then(() => iterator.next());
    let timer;
    let onAbort;
    try {
      const value = await Promise.race([pending, new Promise((resolve, reject) => {
        timer = setTimeout(() => resolve(timeout), remaining);
        onAbort = () => reject(signal.reason);
        signal?.addEventListener('abort', onAbort, { once: true });
      })]);
      if (value !== timeout) {
        pending = undefined;
        if (value.done) ended = true;
      }
      return value;
    } finally {
      clearTimeout(timer);
      if (onAbort) signal?.removeEventListener('abort', onAbort);
    }
  };

  const inspect = (frames) => {
    if (frames.length) hasFrames = true;
    for (const raw of frames) {
      if (finished || eventCount >= limits.maxEvents || performance.now() >= readDeadline) break;
      eventCount++;
      const parsed = decodeFrame(raw, false);
      if (parsed.invalid || parsed.done) { finished = true; break; }
      if (!parsed.value && !parsed.eventName) continue;
      const type = parsed.value?.type ?? parsed.eventName;
      if (outputStarted(parsed.value, type)) { finished = true; stats.outcome = 'output'; break; }
      error = invalidRequest(parsed.value, type);
      if (error) { finished = true; stats.outcome = 'invalid_request'; break; }
      if (announcements.has(type)) continue;
      const details = parsed.value?.response?.error;
      if (type === 'response.failed' && (!record(details) || !(details.code || details.message))) {
        readDeadline = Math.min(readDeadline, performance.now() + limits.detailTimeoutMs);
        continue;
      }
      finished = true;
    }
  };

  try {
    while (!finished && eventCount < limits.maxEvents && byteCount < limits.maxBytes) {
      const item = await readBefore();
      if (item === timeout) { stats.outcome = 'timeout'; break; }
      if (item.done) { inspect(decoder.finish()); break; }
      const chunk = item.value;
      prefix.push(chunk);
      const inspectBytes = Math.min(chunk.length, limits.maxBytes - byteCount);
      inspect(decoder.feed(chunk.subarray(0, inspectBytes)));
      byteCount += chunk.length;
    }
    stats.bufferedBytes = byteCount;
    stats.inspectedEvents = eventCount;
  } catch (cause) {
    // The transport owner cancels the source; never block error handling on an
    // iterator.return() that is waiting for an upstream read to settle.
    void close().catch(() => {});
    throw cause;
  }

  const stream = async function* () {
    try {
      for (const chunk of prefix) { signal?.throwIfAborted(); yield chunk; }
      while (!ended && !closed) {
        signal?.throwIfAborted();
        const item = await next();
        if (item.done) return;
        yield item.value;
      }
    } finally { await close(); }
  };
  return { error, stream: stream(), close, stats, hasFrames };
}

export async function readJsonResponse(source, { signal } = {}) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of source) {
    signal?.throwIfAborted();
    bytes += chunk.length;
    if (bytes > MAX_JSON_RESPONSE_BYTES) throw new ResponseStreamError('proxy_json_response_limit', '上游 JSON 响应超过 32 MiB 限制。');
    chunks.push(chunk);
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes));
    const value = JSON.parse(text);
    if (!record(value)) throw new Error('not an object');
    return value;
  } catch { throw new ResponseStreamError('proxy_response_invalid_json', '上游响应不是有效的 JSON 对象。'); }
}

export async function writeStream(response, source) {
  for await (const chunk of source) {
    if (response.destroyed) throw new ResponseStreamError('proxy_client_closed', '客户端已断开。');
    if (response.write(chunk)) continue;
    await new Promise((resolve, reject) => {
      const cleanup = () => { response.off('drain', drained); response.off('error', failed); response.off('close', closed); };
      const drained = () => { cleanup(); resolve(); };
      const failed = (error) => { cleanup(); reject(error); };
      const closed = () => failed(new ResponseStreamError('proxy_client_closed', '客户端已断开。'));
      response.once('drain', drained); response.once('error', failed); response.once('close', closed);
    });
  }
  response.end();
}
