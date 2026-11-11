// api/src/domain/charter/restore-drill.ts
// The restore drill: back a Basecamp up, reinstall it from that backup, and
// grade what came back -- the hub's rows, the Apps it manages, and one App's
// data through its own backup and restore.
//
// A rehearsal reads the box and runs `basecamp:reinstall --plan`, so it changes
// nothing. A real run retires the Basecamp, and the Apps on the box have no hub
// until the install is back.
//
// The drill is its own detached process (`restore-drill-run.ts`) writing a
// record after every stage. `bun --watch` restarts this API whenever a file
// changes, and a drill driven from inside it would die between the retire and
// the install. A record whose process is gone reads `stopped`.
//
// The App data stage stops, overwrites and re-releases its App, so it runs only
// on an App a Charter case left standing (`keptApps`) and never on anything
// else the box serves. Every value that reaches a script on the box is checked
// against a pattern first.

import { spawn }                                                               from 'node:child_process'
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve }                                                       from 'node:path'
import { workbenchDir }                                                        from '../../core/env.ts'
import { tail }                                                                from '../workbench/workbench-run.ts'
import { entryOf }                                                             from '../basecamps/basecamps.ts'
import { reinstallationOf }                                                    from '../basecamps/basecamps-reinstall.ts'
import { keptApps, liveProcesses, drillProcesses }                             from './live-runs.ts'

export const DRILL_STAGES = ['preflight', 'before', 'reinstall', 'hub', 'apps', 'data'] as const
export const DRILL_MODES  = ['rehearse', 'real'] as const

export type DrillStage = typeof DRILL_STAGES[number]
export type DrillMode  = typeof DRILL_MODES[number]
export type Outcome    = 'passed' | 'failed' | 'skipped' | 'not reached'
export type StageRow   = { outcome: Outcome, ms: number, detail: string }
export type Sample     = { record: string, appName: string, appId: string, hostname: string | null }
export type DrillState = 'starting' | 'running' | 'stopped' | 'passed' | 'failed'

export type Drill = {
  drill:      1
  id:         string
  mode:       DrillMode
  basecamp:   string
  startedAt:  string
  finishedAt: string | null
  outcome:    'passed' | 'failed' | null
  pid:        number | null
  current:    DrillStage | null
  sample:     Sample | null
  log:        string
  reinstallLog: string | null
  stages:     Record<DrillStage, StageRow>
}

type Row       = Record<string, any>
type Item      = { id: string, label: string }
type Inventory = Record<string, Item[]>
type Reinstall = { log: string, exit: { code: number | null, signal: string | null } | null, error?: string }
export type Probe = { ok: boolean, status: number | null, why: string | null }

/** Everything the drill does to the outside world. */
export type Deps = {
  save:      (d: Drill) => void
  /** Why `fli deploy` would refuse this commit; empty when it would not. */
  gate:      () => string[]
  read:      (path: string) => Promise<any>
  list:      (path: string) => Promise<Row[]>
  /** A POST, with `method` as the service method when it is not `create`. */
  call:      (path: string, method: string | null, body: Row) => Promise<any>
  /** Every key filed for this Basecamp's address, by entry, and the status it got. */
  keys:      () => Promise<Array<{ name: string, status: number | null }>>
  probe:     (hostname: string) => Promise<Probe>
  box:       (script: string, what: string) => Promise<string>
  reinstall: (plan: boolean) => Reinstall
  sleep:     (ms: number) => Promise<void>
  now:       () => number
}

export type Options = {
  /** Workbench's own directory: drill records and logs. */
  wb?:   string
  /** Where `basecamps.json` is read from. */
  home?: string
  /** Other work holding the box; `ps` when absent. */
  running?: () => number[]
  /** Why this commit cannot deploy; the real gate when absent. */
  gate?: () => Promise<string[]>
  /** The kept Apps; Charter's records when absent. */
  kept?: () => Array<Sample & { basecamp: string | null }>
  /** Starts the runner on a record; a detached process when absent. */
  spawnRunner?: (file: string, log: string) => void
}

