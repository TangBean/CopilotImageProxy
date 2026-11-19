const maxJsonBytes = 32 * 1024 * 1024;

export class UsageResponseError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'UsageResponseError';
    this.code = code;
    this.status = 502;
  }
}

export async function readUsageResponse(source, { signal } = {}) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of source) {
    signal?.throwIfAborted();
    bytes += chunk.length;
    if (bytes > maxJsonBytes) throw new UsageResponseError('proxy_json_response_limit', '上游 JSON 响应超过 32 MiB 限制。');
    chunks.push(chunk);
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes));
    const value = JSON.parse(text);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object');
    return value;
  } catch {
    throw new UsageResponseError('proxy_response_invalid_json', '上游响应不是有效的 JSON 对象。');
  }
}
