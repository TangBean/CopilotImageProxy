import { createHash } from 'node:crypto';
import sharp from 'sharp';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const RASTER_FORMATS = new Set(['jpeg', 'png', 'webp', 'gif', 'avif', 'heif', 'tiff']);

function abortError() {
  const error = new Error('Image processing aborted');
  error.name = 'AbortError';
  return error;
}

function requestCancellation(signal) {
  const listeners = new Set();
  let cancelled = Boolean(signal?.aborted);
  const onAbort = () => {
    cancelled = true;
    for (const listener of [...listeners]) listener();
    listeners.clear();
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  return {
    throwIfAborted() {
      if (cancelled) throw abortError();
    },
    subscribe(listener) {
      if (cancelled) listener();
      else listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      signal?.removeEventListener('abort', onAbort);
      listeners.clear();
    },
  };
}

function imageParts(payload) {
  if (!Array.isArray(payload?.input)) return [];
  const parts = [];
  for (const item of payload.input) {
    if (item === null || typeof item !== 'object') continue;
    let content;
    if ((item.type === 'message' || item.type === undefined) && Array.isArray(item.content)) {
      content = item.content;
    } else if (
      (item.type === 'custom_tool_call_output' || item.type === 'function_call_output')
      && Array.isArray(item.output)
    ) {
      content = item.output;
    }
    if (!content) continue;
    for (const part of content) {
      if (part !== null && typeof part === 'object' && part.type === 'input_image') parts.push(part);
    }
  }
  return parts;
}

function parseImageUrl(url) {
  if (typeof url !== 'string' || !/^data:/i.test(url)) return { reason: 'nonDataUrl' };
  const comma = url.indexOf(',');
  if (comma < 0) return { reason: 'invalidDataUrl' };
  const header = url.slice(5, comma).split(';');
  if (!/^image\/[a-z0-9.+-]+$/i.test(header[0]) || header.at(-1)?.toLowerCase() !== 'base64') {
    return { reason: 'invalidDataUrl' };
  }
  let encoded = url.slice(comma + 1);
  if (/\s/.test(encoded)) encoded = encoded.replace(/\s/g, '');
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  const bodyLength = encoded.length - padding;
  if (
    bodyLength === 0
    || /[^a-z0-9+/]/i.test(encoded.slice(0, bodyLength))
    || bodyLength % 4 === 1
    || (padding > 0 && (encoded.length % 4 !== 0 || padding !== (4 - bodyLength % 4) % 4))
  ) return { reason: 'invalidDataUrl' };
  return { encoded };
}

// libvips does not expose APNG frames on every build. Check the container before
// decoding so an unsupported animated PNG cannot silently become its first frame.
function hasAnimationMarker(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    let offset = 8;
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset);
      const end = offset + 12 + length;
      if (end > bytes.length) break;
      const type = bytes.toString('ascii', offset + 4, offset + 8);
      if (type === 'acTL') return true;
      if (type === 'IEND') break;
      offset = end;
    }
  }
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    let offset = 12;
    while (offset + 8 <= bytes.length) {
      const type = bytes.toString('ascii', offset, offset + 4);
      const length = bytes.readUInt32LE(offset + 4);
      const end = offset + 8 + length;
      if (end > bytes.length) break;
      if (type === 'ANIM' || (type === 'VP8X' && length > 0 && (bytes[offset + 8] & 2) !== 0)) return true;
      offset = end + (length % 2);
    }
  }
  return false;
}

function classifyDecodeError(error) {
  return /unsupported image format|no (?:decoding|loading) plugin|unsupported compression/i.test(error?.message ?? '')
    ? 'unsupportedFormat'
    : 'invalidImage';
}

function newStats() {
  return {
    imageCount: 0,
    base64ImageCount: 0,
    inputBytes: 0,
    outputBytes: 0,
    transformed: 0,
    retained: 0,
    cacheHits: 0,
    cacheMisses: 0,
    cacheEvictions: 0,
    wireCacheHits: 0,
    contentCacheHits: 0,
    base64Decodes: 0,
    base64Encodes: 0,
    imageEncodeOperations: 0,
    cacheEntries: 0,
    cacheAliases: 0,
    cacheBytes: 0,
    cachePayloadBytes: 0,
    cacheIndexBytes: 0,
    maxConcurrentTransforms: 0,
    skipped: {
      nonDataUrl: 0,
      invalidDataUrl: 0,
      invalidImage: 0,
      unsupportedFormat: 0,
      animated: 0,
      notSmaller: 0,
    },
  };
}

