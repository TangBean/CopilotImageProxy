import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readImageSample } from '../scripts/image-sample.mjs';

async function removeFixture(directory) {
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
  await rm(directory, { recursive: true, force: true });
}

function run(script, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL(`../scripts/${script}`, import.meta.url)), ...args], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000,
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

test('validation scripts reject empty image samples before producing reports or contacting models', { timeout: 15000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'cip-validation-'));
  t.after(() => removeFixture(directory));
  const sample = join(directory, 'empty.jsonl');
  await writeFile(sample, JSON.stringify({ type: 'response_item', payload: { type: 'message', content: [{ type: 'input_text', text: 'no image' }] } }) + '\n');
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests++;
    req.resume();
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'failed', error: { code: 'unexpected_request' } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  for (const script of ['validate-sample.mjs', 'validate-live.mjs', 'validate-tool-roundtrip.mjs']) {
    const output = join(directory, script + '.json');
    const args = script === 'validate-sample.mjs' ? [sample, output] : [sample, output, baseUrl];
    const result = await run(script, args);
    assert.equal(result.signal, null, script);
    assert.equal(result.code, 1, script);
    assert.match(result.stderr, /at least \d+.*image/i, script);
    await assert.rejects(readFile(output), { code: 'ENOENT' });
  }
  assert.equal(requests, 0);
});

test('sample reader preserves typed image order, ignores UI mirrors, and validates required counts', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'cip-sample-'));
  t.after(() => removeFixture(directory));
  const filename = join(directory, 'sample.jsonl');
  const first = { type: 'input_image', image_url: 'data:image/png;base64,AA==', detail: 'original' };
  const second = { type: 'input_image', image_url: 'data:image/png;base64,AQ==' };
  await writeFile(filename, [
    { type: 'event_msg', payload: { type: 'message', content: [first] } },
    { type: 'response_item', payload: { type: 'message', content: [null, first, { type: 'input_image', image_url: 123 }] } },
    { type: 'response_item', payload: { type: 'function_call_output', output: [second] } },
  ].map(row => JSON.stringify(row)).join('\n'));
  const result = await readImageSample(filename, 2);
  assert.deepEqual(result.images, [first, second]);
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  await assert.rejects(readImageSample(filename, 3), /at least 3.*found 2/);
  await writeFile(filename, '{}\n{"PRIVATE_SAMPLE_TEXT": broken');
  await assert.rejects(readImageSample(filename), error => error.message === 'Invalid rollout JSON at line 2.');
});
