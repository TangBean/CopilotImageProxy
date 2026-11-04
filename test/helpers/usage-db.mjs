import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export async function createUsageDb(t, rows = [], { wal = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'copilot-usage-range-'));
  const path = join(directory, 'usage.sqlite');
  const db = new DatabaseSync(path);
  t.after(async () => {
    if (db.isOpen) db.close();
    await rm(directory, { recursive: true, force: true });
  });
  if (wal) db.exec('PRAGMA journal_mode = WAL');
  db.exec(`CREATE TABLE token_usage_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at_ms INTEGER NOT NULL, created_at_utc TEXT NOT NULL, trace_id TEXT NOT NULL,
    session_id TEXT NOT NULL DEFAULT '', user_id TEXT NOT NULL DEFAULT '', user_agent TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL, endpoint TEXT NOT NULL, provider_name TEXT, model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_input_tokens INTEGER NOT NULL DEFAULT 0, cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0, total_nano_aiu INTEGER,
    cost_currency TEXT, total_cost_nanos INTEGER, cost_source TEXT,
    request_id TEXT, first_token_ms REAL, duration_ms REAL, request_outcome TEXT
  );
  CREATE INDEX idx_token_usage_events_created_at_ms ON token_usage_events(created_at_ms);
  CREATE INDEX idx_token_usage_events_request_id ON token_usage_events(request_id);`);
  const insert = (row) => {
    const createdAt = row.created_at_ms ?? Date.parse('2026-01-01T00:00:00Z');
    const event = {
      created_at_ms: createdAt, created_at_utc: new Date(createdAt).toISOString(), trace_id: 'trace',
      session_id: '', user_id: '', user_agent: '', source: 'responses', endpoint: '/responses',
      provider_name: null, model: 'model-a', input_tokens: 0, output_tokens: 0,
      cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
      total_tokens: (row.input_tokens ?? 0) + (row.output_tokens ?? 0) +
        (row.cache_read_input_tokens ?? 0) + (row.cache_creation_input_tokens ?? 0),
      total_nano_aiu: null, cost_currency: null, total_cost_nanos: null, cost_source: null,
      request_id: null, first_token_ms: null, duration_ms: null, request_outcome: null,
      ...row,
    };
    return Number(db.prepare(`INSERT INTO token_usage_events (${Object.keys(event).join(', ')})
      VALUES (${Object.keys(event).map(() => '?').join(', ')})`).run(...Object.values(event)).lastInsertRowid);
  };
  for (const row of rows) insert(row);
  return { path, db, insert };
}
