// src/domain/prototypes/catalog.ts — the prototypes catalog, as this app reads and writes it.
//
// Two files, two owners (`IDEAS/prototypes-catalog.md` § Recommended setup):
//   <PROTOTYPES_DIR>/catalog/CATALOG.json   one record per repo: what it is.
//                                           Claude reads it, the owner hand-edits it.
//   <WORKBENCH_DIR>/prototypes.json         the owner's view: favorites, order, folded.
//
// A write to CATALOG.json goes through a rename and re-reads the file first, so
// a hand edit made since the page loaded survives, and a crash mid-write cannot
// leave half a file. A record's unknown fields are kept: the file is also the
// owner's notebook, and a field this code does not know is theirs.

import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { env, workbenchDir } from '../../core/env.ts'
import { describeRepo, listLocalRepos, type LocalRepo } from '../local/local-git.ts'

export const OWNERS   = ['kobami', 'knightworks', 'personal', 'framework'] as const
export const KINDS    = ['client', 'product', 'stressor', 'example', 'test', 'spike'] as const
export const STATUSES = ['active', 'paused', 'archived', 'moving'] as const

export type Related = { to: string, why: string }
export type Record_ = {
  path:     string
  owner:    typeof OWNERS[number]
  kind:     typeof KINDS[number]
  status:   typeof STATUSES[number]
  purpose?: string
  related?: Related[]
  [unknown: string]: unknown
}
export type View = { favorites: string[], order: string[], folded: string[] }

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
// The order a new record's keys are written in; a record already in the file keeps its own.
const KEY_ORDER = ['path', 'owner', 'kind', 'status', 'purpose', 'related']

/** Absent, the fjs-prototypes folder beside this repo, where the prototypes are checked out. */
export const prototypesDir = (dir?: string) =>
  dir || env.PROTOTYPES_DIR || resolve(import.meta.dir, '../../../../../../../fjs-prototypes')
export const catalogFile = (dir?: string) => join(prototypesDir(dir), 'catalog', 'CATALOG.json')
export const viewFile    = (wb?: string) => join(wb || workbenchDir(), 'prototypes.json')

/** `~/` is the operator's home; any other path must already be absolute. */
export function expandPath(p: string): string {
  return p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p
}

/** Where the catalog says a prototype is, expanded; null when it records none. */
export function recordedPath(name: string, dir?: string): string | null {
  const { records } = readCatalog(dir)
  const rec = Object.hasOwn(records, name) ? records[name] : undefined
  return rec ? expandPath(rec.path) : null
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Why a record is not one — in plain words — or null. Says nothing about the disk. */
export function validateRecord(name: unknown, rec: unknown): string | null {
  if (typeof name !== 'string' || !NAME.test(name))
    return `'${String(name)}' is not a usable name — letters, digits, '.', '_' and '-', starting with a letter or digit`
  if (!isObject(rec)) return `${name}: a record is an object`
  if (typeof rec.path !== 'string' || !rec.path.trim()) return `${name}: path is required — where the repo is`
  if (!isAbsolute(expandPath(rec.path))) return `${name}: path '${rec.path}' must start with / or ~/`
  for (const [key, set] of [['owner', OWNERS], ['kind', KINDS], ['status', STATUSES]] as const)
    if (!(set as readonly unknown[]).includes(rec[key])) return `${name}: ${key} must be one of ${set.join(', ')}`
  if ('purpose' in rec && typeof rec.purpose !== 'string') return `${name}: purpose is a string`
  if ('related' in rec) {
    if (!Array.isArray(rec.related)) return `${name}: related is a list of { to, why }`
    for (const r of rec.related)
      if (!isObject(r) || typeof r.to !== 'string' || typeof r.why !== 'string') return `${name}: each related entry is { to, why }, both strings`
  }
  return null
}

// ─── the file ────────────────────────────────────────────────────────────

// JSON.stringify puts every { to, why } on four lines; the file has them on one,
// so the writer is this and a rewrite of an untouched file is a no-op in git.
function serialize(v: unknown, indent = '', inArray = false): string {
  if (Array.isArray(v)) {
    if (!v.length) return '[]'
    const inner = indent + '  '
    return '[\n' + v.map(x => inner + serialize(x, inner, true)).join(',\n') + '\n' + indent + ']'
  }
  if (isObject(v)) {
    const entries = Object.entries(v).filter(([, x]) => x !== undefined)
    if (!entries.length) return '{}'
    if (inArray && entries.every(([, x]) => x === null || typeof x !== 'object'))
      return '{ ' + entries.map(([k, x]) => `${JSON.stringify(k)}: ${JSON.stringify(x)}`).join(', ') + ' }'
    const inner = indent + '  '
    return '{\n' + entries.map(([k, x]) => `${inner}${JSON.stringify(k)}: ${serialize(x, inner)}`).join(',\n') + '\n' + indent + '}'
  }
  return JSON.stringify(v)
}
export const serializeCatalog = (records: Record<string, unknown>) => serialize(records) + '\n'

function atomicWrite(file: string, text: string) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, text)
  renameSync(tmp, file)
}

