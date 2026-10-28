// src/domain/backup/hub-restore.ts
// A hub brought back from one archive at `/setup` (`IDEAS/backups.md` 4.4):
// list the bucket, fetch or take an upload, stage it, and at the next boot
// swap it in before any database opens.
//
// ─── Stage, then restart ──────────────────────────────────────────────────
//
// The process serving `/setup` holds the databases a restore replaces, so it
// replaces nothing. The route unpacks into `restore-staged/` beside the live
// database, and only once `archiveRefusals` passes: a wrong key, a damaged
// file or a history this code cannot continue is refused while the live files
// are untouched. `restoreStaged` runs at boot, before `openSqlite`, and hands
// the swap to `litestone restore --from-backup --force` — the one owner of
// putting a backup's files back, and all or nothing. Then the directory is
// renamed `restore-done-<stamp>/`, so a second boot does not restore twice.
//
// ─── A live hub is never overwritten ──────────────────────────────────────
//
// Both doors ask the same question, does an `Account` row exist: the route
// answers 409, and boot leaves the staged directory in place and says so. The boot check reads the
// file before any client exists, which is why it is the one raw query here.
//
// ─── No row, so no target ─────────────────────────────────────────────────
//
// A destination is a `BackupDestination` row with a `Secret`, and conduit's
// target resolves `secret:<id>` at send time. Neither exists on a fresh box,
// so the bucket is reached over pre-signed URLs (`presign`, the URL a fleet
// `/backup` is handed), signed with the key the form or `HUB_RESTORE_KEY`
// carries and fetched directly. The key is never stored.
//
// ─── What is not restored ─────────────────────────────────────────────────
//
// `jobs.db`, Caravan's queue, is in the archive and no schema names it, so
// `litestone restore` leaves it. A fresh box's queue starts empty; every
// scheduled Job is re-registered from its row at boot (`restoreSchedules`).

import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { uriEncode }      from '@frontierjs/toolbelt/sigv4'
import { SCHEMA_PATH }    from '../../core/db.ts'
import { env }            from '../../core/env.ts'
import { keyUnder }       from '../../providers/storage/index.ts'
import type { DestinationRow } from '../../providers/storage/index.ts'
import { errorCode, objectPath, parseListing, presign } from '../../providers/storage/s3.ts'
import { ARCHIVE_NAME, stampOf } from './backup-archives.ts'
import { archiveRefusals, MANIFEST_FILE } from './archive-manifest.ts'
import { MAX_UPLOAD_BYTES } from '../../jobs/backup-run.job.ts'

export const STAGED_DIR = 'restore-staged'

/** Where an archive waits for the next boot: beside the live database, on the
 *  volume that survives the restart. */
export function stagedDir(dbPath: string): string {
  return join(dirname(resolve(dbPath)), STAGED_DIR)
}

// ─── The bucket ───────────────────────────────────────────────────────────

/** A `BackupDestination`'s shape, typed into a form: no row exists yet. */
export type RestoreBucket = Pick<DestinationRow, 'endpoint' | 'region' | 'bucket' | 'prefix'> & { key: string }

/** What the form starts filled with. The key is reported as set, never sent. */
export function bucketFromEnv(): Omit<RestoreBucket, 'key'> & { key: boolean } {
  return {
    endpoint: env.HUB_RESTORE_ENDPOINT ?? '',
    region:   env.HUB_RESTORE_REGION   ?? '',
    bucket:   env.HUB_RESTORE_BUCKET   ?? '',
    prefix:   env.HUB_RESTORE_PREFIX   ?? '',
    key:      Boolean(env.HUB_RESTORE_KEY),
  }
}

/** The form's answer with the env filling a blank key, or why it cannot be used. */
export function readBucket(input: Partial<Record<keyof RestoreBucket, unknown>>): RestoreBucket | { error: string } {
  const str = (v: unknown) => typeof v === 'string' ? v.trim() : ''
  const b = {
    endpoint: str(input.endpoint), region: str(input.region) || 'us-east-1',
    bucket:   str(input.bucket),   prefix: str(input.prefix),
    key:      str(input.key) || (env.HUB_RESTORE_KEY ?? ''),
  }
  if (!/^https?:\/\/[^/]+/.test(b.endpoint)) return { error: 'endpoint is the bucket host, http(s)://… with no bucket in it' }
  if (!b.bucket)                              return { error: 'bucket is required' }
  if (!/^[^:]+:.+$/.test(b.key))             return { error: 'key is <accessKeyId>:<secretAccessKey>' }
  return b
}

