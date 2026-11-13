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
// Set up B2 backups and its undo run `core/basecamp-backups.js`, the module
// `fli basecamp:backups` runs, with the laptop's B2 key read from
// `~/.config/fli/.env` here (the API's own env does not hold it). Each `say` line
// is kept on the outcome for the page to show.
//
// Download fetches the newest archive Basecamp already holds into the same
// folder, taking no backup; Save .tar.gz answers the one-use link Basecamp
// mints for it, which the page navigates to. Key copy compares the box's
// ENCRYPTION_KEY, read over ssh, with the copies filed under
// `configDir()/basecamp/<name>`; Save key files it there and attests it.
//
// No credential leaves this module: an entry is answered without `apiKey`,
// `scopedKey` or `peerKeyId`, only whether it holds one; the B2 key is read
// for the session and never answered; a key is answered as a fingerprint; a plan is summarized without holder emails.

import { rmSync, statSync } from 'node:fs'
import { join }             from 'node:path'

type Entry = {
  url: string, host?: string, cloud?: string, boxId?: string | number, runs?: boolean, profile?: string,
  apiKey?: string, scopedKey?: string, peerKeyId?: string,
}
type Ping = { ok: true, ms: number } | { ok: false, why: string }
type Log  = { warn: (t: string) => void, dry: (t: string) => void }
export type HubBackup = { id: string, status: string, createdAt?: string, startedAt?: string, finishedAt?: string, error?: string | null, [k: string]: unknown }

type Cli = {
  readBasecamps: (o: { home?: string }) => Record<string, Entry>
  sshHosts:      (home?: string) => Set<string>
  pingBasecamp:  (e: Entry, o: { timeout?: number, fetcher?: typeof fetch }) => Promise<Ping>
  basecamp:      (origin: string, key: string, path: string, o?: { method?: string, headers?: Record<string, string>, body?: unknown }) => Promise<unknown>
  takeHubBackup: (o: { origin: string, key: string, log: Log }) => Promise<HubBackup>
  restartApi:    (o: { host: string, container: string }) => Promise<string>
  probeUntil:    (o: { host: string, port: number, until: (p: unknown) => boolean }) => Promise<unknown>
  basecampApi:   () => Promise<{ container: string, port: number }>
  localBackups:  (dir: string) => Array<{ name: string, kind: string, takenAt: string | null, bytes: number, fingerprint: string | null }>
  newestHubArchive: (o: { origin: string, key: string }) => Promise<HubBackup | null>
  fetchHubArchive:  (o: { origin: string, key: string, row: HubBackup, out: string }) => Promise<{ dir: string }>
  archiveDirName:   (row: HubBackup) => string
  basecampFiles:    (server: string) => Promise<{ host: string, envFile: string, secretsDir: string }>
  readBoxKey:       (o: { host: string, envFile: string, secretsDir: string }) => Promise<string | null>
  keyCopyState:     (server: string, boxKey: string | null) => { state: KeyState, fingerprint: string | null, filed: string[] }
  keepKey:          (o: { server: string, key: string, how: 'f', echo: (t: string) => void }) => { keyFile: string | null, already: boolean, fingerprint: string }
  attestKeyCopy:    (o: { origin: string, key: string, fingerprint: string }) => Promise<unknown>
  dataDir:       (o: { home?: string }) => string
  listGlobal:    (o: { home?: string }) => Array<{ key: string, value: string }>
  listProfile:   (name: string, o: { home?: string }) => Array<{ key: string, value: string }>
  replWhere:     (e: Entry & { name: string }) => unknown
  laptopSession: (o: { env: Record<string, string | undefined> }) => Promise<unknown>
  planBackups:   (e: Entry & { name: string }, o: { apps?: string[], session?: unknown }) => Promise<BackupsPlan>
  setUpBackups:  (e: Entry & { name: string }, o: { apps?: string[], session?: unknown, say: (l: string) => void }) => Promise<unknown>
  undoBackups:   (e: Entry & { name: string }, o: { session?: unknown, say: (l: string) => void }) => Promise<{ removed: number, kept: number }>
  LOCK_DAYS:     number
}

