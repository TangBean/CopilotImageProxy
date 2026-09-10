import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { DEFAULT_CONFIG } from '../src/config.mjs';
import { createImageProcessor } from '../src/images.mjs';

const args = process.argv.slice(2);
if (args.length < 2 || args.length > 3) {
  process.stderr.write('Usage: node scripts/validate-sample.mjs rollout.jsonl report.json [preview-directory]\n');
  process.exit(1);
}
const source = await readFile(args[0], 'utf8');
const images = [];
for (const line of source.split('\n')) {
  if (!line.trim()) continue;
  const row = JSON.parse(line);
  if (row.type !== 'response_item') continue;
  const item = row.payload;
  const parts = item.type === 'message' ? item.content :
    ['custom_tool_call_output', 'function_call_output'].includes(item.type) ? item.output : null;
  if (!Array.isArray(parts)) continue;
  for (const part of parts) {
    if (part.type === 'input_image' && typeof part.image_url === 'string' && part.image_url.startsWith('data:image/')) {
      images.push(structuredClone(part));
    }
  }
}
const payload = { input: [{ type: 'message', role: 'user', content: images }] };
const processor = createImageProcessor(DEFAULT_CONFIG);
const started = performance.now();
const result = await processor.transformPayload(structuredClone(payload));
const elapsedMs = Math.round(performance.now() - started);
const transformedImages = result.payload.input[0].content;
const imageBytes = (part) => Buffer.from(part.image_url.slice(part.image_url.indexOf(',') + 1), 'base64');
const base64Size = (parts) => parts.reduce((sum, part) => sum + part.image_url.slice(part.image_url.indexOf(',') + 1).length, 0);
const inputBase64Bytes = base64Size(images);
const outputBase64Bytes = base64Size(transformedImages);
const againStarted = performance.now();
const cached = await processor.transformPayload(structuredClone(payload));
const report = {
  generatedAt: new Date().toISOString(), sampleSha256: createHash('sha256').update(source).digest('hex'),
  imageCount: images.length, inputBase64Bytes, outputBase64Bytes,
  reductionPercent: (1 - outputBase64Bytes / inputBase64Bytes) * 100,
  elapsedMs, cachedElapsedMs: Math.round(performance.now() - againStarted),
  stats: result.stats, cachedStats: cached.stats,
  interpretation: 'Offline image-byte and structure measurement, not proof of upstream acceptance.',
};
if (args[2]) {
  const previewDir = resolve(args[2]);
  await mkdir(previewDir, { recursive: true });
  // Contact sheet compares viewport, texture and final render; originals stay untouched.
  const selected = [2, 5, images.length - 1].filter((n) => n >= 0 && n < images.length);
  const tileWidth = 640; const tileHeight = 560; const composites = [];
  for (let row = 0; row < selected.length; row++) {
    const index = selected[row];
    for (let col = 0; col < 2; col++) {
      const bytes = imageBytes(col ? transformedImages[index] : images[index]);
      const tile = await sharp(bytes).rotate().resize(tileWidth, tileHeight, { fit: 'contain', background: '#dddddd' }).png().toBuffer();
      composites.push({ input: tile, left: col * tileWidth, top: row * tileHeight });
    }
  }
  await sharp({ create: { width: tileWidth * 2, height: tileHeight * selected.length, channels: 3, background: '#dddddd' } })
    .composite(composites).png().toFile(resolve(previewDir, 'before-after.png'));
  report.preview = 'before-after.png: original on left; proxy output on right; rows are viewport, texture, render.';
}
await mkdir(dirname(resolve(args[1])), { recursive: true });
await writeFile(args[1], JSON.stringify(report, null, 2) + '\n');
processor.close();
process.stdout.write(JSON.stringify(report) + '\n');
