import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const MOCK_NPM = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const pathKeys = Object.keys(process.env).filter((key) => key.toLowerCase() === 'path');
fs.appendFileSync(process.env.CIP_TEST_RECORD, JSON.stringify({ args, cwd: process.cwd(), pathKeys,
  pathFirst: (process.env[pathKeys[0]] || '').split(path.delimiter)[0] }) + '\n');
const mode = process.env.CIP_TEST_MODE || 'ok';
if (args[0] === 'view') {
  if (mode === 'lookup-fail') {
    process.stderr.write(process.env.CIP_TEST_SECRET);
    process.exit(42);
  }
  if (mode === 'lookup-invalid') process.stdout.write(process.env.CIP_TEST_INVALID);
  else process.stdout.write(JSON.stringify(process.env.CIP_TEST_VERSION || '2.5.3') + '\n');
} else if (args[0] === 'exec') {
  if (mode === 'install-fail') {
    process.stderr.write(process.env.CIP_TEST_SECRET);
    process.exit(23);
  }
  if (mode === 'abort-wait') {
    setTimeout(() => process.exit(0), 10000);
  } else if (mode === 'missing-marker') {
    process.stdout.write('unrelated npm output\n{"version":"2.5.3"}\n');
  } else {
    const separator = args.indexOf('--');
    const command = args[separator + 1];
    const commandArgs = args.slice(separator + 2);
    const env = { ...process.env };
    const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') || 'PATH';
    const originalPath = env[pathKey] || '';
    for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
    env[pathKey] = process.env.CIP_TEST_BIN + path.delimiter + originalPath;
    const child = spawnSync(command, commandArgs, { env, cwd: process.cwd(), encoding: 'utf8', shell: false });
    process.stdout.write('npm notice: mock preparation output\n{"version":"0.0.0","binPath":"wrong"}\n');
    let output = child.stdout || '';
    if (mode === 'wrong-version') output = output.replace('"version":"2.5.3"', '"version":"9.9.9"');
    process.stdout.write(output);
    if (mode === 'duplicate-marker') process.stdout.write(output);
    process.stderr.write(child.stderr || '');
    process.exitCode = child.status === null ? 1 : child.status;
  }
} else {
  process.exitCode = 99;
}
`;

export async function createUpstreamPackageFixture(t, overrides = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'copilot-upstream-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'owned project 空格 & %');
  const cacheModules = path.join(root, 'npm cache 中文 & %', 'node_modules');
  const binDirectory = path.join(cacheModules, '.bin');
  const packageDirectory = path.join(cacheModules, '@jeffreycao', 'copilot-api');
  const binPath = path.join(packageDirectory, 'dist', 'main.js');
  const npmCli = path.join(root, 'mock npm', 'npm-cli.js');
  const record = path.join(root, 'calls.jsonl');
  await Promise.all([
    mkdir(cwd, { recursive: true }), mkdir(binDirectory, { recursive: true }),
    mkdir(path.dirname(binPath), { recursive: true }), mkdir(path.dirname(npmCli), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(npmCli, MOCK_NPM),
    writeFile(path.join(cwd, 'package.json'), JSON.stringify({ name: 'copilot-image-proxy', private: true })),
    writeFile(path.join(packageDirectory, 'package.json'), JSON.stringify({
      name: '@jeffreycao/copilot-api', version: '2.5.3', bin: { 'copilot-api': './dist/main.js' },
    })),
    writeFile(binPath, 'throw new Error("THE_DOWNLOADED_PACKAGE_MUST_NOT_EXECUTE_DURING_RESOLUTION");\n'),
  ]);
  const env = {
    ...process.env, npm_execpath: npmCli, CIP_TEST_RECORD: record, CIP_TEST_BIN: binDirectory,
    CIP_TEST_SECRET: 'SENTINEL_NOT_FOR_LOGS', ...overrides,
  };
  return {
    root, cwd, packageDirectory, binDirectory, binPath, env,
    calls: async () => (await readFile(record, 'utf8')).trim().split('\n').map((line) => JSON.parse(line)),
  };
}