const COLLECTIONS = { apps: '/apps', domains: '/domains', servers: '/servers', projects: '/projects', workspaces: '/workspaces' }

const POLL_MS        = 5_000
const HUB_WAIT_MS    = 5 * 60_000
const BEAT_WAIT_MS   = 3 * 60_000
const BACKUP_WAIT_MS = 10 * 60_000
const DEPLOY_WAIT_MS = 10 * 60_000
const SERVE_WAIT_MS  = 2 * 60_000
// One missed check is the network between here and the box; two in a row is an outage.
const OUTAGE_CHECKS  = 2

const APP_ID  = /^[0-9a-f-]{36}$/
const SAFE    = /^[A-Za-z0-9_.-]+$/
const PATH    = /^\/[A-Za-z0-9_./-]+$/
const MARKER  = '.fjs-drill-marker'

// ─── The inventory ──────────────────────────────────────────────────────────

const labelOf = (row: Row) => String(row.name ?? row.hostname ?? row.slug ?? row.id)

async function inventoryOf(deps: Deps): Promise<Inventory> {
  const out: Inventory = {}
  for (const [name, path] of Object.entries(COLLECTIONS))
    out[name] = (await deps.list(path)).map(r => ({ id: String(r.id), label: labelOf(r) }))
  return out
}

/** What is missing, new or renamed between two inventories, one sentence each. */
export function diffInventory(before: Inventory, after: Inventory): string[] {
  const out: string[] = []
  for (const name of Object.keys(before)) {
    const now = new Map((after[name] ?? []).map(r => [r.id, r]))
    const was = new Set(before[name].map(r => r.id))
    for (const r of before[name]) {
      const found = now.get(r.id)
      if (!found) out.push(`${name}: ${r.label} is missing`)
      else if (found.label !== r.label) out.push(`${name}: ${r.label} is now ${found.label}`)
    }
    for (const r of after[name] ?? []) if (!was.has(r.id)) out.push(`${name}: ${r.label} is new`)
  }
  return out
}

const count   = (n: number, plural: string) => `${n} ${n === 1 ? plural.replace(/s$/, '') : plural}`
const counted = (inv: Inventory) => Object.entries(inv).map(([k, v]) => count(v.length, k)).join(', ')

// ─── Serving ────────────────────────────────────────────────────────────────

type Watch = { checks: number, misses: number, streak: number, worst: number }

async function watchOnce(hosts: string[], watched: Map<string, Watch>, deps: Deps) {
  await Promise.all(hosts.map(async h => {
    const w = watched.get(h) ?? { checks: 0, misses: 0, streak: 0, worst: 0 }
    watched.set(h, w)
    const p = await deps.probe(h)
    w.checks++
    if (p.ok) { w.streak = 0; return }
    w.misses++
    w.streak++
    w.worst = Math.max(w.worst, w.streak)
  }))
}

async function servingNow(hostname: string, deps: Deps, forMs: number): Promise<Probe> {
  const until = deps.now() + forMs
  for (;;) {
    const p = await deps.probe(hostname)
    if (p.ok || deps.now() >= until) return p
    await deps.sleep(POLL_MS)
  }
}

const said = (p: Probe) => p.why ?? `answered ${p.status}`

// ─── The App data round trip ────────────────────────────────────────────────

// Run inside the App's own container, as its own uid, so nothing on the volume
// changes owner. The App's databases are opened read-only: a row or table the
// drill added could refuse its next boot, so the writable proof is a file.
const VOLUME_SCRIPT = `
const { Database } = require('bun:sqlite')
const fs = require('node:fs'), path = require('node:path')
const dir = process.env.DRILL_DIR, marker = path.join(dir, '${MARKER}')
if (process.env.DRILL_WRITE === '-') fs.rmSync(marker, { force: true })
else if (process.env.DRILL_WRITE) fs.writeFileSync(marker, process.env.DRILL_WRITE)
const dbs = {}
for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.db') && !f.includes('jobs')).sort()) {
  const db = new Database(path.join(dir, f), { readonly: true })
  const check = db.query('PRAGMA integrity_check').get().integrity_check
  const rows = {}
  for (const t of db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all())
    rows[t.name] = db.query('SELECT count(*) AS n FROM "' + t.name.replace(/"/g, '""') + '"').get().n
  dbs[f] = { check, rows }
  db.close()
}
console.log(JSON.stringify({ marker: fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : null, dbs }))
`

