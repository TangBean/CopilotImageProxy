import { Worker, isMarkedAsUntransferable } from 'node:worker_threads';

export class BodyTransformError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    this.name = 'BodyTransformError';
    Object.assign(this, { status, code, details });
  }
}

const failed = () => new BodyTransformError(500, 'proxy_image_worker_failed', '图片转换工作线程失败，请重试当前请求。');
const closedError = () => new BodyTransformError(503, 'proxy_image_worker_closed', '图片转换服务已关闭。');
const abortError = () => Object.assign(new Error('Image body processing aborted'), { name: 'AbortError' });

// The caller gives up ownership of full, independently allocated Buffers.
// Slices and pooled/non-transferable buffers get one dedicated copy instead.
export function transferableBody(buffer) {
  if (buffer.buffer instanceof ArrayBuffer && buffer.byteOffset === 0
    && buffer.byteLength === buffer.buffer.byteLength && !isMarkedAsUntransferable(buffer.buffer)) {
    return { bytes: buffer.buffer, copiedBytes: 0 };
  }
  const copy = new Uint8Array(buffer.byteLength);
  copy.set(buffer);
  return { bytes: copy.buffer, copiedBytes: copy.byteLength };
}

export function createBodyTransformer({ config = {}, useWorker = true,
  workerUrl = new URL('./transform-worker.mjs', import.meta.url) } = {}) {
  const limitBytes = Math.floor((config.maxImageQueueMiB ?? 256) * 1048576);
  const imageConfig = Object.fromEntries(['maxEdge', 'jpegQuality', 'cacheMiB', 'imageConcurrency']
    .filter((key) => config[key] !== undefined).map((key) => [key, config[key]]));
  const pending = new Map();
  let worker;
  let inlineProcessor;
  let processorPromise;
  let nextId = 1;
  let queuedInputBytes = 0;
  let closed = false;

  function finish(id, error, value) {
    const task = pending.get(id);
    if (!task) return;
    pending.delete(id);
    queuedInputBytes -= task.inputBytes;
    if (pending.size === 0) worker?.unref();
    task.signal?.removeEventListener('abort', task.onAbort);
    if (task.settled) return;
    task.settled = true;
    if (error) task.reject(error);
    else task.resolve(value);
  }

  function failAll(error) {
    for (const task of pending.values()) task.controller?.abort();
    for (const id of [...pending.keys()]) finish(id, error);
  }

  function getWorker() {
    if (worker) return worker;
    let current;
    try {
      current = new Worker(workerUrl, { workerData: { imageConfig }, stdout: true, stderr: true });
    } catch { throw failed(); }
    worker = current;
    current.unref();
    current.stdout.resume();
    current.stderr.resume();
    const workerFailed = () => {
      if (worker !== current) return;
      worker = undefined;
      failAll(failed());
      void current.terminate().catch(() => {});
    };
    current.on('error', workerFailed);
    current.on('exit', workerFailed);
    current.on('message', (message) => {
      if (worker !== current || !message || typeof message.id !== 'number') return;
      const task = pending.get(message.id);
      if (!task) return;
      if (message.type === 'result' && message.bytes instanceof ArrayBuffer) {
        finish(message.id, undefined, { body: Buffer.from(message.bytes), stats: {
          ...message.stats, workerInputCopiedBytes: task.copiedBytes,
        } });
      } else if (message.type === 'cancelled') {
        finish(message.id, abortError());
      } else if (message.type === 'error') {
        // Only our finite internal error codes cross the trust boundary. Do not
        // forward a worker exception message or stack, which may quote JSON.
        const error = message.code === 'proxy_invalid_json'
          ? new BodyTransformError(400, 'proxy_invalid_json', '请求体不是有效 JSON。')
          : failed();
        finish(message.id, error);
      } else {
        workerFailed();
      }
    });
    return current;
  }

  async function inlineTransform(task, body) {
    try {
      processorPromise ??= import('./images.mjs').then(({ createImageProcessor }) => {
        if (closed) throw closedError();
        inlineProcessor = createImageProcessor(imageConfig);
        return inlineProcessor;
      });
      const processor = await processorPromise;
      if (task.controller.signal.aborted) throw abortError();
      let payload;
      try { payload = JSON.parse(body.toString('utf8')); }
      catch { throw new BodyTransformError(400, 'proxy_invalid_json', '请求体不是有效 JSON。'); }
      const result = await processor.transformPayload(payload, { signal: task.controller.signal });
      if (task.controller.signal.aborted) throw abortError();
      finish(task.id, undefined, {
        body: result.stats.transformed > 0 ? Buffer.from(JSON.stringify(result.payload), 'utf8') : body,
        stats: { ...result.stats, workerInputCopiedBytes: 0, workerOutputCopiedBytes: 0 },
      });
    } catch (error) {
      finish(task.id, error instanceof BodyTransformError || error?.name === 'AbortError' ? error : failed());
    }
  }

  return {
    transform(body, { signal } = {}) {
      if (closed) return Promise.reject(closedError());
      if (signal?.aborted) return Promise.reject(abortError());
      if (queuedInputBytes + body.byteLength > limitBytes) {
        return Promise.reject(new BodyTransformError(503, 'proxy_image_queue_full', '图片转换队列已满，请稍后重试。', {
          queuedInputBytes, requestBytes: body.byteLength, limitBytes,
        }));
      }
      let current;
      let transfer;
      if (useWorker) {
        try { current = getWorker(); transfer = transferableBody(body); }
        catch { return Promise.reject(failed()); }
      }
      const id = nextId++;
      const inputBytes = body.byteLength;
      queuedInputBytes += inputBytes;
      return new Promise((resolve, reject) => {
        const task = { id, inputBytes, resolve, reject, signal, settled: false,
          copiedBytes: transfer?.copiedBytes ?? 0, controller: useWorker ? undefined : new AbortController() };
        task.onAbort = () => {
          if (task.settled) return;
          task.settled = true;
          task.reject(abortError());
          task.signal?.removeEventListener('abort', task.onAbort);
          task.controller?.abort();
          // Retain byte admission until the worker acknowledges completion or
          // cancellation; a disconnected caller does not free active memory.
          if (current && worker === current) {
            try { current.postMessage({ type: 'cancel', id }); }
            catch { finish(id, failed()); }
          }
        };
        pending.set(id, task);
        signal?.addEventListener('abort', task.onAbort, { once: true });
        if (useWorker) {
          current.ref();
          try { current.postMessage({ type: 'transform', id, bytes: transfer.bytes }, [transfer.bytes]); }
          catch { finish(id, failed()); }
        } else {
          void inlineTransform(task, body);
        }
      });
    },
    getState() {
      return { queuedInputBytes, pendingRequests: pending.size, workerThreadId: worker?.threadId ?? null, closed };
    },
    async close() {
      if (closed) return;
      closed = true;
      failAll(closedError());
      inlineProcessor?.close();
      const current = worker;
      worker = undefined;
      if (current) await current.terminate();
    },
  };
}
