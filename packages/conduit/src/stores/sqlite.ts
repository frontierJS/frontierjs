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
    registered_at   INTEGER NOT NULL,
    last_seen_at    INTEGER
  )
`

// bun:sqlite is synchronous. The ConduitStore interface is async so that a
// networked registry is implementable — these methods satisfy it without
// pretending to do I/O off-thread.
export function createSQLiteStore(db: Database): ConduitStore {

  async function init() {
    db.run(CREATE_TABLE)
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
    db.run(`
      INSERT INTO conduit_targets (id, kind, protocol, address, auth, registered_at, last_seen_at)
      VALUES ($id, $kind, $protocol, $address, $auth, $registered_at, $last_seen_at)
      ON CONFLICT(id) DO UPDATE SET
        kind         = excluded.kind,
        protocol     = excluded.protocol,
        address      = excluded.address,
        auth         = excluded.auth,
        last_seen_at = excluded.last_seen_at
    `, {
      $id:            descriptor.id,
      $kind:          descriptor.kind,
      $protocol:      descriptor.protocol,
      $address:       descriptor.address,
      $auth:          JSON.stringify(descriptor.auth),
      $registered_at: descriptor.registered_at,
      $last_seen_at:  descriptor.last_seen_at
    })
  }

  async function deleteTarget(id: string): Promise<void> {
    db.run(`DELETE FROM conduit_targets WHERE id = $id`, { $id: id })
  }

  async function list(): Promise<TargetDescriptor[]> {
    const rows = db.query(`
      SELECT * FROM conduit_targets ORDER BY registered_at ASC
    `).all() as RawRow[]

    return rows.map(deserialize)
  }

  async function touch(id: string): Promise<void> {
    db.run(`
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
  auth:          string   // JSON string
  registered_at: number
  last_seen_at:  number | null
}

function deserialize(row: RawRow): TargetDescriptor {
  return {
    id:            row.id,
    kind:          row.kind          as TargetDescriptor['kind'],
    protocol:      row.protocol      as TargetDescriptor['protocol'],
    address:       row.address,
    auth:          JSON.parse(row.auth),
    registered_at: row.registered_at,
    last_seen_at:  row.last_seen_at
  }
}
