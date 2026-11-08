/**
 * SqliteNanoReplayStore on a real better-sqlite3 file, reopened the way a
 * restart reopens it. Skipped (and said so) where the native binary is absent.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, describe, expect, it } from 'vitest';
import { SqliteNanoReplayStore } from './index';

let available = true;
try { new Database(':memory:').close(); } catch { available = false; }

const dir = mkdtempSync(join(tmpdir(), 'nano-claims-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const open = (file: string, sync = 'FULL') => {
  const db = new Database(file);
  db.pragma(`synchronous = ${sync}`);
  return db;
};

describe.skipIf(!available)('SqliteNanoReplayStore on a real database', () => {
  it('survives a restart: a block claimed before is refused after reopening the file', () => {
    const file = join(dir, 'a.db');
    const first = open(file);
    expect(new SqliteNanoReplayStore(first).claim('HASH1', 'ORDER1', 2000)).toBe(true);
    first.close();
    const second = open(file);
    const store = new SqliteNanoReplayStore(second);
    expect(store.claim('HASH1', 'ORDER9', 2000)).toBe(false);
    expect(store.claim('HASH9', 'ORDER1', 2000)).toBe(false);
    expect(store.claim('HASH2', 'ORDER2', 3000)).toBe(true);
    store.prune(2500);
    expect(store.claim('HASH1', 'ORDER1', 2000)).toBe(true);
    second.close();
  });

  it('is shared by two connections to one file: one wins', () => {
    const file = join(dir, 'b.db');
    const a = open(file);
    const b = open(file);
    const sa = new SqliteNanoReplayStore(a);
    const sb = new SqliteNanoReplayStore(b);
    expect([sa.claim('H', 'O', 1), sb.claim('H', 'O', 1)]).toEqual([true, false]);
    a.close();
    b.close();
  });

  it('refuses a connection with synchronous = OFF', () => {
    const db = open(join(dir, 'c.db'), 'OFF');
    expect(() => new SqliteNanoReplayStore(db)).toThrow('synchronous');
    db.close();
  });
});