async function signedFetch(b: RestoreBucket, path: string, query: Record<string, string> = {}): Promise<Response | { error: string }> {
  const url = new URL(b.endpoint.replace(/\/$/, '') + path)
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v)
  let res: Response
  try {
    res = await fetch(await presign({ url: url.toString(), credential: b.key, region: b.region, expiresIn: 300 }))
  } catch (err) {
    return { error: `${b.endpoint} could not be reached: ${(err as Error).message}` }
  }
  if (res.ok) return res
  const text = await res.text()
  const code = errorCode(text)
  return { error: `${b.endpoint} answered ${res.status}${code ? ` ${code}` : ''}` +
    (code === 'SignatureDoesNotMatch' || code === 'InvalidAccessKeyId' ? ': the key is wrong' : '') }
}

export type ListedArchive = { key: string; name: string; takenAt: string; size: number }

/** Every `<prefix>/basecamp-<stamp>.tar.gz`, newest first. A neighbor's object
 *  under the same prefix is not a hub archive and is left out. */
export async function listHubArchives(b: RestoreBucket): Promise<{ archives: ListedArchive[] } | { error: string }> {
  const archives: ListedArchive[] = []
  let token: string | null = null
  do {
    const res = await signedFetch(b, `/${uriEncode(b.bucket)}`, {
      'list-type': '2', prefix: keyUnder(b, 'basecamp-'), ...(token ? { 'continuation-token': token } : {}),
    })
    if ('error' in res) return res
    const page = parseListing(await res.text())
    for (const o of page.objects) {
      const name    = o.key.slice(o.key.lastIndexOf('/') + 1).replace(/\.tar\.gz$/, '')
      const takenAt = stampOf(name)
      if (takenAt && o.key === keyUnder(b, `${name}.tar.gz`)) archives.push({ key: o.key, name, takenAt, size: o.size })
    }
    token = page.nextToken
  } while (token)
  return { archives: archives.sort((x, y) => y.takenAt.localeCompare(x.takenAt)) }
}

/** One archive from the bucket into `to`, streamed rather than held. */
export async function fetchHubArchive(b: RestoreBucket, key: string, to: string): Promise<{ error: string } | null> {
  const res = await signedFetch(b, objectPath(b.bucket, key))
  if ('error' in res) return res
  await Bun.write(to, res)
  return null
}

/** An uploaded archive into `to`. A stream route bounds nothing a chunked
 *  sender writes, so the count is kept here; the cap is the one `backup:run`
 *  holds an upload to, which no archive it sent can exceed. */
export async function receiveUpload(body: ReadableStream<Uint8Array> | null, to: string): Promise<{ error: string } | null> {
  if (!body) return { error: 'The upload is empty' }
  const sink = Bun.file(to).writer()
  let bytes = 0
  const reader = body.getReader()
  try {
    for (let r = await reader.read(); !r.done; r = await reader.read()) {
      bytes += r.value.byteLength
      if (bytes > MAX_UPLOAD_BYTES) return { error: `The upload is over ${MAX_UPLOAD_BYTES} bytes; restore it from the bucket` }
      sink.write(r.value)
    }
  } finally { await sink.end(); reader.releaseLock() }
  return bytes ? null : { error: 'The upload is empty' }
}

// ─── Staging ──────────────────────────────────────────────────────────────

/** A scratch path beside the live database for a download or an upload, so
 *  the tarball lands on the volume the archive is unpacked onto. */
export function scratchTarball(dbPath: string): string {
  const dir = dirname(resolve(dbPath))
  mkdirSync(dir, { recursive: true })
  return join(dir, `.restore-${crypto.randomUUID()}.tar.gz`)
}

/**
 * Unpack a `basecamp-<stamp>.tar.gz` and stage it for the next boot, or answer
 * why not with the live files untouched. A staged archive already waiting is
 * replaced: choosing again before the restart is choosing.
 */