type Volume = { marker: string | null, dbs: Record<string, { check: string, rows: Record<string, number> }> }

async function inVolume(deps: Deps, container: string, dir: string, write: string): Promise<Volume> {
  const encoded = Buffer.from(VOLUME_SCRIPT).toString('base64')
  const out = await deps.box(
    `docker exec -e DRILL_DIR=${dir} -e DRILL_WRITE=${write} ${container} bun -e "$(echo ${encoded} | base64 -d)"`,
    'read the App volume')
  return JSON.parse(out.trim().split('\n').pop() as string)
}

async function containerOf(deps: Deps, appId: string): Promise<string> {
  const out = await deps.box(`docker ps --filter label=fjs.app=${appId} --format '{{.Names}}'`, 'find the App container')
  const name = out.trim().split('\n')[0] ?? ''
  if (!SAFE.test(name)) throw new Error(`No running container for App ${appId}`)
  return name
}

async function settled(deps: Deps, path: string, forMs: number, what: string): Promise<Row> {
  const until = deps.now() + forMs
  for (;;) {
    const row = await deps.read(path) as Row
    if (['success', 'failed', 'cancelled', 'rolledBack'].includes(row.status)) {
      if (row.status !== 'success') throw new Error(`${what} ended ${row.status}${row.error ? `: ${row.error}` : ''}`)
      return row
    }
    if (deps.now() >= until) throw new Error(`${what} was still ${row.status} after ${Math.round(forMs / 60_000)} minutes`)
    await deps.sleep(POLL_MS)
  }
}

/** The App this stage may stop and overwrite, read back and held to its record. */
async function sampleOnHub(deps: Deps, s: Sample) {
  if (!APP_ID.test(s.appId)) throw new Error(`'${s.appId}' is not an App id`)
  const app = await deps.read(`/apps/${s.appId}`) as Row
  const project = app.environment?.project
  if (![app.name, app.slug, project?.name, project?.slug].includes(s.appName))
    throw new Error(`App ${s.appId} is not ${s.appName}, the App ${s.record} left standing`)
  const dir      = String(app.volumePath ?? '')
  const serverId = app.placement?.[0]?.serverId as string | undefined
  const release  = (app.recent_deployments ?? []).find((r: Row) => r.status === 'success' && r.builtImage) as Row | undefined
  if (!PATH.test(dir)) throw new Error(`${s.appName} has no volume to back up`)
  if (!serverId) throw new Error(`${s.appName} is placed on no machine`)
  if (!release) throw new Error(`${s.appName} has no successful release naming its image`)
  return { dir, serverId, release }
}

