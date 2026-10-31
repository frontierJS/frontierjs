// src/domain/backup/app-archive-import.ts
// An archive a person uploads, put in the app's bucket as a restorable row
// (`IDEAS/app-archives.md` 3.1). The bytes arrive on `plugins/app-archive-upload.ts`'s
// stream route; who may send them was graded by `appBackups.upload`.
//
// ─── Refused before anything lands ────────────────────────────────────────
//
// A row is restorable once it has a sha256, so a garbage file that reached the
// bucket would read as an archive. The upload is checked on this disk first:
// a gzipped tar must be flat, hold only plain files, and list at least one
// top-level `*.db` (the shape `IDEAS/app-archives.md` 0.1 recorded); a bare
// file must open as SQLite. Nothing is keyed to the app's id — an archive of
// one app restored onto another is the point.
//
// ─── A bare database is wrapped ───────────────────────────────────────────
//
// Into the same flat `tar.gz` under its own name (`FJS-D1719`), keyed
// `<appId>-<stamp>.db.tar.gz` (`FJS-D1724`), which is how a restore and a
// rescan know it replaces one database and not the volume.
//
// ─── One row kind ─────────────────────────────────────────────────────────
//
// `found`, as `rescanAppArchives` writes one, with the digest taken here
// rather than by a read-through, and `requestedBy` naming the uploader. Only
// the app's own bucket takes it (`FJS-D1718`).

import { Database }   from 'bun:sqlite'
import { mkdirSync, mkdtempSync, renameSync, rmSync, statSync } from 'node:fs'
import { tmpdir }     from 'node:os'
import { dirname, join } from 'node:path'
import { keyUnder }   from '../../providers/storage/index.ts'
import { destinationFor, mintPut } from '../../jobs/app-backup-run.job.ts'
import { receiveUpload } from './hub-restore.ts'
import type { App }   from '@frontierjs/junction'

/** A database name a bare upload may carry: one path segment, ending `.db`. */
export const DB_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}\.db$/

const GZIP   = [0x1f, 0x8b]
const SQLITE = 'SQLite format 3\0'

type Imported = { row: Record<string, unknown> } | { refused: string; status: number }

/**
 * Take one uploaded file into the app's bucket and answer its row, or why not
 * with nothing written. `name` is the file's own name, used only to wrap a
 * bare database.
 */
export async function importAppArchive(app: App, opts: {
  appId: string; name: string; by: string; body: ReadableStream<Uint8Array> | null
}): Promise<Imported> {
  const sys    = app.db!.asSystem()
  const target = await sys.app.findFirst({ where: { id: opts.appId } })
  if (!target) return { refused: `No app '${opts.appId}'`, status: 404 }
  const dest = await destinationFor(app, target)
  if (!dest) return { refused: `App '${target.name}' names no backup destination — give it one to import an archive`, status: 400 }

  const work = scratch(app)
  try {
    const upload = join(work, 'upload')
    const failed = await receiveUpload(opts.body, upload)
    if (failed) return { refused: failed.error, status: 400 }

    const head = new Uint8Array(await Bun.file(upload).slice(0, 16).arrayBuffer())
    let tarball = upload, wrapped = false
    if (head[0] === GZIP[0] && head[1] === GZIP[1]) {
      const why = await tarRefusal(upload)
      if (why) return { refused: why, status: 422 }
    } else if (new TextDecoder().decode(head) === SQLITE) {
      if (!DB_NAME.test(opts.name)) return { refused: `A database uploads under its own name ending .db; '${opts.name}' is not one`, status: 422 }
      const why = sqliteRefusal(upload)
      if (why) return { refused: why, status: 422 }
      tarball = await wrap(work, upload, opts.name)
      wrapped = true
    } else {
      return { refused: 'The file is neither a gzipped tar nor a SQLite database', status: 422 }
    }

    const sha256 = await digest(tarball)
    const at     = new Date().toISOString()
    const key    = keyUnder(dest, `${target.id}-${at.replace(/[:.]/g, '-')}${wrapped ? '.db' : ''}.tar.gz`)
    const res    = await fetch(await mintPut(app, dest, key), { method: 'PUT', body: Bun.file(tarball), headers: { 'content-type': 'application/gzip' } })
    if (!res.ok) return { refused: `'${dest.name}' refused the upload (${res.status}): ${(await res.text()).slice(0, 300)}`, status: 502 }

    const row = await sys.appBackup.create({ data: {
      appId: target.id, serverId: null, destinationId: dest.id, kind: 'found', status: 'success',
      location: key, sizeBytes: statSync(tarball).size, sha256, startedAt: at, finishedAt: new Date().toISOString(),
      requestedBy: opts.by,
    } })
    return { row }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

/** Beside the live database, so a large upload lands on the volume that has room for archives. */
function scratch(app: App): string {
  const live = app.sqlite.filename
  const dir  = live && live !== ':memory:' ? join(dirname(live), 'backups') : tmpdir()
  mkdirSync(dir, { recursive: true })
  return mkdtempSync(join(dir, '.upload-'))
}

/** Why a tarball is not an app archive, or null. A restore extracts it into
 *  the volume, so a nested path, a `..` or a link is refused by name. */
async function tarRefusal(tarball: string): Promise<string | null> {
  const list = async (flags: string) => {
    const proc = Bun.spawn(['tar', flags, tarball], { stdout: 'pipe', stderr: 'pipe' })
    const out  = await new Response(proc.stdout).text()
    return await proc.exited === 0 ? out.split('\n').filter(Boolean) : null
  }
  const names = await list('-tzf'), long = await list('-tvzf')
  if (!names || !long || names.length !== long.length) return 'The file is not a readable gzipped tar'
  const dbs: string[] = []
  for (const [i, raw] of names.entries()) {
    const name = raw.replace(/^\.\//, '').replace(/\/$/, '')
    if (!name || name === '.') continue
    if (name.includes('/') || name === '..' || raw.startsWith('/') || long[i][0] === 'd') return `The archive holds ${raw}; an app archive is flat, every file at its top`
    if (long[i][0] !== '-') return `The archive holds ${raw}, which is not a plain file`
    if (name.endsWith('.db')) dbs.push(name)
  }
  return dbs.length ? null : 'The archive holds no top-level .db file'
}

function sqliteRefusal(file: string): string | null {
  try {
    const db = new Database(file, { readonly: true })
    try { db.query('SELECT count(*) FROM sqlite_master').get() } finally { db.close() }
    return null
  } catch (err) {
    return `The file does not open as SQLite: ${(err as Error).message}`
  }
}

/** The flat `./<name>` tarball an archive of one database is. */
async function wrap(work: string, file: string, name: string): Promise<string> {
  const dir = join(work, 'wrap')
  mkdirSync(dir)
  renameSync(file, join(dir, name))
  const out  = join(work, 'wrapped.tar.gz')
  const proc = Bun.spawn(['tar', '-czf', out, '-C', dir, '.'], { stderr: 'pipe' })
  if (await proc.exited !== 0) throw new Error(`tar failed: ${(await new Response(proc.stderr).text()).trim()}`)
  return out
}

async function digest(file: string): Promise<string> {
  const hasher = new Bun.CryptoHasher('sha256')
  const reader = Bun.file(file).stream().getReader()
  for (let r = await reader.read(); !r.done; r = await reader.read()) hasher.update(r.value)
  return hasher.digest('hex')
}