export async function stageHubArchive(
  tarball: string,
  dbPath:  string,
  opts:    { migrationsRoot: string },
): Promise<{ takenAt: string } | { refused: string[] }> {
  const work = mkdtempSync(join(dirname(resolve(dbPath)), '.restore-unpacking-'))
  try {
    const proc = Bun.spawn(['tar', '-xzf', tarball, '-C', work, '--no-same-owner'], { stderr: 'pipe' })
    if (await proc.exited !== 0)
      return { refused: [`The file is not a gzipped tar: ${(await new Response(proc.stderr).text()).trim().split('\n')[0]}`] }

    const top = readdirSync(work)
    if (top.length !== 1 || !ARCHIVE_NAME.test(top[0]))
      return { refused: [`A Basecamp archive holds one basecamp-<stamp>/ directory; this one holds ${top.join(', ') || 'nothing'}.`] }
    const unpacked = join(work, top[0])

    // An uploaded tar can carry a link that points off the volume, which the
    // copy at boot would follow; an archive `backup:run` wrote holds none.
    const odd = readdirSync(unpacked, { recursive: true, withFileTypes: true }).filter(e => !e.isFile() && !e.isDirectory())
    if (odd.length) return { refused: [`The archive holds ${odd[0].name}, which is not a plain file.`] }

    const reasons = await archiveRefusals(unpacked, opts)
    if (reasons.length) return { refused: reasons }

    const staged = stagedDir(dbPath)
    rmSync(staged, { recursive: true, force: true })
    renameSync(unpacked, staged)
    return { takenAt: stampOf(top[0])! }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

// ─── Boot ─────────────────────────────────────────────────────────────────

export type RestoreState =
  | { state: 'staged'; takenAt: string | null }
  | { state: 'done'; takenAt: string | null }
  | { state: 'refused' | 'failed'; message: string }

let bootResult: RestoreState | null = null

/** Does a hub live in this file — an account somebody set up or restored.
 *  Only a missing file or a missing table is "no": a lock or a damaged file
 *  answers yes, because the step this guards is `--force`. */
function hubLivesAt(dbPath: string): boolean {
  if (!existsSync(dbPath)) return false
  let raw: Database
  try { raw = new Database(dbPath, { readonly: true }) } catch { return true }
  try { return raw.query('SELECT 1 FROM account LIMIT 1').get() != null }
  catch (err) { return !/no such table: account/.test((err as Error).message) }
  finally { raw.close() }
}

function takenAtOf(dir: string): string | null {
  try { return JSON.parse(readFileSync(join(dir, MANIFEST_FILE), 'utf8')).takenAt ?? null } catch { return null }
}

const LITESTONE_CLI = join(dirname(Bun.resolveSync('@frontierjs/litestone/replicate', import.meta.dir)), 'cli.js')

/**
 * Put a staged archive in place of this hub's databases, before any opens.
 * Answers what happened, or null when nothing was staged. A failed swap leaves
 * the live files as they were and the staged directory where it is, so the
 * reason is in the log and on `/setup` until somebody stages another.
 */
export async function restoreStaged(
  dbPath: string,
  log:    { info(msg: string, meta?: object): void; error(msg: string, meta?: object): void },
): Promise<RestoreState | null> {
  if (!dbPath || dbPath === ':memory:') return null
  const staged = stagedDir(dbPath)
  if (!existsSync(staged)) return null
  const takenAt = takenAtOf(staged)

  if (hubLivesAt(resolve(dbPath))) {
    bootResult = { state: 'refused', message:
      `${staged} is staged beside a database that holds an account, or could not be read, and was left in place. ` +
      'Remove it, or restore by hand (docs/BACKUPS.md § 7).' }
    log.error('staged restore refused', { staged })
    return bootResult
  }

  // The schema's declared paths, resolved the way the client resolves them:
  // the CLI anchors on the schema, and DATABASE_URL is the file this boot opens.
  const proc = Bun.spawn(
    [process.execPath, LITESTONE_CLI, 'restore', `--from-backup=${staged}`, '--force', `--schema=${SCHEMA_PATH}`],
    { cwd: dirname(dirname(SCHEMA_PATH)), env: { ...process.env, DATABASE_URL: resolve(dbPath), NO_COLOR: '1' },
      stdout: 'pipe', stderr: 'pipe' },
  )
  const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  if (code !== 0) {
    const why = (err.trim() || out.trim()).split('\n').filter(Boolean).slice(-3).join(' ')
    bootResult = { state: 'failed', message: `litestone restore exited ${code}: ${why}` }
    log.error('staged restore failed', { staged, code, output: why })
    return bootResult
  }

  const done = join(dirname(staged), `restore-done-${new Date().toISOString().replace(/[:.]/g, '-')}`)
  renameSync(staged, done)
  bootResult = { state: 'done', takenAt }
  log.info('hub restored from a staged archive', { takenAt, kept: done })
  return bootResult
}

/** What `/setup/probe` reports: this boot's restore, else an archive waiting. */
export function restoreState(dbPath: string): RestoreState | null {
  if (bootResult) return bootResult
  const staged = dbPath && dbPath !== ':memory:' ? stagedDir(dbPath) : null
  return staged && existsSync(staged) ? { state: 'staged', takenAt: takenAtOf(staged) } : null
}