async function dataRoundTrip(s: Sample, deps: Deps): Promise<string> {
  const { dir, serverId, release } = await sampleOnHub(deps, s)
  const A = `kept-${deps.now()}`
  const B = `changed-${deps.now()}`
  let container = await containerOf(deps, s.appId)
  const taken = await inVolume(deps, container, dir, A)

  const started = await deps.call('/app-backups', 'take', { appId: s.appId, serverId }) as Row
  const backup  = await settled(deps, `/app-backups/${started.id}`, BACKUP_WAIT_MS, 'The App backup')
  const archive = String(backup.location ?? '')
  if (!PATH.test(archive) || !/\/backups\/[^/]+$/.test(archive)) throw new Error(`The App backup is not on the machine's disk: ${archive || 'no location'}`)

  await inVolume(deps, container, dir, B)
  const restoreDir = archive.replace(/\/backups\/[^/]+$/, '/restore')
  const copy       = `${restoreDir}/drill-${s.appId}.tar.gz`
  try {
    // Outpost refuses a data directory any container holds, stopped ones included.
    await deps.box(`docker rm -f ${container} && mkdir -p ${restoreDir} && cp -- ${archive} ${copy}`, 'stop the App and stage its archive')
    await deps.call(`/apps/${s.appId}`, 'restoreVolume', { serverId, path: copy, isOverwriting: true })
    const made = await deps.call('/deployments', null, { appId: s.appId, builtImage: release.builtImage, toImage: release.toImage ?? null }) as Row
    await settled(deps, `/deployments/${made.id}`, DEPLOY_WAIT_MS, 'The release after the restore')

    container = await containerOf(deps, s.appId)
    const back = await inVolume(deps, container, dir, '')
    if (back.marker !== A) throw new Error(`The restore brought back marker ${back.marker ?? 'none'}, not the one in the backup`)
    if (JSON.stringify(back.dbs) !== JSON.stringify(taken.dbs)) throw new Error(`The App's databases differ from the backup: ${JSON.stringify(back.dbs)} against ${JSON.stringify(taken.dbs)}`)
    const bad = Object.entries(back.dbs).filter(([, v]) => v.check !== 'ok').map(([f]) => f)
    if (bad.length) throw new Error(`integrity_check failed on ${bad.join(', ')}`)
    if (s.hostname) {
      const p = await servingNow(s.hostname, deps, SERVE_WAIT_MS)
      if (!p.ok) throw new Error(`${s.hostname} ${said(p)} after the restore`)
    }
    await inVolume(deps, container, dir, '-')
    return `${s.appName} came back from its backup: the marker and ${count(Object.keys(back.dbs).length, 'databases')} match`
  } finally {
    await deps.box(`rm -f -- ${copy}`, 'remove the staged archive').catch(() => {})
  }
}

// ─── The run ────────────────────────────────────────────────────────────────

export const blankStages = (): Record<DrillStage, StageRow> =>
  Object.fromEntries(DRILL_STAGES.map(s => [s, { outcome: 'not reached', ms: 0, detail: '' }])) as Record<DrillStage, StageRow>

type Work = () => Promise<string | { skipped: string }>

async function stage(d: Drill, deps: Deps, name: DrillStage, work: Work): Promise<Outcome> {
  const began = deps.now()
  d.current = name
  deps.save(d)
  let row: Pick<StageRow, 'outcome' | 'detail'>
  try {
    const out = await work()
    row = typeof out === 'string' ? { outcome: 'passed', detail: out } : { outcome: 'skipped', detail: out.skipped }
  } catch (e) {
    row = { outcome: 'failed', detail: (e as Error).message }
  }
  d.stages[name] = { ...row, ms: deps.now() - began }
  d.current = null
  deps.save(d)
  return row.outcome
}

function finish(d: Drill, deps: Deps) {
  d.current    = null
  d.finishedAt = new Date(deps.now()).toISOString()
  d.outcome    = Object.values(d.stages).some(s => s.outcome === 'failed') ? 'failed' : 'passed'
  deps.save(d)
  return d
}

async function untilHubAnswers(deps: Deps): Promise<Inventory> {
  const until = deps.now() + HUB_WAIT_MS
  for (;;) {
    try { return await inventoryOf(deps) }
    catch (e) {
      if (deps.now() >= until) throw new Error(`The hub did not answer: ${(e as Error).message}`)
      await deps.sleep(POLL_MS)
    }
  }
}

const isRunningKind = (a: Row) => a.kind !== 'static' && a.kind !== 'function'

async function runningApps(deps: Deps, apps: Row[]): Promise<Item[]> {
  const out: Item[] = []
  for (const a of apps.filter(isRunningKind)) {
    const logs = await deps.call(`/apps/${a.id}`, 'logs', {}) as Row
    if (logs.running) out.push({ id: String(a.id), label: labelOf(a) })
  }
  return out
}

async function heartbeatsAfter(deps: Deps, since: number): Promise<string[]> {
  const until = deps.now() + BEAT_WAIT_MS
  for (;;) {
    const quiet = (await deps.list('/servers')).filter(s => !s.lastHeartbeatAt || Date.parse(s.lastHeartbeatAt) < since).map(labelOf)
    if (!quiet.length || deps.now() >= until) return quiet
    await deps.sleep(POLL_MS)
  }
}

