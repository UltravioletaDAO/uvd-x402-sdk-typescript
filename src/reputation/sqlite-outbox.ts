/**
 * The outbox on SQLite, through a `better-sqlite3` database the program
 * opens and passes in. The SDK never loads `better-sqlite3` itself: it is an
 * optional peer dependency, and only programs that use this adapter install
 * it.
 *
 * ```ts
 * import Database from 'better-sqlite3';
 * const outbox = new SqliteRatingOutbox(new Database('reputation.db'));
 * ```
 *
 * Two tables, prefixed so they can live in the program's own database:
 * `uvd_reputation_outbox` (one row per ref, its key columns plus the whole
 * row as JSON) and `uvd_reputation_state` (key/value, for the governor's
 * breaker). `PRAGMA user_version` is left alone: it belongs to the program.
 *
 * Every transition runs inside `BEGIN IMMEDIATE` and its `UPDATE` repeats the
 * expected status in its `WHERE`, so two processes on one file cannot both
 * move a row; the loser gets `null` and sends nothing. The connection must
 * run with `PRAGMA synchronous = FULL` (or `EXTRA`): the constructor refuses
 * anything less, because a commit a power cut can undo is a payment signed
 * twice.
 */

import { ReputationError } from './errors';
import {
  ACTIVE_STATUSES,
  DUE_ORDER,
  applyTransition,
  forgetRow,
  newRow,
  settling,
  type CountFilter,
  type ForgetReport,
  type NewRating,
  type RatingOutbox,
  type RatingPatch,
  type RatingRow,
  type RatingStatus,
} from './outbox';

/** The part of a `better-sqlite3` `Database` this adapter uses. */
export interface SqliteDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): SqliteStatement;
  transaction<F extends (...args: any[]) => any>(fn: F): F & { immediate: F };
}

export interface SqliteStatement {
  run(...params: unknown[]): { changes: number };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

const SCHEMA_KEY = 'uvd_reputation.schema';
const SCHEMA_VERSION = '1';

export class SqliteRatingOutbox implements RatingOutbox {
  private readonly db: SqliteDatabase;
  private readonly now: () => number;

