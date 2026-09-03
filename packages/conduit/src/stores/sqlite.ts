// ============================================================
// Conduit — SQLite Store
// Persistent registry backend using bun:sqlite.
// Targets survive process restarts.
// Pass createSQLiteStore(db) to createConduit({ store: ... })
// ============================================================

import type { Database } from 'bun:sqlite'
import type { ConduitStore, TargetDescriptor } from '../types.ts'

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS conduit_targets (
    id              TEXT PRIMARY KEY,
    kind            TEXT NOT NULL,
    protocol        TEXT NOT NULL,
    address         TEXT NOT NULL,
    auth            TEXT NOT NULL,
    extra           TEXT,
    registered_at   INTEGER NOT NULL,
    last_seen_at    INTEGER
  )
`

// The descriptor's optional fields, carried as one JSON column.
//
// One column rather than one per field, because every one of these is optional
// and a column each means a migration each — and the first two got here by
// being forgotten: `encoding` shipped for `FJS-556` and was never added to this
// store, so a target declared `form` came back `json` after a restart and every
// body went out as JSON again, which is the defect that feature exists to fix,
// resurrected by persistence alone. A registry that drops what it is given is
// worse than one that refuses it.
// A descriptor field absent from this list is dropped on write with nothing
// said — the row round-trips, the target works, and the field it was declared
// with is simply not there after a restart (`FJS-657`).
const EXTRA_KEYS = ['encoding', 'headers', 'follow_redirects'] as const

// `CREATE TABLE IF NOT EXISTS` does nothing to a table that already exists, so a
// registry written before this column simply lacks it. Added idempotently rather
// than versioned: there is one column, its absence is decidable from PRAGMA, and
// a migration framework for a single optional blob is more machinery than fact.
function ensureExtraColumn(db: Database): void {
  const cols = db.query(`PRAGMA table_info(conduit_targets)`).all() as Array<{ name: string }>
  if (cols.some(c => c.name === 'extra')) return
  db.run(`ALTER TABLE conduit_targets ADD COLUMN extra TEXT`)
}

// bun:sqlite is synchronous. The ConduitStore interface is async so that a
// networked registry is implementable — these methods satisfy it without
// pretending to do I/O off-thread.
// bun:sqlite accepts a named-parameter object at runtime, but its `run`
// overload is typed `SQLQueryBindings[]` (positional only). Narrowed here
// once rather than casting at four call sites.
type NamedParams = Record<string, string | number | null>
type RunNamed = (sql: string, params: NamedParams) => unknown

export function createSQLiteStore(db: Database): ConduitStore {
  const run = db.run.bind(db) as unknown as RunNamed


  async function init() {
    db.run(CREATE_TABLE)
    ensureExtraColumn(db)
  }

  async function get(id: string): Promise<TargetDescriptor | null> {
    const row = db.query(`
      SELECT * FROM conduit_targets WHERE id = $id
    `).get({ $id: id }) as RawRow | null

    return row ? deserialize(row) : null
  }

  async function set(descriptor: TargetDescriptor): Promise<void> {
    // registered_at is intentionally excluded from the UPDATE clause —
    // we never overwrite the original registration timestamp on heartbeat.
    run(`
      INSERT INTO conduit_targets (id, kind, protocol, address, auth, extra, registered_at, last_seen_at)
      VALUES ($id, $kind, $protocol, $address, $auth, $extra, $registered_at, $last_seen_at)
      ON CONFLICT(id) DO UPDATE SET
        kind         = excluded.kind,
        protocol     = excluded.protocol,
        address      = excluded.address,
        auth         = excluded.auth,
        extra        = excluded.extra,
        last_seen_at = excluded.last_seen_at
    `, {
      $id:            descriptor.id,
      $kind:          descriptor.kind,
      $protocol:      descriptor.protocol,
      $address:       descriptor.address,
      $auth:          JSON.stringify(descriptor.auth),
      $extra:         serializeExtra(descriptor),
      $registered_at: descriptor.registered_at,
      $last_seen_at:  descriptor.last_seen_at
    })
  }

  async function deleteTarget(id: string): Promise<void> {
    run(`DELETE FROM conduit_targets WHERE id = $id`, { $id: id })
  }

  async function list(): Promise<TargetDescriptor[]> {
    const rows = db.query(`
      SELECT * FROM conduit_targets ORDER BY registered_at ASC
    `).all() as RawRow[]

    return rows.map(deserialize)
  }

  async function touch(id: string): Promise<void> {
    run(`
      UPDATE conduit_targets SET last_seen_at = $now WHERE id = $id
    `, { $id: id, $now: Date.now() })
  }

  return { init, get, set, delete: deleteTarget, list, touch }
}

// ─── Internal ────────────────────────────────────────────────

interface RawRow {
  id:            string
  kind:          string
  protocol:      string
  address:       string
  auth:          string          // JSON string
  extra:         string | null   // JSON string — the optional fields, see EXTRA_KEYS
  registered_at: number
  last_seen_at:  number | null
}

// `null` rather than '{}' when there is nothing to carry, so a row says plainly
// that the descriptor declared none of them.
function serializeExtra(descriptor: TargetDescriptor): string | null {
  const extra: Record<string, unknown> = {}
  for (const key of EXTRA_KEYS) {
    const value = descriptor[key]
    if (value !== undefined) extra[key] = value
  }
  return Object.keys(extra).length ? JSON.stringify(extra) : null
}

function deserialize(row: RawRow): TargetDescriptor {
  return {
    id:            row.id,
    kind:          row.kind          as TargetDescriptor['kind'],
    protocol:      row.protocol      as TargetDescriptor['protocol'],
    address:       row.address,
    auth:          JSON.parse(row.auth),
    // A row written before the column exists reads null; a row whose JSON is
    // unreadable is treated the same way, because a registry that throws on
    // read takes every OTHER target down with the one that is corrupt.
    ...parseExtra(row.extra),
    registered_at: row.registered_at,
    last_seen_at:  row.last_seen_at
  }
}

function parseExtra(raw: string | null): Partial<TargetDescriptor> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of EXTRA_KEYS) {
      if (parsed[key] !== undefined) out[key] = parsed[key]
    }
    return out as Partial<TargetDescriptor>
  } catch {
    return {}
  }
}
