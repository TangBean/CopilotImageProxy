import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

function parseUpdatedAt(value) {
  const match = /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.(\d+))?(?:Z|[+-]\d{2}:\d{2})$/i.exec(value);
  if (!match) return null;
  const seconds = Date.parse(value.replace(/\.\d+/, '')) / 1000;
  if (!Number.isFinite(seconds) || new Date(`${match[1]}T00:00:00Z`).toISOString().slice(0, 10) !== match[1]) return null;
  const fraction = (match[2] ?? '').replace(/0+$/, '');
  return { seconds, fraction };
}

function parseTitles(contents) {
  const latest = new Map();
  for (const line of contents.split(/\r?\n/)) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (!row || typeof row.id !== 'string' || !row.id.trim() ||
        typeof row.thread_name !== 'string' || typeof row.updated_at !== 'string') continue;
    const updatedAt = parseUpdatedAt(row.updated_at);
    if (!updatedAt) continue;
    const previous = latest.get(row.id);
    if (!previous || updatedAt.seconds > previous.updatedAt.seconds ||
        (updatedAt.seconds === previous.updatedAt.seconds && updatedAt.fraction >= previous.updatedAt.fraction)) {
      latest.set(row.id, { title: row.thread_name, updatedAt });
    }
  }
  return Object.fromEntries([...latest]
    .filter(([, { title }]) => title.trim())
    .map(([id, { title }]) => [id, title]));
}

export function createSessionTitleReader(sessionIndexPath = null) {
  const path = sessionIndexPath ?? join(homedir(), '.codex', 'session_index.jsonl');
  let cached;
  return async () => {
    try {
      const { mtimeMs, size } = await stat(path);
      if (cached && cached.mtimeMs === mtimeMs && cached.size === size) return cached.titles;
      const titles = parseTitles(await readFile(path, 'utf8'));
      cached = { mtimeMs, size, titles };
      return titles;
    } catch {
      cached = undefined;
      return {};
    }
  };
}