  constructor(db: SqliteDatabase, options: { now?: () => number } = {}) {
    if (!db || typeof db.prepare !== 'function' || typeof db.transaction !== 'function') {
      throw new ReputationError('invalid_input', 'SqliteRatingOutbox needs a better-sqlite3 Database');
    }
    // "Stored before it is broadcast" holds only if a commit survives a power
    // cut. Below FULL (with WAL and NORMAL, say) the last commits can roll back
    // after a crash, the row is `queued` again, and the payment is signed twice.
    const sync = db.prepare('PRAGMA synchronous').get() as { synchronous?: number } | undefined;
    if (!sync || typeof sync.synchronous !== 'number' || sync.synchronous < 2) {
      throw new ReputationError(
        'invalid_input',
        'SqliteRatingOutbox needs PRAGMA synchronous = FULL (2) or EXTRA (3) on this connection'
      );
    }
    this.db = db;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    db.exec(`
      CREATE TABLE IF NOT EXISTS uvd_reputation_outbox (
        ref TEXT PRIMARY KEY,
        viewer_id TEXT,
        subject TEXT NOT NULL,
        stream_id TEXT NOT NULL,
        status TEXT NOT NULL,
        next_attempt_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        row TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS uvd_reputation_outbox_due ON uvd_reputation_outbox (status, next_attempt_at);
      CREATE INDEX IF NOT EXISTS uvd_reputation_outbox_subject ON uvd_reputation_outbox (subject, started_at);
      CREATE INDEX IF NOT EXISTS uvd_reputation_outbox_stream ON uvd_reputation_outbox (stream_id, started_at);
      CREATE INDEX IF NOT EXISTS uvd_reputation_outbox_viewer ON uvd_reputation_outbox (viewer_id);
      CREATE TABLE IF NOT EXISTS uvd_reputation_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    const stored = db.prepare('SELECT value FROM uvd_reputation_state WHERE key = ?').get(SCHEMA_KEY) as
      | { value: string }
      | undefined;
    if (stored === undefined) {
      db.prepare('INSERT INTO uvd_reputation_state (key, value) VALUES (?, ?)').run(SCHEMA_KEY, SCHEMA_VERSION);
    } else if (stored.value !== SCHEMA_VERSION) {
      throw new ReputationError('invalid_input', `the outbox tables are schema ${stored.value}, this SDK reads ${SCHEMA_VERSION}`);
    }
  }

  private read(ref: string): RatingRow | null {
    const found = this.db.prepare('SELECT row FROM uvd_reputation_outbox WHERE ref = ?').get(ref) as
      | { row: string }
      | undefined;
    return found === undefined ? null : (JSON.parse(found.row) as RatingRow);
  }

  private write(row: RatingRow, expected: RatingStatus | null): boolean {
    const values = [
      row.viewerId,
      row.subject,
      row.streamId,
      row.status,
      row.nextAttemptAt,
      row.createdAt,
      row.startedAt,
      JSON.stringify(row),
    ];
    if (expected === null) {
      return (
        this.db
          .prepare(
            `INSERT INTO uvd_reputation_outbox
               (viewer_id, subject, stream_id, status, next_attempt_at, created_at, started_at, row, ref)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (ref) DO NOTHING`
          )
          .run(...values, row.ref).changes === 1
      );
    }
    return (
      this.db
        .prepare(
          `UPDATE uvd_reputation_outbox
             SET viewer_id = ?, subject = ?, stream_id = ?, status = ?, next_attempt_at = ?,
                 created_at = ?, started_at = ?, row = ?
           WHERE ref = ? AND status = ?`
        )
        .run(...values, row.ref, expected).changes === 1
    );
  }

  async enqueue(rating: NewRating): Promise<'inserted' | 'duplicate'> {
    return this.write(newRow(rating, this.now()), null) ? 'inserted' : 'duplicate';
  }

  async get(ref: string): Promise<RatingRow | null> {
    return this.read(ref);
  }

  async due(now: number, limit: number): Promise<RatingRow[]> {
    const placeholders = ACTIVE_STATUSES.map(() => '?').join(', ');
    const order = `CASE status ${ACTIVE_STATUSES.map((s) => `WHEN '${s}' THEN ${DUE_ORDER[s]}`).join(' ')} ELSE 9 END`;
    const rows = this.db
      .prepare(
        `SELECT row FROM uvd_reputation_outbox
          WHERE status IN (${placeholders}) AND next_attempt_at <= ?
          ORDER BY ${order}, next_attempt_at, created_at, ref
          LIMIT ?`
      )
      .all(...ACTIVE_STATUSES, now, Math.max(0, Math.floor(limit))) as Array<{ row: string }>;
    return rows.map((r) => JSON.parse(r.row) as RatingRow);
  }

  async transition(ref: string, from: RatingStatus, patch: RatingPatch, expectVersion?: number): Promise<RatingRow | null> {
    // BEGIN IMMEDIATE: the row read here is the latest, so the status and
    // version applyTransition compares are the compare-and-set itself.
    const run = this.db.transaction((): RatingRow | null => {
      const row = this.read(ref);
      if (!row) throw new ReputationError('row_missing', 'no outbox row has this ref');
      const next = applyTransition(row, from, JSON.parse(JSON.stringify(patch)) as RatingPatch, this.now(), expectVersion);
      if (next === null) return null;
      return this.write(next, from) ? next : null;
    });
    return run.immediate();
  }

  async count(filter: CountFilter): Promise<number> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.subject !== undefined) {
      where.push('subject = ?');
      params.push(filter.subject.toLowerCase());
    }
    if (filter.streamId !== undefined) {
      where.push('stream_id = ?');
      params.push(filter.streamId);
    }
    if (filter.admitted || filter.since !== undefined) where.push('started_at IS NOT NULL');
    if (filter.since !== undefined) {
      where.push('started_at >= ?');
      params.push(filter.since);
    }
    if (filter.statuses !== undefined) {
      if (filter.statuses.length === 0) return 0;
      where.push(`status IN (${filter.statuses.map(() => '?').join(', ')})`);
      params.push(...filter.statuses);
    }
    const sql = `SELECT COUNT(*) AS n FROM uvd_reputation_outbox${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`;
    return Number((this.db.prepare(sql).get(...params) as { n: number }).n);
  }

  async forget(viewerId: string): Promise<ForgetReport> {
    const report: ForgetReport = { deleted: 0, scrubbed: 0, inFlight: 0 };
    if (typeof viewerId !== 'string' || viewerId === '') return report;
    const run = this.db.transaction(() => {
      const now = this.now();
      const rows = this.db
        .prepare('SELECT row FROM uvd_reputation_outbox WHERE viewer_id = ?')
        .all(viewerId) as Array<{ row: string }>;
      for (const { row: text } of rows) {
        const row = JSON.parse(text) as RatingRow;
        const result = forgetRow(row, now);
        if (result === 'delete') {
          this.db.prepare('DELETE FROM uvd_reputation_outbox WHERE ref = ? AND status = ?').run(row.ref, row.status);
          report.deleted++;
        } else {
          this.write(result, row.status);
          report.scrubbed++;
          if (settling(result)) report.inFlight++;
        }
      }
    });
    run.immediate();
    return report;
  }

  async getState(key: string): Promise<string | null> {
    const found = this.db.prepare('SELECT value FROM uvd_reputation_state WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return found === undefined ? null : found.value;
  }

  async setState(key: string, value: string): Promise<void> {
    this.db
      .prepare('INSERT INTO uvd_reputation_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }
}
