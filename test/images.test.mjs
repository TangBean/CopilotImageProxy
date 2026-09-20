import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { createImageProcessor } from '../src/images.mjs';

function dataUrl(bytes, mime = 'image/png') {
  return `data:${mime};base64,${bytes.toString('base64')}`;
}

function bytesFrom(url) {
  return Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
}

function message(...urls) {
  return { input: [{ type: 'message', role: 'user', content: urls.map((image_url) => ({ type: 'input_image', image_url })) }] };
}

function firstUrl(payload) {
  return payload.input[0].content[0].image_url;
}

async function noisePng(width = 160, height = 80, seed = 1, alpha = undefined) {
  const channels = alpha === undefined ? 3 : 4;
  const pixels = Buffer.alloc(width * height * channels);
  let state = seed;
  for (let index = 0; index < pixels.length; index += channels) {
    for (let channel = 0; channel < 3; channel += 1) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      pixels[index + channel] = state >>> 24;
    }
    if (channels === 4) pixels[index + 3] = alpha;
  }
  return sharp(pixels, { raw: { width, height, channels } }).png().toBuffer();
}

async function solidPng(red) {
  return sharp({ create: { width: 12, height: 6, channels: 3, background: { r: red, g: 80, b: 130 } } }).png().toBuffer();
}

async function animated(format) {
  const pixels = Buffer.alloc(8 * 16 * 4, 255);
  for (let index = 0; index < pixels.length; index += 4) {
    pixels[index] = index < pixels.length / 2 ? 255 : 0;
    pixels[index + 1] = 0;
    pixels[index + 2] = index < pixels.length / 2 ? 0 : 255;
  }
  return sharp(pixels, { raw: { width: 8, height: 16, channels: 4, pageHeight: 8 } })
    .toFormat(format, { loop: 0, delay: [100, 100] }).toBuffer();
}

function pngChunks(bytes) {
  const result = [];
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const size = bytes.readUInt32BE(offset);
    result.push({ type: bytes.toString('ascii', offset + 4, offset + 8), data: bytes.subarray(offset + 8, offset + 8 + size) });
    offset += 12 + size;
  }
  return result;
}

function chunk(type, bytes) {
  const body = Buffer.concat([Buffer.from(type), bytes]);
  let crc = 0xffffffff;
  for (const byte of body) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  const output = Buffer.alloc(bytes.length + 12);
  output.writeUInt32BE(bytes.length, 0);
  body.copy(output, 4);
  output.writeUInt32BE((crc ^ 0xffffffff) >>> 0, output.length - 4);
  return output;
}

async function animatedPng() {
  const first = pngChunks(await solidPng(255));
  const second = pngChunks(await solidPng(0));
  const actl = Buffer.alloc(8);
  actl.writeUInt32BE(2, 0);
  const frame = (sequence) => {
    const bytes = Buffer.alloc(26);
    bytes.writeUInt32BE(sequence, 0);
    bytes.writeUInt32BE(12, 4);
    bytes.writeUInt32BE(6, 8);
    bytes.writeUInt16BE(1, 20);
    bytes.writeUInt16BE(10, 22);
    return bytes;
  };
  const secondData = Buffer.concat(second.filter(({ type }) => type === 'IDAT').map(({ data }) => data));
  const fdat = Buffer.alloc(secondData.length + 4);
  fdat.writeUInt32BE(2, 0);
  secondData.copy(fdat, 4);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', first.find(({ type }) => type === 'IHDR').data),
    chunk('acTL', actl), chunk('fcTL', frame(0)),
    ...first.filter(({ type }) => type === 'IDAT').map(({ data }) => chunk('IDAT', data)),
    chunk('fcTL', frame(1)), chunk('fdAT', fdat), chunk('IEND', Buffer.alloc(0)),
  ]);
}

