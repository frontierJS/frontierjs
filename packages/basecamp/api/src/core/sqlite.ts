// The raw bun:sqlite handle beside the Litestone client — migrations run on it
// before the client opens, and conduit's store, the health probe and
// `app.sqlite` want a Database rather than an ORM. Litestone opens it so the
// wait-then-WAL rule and its retry are the client's own (`FJS-D646`).
import type { Database } from 'bun:sqlite'
import { openWalDatabase } from '@frontierjs/litestone/engine'

export function openSqlite(path: string): Database {
  const db: Database = openWalDatabase(path.replace(/^file:/, ''), { create: true })
  db.run('PRAGMA synchronous  = NORMAL')
  db.run('PRAGMA foreign_keys = ON')
  return db
}
