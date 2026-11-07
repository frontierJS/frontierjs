// api/src/domain/basecamps/basecamps.ts
// The Basecamps this laptop made, from `~/.config/fli/basecamps.json`: each one
// read with whether it answers and the newest backup it holds, and the two
// verbs the screen offers on one — Basecamp's own backup, taken over its API
// with the entry's admin key, and a restart of its API container over ssh.
//
// A verb takes minutes, so it is started here and its outcome held in memory,
// one per entry, for the page to poll (the shape of `explain` in
// `domain/atlas/atlas.ts`). A Workbench restart forgets them; Basecamp's own
// `HubBackup` row is the record that outlives it.
//
// Beside each entry sit the backups already pulled to this laptop
// (`dataDir()/basecamp/<name>`, one directory per backup, `core/basecamp.js`),
// and Delete removes one. The client names an entry and a bare directory name;
// the path is resolved here from the listing, so a crafted name can only miss.
//
// No credential leaves this module: an entry is answered without `apiKey`,
// `scopedKey` or `peerKeyId`, only whether it holds one.

import { rmSync, statSync } from 'node:fs'
import { join }             from 'node:path'

type Entry = {
  url: string, host?: string, cloud?: string, boxId?: string | number, runs?: boolean,
  apiKey?: string, scopedKey?: string, peerKeyId?: string,
}
type Ping = { ok: true, ms: number } | { ok: false, why: string }
type Log  = { warn: (t: string) => void, dry: (t: string) => void }
export type HubBackup = { id: string, status: string, createdAt?: string, startedAt?: string, finishedAt?: string, error?: string | null, [k: string]: unknown }

type Cli = {
  readBasecamps: (o: { home?: string }) => Record<string, Entry>
  pingBasecamp:  (e: Entry, o: { timeout?: number, fetcher?: typeof fetch }) => Promise<Ping>
  basecamp:      (origin: string, key: string, path: string) => Promise<unknown>
  takeHubBackup: (o: { origin: string, key: string, log: Log }) => Promise<HubBackup>
  restartApi:    (o: { host: string, container: string }) => Promise<string>
  probeUntil:    (o: { host: string, port: number, until: (p: unknown) => boolean }) => Promise<unknown>
  basecampApi:   () => Promise<{ container: string, port: number }>
  localBackups:  (dir: string) => Array<{ name: string, kind: string, takenAt: string | null, bytes: number }>
  dataDir:       (o: { home?: string }) => string
}

// The cli is a devDependency and the image installs none, so it is reached
// only on a machine where the screen is offered at all.
let cli: Promise<Cli> | null = null
const loadCli = () => cli ??= Promise.all([
  import('@frontierjs/cli/core/basecamps.js'),
  import('@frontierjs/cli/core/basecamp.js'),
  import('@frontierjs/cli/core/paths.js'),
]).then(mods => Object.assign({}, ...mods) as unknown as Cli)

export type Outcome = {
  verb:       'backup' | 'restart'
  state:      'working' | 'done' | 'error'
  startedAt:  string
  finishedAt: string | null
  /** backup: the row Basecamp recorded. */
  row?:       HubBackup
  /** backup: taken, but kept on the box rather than at its destination. */
  note?:      string
  /** restart: what `/setup/probe` answered once the API came back. */
  probe?:     unknown
  seconds?:   number
  error?:     string
}

/** One backup pulled to this laptop: a directory under the entry's folder. */
export type LocalCopy = { file: string, kind: string, takenAt: string | null, bytes: number, mtime: string | null }

export type Listed = {
  name: string, url: string, host: string | null, cloud: string | null, boxId: string | number | null, runs: boolean
  hasKey: boolean, hasScopedKey: boolean
  answers:      Ping
  newestBackup: HubBackup | null
  /** Why the newest backup could not be read from a Basecamp that answers. */
  backupError:  string | null
  outcome:      Outcome | null
  /** The backups on this laptop, oldest first. */
  local:        LocalCopy[]
}

export type Options = { home?: string, fetcher?: typeof fetch }

const outcomes = new Map<string, Outcome>()

export function outcomeOf(name: string): Outcome | null {
  const held = outcomes.get(name)
  return held ? { ...held } : null
}

async function entries(opts: Options): Promise<Record<string, Entry>> {
  return (await loadCli()).readBasecamps({ home: opts.home })
}

export async function entryOf(name: string, opts: Options = {}): Promise<Entry | null> {
  const all = await entries(opts)
  return Object.hasOwn(all, name) ? all[name] : null
}

// A 404 is a key whose holder is no system admin; it reads as "no backup to
// show" rather than as the Basecamp being down.
async function newestBackup(c: Cli, e: Entry): Promise<{ row: HubBackup | null, error: string | null }> {
  try {
    const rows = await c.basecamp(e.url, e.apiKey!, '/hub-backups?$limit=1&$orderBy[createdAt]=desc') as HubBackup[]
    return { row: rows?.[0] ?? null, error: null }
  } catch (err) {
    const e2 = err as Error & { status?: number, unreachable?: boolean }
    if (e2.status === 404 || e2.unreachable) return { row: null, error: null }
    return { row: null, error: e2.message }
  }
}

