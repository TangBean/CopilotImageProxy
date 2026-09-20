import assert from 'node:assert/strict';
import test from 'node:test';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, copyFile, writeFile, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { buildSupervisor } from '../scripts/build-supervisor.mjs';

test('concurrent first builds reuse the completed supervisor even while it is running', { skip: process.platform !== 'win32', timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'cip-build-'));
  const children = [], exits = [];
  t.after(async () => {
    for (const child of children) if (child.connected) child.send('stop');
    await Promise.all(exits);
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(root, 'native'));
  await mkdir(join(root, 'scripts'));
  await copyFile(new URL('../scripts/build-supervisor.mjs', import.meta.url), join(root, 'scripts', 'build-supervisor.mjs'));
  const source = 'using System; using System.Threading; class Fixture { static void Main() { Console.WriteLine("ready"); Thread.Sleep(60000); } }';
  await writeFile(join(root, 'native', 'JobHost.cs'), source);
  const worker = join(root, 'worker.mjs');
  await writeFile(worker, `
import { spawn } from 'node:child_process';
import { buildSupervisor } from './scripts/build-supervisor.mjs';
let executable;
process.on('message', message => {
  if (message === 'go') {
    try {
      const filename = buildSupervisor();
      executable = spawn(filename, [], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      executable.once('error', error => process.send({ error: error.message }));
      executable.stderr.resume();
      executable.stdout.once('data', () => process.send({ built: filename }));
    } catch (error) { process.send({ error: error.message }); }
  } else {
    if (executable && executable.exitCode === null) {
      executable.once('close', () => process.disconnect());
      executable.kill();
    } else process.disconnect();
  }
});
process.send({ ready: true });
`);
  for (let index = 0; index < 4; index++) {
    const child = fork(worker, [], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    children.push(child);
    child.stderr.resume();
    exits.push(once(child, 'exit'));
  }
  const ready = await Promise.all(children.map(child => once(child, 'message')));
  assert.ok(ready.every(([message]) => message.ready));
  const results = children.map(child => once(child, 'message'));
  for (const child of children) child.send('go');
  const completed = (await Promise.all(results)).map(([message]) => message);
  const filename = `JobHost.${createHash('sha256').update(source).digest('hex')}.exe`;
  assert.ok(completed.every(row => row.built === join(root, 'bin', filename)), JSON.stringify(completed));
  assert.deepEqual(await readdir(join(root, 'bin')), [filename]);
  const original = await readFile(join(root, 'bin', filename));
  await writeFile(join(root, 'native', 'JobHost.cs'), source + '\n// new source version\n');
  const updated = buildSupervisor({ projectRoot: root });
  assert.notEqual(updated, join(root, 'bin', filename));
  assert.deepEqual(await readFile(join(root, 'bin', filename)), original);
});
