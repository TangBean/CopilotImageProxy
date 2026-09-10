import { createHash } from 'node:crypto';
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function buildSupervisor({ projectRoot = root } = {}) {
  if (process.platform !== 'win32') throw new Error('The Job supervisor requires Windows.');
  const source = join(projectRoot, 'native', 'JobHost.cs');
  const destination = join(projectRoot, 'bin', 'JobHost.exe');
  const stamp = `${destination}.sha256`;
  const sourceHash = createHash('sha256').update(readFileSync(source)).digest('hex');
  if (existsSync(destination) && existsSync(stamp) && readFileSync(stamp, 'utf8').trim() === sourceHash) return destination;
  const windows = process.env.SystemRoot || 'C:\\Windows';
  const compiler = [join(windows, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'), join(windows, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe')].find(existsSync);
  if (!compiler) throw new Error('The Windows .NET Framework C# compiler was not found.');
  mkdirSync(dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.tmp.exe`;
  try {
    const result = spawnSync(compiler, ['/nologo', '/optimize+', '/target:exe', '/platform:anycpu', `/out:${temporary}`, source], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    if (result.error || result.status !== 0) {
      throw new Error(`Could not build Windows Job supervisor. ${result.error?.message || result.stdout || result.stderr || `Compiler exit ${result.status}`}`);
    }
    renameSync(temporary, destination);
    writeFileSync(stamp, `${sourceHash}\n`, 'utf8');
    return destination;
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(buildSupervisor()); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
