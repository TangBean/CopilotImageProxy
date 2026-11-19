import assert from 'node:assert/strict';
import test from 'node:test';
import { readUsageResponse } from '../src/usage-response.mjs';

test('upstream dashboard usage accepts a fragmented JSON object and rejects invalid responses', async () => {
  const chunks = [Buffer.from('{"period":'), Buffer.from('"today"}')];
  assert.deepEqual(await readUsageResponse(chunks), { period: 'today' });
  for (const invalid of [Buffer.from('{bad}'), Buffer.from('[]'), Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d])]) {
    await assert.rejects(readUsageResponse([invalid]), { status: 502, code: 'proxy_response_invalid_json' });
  }
});

test('upstream dashboard usage rejects a response exceeding 32 MiB across chunks', async () => {
  const chunks = [Buffer.alloc(32 * 1024 * 1024), Buffer.from(' ')];
  await assert.rejects(readUsageResponse(chunks), { status: 502, code: 'proxy_json_response_limit' });
});
