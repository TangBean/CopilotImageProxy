import { parentPort, workerData } from 'node:worker_threads';
import { createImageProcessor } from './images.mjs';
import { transferableBody } from './body-transformer.mjs';

const processor = createImageProcessor(workerData.imageConfig);
const requests = new Map();

parentPort.on('message', (message) => {
  if (message?.type === 'cancel') {
    requests.get(message.id)?.abort();
  } else if (message?.type === 'transform') {
    void transform(message.id, message.bytes);
  }
});

async function transform(id, bytes) {
  const controller = new AbortController();
  requests.set(id, controller);
  try {
    const input = Buffer.from(bytes);
    let payload;
    try { payload = JSON.parse(input.toString('utf8')); }
    catch {
      parentPort.postMessage({ type: 'error', id, code: 'proxy_invalid_json' });
      return;
    }
    const result = await processor.transformPayload(payload, { signal: controller.signal });
    if (controller.signal.aborted) {
      parentPort.postMessage({ type: 'cancelled', id });
      return;
    }
    const output = result.stats.transformed > 0 ? Buffer.from(JSON.stringify(result.payload), 'utf8') : input;
    const transfer = transferableBody(output);
    parentPort.postMessage({ type: 'result', id, bytes: transfer.bytes,
      stats: { ...result.stats, workerOutputCopiedBytes: transfer.copiedBytes } }, [transfer.bytes]);
  } catch {
    parentPort.postMessage(controller.signal.aborted
      ? { type: 'cancelled', id }
      : { type: 'error', id, code: 'proxy_image_worker_failed' });
  } finally {
    requests.delete(id);
  }
}