/** The part of `planBackups`' answer the summary reads. */
export type BackupsPlan = {
  name: string
  buckets: Record<'archive' | 'replica', { name: string, held: { lockDays?: number } | null }>
  workspaces: Array<{
    id: string, name: string, holder: unknown
    archive:  Dest
    replica?: Dest
  }>
  hub:  { backupDestinationId?: string | null, replicaDestinationId?: string | null, backupCron?: string | null }
  apps: Array<{ slug: string, backupDestinationId?: string | null, backupCron?: string | null }>
  unset: Array<{ id: string, slug: string }>
}
type Dest = { bucket: string, prefix: string, name: string, keyName: string, row: { lastTestAt?: string | null } | null }

// The cli is a devDependency and the image installs none, so it is reached
// only on a machine where the screen is offered at all.
let cli: Promise<Cli> | null = null
const loadCli = () => cli ??= Promise.all([
  import('@frontierjs/cli/core/basecamps.js'),
  import('@frontierjs/cli/core/basecamp.js'),
  import('@frontierjs/cli/core/paths.js'),
  import('@frontierjs/cli/core/global-env.js'),
  import('@frontierjs/cli/core/basecamp-backups.js'),
]).then(mods => Object.assign({}, ...mods) as unknown as Cli)

export type Outcome = {
  verb:       'backup' | 'restart' | 'b2' | 'b2-undo' | 'download'
  state:      'working' | 'done' | 'error'
  startedAt:  string
  finishedAt: string | null
  /** backup: the row Basecamp recorded; download: the row fetched. */
  row?:       HubBackup
  /** backup: taken, but kept on the box rather than at its destination; download: already on this laptop. */
  note?:      string
  /** restart: what `/setup/probe` answered once the API came back. */
  probe?:     unknown
  seconds?:   number
  error?:     string
  /** b2, b2-undo: one line per thing done, as `fli basecamp:backups` prints them. */
  lines?:     string[]
}

/** One backup pulled to this laptop: a directory under the entry's folder. */
export type LocalCopy = { file: string, kind: string, takenAt: string | null, bytes: number, mtime: string | null }