test('processes only typed images in the three supported Responses containers', async () => {
  const processor = createImageProcessor();
  const source = dataUrl(await noisePng());
  const payload = {
    id: 'request-1',
    input: [
      { type: 'message', id: 'm1', role: 'user', content: [{ type: 'input_text', text: source }, { type: 'input_image', image_url: source, detail: 'high', extra: { keep: true } }] },
      { role: 'user', content: [{ type: 'input_image', image_url: source }] },
      { type: 'custom_tool_call_output', call_id: 'custom-1', output: [{ type: 'input_image', image_url: source }, { type: 'input_text', text: 'keep' }] },
      { type: 'function_call_output', call_id: 'function-1', output: [{ type: 'input_image', image_url: source }] },
      { type: 'unknown', content: [{ type: 'input_image', image_url: source }] },
      { type: 'message', content: [{ image_url: source }, { type: 'input_text', nested: { type: 'input_image', image_url: source } }] },
      { type: 'function_call_output', output: JSON.stringify({ type: 'input_image', image_url: source }) },
    ],
    extra: { type: 'input_image', image_url: source },
  };
  const expected = structuredClone(payload);
  const { payload: output, stats } = await processor.transformPayload(payload);
  assert.equal(output, payload);
  const transformed = output.input[0].content[1].image_url;
  assert.match(transformed, /^data:image\/jpeg;base64,/);
  expected.input[0].content[1].image_url = transformed;
  expected.input[1].content[0].image_url = transformed;
  expected.input[2].output[0].image_url = transformed;
  expected.input[3].output[0].image_url = transformed;
  assert.deepEqual(output, expected);
  assert.equal(stats.imageCount, 4);
  assert.equal(stats.transformed, 4);
  assert.equal(stats.cacheMisses, 1);
  assert.equal(stats.cacheHits, 3);
  assert(stats.outputBytes < stats.inputBytes);
  assert.doesNotMatch(JSON.stringify(stats), /base64,|image_url|request-1/);
  processor.close();
});

test('uses inside resizing and never enlarges an opaque image', async () => {
  const processor = createImageProcessor({ maxEdge: 1280 });
  const large = message(dataUrl(await noisePng(2000, 1000)));
  const small = message(dataUrl(await noisePng(180, 90)));
  await processor.transformPayload(large);
  await processor.transformPayload(small);
  const bigMeta = await sharp(bytesFrom(firstUrl(large))).metadata();
  const smallMeta = await sharp(bytesFrom(firstUrl(small))).metadata();
  assert.equal(bigMeta.format, 'jpeg');
  assert.deepEqual([bigMeta.width, bigMeta.height], [1280, 640]);
  assert.deepEqual([smallMeta.width, smallMeta.height], [180, 90]);
  processor.close();
});

test('keeps real transparency as PNG but treats fully opaque alpha as JPEG', async () => {
  const processor = createImageProcessor({ maxEdge: 64 });
  const transparent = message(dataUrl(await noisePng(160, 80, 2, 128)));
  const opaqueAlpha = message(dataUrl(await noisePng(160, 80, 2, 255)));
  await processor.transformPayload(transparent);
  await processor.transformPayload(opaqueAlpha);
  const transparentBytes = bytesFrom(firstUrl(transparent));
  const transparentMeta = await sharp(transparentBytes).metadata();
  assert.equal(transparentMeta.format, 'png');
  assert.equal(transparentMeta.hasAlpha, true);
  assert.equal((await sharp(transparentBytes).stats()).isOpaque, false);
  assert.deepEqual([transparentMeta.width, transparentMeta.height], [64, 32]);
  const opaqueMeta = await sharp(bytesFrom(firstUrl(opaqueAlpha))).metadata();
  assert.equal(opaqueMeta.format, 'jpeg');
  assert.equal(opaqueMeta.hasAlpha, false);
  processor.close();
});

test('applies EXIF orientation and removes the orientation instruction', async () => {
  const input = await sharp(await noisePng(120, 40)).jpeg({ quality: 90 }).withMetadata({ orientation: 6 }).toBuffer();
  assert.equal((await sharp(input).metadata()).orientation, 6);
  const processor = createImageProcessor();
  const payload = message(dataUrl(input, 'image/jpeg'));
  const { stats } = await processor.transformPayload(payload);
  const output = await sharp(bytesFrom(firstUrl(payload))).metadata();
  assert.equal(stats.transformed, 1);
  assert.deepEqual([output.width, output.height], [40, 120]);
  assert.equal(output.orientation, undefined);
  assert.equal(output.space, 'srgb');
  processor.close();
});