/** The stages, in order, saving after each. A real run stops before the retire on anything wrong. */
export async function runDrill(d: Drill, deps: Deps): Promise<Drill> {
  const real = d.mode === 'real'
  let before: Inventory = {}
  let hosts: string[] = []
  let running: Item[] = []
  const watched = new Map<string, Watch>()

  const ready = await stage(d, deps, 'preflight', async () => {
    await deps.read('/apps?$limit=1')
    const refusals = deps.gate()
    if (refusals.length) throw new Error(`fli deploy would refuse this commit: ${refusals.join('; ')}`)
    return 'The admin key answers and this commit can deploy'
  })

  const read = await stage(d, deps, 'before', async () => {
    before  = await inventoryOf(deps)
    hosts   = (await deps.list('/domains')).map(r => String(r.hostname))
    running = await runningApps(deps, await deps.list('/apps'))
    await watchOnce(hosts, watched, deps)
    const down = hosts.filter(h => watched.get(h)!.misses)
    if (down.length) throw new Error(`Already not serving: ${down.join(', ')}`)
    return `${counted(before)}; ${count(hosts.length, 'hostnames')} serving, ${count(running.length, 'Apps')} running`
  })

  if (real && (ready !== 'passed' || read !== 'passed')) return finish(d, deps)

  let finishedAt = 0
  const installed = await stage(d, deps, 'reinstall', async () => {
    const run = deps.reinstall(!real)
    d.reinstallLog = run.log
    deps.save(d)
    while (!run.exit && !run.error) {
      if (real) await watchOnce(hosts, watched, deps)
      await deps.sleep(POLL_MS)
    }
    finishedAt = deps.now()
    if (run.error) throw new Error(`Could not start fli basecamp:reinstall: ${run.error}`)
    if (run.exit!.code !== 0) throw new Error(`fli basecamp:reinstall exited ${run.exit!.code ?? run.exit!.signal}; read its log`)
    return real ? 'Backed up, retired and restored' : 'The plan ran and nothing changed'
  })

  if (!real) {
    for (const s of ['hub', 'apps', 'data'] as const) d.stages[s] = { outcome: 'skipped', ms: 0, detail: 'A rehearsal changes nothing, so there is nothing to compare' }
    return finish(d, deps)
  }

  const hub = await stage(d, deps, 'hub', async () => {
    const after = await untilHubAnswers(deps)
    const problems = diffInventory(before, after)
    const refused  = (await deps.keys()).filter(k => k.status === 401).map(k => k.name)
    if (refused.length) problems.push(`keys no longer accepted: ${refused.join(', ')}`)
    if (problems.length) throw new Error(problems.join('; '))
    return `${counted(after)} match, and every filed key is still accepted`
  })

  const apps = await stage(d, deps, 'apps', async () => {
    const problems: string[] = []
    for (const [h, w] of watched)
      if (w.worst >= OUTAGE_CHECKS) problems.push(`${h} went down during the reinstall: ${w.misses} of ${w.checks} checks missed`)
    for (const h of hosts) {
      const p = await servingNow(h, deps, SERVE_WAIT_MS)
      if (!p.ok) problems.push(`${h} ${said(p)}`)
    }
    if (hub === 'passed') {
      const quiet = await heartbeatsAfter(deps, finishedAt)
      if (quiet.length) problems.push(`no heartbeat since the restore from ${quiet.join(', ')}`)
      const now = new Set((await runningApps(deps, await deps.list('/apps'))).map(a => a.id))
      const lost = running.filter(a => !now.has(a.id)).map(a => a.label)
      if (lost.length) problems.push(`the hub can no longer reach ${lost.join(', ')}`)
    } else problems.push('the hub did not match, so it could not be asked about its Apps')
    if (problems.length) throw new Error(problems.join('; '))
    return `${count(hosts.length, 'hostnames')} served throughout, and the hub reaches ${count(running.length, 'running Apps')}`
  })

  if (installed === 'passed' && hub === 'passed' && apps === 'passed')
    await stage(d, deps, 'data', async () => d.sample
      ? dataRoundTrip(d.sample, deps)
      : { skipped: 'No App is left standing on this Basecamp: run a Charter case with Leave it standing' })

  return finish(d, deps)
}

