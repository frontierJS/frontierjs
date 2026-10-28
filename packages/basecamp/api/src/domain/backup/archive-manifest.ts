// src/domain/backup/archive-manifest.ts
// The `manifest.json` an archive carries, and the one check a restore runs
// against it before any live file is replaced (`IDEAS/backups.md` 4.3).
//
// ─── What it says, and what it leaves to the databases ────────────────────
//
// The manifest holds only what the archived files cannot answer for
// themselves: which key encrypted them, and what each file's bytes were when
// it was written. Whether this code can serve the archived schema is read from
// the staged databases' own migration history through litestone's `status()`,
// not from a hash recorded here — a hash of `schema.lite` refuses a restore
// whose pending migrations would apply, and a copy of the history is a second
// record of it. Pre-alpha `initial_schema.sql` is rewritten in place, so an
// archive taken before such a rewrite reads `modified` and is refused by name:
// boot's `apply()` does not look at `modified` or `orphaned`, and would open
// the database against tables it never created.
//
// `litestone restore --from-backup` reads only the files it knows by name, so
// a `manifest.json` beside them is never restored as data.

import { Database }       from 'bun:sqlite'
import { createReadStream, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { status }         from '@frontierjs/litestone/migrations'
import { encryptionKeyFingerprint } from '../../core/db.ts'

export const MANIFEST_FILE = 'manifest.json'

const BASECAMP_VERSION: string =
  JSON.parse(readFileSync(new URL('../../../../package.json', import.meta.url), 'utf8')).version

export type ArchiveManifest = {
  basecamp:                 string
  takenAt:                  string
  /** sha256 of the key the archived `@encrypted` columns need; null for the
   *  development placeholder (`encryptionKeyFingerprint`). */
  encryptionKeyFingerprint: string | null
  /** Every file in the archive but this one, path relative and `/`-separated. */
  files:                    { path: string; bytes: number; sha256: string }[]
}

async function sha256Of(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher('sha256')
  for await (const chunk of createReadStream(path)) hasher.update(chunk)
  return hasher.digest('hex')
}

async function listFiles(dir: string): Promise<ArchiveManifest['files']> {
  const paths = readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(e => e.isFile())
    .map(e => join(e.parentPath, e.name))
    .filter(p => relative(dir, p) !== MANIFEST_FILE)
    .sort()
  const files: ArchiveManifest['files'] = []
  for (const p of paths)
    files.push({ path: relative(dir, p).split(sep).join('/'), bytes: statSync(p).size, sha256: await sha256Of(p) })
  return files
}

/** Write `manifest.json` into a finished archive directory. Last, so every
 *  file it lists is the file the tarball carries. */
export async function writeManifest(dir: string, takenAt: string): Promise<ArchiveManifest> {
  const manifest: ArchiveManifest = {
    basecamp:                 BASECAMP_VERSION,
    takenAt,
    encryptionKeyFingerprint: encryptionKeyFingerprint(),
    files:                    await listFiles(dir),
  }
  writeFileSync(join(dir, MANIFEST_FILE), JSON.stringify(manifest, null, 2) + '\n')
  return manifest
}

const short = (fp: string | null) => fp ? fp.slice(0, 12) : 'the development placeholder'

/**
 * Why the archive staged at `dir` cannot replace this hub's databases, one
 * sentence per reason, or none. `migrationsRoot` holds one directory per
 * database (`db/migrations/<name>/`); a staged `<name>.db` with a directory
 * there is graded by its own history. Opens the STAGED copies only — a
 * database whose history has no tracking table gets one, which is a write to
 * a file this restore owns and nobody else has opened.
 */
export async function archiveRefusals(
  dir:  string,
  opts: { migrationsRoot: string; keyFingerprint?: string | null },
): Promise<string[]> {
  const path = join(dir, MANIFEST_FILE)
  if (!existsSync(path)) return [`The archive has no ${MANIFEST_FILE}, so nothing says which key its secrets need.`]

  let manifest: ArchiveManifest
  try { manifest = JSON.parse(readFileSync(path, 'utf8')) }
  catch (err) { return [`${MANIFEST_FILE} is not JSON: ${(err as Error).message}.`] }
  if (!Array.isArray(manifest?.files)) return [`${MANIFEST_FILE} lists no files.`]

  const reasons: string[] = []

  const key = opts.keyFingerprint === undefined ? encryptionKeyFingerprint() : opts.keyFingerprint
  if ((manifest.encryptionKeyFingerprint ?? null) !== key)
    reasons.push(`The archive was encrypted under ${short(manifest.encryptionKeyFingerprint ?? null)} ` +
      `and this hub runs ${short(key)}; set ENCRYPTION_KEY to the key the archive was taken with.`)

  for (const f of manifest.files) {
    // A listed path is a column of a file somebody uploaded, so it is held
    // inside the staged directory before anything reads it.
    const at = join(dir, f.path)
    if (relative(dir, at).startsWith('..')) { reasons.push(`${MANIFEST_FILE} names ${f.path}, outside the archive.`); continue }
    if (!existsSync(at))                     { reasons.push(`${f.path} is listed and missing.`); continue }
    if (statSync(at).size !== f.bytes || await sha256Of(at) !== f.sha256)
      reasons.push(`${f.path} does not match its sha256; the archive is damaged.`)
  }
  if (reasons.length) return reasons

  for (const name of readdirSync(opts.migrationsRoot)) {
    const staged = join(dir, `${name}.db`)
    if (!existsSync(staged)) continue
    const raw = new Database(staged)
    try {
      for (const row of status(raw, join(opts.migrationsRoot, name))) {
        if (row.state === 'orphaned') reasons.push(
          `${name}.db applied ${row.file}, which this Basecamp does not have; the archive is from a newer version.`)
        if (row.state === 'modified') reasons.push(
          `${name}.db applied ${row.file} as it read before it was rewritten; this Basecamp cannot continue that history.`)
      }
    } finally { raw.close() }
  }
  return reasons
}