const copiesDir = (c: Cli, name: string, opts: Options) => join(c.dataDir({ home: opts.home }), 'basecamp', name)

function localCopies(c: Cli, name: string, opts: Options): LocalCopy[] {
  const dir = copiesDir(c, name, opts)
  return c.localBackups(dir).map(b => {
    let mtime: string | null = null
    try { mtime = statSync(join(dir, b.name)).mtime.toISOString() } catch {}
    return { file: b.name, kind: b.kind, takenAt: b.takenAt, bytes: b.bytes, mtime }
  })
}

/** Remove one pulled backup by its entry and directory name; answers `{ freed }` or `{ refused }`. */
export async function deleteLocal(name: string, file: string, opts: Options = {}): Promise<{ freed: number } | { refused: string }> {
  if (!await entryOf(name, opts)) return { refused: `No Basecamp named '${name}' in basecamps.json` }
  // A path from the page must never reach rmSync: only a bare name that the listing itself produced is removed.
  if (!file || file === '.' || file.includes('/') || file.includes('\\') || file.includes('..') || file.includes('\0'))
    return { refused: `'${file}' is not a backup name` }
  const c   = await loadCli()
  const row = localCopies(c, name, opts).find(b => b.file === file)
  if (!row) return { refused: `no backup '${file}' on this laptop for '${name}'` }
  rmSync(join(copiesDir(c, name, opts), file), { recursive: true, force: true })
  return { freed: row.bytes }
}

/** Every entry, keys left out, each pinged and its newest backup read in parallel. */
export async function listBasecamps(opts: Options = {}): Promise<Listed[]> {
  const c   = await loadCli()
  const all = await entries(opts)
  return Promise.all(Object.entries(all).map(async ([name, e]) => {
    const answers = await c.pingBasecamp(e, { ...(opts.fetcher ? { fetcher: opts.fetcher } : {}) })
    const newest  = answers.ok && e.apiKey ? await newestBackup(c, e) : { row: null, error: null }
    return {
      name,
      url:          e.url,
      host:         e.host ?? null,
      cloud:        e.cloud ?? null,
      boxId:        e.boxId ?? null,
      runs:         e.runs === true,
      hasKey:       !!e.apiKey,
      hasScopedKey: !!e.scopedKey,
      answers,
      newestBackup: newest.row,
      backupError:  newest.error,
      outcome:      outcomeOf(name),
      local:        localCopies(c, name, opts),
    }
  }))
}

// One verb per entry at a time: a second press while one runs answers it, so
// a double click never takes two backups or restarts a container mid-boot.
function hold(name: string, verb: Outcome['verb'], run: (held: Outcome) => Promise<void>): Outcome {
  const was = outcomes.get(name)
  if (was?.state === 'working') return { ...was }
  const began = Date.now()
  const held: Outcome = { verb, state: 'working', startedAt: new Date(began).toISOString(), finishedAt: null }
  outcomes.set(name, held)
  run(held).then(
    ()  => { held.state = 'done' },
    err => { held.state = 'error'; held.error = (err as Error).message },
  ).finally(() => {
    held.finishedAt = new Date().toISOString()
    held.seconds    = Math.round((Date.now() - began) / 1000)
  })
  return { ...held }
}

/** Take Basecamp's own backup and wait for its row; the archive stays where Basecamp wrote it. */
export async function startBackup(name: string, opts: Options = {}): Promise<Outcome | { refused: string }> {
  const e = await entryOf(name, opts)
  if (!e) return { refused: `No Basecamp named '${name}' in basecamps.json` }
  if (!e.apiKey) return { refused: `Basecamp '${name}' has no API key — fli basecamp:key --server ${e.host ?? '<box>'} files one` }
  const c = await loadCli()
  return hold(name, 'backup', async (held) => {
    const log: Log = { warn: (t) => { held.note = t }, dry: () => {} }
    held.row = await c.takeHubBackup({ origin: e.url, key: e.apiKey!, log })
  })
}

/** Restart the entry's API container over ssh and wait for `/setup/probe` to answer again. */
export async function startRestart(name: string, opts: Options = {}): Promise<Outcome | { refused: string }> {
  const e = await entryOf(name, opts)
  if (!e) return { refused: `No Basecamp named '${name}' in basecamps.json` }
  if (!e.host) return { refused: `Basecamp '${name}' has no ssh Host, and a restart is a command run on its box over ssh — the dev Basecamp has none` }
  const host = e.host
  const c    = await loadCli()
  const { container, port } = await c.basecampApi()
  return hold(name, 'restart', async (held) => {
    await c.restartApi({ host, container })
    held.probe = await c.probeUntil({ host, port, until: () => true })
  })
}