test('normalizes CMYK to sRGB and does not retain a larger color-normalized source', async () => {
  const cmyk = await sharp(await solidPng(100)).toColourspace('cmyk').jpeg({ quality: 5 }).toBuffer();
  assert.equal((await sharp(cmyk).metadata()).space, 'cmyk');
  const processor = createImageProcessor();
  const payload = message(dataUrl(cmyk, 'image/jpeg'));
  const { stats } = await processor.transformPayload(payload);
  assert.equal(stats.transformed, 1);
  const output = bytesFrom(firstUrl(payload));
  assert(output.length > cmyk.length, 'normalization must still happen when its result is larger');
  assert.equal((await sharp(output).metadata()).space, 'srgb');
  processor.close();
});

test('honors embedded Display P3 profiles before producing untagged sRGB', async () => {
  const p3 = await sharp({ create: { width: 24, height: 12, channels: 3, background: { r: 235, g: 40, b: 70 } } })
    .withIccProfile('p3').png().toBuffer();
  assert.equal((await sharp(p3).metadata()).hasProfile, true);
  const expected = await sharp(p3).withIccProfile('srgb', { attach: false }).removeAlpha().raw().toBuffer();
  const processor = createImageProcessor();
  const payload = message(dataUrl(p3));
  const { stats } = await processor.transformPayload(payload);
  assert.equal(stats.transformed, 1);
  const output = bytesFrom(firstUrl(payload));
  assert.equal((await sharp(output).metadata()).hasProfile, false);
  const actual = await sharp(output).removeAlpha().raw().toBuffer();
  for (let channel = 0; channel < 3; channel += 1) {
    assert(Math.abs(actual[channel] - expected[channel]) <= 3, `sRGB channel ${channel} should respect the input ICC profile`);
  }
  processor.close();
});

test('retains the original URL when an already suitable image would grow', async () => {
  const processor = createImageProcessor();
  const source = dataUrl(await solidPng(40));
  const payload = message(source);
  const { stats } = await processor.transformPayload(payload);
  assert.equal(firstUrl(payload), source);
  assert.equal(stats.transformed, 0);
  assert.equal(stats.retained, 1);
  assert.equal(stats.skipped.notSmaller, 1);
  assert.equal(stats.inputBytes, stats.outputBytes);
  processor.close();
});

test('preserves all animated GIF, WebP and APNG bytes, regardless of size policy', async () => {
  const gif = await animated('gif');
  const webp = await animated('webp');
  assert.equal((await sharp(gif).metadata()).pages, 2);
  assert.equal((await sharp(webp).metadata()).pages, 2);
  const urls = [dataUrl(gif, 'image/gif'), dataUrl(webp, 'image/webp'), dataUrl(await animatedPng())];
  const processor = createImageProcessor({ maxEdge: 4 });
  const payload = message(...urls);
  const { stats } = await processor.transformPayload(payload);
  assert.deepEqual(payload.input[0].content.map(({ image_url }) => image_url), urls);
  assert.equal(stats.skipped.animated, 3);
  assert.equal(stats.retained, 3);
  assert.equal(stats.transformed, 0);
  processor.close();
});

test('classifies malformed URLs, unsupported formats and corrupt images without exposing content', async () => {
  const truncatedPng = (await noisePng()).subarray(0, 50);
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>');
  const urls = [
    'https://example.test/image.png',
    'data:image/png,abc',
    'data:image/png;base64,%%%',
    'data:image/png;base64,a',
    dataUrl(truncatedPng),
    dataUrl(svg, 'image/svg+xml'),
  ];
  const processor = createImageProcessor();
  const payload = message(...urls);
  const { stats } = await processor.transformPayload(payload);
  assert.deepEqual(payload.input[0].content.map(({ image_url }) => image_url), urls);
  assert.equal(stats.skipped.nonDataUrl, 1);
  assert.equal(stats.skipped.invalidDataUrl, 3);
  assert.equal(stats.skipped.invalidImage, 1);
  assert.equal(stats.skipped.unsupportedFormat, 1);
  assert.equal(stats.base64ImageCount, 2);
  for (const value of Object.values(stats.skipped)) assert.equal(typeof value, 'number');
  processor.close();
});