/** The file as written, unvalidated: a record that fails is still there to be fixed by hand. */
function readRaw(file: string): { raw: Record<string, unknown> } | { error: string } {
  if (!existsSync(file)) return { raw: {} }
  let parsed: unknown
  try { parsed = JSON.parse(readFileSync(file, 'utf8')) } catch (e) { return { error: `CATALOG.json is not valid JSON: ${(e as Error).message}` } }
  if (!isObject(parsed)) return { error: 'CATALOG.json must hold one object, a record per repo name' }
  return { raw: parsed }
}

export type Catalog = {
  file:     string
  /** Why the file could not be read at all; the records are then empty. */
  error:    string | null
  records:  Record<string, Record_>
  /** Records in the file that failed validation — left out of `records`, not deleted. */
  problems: Array<{ name: string, error: string }>
}

export function readCatalog(dir?: string): Catalog {
  const file = catalogFile(dir)
  const out: Catalog = { file, error: null, records: {}, problems: [] }
  const read = readRaw(file)
  if ('error' in read) return { ...out, error: read.error }
  for (const [name, rec] of Object.entries(read.raw)) {
    const error = validateRecord(name, rec)
    if (error) out.problems.push({ name, error })
    else out.records[name] = rec as Record_
  }
  return out
}

/**
 * Set one record. `patch` merges over the record already there: a key it names
 * replaces, a key it leaves out stays, an explicit null clears `purpose` or
 * `related` (`Invariant 9`), and a field this code does not know is untouched.
 * Returns the stored record, or why it was refused.
 */
export function writeRecord(name: string, patch: Record<string, unknown>, dir?: string): { record: Record_ } | { refused: string } {
  const file = catalogFile(dir)
  const read = readRaw(file)
  if ('error' in read) return { refused: `${read.error} — fix it by hand before saving here` }
  const before = read.raw[name]
  const merged: Record<string, unknown> = isObject(before) ? { ...before } : {}
  if (!isObject(before)) for (const k of KEY_ORDER) if (k in patch) merged[k] = undefined
  for (const [k, v] of Object.entries(patch)) {
    if (v === null && (k === 'purpose' || k === 'related')) delete merged[k]
    else merged[k] = v
  }
  const refused = validateRecord(name, merged)
  if (refused) return { refused }
  const next = { ...read.raw, [name]: merged }
  atomicWrite(file, serializeCatalog(next))
  return { record: merged as Record_ }
}

// ─── view state ──────────────────────────────────────────────────────────

const names = (v: unknown) => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []

// A folded entry names a group, not a repo: `owner:kobami`, `kind:client`, `status:paused`.
const GROUP = new Set([
  ...OWNERS.map(v => `owner:${v}`), ...KINDS.map(v => `kind:${v}`), ...STATUSES.map(v => `status:${v}`),
  'unsorted', 'missing',
])

