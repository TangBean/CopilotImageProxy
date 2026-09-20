import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// Read model-visible images only; UI mirror events are not additional samples.
export async function readImageSample(filename, minimumImages = 1) {
  const source = await readFile(filename, 'utf8');
  const images = [];
  const lines = source.split('\n');
  for (let index = 0; index < lines.length; index++) {
    if (!lines[index].trim()) continue;
    let row;
    try { row = JSON.parse(lines[index]); }
    catch { throw new Error(`Invalid rollout JSON at line ${index + 1}.`); }
    if (row?.type !== 'response_item') continue;
    const item = row.payload;
    const parts = item?.type === 'message' ? item.content :
      ['custom_tool_call_output', 'function_call_output'].includes(item?.type) ? item.output : null;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      if (part?.type === 'input_image' && typeof part.image_url === 'string' && /^data:image\//i.test(part.image_url)) {
        images.push(part);
      }
    }
  }
  if (images.length < minimumImages) throw new Error(`The sample requires at least ${minimumImages} embedded image(s); found ${images.length}.`);
  return { images, sha256: createHash('sha256').update(source).digest('hex') };
}