test('accepts canonical, unpadded and whitespace base64 and keys the cache by decoded contents', async () => {
  const processor = createImageProcessor();
  const bytes = await noisePng(171, 81);
  const encoded = bytes.toString('base64');
  const variants = [
    dataUrl(bytes),
    `data:image/png;base64,${encoded.replace(/=+$/, '')}`,
    `data:image/png;base64,${encoded.slice(0, 20)}\n${encoded.slice(20)}`,
  ];
  const payload = message(...variants);
  const { stats } = await processor.transformPayload(payload);
  assert.equal(stats.cacheMisses, 1);
  assert.equal(stats.cacheHits, 2);
  assert.equal(new Set(payload.input[0].content.map(({ image_url }) => image_url)).size, 1);
  processor.close();
});

test('reuses identical encoded results across requests without another lossy encode', async () => {
  const processor = createImageProcessor();
  const source = dataUrl(await noisePng());
  const first = await processor.transformPayload(message(source));
  const second = await processor.transformPayload(message(source));
  assert.equal(first.stats.cacheMisses, 1);
  assert.equal(second.stats.cacheMisses, 0);
  assert.equal(second.stats.cacheHits, 1);
  assert.equal(first.stats.base64Decodes, 1);
  assert.equal(first.stats.base64Encodes, 1);
  assert.equal(first.stats.imageEncodeOperations, 1);
  assert.equal(second.stats.wireCacheHits, 1);
  assert.equal(second.stats.base64Decodes, 0);
  assert.equal(second.stats.base64Encodes, 0);
  assert.equal(second.stats.imageEncodeOperations, 0);
  assert.equal(firstUrl(first.payload), firstUrl(second.payload));
  assert.equal(second.stats.cachePayloadBytes, firstUrl(first.payload).length * 2);
  assert(second.stats.cacheIndexBytes > 0);
  assert.equal(second.stats.cacheBytes, second.stats.cachePayloadBytes + second.stats.cacheIndexBytes);
  processor.close();
});

test('LRU budget includes result and alias indexes and refreshes cache access order', async () => {
  const buffers = await Promise.all([solidPng(20), solidPng(100), solidPng(200)]);
  const probe = createImageProcessor();
  const first = await probe.transformPayload(message(dataUrl(buffers[0])));
  const byteBudget = first.stats.cacheBytes * 2;
  probe.close();
  const processor = createImageProcessor({ cacheMiB: byteBudget / 1024 / 1024 });
  const urls = buffers.map((bytes) => dataUrl(bytes));
  await processor.transformPayload(message(urls[0]));
  await processor.transformPayload(message(urls[1]));
  assert.equal((await processor.transformPayload(message(urls[0]))).stats.cacheHits, 1);
  const third = await processor.transformPayload(message(urls[2]));
  assert.equal(third.stats.cacheEvictions, 1);
  assert.equal(third.stats.cacheEntries, 2);
  assert.equal(third.stats.cacheAliases, 2);
  assert.equal(third.stats.cachePayloadBytes, 0, 'retained originals are not stored in the cache');
  assert(third.stats.cacheBytes <= byteBudget);
  assert.equal((await processor.transformPayload(message(urls[0]))).stats.cacheHits, 1);
  assert.equal((await processor.transformPayload(message(urls[1]))).stats.cacheMisses, 1);
  processor.close();
});

test('hot wire-cache hits perform no base64 decoding or encoding', async () => {
  const processor = createImageProcessor();
  const source = dataUrl(await noisePng());
  const first = await processor.transformPayload(message(source));
  const originalFrom = Buffer.from;
  const originalToString = Buffer.prototype.toString;
  let decodes = 0;
  let encodes = 0;
  Buffer.from = function (...args) {
    if (args[1] === 'base64') decodes += 1;
    return Reflect.apply(originalFrom, Buffer, args);
  };
  Buffer.prototype.toString = function (...args) {
    if (args[0] === 'base64') encodes += 1;
    return Reflect.apply(originalToString, this, args);
  };
  let second;
  try {
    second = await processor.transformPayload(message(source, source, source));
  } finally {
    Buffer.from = originalFrom;
    Buffer.prototype.toString = originalToString;
    processor.close();
  }
  assert.equal(decodes, 0);
  assert.equal(encodes, 0);
  assert.equal(second.stats.wireCacheHits, 3);
  assert(second.payload.input[0].content.every((part) => part.image_url === firstUrl(first.payload)));
});