// ─── Records ────────────────────────────────────────────────────────────────

const drillDir = (o: Options) => join(o.wb || workbenchDir(), 'drills')
const logDir   = (o: Options) => join(o.wb || workbenchDir(), 'logs')
const RECORD   = /^(\d{4}-\d{2}-\d{2}T[\d-]+Z)\.json$/
const STARTING_MS = 30_000

const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

/** A drill's state: a record with no end is running only while its process is. */
export function stateOfDrill(d: Drill, isAlive: (pid: number) => boolean = alive, now = Date.now()): DrillState {
  if (d.outcome) return d.outcome
  if (d.pid) return isAlive(d.pid) ? 'running' : 'stopped'
  return now - Date.parse(d.startedAt) < STARTING_MS ? 'starting' : 'stopped'
}

/** The record, or why it is not one this reader knows. */
export function readDrill(text: string, name: string): Drill | { refused: string } {
  let r: Row
  try { r = JSON.parse(text) } catch (e) { return { refused: `${name} is not JSON: ${(e as Error).message}` } }
  if (r?.drill !== 1) return { refused: `${name} is drill record version ${r?.drill}, which this Workbench does not read` }
  for (const s of DRILL_STAGES) if (!r.stages?.[s]) return { refused: `${name} is missing stage '${s}'` }
  return r as Drill
}

export function allDrills(o: Options = {}) {
  let names: string[] = []
  try { names = readdirSync(drillDir(o)).filter(f => RECORD.test(f)) } catch { /* none yet */ }
  return names.sort().reverse().map(f => readDrill(readFileSync(join(drillDir(o), f), 'utf8'), f))
}

// ─── Starting ───────────────────────────────────────────────────────────────

const basecampRoot = () => resolve(import.meta.dir, '../../../../../basecamp')

type Gate = { gateVerdict: (f: unknown) => { refusals: string[] }, readGateFacts: (root: string) => unknown }

/** Why `fli deploy` would refuse this commit. */
export async function deployRefusals(): Promise<string[]> {
  const { gateVerdict, readGateFacts } = await import('@frontierjs/cli/core/deploy-gate.js') as unknown as Gate
  return gateVerdict(readGateFacts(basecampRoot())).refusals
}

const otherWork = () => [...liveProcesses(), ...drillProcesses()]

type Designated = { designatedBasecamp: (x: { home?: string }) => { name: string } }

async function designated(o: Options) {
  const { designatedBasecamp } = await import('@frontierjs/cli/core/basecamps.js') as unknown as Designated
  const name = designatedBasecamp({ home: o.home }).name
  return { name, entry: await entryOf(name, { home: o.home }) }
}

function sampleFor(name: string, o: Options): Sample | null {
  const kept = (o.kept ?? keptApps)().filter(k => k.basecamp === name && APP_ID.test(k.appId))
  if (!kept.length) return null
  const { record, appName, appId, hostname } = kept[0]
  return { record, appName, appId, hostname }
}

function spawnRunner(file: string, log: string) {
  const fd = openSync(log, 'a')
  try {
    spawn(process.execPath, [join(import.meta.dir, 'restore-drill-run.ts'), file], {
      detached: true, stdio: ['ignore', fd, fd], env: { ...process.env, NO_COLOR: '1' },
    }).unref()
  } finally { closeSync(fd) }
}