/** Transform only Responses image parts, without reading or writing image files. */
export function createImageProcessor(config = {}) {
  const maxEdge = config.maxEdge ?? 1280;
  const jpegQuality = config.jpegQuality ?? 80;
  const cacheMiB = config.cacheMiB ?? 64;
  const imageConcurrency = config.imageConcurrency ?? 2;
  if (!Number.isInteger(maxEdge) || maxEdge < 1) throw new TypeError('maxEdge must be a positive integer');
  if (!Number.isInteger(jpegQuality) || jpegQuality < 1 || jpegQuality > 100) throw new TypeError('jpegQuality must be between 1 and 100');
  if (!Number.isFinite(cacheMiB) || cacheMiB < 0) throw new TypeError('cacheMiB must be non-negative');
  if (!Number.isInteger(imageConcurrency) || imageConcurrency < 1) throw new TypeError('imageConcurrency must be a positive integer');

  const budget = Math.floor(cacheMiB * 1024 * 1024);
  const configurationKey = `srgb-auto-orient-v2:${maxEdge}:${jpegQuality}:`;
  const cache = new Map();
  const wireCache = new Map();
  const inflight = new Map();
  const contentInflight = new Map();
  const queue = [];
  let cacheBytes = 0;
  let cachePayloadBytes = 0;
  let active = 0;
  let peakActive = 0;
  let closed = false;

  // Count strings at their UTF-16 upper bound, plus conservative fixed charges
  // for the result object and each Map/Set index. This is a cache admission
  // budget, not a claim to measure V8 or libvips process RSS exactly.
  const entryOverhead = 256;
  const aliasOverhead = 128;
  const aliasCost = (key) => key.length * 2 + aliasOverhead;

  function cacheGet(key) {
    const record = cache.get(key);
    if (record) {
      cache.delete(key);
      cache.set(key, record);
    }
    return record;
  }

  function evict(record) {
    cache.delete(record.key);
    for (const key of record.wireKeys) wireCache.delete(key);
    cacheBytes -= record.cost;
    cachePayloadBytes -= record.payloadCost;
  }

  function makeRoom(cost, preserve) {
    let evictions = 0;
    for (const record of cache.values()) {
      if (cacheBytes + cost <= budget) break;
      if (record === preserve) continue;
      evict(record);
      evictions += 1;
    }
    return evictions;
  }

  function cachePut(key, value, wireKey) {
    if (closed || budget === 0) return 0;
    const current = cacheGet(key);
    if (current) {
      if (current.wireKeys.has(wireKey)) return 0;
      const extra = aliasCost(wireKey);
      if (current.cost + extra > budget) return 0;
      const evictions = makeRoom(extra, current);
      current.wireKeys.add(wireKey);
      current.cost += extra;
      wireCache.set(wireKey, current);
      cacheBytes += extra;
      return evictions;
    }
    const payloadCost = (value.dataUrl?.length ?? 0) * 2;
    const cost = payloadCost + key.length * 2 + entryOverhead + aliasCost(wireKey);
    if (cost > budget) return 0;
    const evictions = makeRoom(cost);
    const record = { key, value, cost, payloadCost, wireKeys: new Set([wireKey]) };
    cache.set(key, record);
    wireCache.set(wireKey, record);
    cacheBytes += cost;
    cachePayloadBytes += payloadCost;
    return evictions;
  }

  async function optimize(job) {
    const bytes = job.bytes;
    const retained = (reason) => ({ inputBytes: bytes.length, outputBytes: bytes.length, transformed: false, reason });
    const checkDemand = () => {
      if (job.abandoned) throw abortError();
    };
    checkDemand();
    if (hasAnimationMarker(bytes)) return retained('animated');
    try {
      const metadata = await sharp(bytes, { failOn: 'error' }).metadata();
      checkDemand();
      if ((metadata.pages ?? 1) > 1) return retained('animated');
      if (!RASTER_FORMATS.has(metadata.format)) return retained('unsupportedFormat');
      let transparent = false;
      if (metadata.hasAlpha) {
        transparent = !(await sharp(bytes, { failOn: 'error' }).stats()).isOpaque;
        checkDemand();
      }

      let pipeline = sharp(bytes, { failOn: 'error' })
        .rotate()
        .toColourspace('srgb')
        .resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true });
      const mime = transparent ? 'image/png' : 'image/jpeg';
      pipeline = transparent
        ? pipeline.png({ compressionLevel: 9, adaptiveFiltering: true, palette: false })
        : pipeline.removeAlpha().jpeg({ quality: jpegQuality });
      job.counts.imageEncodeOperations += 1;
      const output = await pipeline.toBuffer();
      checkDemand();
      const fits = metadata.width <= maxEdge && metadata.height <= maxEdge;
      const needsNormalization = (metadata.orientation !== undefined && metadata.orientation !== 1)
        || metadata.hasProfile === true
        || metadata.space !== 'srgb';
      if (fits && !needsNormalization && output.length >= bytes.length) return retained('notSmaller');
      const dataUrl = `data:${mime};base64,${output.toString('base64')}`;
      job.counts.base64Encodes += 1;
      return { inputBytes: bytes.length, outputBytes: output.length, transformed: true, dataUrl };
    } catch (error) {
      if (job.abandoned) throw abortError();
      return retained(classifyDecodeError(error));
    }
  }

  function abandon(entry) {
    entry.abandoned = true;
    if (inflight.get(entry.key) === entry) inflight.delete(entry.key);
    const job = entry.contentJob;
    if (job) {
      job.consumers.delete(entry);
      if (job.consumers.size === 0) {
        job.abandoned = true;
        if (contentInflight.get(job.key) === job) contentInflight.delete(job.key);
      }
    }
  }

  async function runEntry(entry) {
    const counts = { cacheHits: 0, cacheMisses: 0, contentCacheHits: 0,
      base64Decodes: 0, base64Encodes: 0, imageEncodeOperations: 0 };
    const parsed = parseImageUrl(entry.url);
    entry.url = undefined;
    if (entry.abandoned) throw abortError();
    if (!parsed.encoded) {
      const value = { transformed: false, reason: parsed.reason };
      return { value, counts, evictions: cachePut(`invalid:${entry.key}`, value, entry.key) };
    }

    // This is deliberately inside the global job slot, after the wire cache
    // check. Queued image requests retain no decoded source-image Buffers.
    let bytes = Buffer.from(parsed.encoded, 'base64');
    parsed.encoded = undefined;
    counts.base64Decodes += 1;
    const contentKey = createHash('sha256').update(configurationKey).update(bytes).digest('hex');
    const cached = cacheGet(contentKey);
    if (cached) {
      counts.cacheHits += 1;
      counts.contentCacheHits += 1;
      return { value: cached.value, counts, evictions: cachePut(contentKey, cached.value, entry.key) };
    }

    let job = contentInflight.get(contentKey);
    const ownsContentJob = !job;
    if (!job) {
      counts.cacheMisses += 1;
      job = { key: contentKey, bytes, consumers: new Set([entry]), abandoned: false,
        counts: { base64Encodes: 0, imageEncodeOperations: 0 } };
      contentInflight.set(contentKey, job);
      job.promise = optimize(job).finally(() => {
        if (contentInflight.get(contentKey) === job) contentInflight.delete(contentKey);
        job.bytes = undefined;
      });
    } else {
      counts.cacheHits += 1;
      counts.contentCacheHits += 1;
      job.consumers.add(entry);
    }
    bytes = undefined;
    entry.contentJob = job;
    try {
      const value = await job.promise;
      if (entry.abandoned) throw abortError();
      if (ownsContentJob) {
        counts.base64Encodes += job.counts.base64Encodes;
        counts.imageEncodeOperations += job.counts.imageEncodeOperations;
      }
      return { value, counts, evictions: cachePut(contentKey, value, entry.key) };
    } finally {
      job.consumers.delete(entry);
      entry.contentJob = undefined;
    }
  }

  function drain() {
    while (!closed && active < imageConcurrency && queue.length > 0) {
      const entry = queue.shift();
      if (entry.abandoned) continue;
      entry.started = true;
      active += 1;
      peakActive = Math.max(peakActive, active);
      void (async () => {
        try {
          entry.resolve(await runEntry(entry));
        } catch (error) {
          entry.reject(error);
        } finally {
          if (inflight.get(entry.key) === entry) inflight.delete(entry.key);
          entry.url = undefined;
          active -= 1;
          drain();
        }
      })();
    }
  }

  function waitForEntry(entry, cancellation) {
    entry.waiters += 1;
    return new Promise((resolve, reject) => {
      let settled = false;
      let unsubscribe = () => {};
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        unsubscribe();
        entry.waiters -= 1;
        callback(value);
      };
      const cancelled = () => {
        finish(reject, abortError());
        if (entry.waiters === 0) {
          abandon(entry);
          if (!entry.started) {
            const index = queue.indexOf(entry);
            if (index !== -1) queue.splice(index, 1);
            entry.url = undefined;
            entry.reject(abortError());
          }
        }
      };
      unsubscribe = cancellation.subscribe(cancelled);
      entry.promise.then((value) => finish(resolve, value), (error) => finish(reject, error));
    });
  }

  async function processPart(part, stats, cancellation, requestKeys) {
    cancellation.throwIfAborted();
    stats.imageCount += 1;
    const url = part.image_url;
    if (typeof url !== 'string' || !/^data:/i.test(url)) {
      stats.skipped.nonDataUrl += 1;
      return;
    }
    let key = requestKeys.get(url);
    if (!key) {
      key = createHash('sha256').update(configurationKey).update(url).digest('hex');
      requestKeys.set(url, key);
    }
    const cached = wireCache.get(key);
    let value = cached?.value;
    if (cached) {
      cacheGet(cached.key);
      stats.cacheHits += 1;
      stats.wireCacheHits += 1;
    } else {
      let entry = inflight.get(key);
      const ownsEntry = !entry;
      if (!entry) {
        let resolve;
        let reject;
        const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
        entry = { key, url, promise, resolve, reject, waiters: 0, started: false, abandoned: false };
        inflight.set(key, entry);
        queue.push(entry);
      } else {
        stats.cacheHits += 1;
        stats.wireCacheHits += 1;
      }
      const waiting = waitForEntry(entry, cancellation);
      drain();
      const result = await waiting;
      value = result.value;
      if (ownsEntry) {
        stats.cacheEvictions += result.evictions;
        for (const [name, count] of Object.entries(result.counts)) stats[name] += count;
      }
    }
    cancellation.throwIfAborted();
    if (value.inputBytes === undefined) {
      stats.skipped[value.reason] += 1;
      return;
    }
    stats.base64ImageCount += 1;
    stats.inputBytes += value.inputBytes;
    stats.outputBytes += value.outputBytes;
    if (value.transformed) {
      part.image_url = value.dataUrl;
      stats.transformed += 1;
    } else {
      stats.retained += 1;
      stats.skipped[value.reason] += 1;
    }
  }

  return {
    async transformPayload(payload, { signal } = {}) {
      if (closed) throw new Error('Image processor is closed');
      const cancellation = requestCancellation(signal);
      const stats = newStats();
      try {
        cancellation.throwIfAborted();
        const requestKeys = new Map();
        await Promise.all(imageParts(payload).map((part) => processPart(part, stats, cancellation, requestKeys)));
        cancellation.throwIfAborted();
        stats.cacheEntries = cache.size;
        stats.cacheAliases = wireCache.size;
        stats.cacheBytes = cacheBytes;
        stats.cachePayloadBytes = cachePayloadBytes;
        stats.cacheIndexBytes = cacheBytes - cachePayloadBytes;
        stats.maxConcurrentTransforms = peakActive;
        return { payload, stats };
      } finally {
        cancellation.dispose();
      }
    },
    close() {
      closed = true;
      queue.length = 0;
      for (const entry of inflight.values()) {
        abandon(entry);
        if (!entry.started) entry.url = undefined;
        entry.reject(new Error('Image processor is closed'));
      }
      inflight.clear();
      cache.clear();
      wireCache.clear();
      cacheBytes = 0;
      cachePayloadBytes = 0;
    },
  };
}