test('a new base64 representation reuses the content result then gains its own wire-cache alias', async () => {
  const processor = createImageProcessor();
  const source = dataUrl(await noisePng());
  const alias = source.replace('base64,', 'base64,\n');
  const first = await processor.transformPayload(message(source));
  const second = await processor.transformPayload(message(alias));
  assert.equal(second.stats.contentCacheHits, 1);
  assert.equal(second.stats.base64Decodes, 1);
  assert.equal(second.stats.imageEncodeOperations, 0);
  assert.equal(second.stats.base64Encodes, 0);
  assert.equal(firstUrl(second.payload), firstUrl(first.payload));
  const third = await processor.transformPayload(message(alias));
  assert.equal(third.stats.wireCacheHits, 1);
  assert.equal(third.stats.base64Decodes, 0);
  assert.equal(third.stats.cacheEntries, 1);
  assert.equal(third.stats.cacheAliases, 2);
  processor.close();
});

test('large retained sources consume metadata-only cache space and aliases stay bounded', async () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><!--' + 'x'.repeat(200_000) + '--></svg>');
  const source = dataUrl(svg, 'image/svg+xml');
  const processor = createImageProcessor({ cacheMiB: 1024 / 1024 / 1024 });
  const first = await processor.transformPayload(message(source));
  assert.equal(firstUrl(first.payload), source);
  assert.equal(first.stats.cacheEntries, 1);
  assert.equal(first.stats.cachePayloadBytes, 0);
  assert(first.stats.cacheBytes < svg.length);
  assert.equal((await processor.transformPayload(message(source))).stats.base64Decodes, 0);
  for (let length = 1; length <= 8; length += 1) {
    const alias = source.replace('base64,', 'base64,' + '\n'.repeat(length));
    const result = await processor.transformPayload(message(alias));
    assert.equal(firstUrl(result.payload), alias);
    assert(result.stats.cacheBytes <= 1024);
    assert(result.stats.cacheAliases <= 2);
  }
  processor.close();
});

test('zero budget and oversized outputs are not retained in the LRU', async () => {
  const source = dataUrl(await noisePng());
  for (const cacheMiB of [0, 1 / 1024 / 1024]) {
    const processor = createImageProcessor({ cacheMiB });
    await processor.transformPayload(message(source));
    const next = await processor.transformPayload(message(source));
    assert.equal(next.stats.cacheHits, 0);
    assert.equal(next.stats.cacheMisses, 1);
    assert.equal(next.stats.cacheBytes, 0);
    processor.close();
  }
});

test('shares one concurrency limit across simultaneous requests', async () => {
  const urls = await Promise.all([1, 2, 3, 4].map(async (seed) => dataUrl(await noisePng(500, 250, seed))));
  for (const imageConcurrency of [1, 2]) {
    const processor = createImageProcessor({ imageConcurrency });
    const results = await Promise.all([
      processor.transformPayload(message(urls[0], urls[1])),
      processor.transformPayload(message(urls[2], urls[3])),
    ]);
    for (const { stats } of results) assert.equal(stats.maxConcurrentTransforms, imageConcurrency);
    assert.equal(results.reduce((sum, result) => sum + result.stats.transformed, 0), 4);
    processor.close();
  }
});

test('aborting one waiter leaves another request sharing the same image running', async () => {
  const processor = createImageProcessor({ imageConcurrency: 1 });
  const source = dataUrl(await noisePng(800, 400));
  const controller = new AbortController();
  const cancelledPayload = message(source);
  const cancelled = processor.transformPayload(cancelledPayload, { signal: controller.signal });
  const surviving = processor.transformPayload(message(source));
  controller.abort();
  await assert.rejects(cancelled, { name: 'AbortError' });
  const completed = await surviving;
  assert.equal(firstUrl(cancelledPayload), source);
  assert.equal(completed.stats.transformed, 1);
  assert.equal(completed.stats.cacheHits, 1);
  assert.equal((await processor.transformPayload(message(source))).stats.cacheHits, 1);
  processor.close();
});