/** Start a drill on the designated Basecamp, or say why not. */
export async function startDrill(input: { mode?: unknown, approved?: unknown }, o: Options = {}): Promise<Drill | { refused: string }> {
  const mode = input.mode as DrillMode
  if (!DRILL_MODES.includes(mode)) return { refused: `A drill is ${DRILL_MODES.join(' or ')}, not '${String(input.mode)}'` }
  if (input.approved !== true) return { refused: 'A restore drill is confirmed by a person each run: it was not approved' }

  let found
  try { found = await designated(o) } catch (e) { return { refused: (e as Error).message } }
  const { name, entry } = found
  if (!entry) return { refused: `No Basecamp named '${name}' in basecamps.json` }
  if (!entry.host) return { refused: `Basecamp '${name}' has no ssh Host, and a drill runs on its box over ssh` }
  if (!entry.apiKey) return { refused: `Basecamp '${name}' has no admin API key — fli basecamp:key --server ${entry.host} files one` }

  const others = (o.running ?? otherWork)()
  if (others.length) return { refused: `A Charter run or another drill is going (pid ${others.join(', ')}), and a drill needs the box to itself` }
  const reinstall = reinstallationOf()
  if (reinstall && !reinstall.exit) return { refused: `Already reinstalling '${reinstall.name}'` }
  if (mode === 'real') {
    const refusals = await (o.gate ?? deployRefusals)()
    if (refusals.length) return { refused: `fli deploy would refuse this commit, after the retire: ${refusals.join('; ')}` }
  }

  const startedAt = new Date().toISOString()
  const id        = startedAt.replace(/[:.]/g, '-')
  mkdirSync(drillDir(o), { recursive: true })
  mkdirSync(logDir(o), { recursive: true })
  const file = join(drillDir(o), `${id}.json`)
  const log  = join(logDir(o), `restore-drill.${name}.${id}.log`)
  const d: Drill = { drill: 1, id, mode, basecamp: name, startedAt, finishedAt: null, outcome: null, pid: null,
    current: null, sample: sampleFor(name, o), log, reinstallLog: null, stages: blankStages() }
  writeFileSync(file, JSON.stringify(d, null, 2))
  ;(o.spawnRunner ?? spawnRunner)(file, log)
  return d
}

// ─── Reading ────────────────────────────────────────────────────────────────

/** Everything the page draws, with no call to the box. */
export async function stateOfDrills(o: Options = {}) {
  let found: Awaited<ReturnType<typeof designated>> | null = null
  let why: string | null = null
  try { found = await designated(o) } catch (e) { why = (e as Error).message }
  const rows   = allDrills(o)
  const drills = rows.filter((r): r is Drill => !('refused' in r)).slice(0, 10).map(d => ({ ...d, state: stateOfDrill(d) }))
  const latest = drills[0] ?? null
  return {
    basecamp: found?.entry ? { name: found.name, url: found.entry.url, host: found.entry.host ?? null, hasKey: !!found.entry.apiKey } : null,
    why,
    sample:  found ? sampleFor(found.name, o) : null,
    gate:     await (o.gate ?? deployRefusals)(),
    drills,
    lines:    latest ? tail(latest.reinstallLog ?? latest.log) : [],
    refused:  rows.filter((r): r is { refused: string } => 'refused' in r).map(r => r.refused),
  }
}

type Cli = { basecamp: (origin: string, key: string, path: string) => Promise<any>, basecampAll: (origin: string, key: string, path: string) => Promise<Row[]> }

/** The Apps a real run puts at risk, by name, for the page's confirmation. Names only. */
export async function fleetOf(o: Options = {}) {
  try {
    const { name, entry } = await designated(o)
    if (!entry?.apiKey) return { apps: [], why: `'${name}' has no admin API key` }
    const { basecampAll } = await import('@frontierjs/cli/core/basecamp.js') as unknown as Cli
    const [apps, domains] = await Promise.all([basecampAll(entry.url, entry.apiKey, '/apps'), basecampAll(entry.url, entry.apiKey, '/domains')])
    return {
      apps: apps.map(a => ({ id: String(a.id), name: labelOf(a), kind: String(a.kind), hostnames: domains.filter(d => d.appId === a.id).map(d => String(d.hostname)) })),
      why:  null,
    }
  } catch (e) { return { apps: [], why: (e as Error).message } }
}