export type Listed = {
  name: string, url: string, host: string | null, cloud: string | null, boxId: string | number | null, runs: boolean
  /** Whether `~/.ssh/config` defines `host`; a key filed for a box another entry already reaches names a Host nothing defines. */
  hostKnown:    boolean
  /** The fli profile the box was bought under; null is the global file. */
  profile:      string | null
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
  const all   = await entries(opts)
  const hosts = c.sshHosts(opts.home)
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
      hostKnown:    !!e.host && hosts.has(e.host),
      profile:      e.profile ?? null,
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

// ─── Set up B2 backups ────────────────────────────────────────────────────

export type PlanSummary = {
  name:    string
  buckets: Array<{ name: string, kind: 'archive' | 'replica', held: boolean, lockDays: number | null, makeLockDays: number | null }>
  destinations: Array<{ name: string, workspace: string, bucket: string, prefix: string, keyName: string, action: 'make' | 'test' | 'keep', filed: boolean }>
  hub:     Array<{ label: string, action: 'set' | 'keep' }>
  apps:    Array<{ slug: string, action: 'set' | 'keep' }>
  unset:   Array<{ slug: string }>
  /** Workspaces with no owner or admin to act as; a set-up would stop there. */
  blocked: string[]
}

/**
 * The plan as the page may see it: bucket and destination names, key NAMES,
 * what would be made or kept. No holder email, no id of a workspace member, no
 * key material (the plan has none: nothing is minted until a run).
 */
export function summarizePlan(plan: BackupsPlan, lockDays: number): PlanSummary {
  const act = (d: Dest) => d.row?.lastTestAt ? 'keep' : d.row ? 'test' : 'make'
  const dest = (d: Dest, w: { name: string }) => ({ name: d.name, workspace: w.name, bucket: d.bucket, prefix: d.prefix, keyName: d.keyName, action: act(d) as 'make' | 'test' | 'keep', filed: !!d.row })
  const pointer = (v: unknown) => v ? 'keep' as const : 'set' as const
  return {
    name: plan.name,
    buckets: (['archive', 'replica'] as const).map(kind => ({
      name:         plan.buckets[kind].name,
      kind,
      held:         !!plan.buckets[kind].held,
      lockDays:     plan.buckets[kind].held?.lockDays ?? null,
      makeLockDays: kind === 'archive' ? lockDays : null,
    })),
    destinations: plan.workspaces.flatMap(w => [dest(w.archive, w), ...(w.replica ? [dest(w.replica, w)] : [])]),
    hub: [
      { label: 'hub backupDestinationId', action: pointer(plan.hub.backupDestinationId) },
      { label: 'hub replicaDestinationId', action: pointer(plan.hub.replicaDestinationId) },
      { label: 'hub backupCron', action: pointer(plan.hub.backupCron) },
    ],
    apps:    plan.apps.map(a => ({ slug: a.slug, action: pointer(a.backupDestinationId) })),
    unset:   plan.unset.map(a => ({ slug: a.slug })),
    blocked: plan.workspaces.filter(w => !w.holder).map(w => w.name),
  }
}

// The API's env does not hold the laptop's B2 key; fli's env files do. The
// entry's profile is read before the global file, as `loadFliEnv` orders them.
async function b2Env(c: Cli, opts: Options, profile?: string): Promise<Record<string, string>> {
  const env: Record<string, string> = {}
  const want = (k: string) => k === 'B2_KEY_ID' || k === 'B2_APPLICATION_KEY'
  const held = [...(profile ? c.listProfile(profile, { home: opts.home }) : []), ...c.listGlobal({ home: opts.home })]
  for (const { key, value } of held) if (want(key) && value && !(key in env)) env[key] = value
  return env
}

async function b2Entry(name: string, opts: Options): Promise<{ entry: Entry & { name: string } } | { refused: string }> {
  const e = await entryOf(name, opts)
  if (!e) return { refused: `No Basecamp named '${name}' in basecamps.json` }
  const entry = { name, ...e }
  const c = await loadCli()
  try { c.replWhere(entry) } catch (err) { return { refused: (err as Error).message } }
  return { entry }
}

const slugsOf = (apps: unknown): string[] | null =>
  apps === undefined ? [] : Array.isArray(apps) && apps.every(a => typeof a === 'string') ? apps as string[] : null

/** What a set-up would do, read off the Basecamp over ssh and the B2 account; changes nothing. */
export async function backupsPlan(name: string, opts: Options = {}): Promise<PlanSummary | { refused: string }> {
  const got = await b2Entry(name, opts)
  if ('refused' in got) return got
  const c = await loadCli()
  try {
    const session = await c.laptopSession({ env: await b2Env(c, opts, got.entry.profile) })
    return summarizePlan(await c.planBackups(got.entry, { session }), c.LOCK_DAYS)
  } catch (err) {
    return { refused: (err as Error).message }
  }
}

export type B2Input = { apps?: unknown, approved?: boolean }

/** Make the buckets, keys and destinations and point the hub and the chosen Apps at them. */
export async function startB2Setup(name: string, input: B2Input = {}, opts: Options = {}): Promise<Outcome | { refused: string }> {
  if (input.approved !== true) return { refused: 'Set up B2 backups makes B2 buckets and keys and is confirmed by a person each run: it was not approved' }
  const apps = slugsOf(input.apps)
  if (!apps) return { refused: 'apps is a list of App slugs' }
  const got = await b2Entry(name, opts)
  if ('refused' in got) return got
  const c = await loadCli()
  return hold(name, 'b2', async (held) => {
    held.lines = []
    const session = await c.laptopSession({ env: await b2Env(c, opts, got.entry.profile) })
    await c.setUpBackups(got.entry, { apps, session, say: (l) => { held.lines!.push(l) } })
  })
}

/** Take the destinations a set-up filed off the hub and Apps, remove them and delete their keys; the buckets stay. */
export async function startB2Undo(name: string, input: B2Input = {}, opts: Options = {}): Promise<Outcome | { refused: string }> {
  if (input.approved !== true) return { refused: 'Undo B2 backups removes backup destinations and deletes their keys and is confirmed by a person each run: it was not approved' }
  const got = await b2Entry(name, opts)
  if ('refused' in got) return got
  const c = await loadCli()
  return hold(name, 'b2-undo', async (held) => {
    held.lines = []
    const session = await c.laptopSession({ env: await b2Env(c, opts, got.entry.profile) })
    const out = await c.undoBackups(got.entry, { session, say: (l) => { held.lines!.push(l) } })
    held.note = `${out.removed} removed, ${out.kept} kept`
  })
}

// ─── Download a hub archive ───────────────────────────────────────────────

async function adminEntry(name: string, opts: Options): Promise<Entry | { refused: string }> {
  const e = await entryOf(name, opts)
  if (!e) return { refused: `No Basecamp named '${name}' in basecamps.json` }
  if (!e.apiKey) return { refused: `Basecamp '${name}' has no API key — fli basecamp:key --server ${e.host ?? '<box>'} files one` }
  return e
}

/** Fetch the newest archive Basecamp holds into this laptop's copies, unpacked and checked against its manifest. Takes no backup. */
export async function startDownload(name: string, opts: Options = {}): Promise<Outcome | { refused: string }> {
  const e = await adminEntry(name, opts)
  if ('refused' in e) return e
  const c = await loadCli()
  return hold(name, 'download', async (held) => {
    const row = await c.newestHubArchive({ origin: e.url, key: e.apiKey! })
    if (!row) throw new Error(`Basecamp '${name}' holds no backup that succeeded — Back up now takes one`)
    held.row = row
    const stamp = c.archiveDirName(row)
    if (localCopies(c, name, opts).some(b => b.file === stamp && b.kind === 'archive')) {
      held.note = `${stamp} is on this laptop already`
      return
    }
    await c.fetchHubArchive({ origin: e.url, key: e.apiKey!, row, out: copiesDir(c, name, opts) })
  })
}

/** The one-use link Basecamp mints for its newest archive, with the sha256 it recorded. The admin key stays here. */
export async function archiveLink(name: string, opts: Options = {}): Promise<{ url: string, name: string, sha256: string | null } | { refused: string }> {
  const e = await adminEntry(name, opts)
  if ('refused' in e) return e
  const c = await loadCli()
  try {
    const row = await c.newestHubArchive({ origin: e.url, key: e.apiKey! })
    if (!row) return { refused: `Basecamp '${name}' holds no backup that succeeded — Back up now takes one` }
    const got = await c.basecamp(e.url, e.apiKey!, `/hub-backups/${encodeURIComponent(row.id)}`,
      { method: 'POST', headers: { 'x-service-method': 'download' }, body: {} }) as { url: string, name: string }
    return { url: new URL(got.url, e.url + '/').href, name: got.name, sha256: (row.sha256 as string | null) ?? null }
  } catch (err) {
    return { refused: (err as Error).message }
  }
}

// ─── The encryption key copy ──────────────────────────────────────────────

export type KeyState = 'matches' | 'missing' | 'differs' | 'none'

/** Fingerprints only, each its first 12 hex characters. */
export type KeyCopy = {
  state:       KeyState
  /** The key on the box's disk. */
  box:         string | null
  /** The copies filed on this laptop. */
  filed:       string[]
  /** The key the newest archive on this laptop was taken under: the one Basecamp ran then. */
  archive:     string | null
  /** The copy Basecamp has on record as kept off the box, and when. */
  attested:    string | null
  attestedAt:  string | null
}

const short = (fp: string | null | undefined) => fp ? fp.slice(0, 12) : null

async function keyEntry(name: string, opts: Options): Promise<Entry & { host: string } | { refused: string }> {
  const e = await adminEntry(name, opts)
  if ('refused' in e) return e
  if (!e.host) return { refused: `Basecamp '${name}' has no ssh Host, and its key is read on its box over ssh — the dev Basecamp keeps its key in this checkout` }
  return e as Entry & { host: string }
}

// The fingerprint the newest pulled archive names is the key the API ran when
// it was taken; the box's disk can hold another one the API has not restarted on.
function archiveKey(c: Cli, name: string, opts: Options): string | null {
  return c.localBackups(copiesDir(c, name, opts)).filter(b => b.kind === 'archive').at(-1)?.fingerprint ?? null
}

async function attestation(c: Cli, e: Entry): Promise<{ fingerprint: string | null, at: string | null }> {
  const row = await c.basecamp(e.url, e.apiKey!, '/hub-config', { method: 'POST', headers: { 'x-service-method': 'current' }, body: {} })
    .catch((err: Error & { status?: number }) => { if (err.status === 404) return null; throw err }) as
    { encryptionKeyFingerprint?: string | null, encryptionKeyEscrowedAt?: string | null } | null
  return { fingerprint: row?.encryptionKeyFingerprint ?? null, at: row?.encryptionKeyEscrowedAt ?? null }
}

/** Whether this laptop holds a copy of the key on the box, read over ssh; changes nothing. */
export async function keyCopy(name: string, opts: Options = {}): Promise<KeyCopy | { refused: string }> {
  const e = await keyEntry(name, opts)
  if ('refused' in e) return e
  const c = await loadCli()
  try {
    const [boxKey, attested] = await Promise.all([c.basecampFiles(e.host).then(f => c.readBoxKey(f)), attestation(c, e)])
    const got = c.keyCopyState(name, boxKey)
    return {
      state: got.state, box: short(got.fingerprint), filed: got.filed.map(f => short(f)!),
      archive: short(archiveKey(c, name, opts)), attested: short(attested.fingerprint), attestedAt: attested.at,
    }
  } catch (err) {
    return { refused: (err as Error).message }
  }
}

/**
 * File the box's key on this laptop, then attest it to Basecamp only when the
 * newest pulled archive was taken under it (`FJS-D1876`): an attestation of a
 * key the API does not run grades `hub.key-escrowed` green for nothing.
 */
export async function saveKey(name: string, opts: Options = {}): Promise<{ kept: string, already: boolean, attested: boolean, why: string | null } | { refused: string }> {
  const e = await keyEntry(name, opts)
  if ('refused' in e) return e
  const c = await loadCli()
  try {
    const boxKey = await c.readBoxKey(await c.basecampFiles(e.host))
    if (!boxKey) return { refused: `${e.host} keeps no ENCRYPTION_KEY, in its secrets directory or env file` }
    const kept = c.keepKey({ server: name, key: boxKey, how: 'f', echo: () => {} })
    const fp = kept.fingerprint
    const archive = archiveKey(c, name, opts)
    const out = { kept: short(fp)!, already: kept.already }
    if (!archive) return { ...out, attested: false, why: 'No archive on this laptop shows which key Basecamp runs — Download one, then Save key again to attest it' }
    if (archive !== fp) return { ...out, attested: false, why: `The newest archive on this laptop was taken under ${short(archive)}, not the ${short(fp)} on the box's disk — Download the newest archive, then Save key again to attest it` }
    await c.attestKeyCopy({ origin: e.url, key: e.apiKey!, fingerprint: fp })
    return { ...out, attested: true, why: null }
  } catch (err) {
    return { refused: (err as Error).message }
  }
}
