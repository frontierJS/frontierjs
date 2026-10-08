// The raw bun:sqlite handle beside the Litestone client — migrations run on it
// before the client opens, and conduit's store, the health probe and
// `app.sqlite` want a Database rather than an ORM. Junction opened this once
// (`FJS-D641`); the pragmas are the ones a file written by two processes needs.
import { Database } from 'bun:sqlite'

export function openSqlite(path: string): Database {
  const db = new Database(path.replace(/^file:/, ''), { create: true })
  // The wait first, then WAL: the switch needs the lock another process may hold.
  db.run('PRAGMA busy_timeout = 5000')
  db.run('PRAGMA journal_mode = WAL')
  db.run('PRAGMA synchronous  = NORMAL')
  db.run('PRAGMA foreign_keys = ON')
  return db
}