/** The owner's view with every name that matches no record, and every group that is not one, dropped. Absent or unreadable is empty. */
export function readView(known: Iterable<string>, wb?: string): View {
  const keep = new Set(known)
  let raw: unknown
  try { raw = JSON.parse(readFileSync(viewFile(wb), 'utf8')) } catch { raw = {} }
  const o = isObject(raw) ? raw : {}
  const clean = (v: unknown, set: Set<string>) => [...new Set(names(v))].filter(n => set.has(n))
  return { favorites: clean(o.favorites, keep), order: clean(o.order, keep), folded: clean(o.folded, GROUP) }
}

/** Not filtered on the way in: a catalog that failed to read would otherwise empty the view. */
export function writeView(view: unknown, wb?: string): { view: View } | { refused: string } {
  if (!isObject(view)) return { refused: 'a view is { favorites, order, folded }, each a list of names' }
  for (const k of ['favorites', 'order', 'folded'])
    if (k in view && (!Array.isArray(view[k]) || (view[k] as unknown[]).some(x => typeof x !== 'string')))
      return { refused: `${k} is a list of repo names` }
  const clean = (v: unknown) => [...new Set(names(v))]
  const out: View = { favorites: clean(view.favorites), order: clean(view.order), folded: clean(view.folded) }
  atomicWrite(viewFile(wb), JSON.stringify(out, null, 2) + '\n')
  return { view: out }
}

// ─── the merge ───────────────────────────────────────────────────────────

const realOf = (p: string) => { try { return realpathSync(p) } catch { return null } }
const isDir  = (p: string) => { try { return statSync(p).isDirectory() } catch { return false } }

export type Recorded = { name: string, record: Record_, path: string, git: LocalRepo | null }
export type Missing  = { name: string, record: Record_, path: string }

/**
 * Every prototype in one answer: the records with their git state, the repos
 * the scan found that no record names, and the records whose folder is gone.
 * The scan is each distinct parent folder the records name plus the prototypes
 * folder, one level down — a prototype is a direct child of its folder.
 */
export async function listPrototypes(o: { dir?: string, wb?: string } = {}) {
  const catalog = readCatalog(o.dir)
  const root = prototypesDir(o.dir)

  const expanded = new Map<string, string>()
  const folders = new Set<string>()
  const recordPaths = new Map<string, string>() // real path -> record name
  for (const [name, rec] of Object.entries(catalog.records)) {
    const path = expandPath(rec.path)
    expanded.set(name, path)
    const real = realOf(path)
    if (real) recordPaths.set(real, name)
    const parent = realOf(dirname(path))
    if (parent) folders.add(parent)
  }
  const rootReal = realOf(root)
  if (rootReal) folders.add(rootReal)
  // The folder holding CATALOG.json is a repo of its own and is the catalog, not a prototype.
  const catalogDir = realOf(dirname(catalog.file))

  const scanned = new Map<string, LocalRepo>()
  let truncated = false
  for (const folder of folders) {
    const found = await listLocalRepos(folder, { depth: 1 })
    truncated ||= found.truncated
    for (const repo of found.repos) scanned.set(repo.path, repo)
  }

  const recorded: Recorded[] = []
  const missing: Missing[] = []
  for (const [name, record] of Object.entries(catalog.records)) {
    const path = expanded.get(name)!
    const real = realOf(path)
    if (!real || !isDir(real)) { missing.push({ name, record, path }); continue }
    // A recorded path inside a folder that is itself a repo is not a child the scan reaches.
    let git = scanned.get(real) ?? null
    if (!git && existsSync(join(real, '.git'))) git = await describeRepo(dirname(real), real)
    recorded.push({ name, record, path: real, git })
  }
  const unsorted = [...scanned.values()]
    .filter(r => !recordPaths.has(r.path) && r.path !== catalogDir)
    .sort((a, b) => a.name.localeCompare(b.name))

  return {
    dir: root, file: catalog.file, error: catalog.error, problems: catalog.problems,
    recorded, unsorted, missing, truncated,
    view: readView(Object.keys(catalog.records), o.wb),
    // The page's pickers read these, so a value added here needs no second copy there.
    choices: { owner: OWNERS, kind: KINDS, status: STATUSES },
  }
}