test('cancelling the owner does not cancel a different wire representation sharing its content job', async () => {
  const processor = createImageProcessor({ imageConcurrency: 2 });
  const source = dataUrl(await noisePng(800, 400));
  const alias = source.replace('base64,', 'base64,\n');
  const controller = new AbortController();
  const cancelled = processor.transformPayload(message(source), { signal: controller.signal });
  const surviving = processor.transformPayload(message(alias));
  controller.abort();
  await assert.rejects(cancelled, { name: 'AbortError' });
  const completed = await surviving;
  assert.equal(completed.stats.transformed, 1);
  assert.equal(completed.stats.contentCacheHits, 1);
  const cached = await processor.transformPayload(message(alias));
  assert.equal(cached.stats.wireCacheHits, 1);
  assert.equal(cached.stats.base64Decodes, 0);
  processor.close();
});

test('cancellation drops queued image work and does not modify the cancelled payload', async () => {
  const processor = createImageProcessor({ imageConcurrency: 1 });
  const urls = await Promise.all([1, 2, 3, 4, 5].map(async (seed) => dataUrl(await noisePng(500, 250, seed))));
  const controller = new AbortController();
  const payload = message(...urls);
  const originalFrom = Buffer.from;
  let decodes = 0;
  Buffer.from = function (...args) {
    if (args[1] === 'base64') decodes += 1;
    return Reflect.apply(originalFrom, Buffer, args);
  };
  try {
    const processing = processor.transformPayload(payload, { signal: controller.signal });
    controller.abort();
    await assert.rejects(processing, { name: 'AbortError' });
  } finally {
    Buffer.from = originalFrom;
  }
  assert.equal(decodes, 1, 'queued images must not be decoded before a global processing slot opens');
  assert.deepEqual(payload.input[0].content.map(({ image_url }) => image_url), urls);
  const last = await processor.transformPayload(message(urls.at(-1)));
  assert.equal(last.stats.cacheMisses, 1);
  assert.equal(last.stats.cacheHits, 0);
  assert.equal(last.stats.cacheEntries, 1);
  processor.close();
});

test('late cancellation leaves cached and pending images unchanged together', async (t) => {
  const processor = createImageProcessor({ imageConcurrency: 1 });
  t.after(() => processor.close());
  const cached = dataUrl(await noisePng());
  const pending = dataUrl(await noisePng(800, 400, 7));
  await processor.transformPayload(message(cached));
  const payload = message(cached, pending);
  const original = structuredClone(payload);
  const controller = new AbortController();
  const processing = processor.transformPayload(payload, { signal: controller.signal });
  controller.abort();
  await assert.rejects(processing, { name: 'AbortError' });
  assert.deepEqual(payload, original);
});

test('passes non-object JSON and unrecognized payload shapes unchanged', async () => {
  const processor = createImageProcessor();
  for (const payload of [null, 7, false, 'text', [], {}, { input: 'hello' }, { input: [null, 'text', {}] }]) {
    const result = await processor.transformPayload(payload);
    assert.equal(result.payload, payload);
    assert.equal(result.stats.imageCount, 0);
    assert.equal(result.stats.transformed, 0);
  }
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(processor.transformPayload({}, { signal: controller.signal }), { name: 'AbortError' });
  processor.close();
  await assert.rejects(processor.transformPayload({}), /closed/);
});

test('closing rejects outstanding work and clears the output cache', async () => {
  const processor = createImageProcessor({ imageConcurrency: 1 });
  const urls = await Promise.all([1, 2].map(async (seed) => dataUrl(await noisePng(500, 250, seed))));
  const processing = processor.transformPayload(message(...urls));
  processor.close();
  await assert.rejects(processing, /closed/);
  await assert.rejects(processor.transformPayload({}), /closed/);
});
