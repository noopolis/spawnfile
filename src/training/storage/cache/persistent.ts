import type { DatabaseSync } from 'node:sqlite';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import type { JudgeCache } from '../../contracts/evaluation.js';
import { contentDigest, digestName, jsonBytes } from '../content.js';
import { initializeStoreRoot, safeStorePath, syncDirectory } from '../filesystem.js';
import { validateCachedJudgment } from './schema.js';

export interface PersistentJudgeCacheOptions {
  /** Trusted host-only root, denied to native subjects by their adapter. */
  root: string;
  /** Explicit calibration epoch; rotate when an unpinned model alias changes. */
  namespace: string;
  maxEntries: number;
  /** Maximum retained serialized entry bytes, not SQLite page overhead. */
  maxBytes: number;
}

const ceiling = 32 * 1024 * 1024;
const format = 'paideia.judgment-cache.v1';

/** Transactional exact cache. Opening/closing each operation releases all locks. */
export async function openJudgeCache(options: PersistentJudgeCacheOptions): Promise<JudgeCache> {
  const { namespace, maxEntries, maxBytes } = options;
  if (!namespace.trim() || namespace.length > 512) throw new Error('Invalid judge cache namespace');
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 10000 ||
    !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > ceiling) throw new Error('Invalid persistent judge cache bounds');
  const { DatabaseSync } = await import('node:sqlite');
  const root = await initializeStoreRoot(options.root);
  const filename = `${digestName(contentDigest(namespace))}.sqlite`;
  const path = await safeStorePath(root, [filename]);
  const created = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    .catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
  if (created) { await created.close(); await syncDirectory(root); }

  async function database<T>(operation: (db: DatabaseSync) => T): Promise<T> {
    await safeStorePath(root, [filename]);
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 67_108_864 || (stat.mode & 0o077) !== 0) throw new Error('Judge cache must be a private bounded regular file');
    } finally { await file.close(); }
    const db = new DatabaseSync(path);
    try {
      db.exec('PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL; PRAGMA max_page_count = 16384;');
      return operation(db);
    } finally { db.close(); }
  }
  await database(db => {
    db.exec('PRAGMA auto_vacuum = FULL; CREATE TABLE IF NOT EXISTS judgments (' +
      'ordinal INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT UNIQUE NOT NULL, body TEXT NOT NULL, digest TEXT NOT NULL, bytes INTEGER NOT NULL)');
    atomic(db, () => prune(db));
  });

  function prune(db: DatabaseSync): void {
    // Compute physical UTF-8 payload length; a damaged accounting column cannot
    // defeat byte eviction. Reads still reject its mismatch instead of repairing it.
    const entries = db.prepare('SELECT key, length(CAST(body AS BLOB)) AS bytes FROM judgments ORDER BY ordinal DESC').all();
    let retainedBytes = 0, retainedEntries = 0;
    for (const entry of entries) {
      const bytes = Number(entry.bytes);
      if (retainedEntries >= maxEntries || retainedBytes + bytes > maxBytes) {
        db.prepare('DELETE FROM judgments WHERE key = ?').run(entry.key!);
      } else { retainedBytes += bytes; retainedEntries++; }
    }
  }

  function read(db: DatabaseSync, key: string) {
    const row = db.prepare('SELECT body, digest, bytes FROM judgments WHERE key = ?').get(key);
    if (!row) return undefined;
    if (typeof row.body !== 'string' || contentDigest(row.body) !== row.digest || Buffer.byteLength(row.body) !== row.bytes) {
      throw new Error('Judge cache integrity mismatch');
    }
    let envelope: { schema: string; namespace: string; key: string; value: unknown };
    try { envelope = JSON.parse(row.body) as typeof envelope; }
    catch { throw new Error('Invalid judge cache envelope'); }
    if (!envelope || envelope.schema !== format || envelope.namespace !== namespace || envelope.key !== key) {
      throw new Error('Judge cache scope mismatch');
    }
    return validateCachedJudgment(envelope.value);
  }
  return {
    persistent: true,
    async get(key) {
      digestName(key);
      return database(db => read(db, key));
    },
    async put(key, value) {
      digestName(key);
      const validated = validateCachedJudgment(value);
      const body = jsonBytes({ schema: format, namespace, key, value: validated });
      const size = Buffer.byteLength(body);
      if (size > maxBytes) return;
      await database(db => {
        atomic(db, () => {
          if (!read(db, key)) {
            db.prepare('INSERT INTO judgments (key, body, digest, bytes) VALUES (?, ?, ?, ?)')
              .run(key, body, contentDigest(body), size);
          }
          prune(db);
        });
      });
    },
  };
}

function atomic(db: DatabaseSync, operation: () => void): void {
  db.exec('BEGIN IMMEDIATE');
  try { operation(); db.exec('COMMIT'); }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
