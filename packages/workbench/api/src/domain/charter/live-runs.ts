// api/src/domain/charter/live-runs.ts
// The Charter page's runs: `bun builder/live.ts <charter>` in a Charter
// checkout, one case at a time, read back through the records it rewrites
// (charter-to-live.md 2.3, FJS-D2025 -- nothing leaves Charter).
//
// One live.ts at a time on the whole machine, not just from here: every run
// writes under apps/charter/oracle/, and a second one started from a terminal
// would corrupt the first. So a start is refused while any live.ts runs.
//
// The queue is in memory. A child is detached and outlives an API restart
// (`bun --watch`), but the cases after it are never started; with nothing held,
// the page reads the newest day's records off disk instead.
//
// A kept App (`--keep`, FJS-D1893) is removed by Charter's own clean stage,
// `live.ts --from clean` on its record, so the box diff that proves a run left
// nothing behind proves the removal too.

import { spawn, spawnSync }                                         from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join, resolve }                                  from 'node:path'
import { env, workbenchDir }                                        from '../../core/env.ts'
import { tail }                                                     from '../workbench/workbench-run.ts'
import { readLiveRecord, stateOf, type LiveRecord, type LiveState } from './live-record.ts'

export type Case = {
  /** The record's name: the file's name without `.json`. */
  case:   string
  /** The path live.ts is given: relative to the checkout for a corpus case, absolute for a picked one. */
  file:   string
  source: 'corpus' | 'picked'
}

export type Item = {
  case:       string
  file:       string
  /** `clean`: removing a kept App. */
  from?:      'clean'
  startedAt:  string | null
  pid:        number | null
  exit:       { code: number | null, signal: string | null } | null
  log:        string | null
  error?:     string
}

export type Batch = { kind: 'run' | 'remove', date: string, keep: boolean, startedAt: string, items: Item[] }

export type ItemView = Item & {
  state:   LiveState | 'queued' | 'starting'
  record:  LiveRecord | null
  refused: string | null
  lines:   string[]
}

export type Options = {
  /** The Charter checkout; `charterDir()` when absent. */
  dir?:  string
  /** Workbench's own directory: picked charters and logs. */
  wb?:   string
  /** Where `basecamps.json` is read from. */
  home?: string
  /** A live.ts already running elsewhere on this machine; `ps` when absent. */
  running?: () => number[]
}

// The record's own name for a case (live.ts `stem`).
const stemOf = (file: string) => basename(file).replace(/(\.charter)?\.json$/i, '')
const WORD   = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const today  = () => new Date().toISOString().slice(0, 10)
const RECORD = /^(\d{4}-\d{2}-\d{2})-live-(.+)\.json$/

export const charterDir = (o: Options = {}) =>
  o.dir || env.CHARTER_DIR || resolve(import.meta.dir, '../../../../../../../fjs-prototypes/charter')
const pickedDir = (o: Options) => join(o.wb || workbenchDir(), 'charters')
const logDir    = (o: Options) => join(o.wb || workbenchDir(), 'logs')

let held: Batch | null = null

// ─── The checkout ───────────────────────────────────────────────────────────

type Ports = { appPorts: (root: string, o: { name?: string, scripts?: Record<string, string> }) => Array<{ port: number, surface: string }> }

/** The checkout, whether it holds live.ts, and where Charter's wizard would answer. */
export async function checkoutOf(o: Options = {}) {
  const dir = charterDir(o)
  const ok  = existsSync(join(dir, 'builder/live.ts'))
  let wizard: string | null = null
  if (ok) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
      const { appPorts } = await import('@frontierjs/cli/core/ports.js') as unknown as Ports
      const web = appPorts(dir, { name: pkg.name, scripts: pkg.scripts }).find(r => r.surface === 'web')
      if (web) wizard = `http://localhost:${web.port}/new/`
    } catch { /* no wizard link: the page says how to start Charter instead */ }
  }
  return { dir, ok, wizard }
}

/** The corpus matrix, then the charters picked on this page. */
export function listCases(o: Options = {}): Case[] {
  const dir    = charterDir(o)
  const json   = (d: string) => { try { return readdirSync(d).filter(f => f.endsWith('.json')).sort() } catch { return [] } }
  const corpus = json(join(dir, 'corpus/live')).map(f => ({ case: stemOf(f), file: `corpus/live/${f}`, source: 'corpus' as const }))
  const picked = json(pickedDir(o)).map(f => ({ case: stemOf(f), file: join(pickedDir(o), f), source: 'picked' as const }))
  return [...corpus, ...picked]
}

/** Keep a charter.json picked on the page, under Workbench's directory, as a case. */
export function addCharter(input: { name?: unknown, text?: unknown }, o: Options = {}): Case | { refused: string } {
  const name = typeof input.name === 'string' ? stemOf(input.name.trim()) : ''
  if (!WORD.test(name)) return { refused: `A charter's name is letters, digits, '.', '_' and '-', not '${name}'` }
  if (typeof input.text !== 'string') return { refused: 'The charter file came with no text' }
  // Its record is runs/<date>-live-<name>.json, so a corpus case's name would share it.
  if (listCases(o).some(c => c.source === 'corpus' && c.case === name)) return { refused: `'${name}' is a corpus case's name; rename the file` }
  let parsed: unknown
  try { parsed = JSON.parse(input.text) } catch (e) { return { refused: `${name}.json is not JSON: ${(e as Error).message}` } }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { refused: `${name}.json is not a charter: not an object` }
  mkdirSync(pickedDir(o), { recursive: true })
  const file = join(pickedDir(o), `${name}.json`)
  writeFileSync(file, input.text)
  return { case: name, file, source: 'picked' }
}

// ─── Records ────────────────────────────────────────────────────────────────

const recordPath = (o: Options, date: string, name: string) => join(charterDir(o), 'runs', `${date}-live-${name}.json`)

function readAt(path: string): LiveRecord | { refused: string } | null {
  let text: string
  try { text = readFileSync(path, 'utf8') } catch { return null }
  return readLiveRecord(text, `runs/${basename(path)}`)
}

/** Every live record in the checkout's runs/, newest date first; a refused one carries its reason. */
export function allRecords(o: Options = {}) {
  const runs = join(charterDir(o), 'runs')
  let names: string[] = []
  try { names = readdirSync(runs).filter(f => RECORD.test(f)) } catch { /* no runs yet */ }
  return names.sort().reverse().map(f => {
    const r = readAt(join(runs, f))!
    return { file: `runs/${f}`, date: RECORD.exec(f)![1], ...('refused' in r ? { record: null, refused: r.refused } : { record: r, refused: null }) }
  })
}

/** A kept App: a run left standing with --keep whose App deploy made. */
export function keptApps(o: Options = {}) {
  return allRecords(o).flatMap(({ file, record: r }) =>
    r && r.keep && r.deploy?.appId && stateOf(r) !== 'running'
      ? [{ record: file, case: r.case, date: r.date, charter: r.charter, appName: r.deploy.appName ?? r.deploy.appId, appId: r.deploy.appId, hostname: r.deploy.hostname ?? null, basecamp: r.deploy.basecamp ?? null }]
      : [])
}

function viewOf(item: Item, date: string, o: Options): ItemView {
  const lines = item.log ? tail(item.log) : []
  if (!item.startedAt) return { ...item, state: 'queued', record: null, refused: null, lines }
  const r = readAt(recordPath(o, date, item.case))
  if (r && 'refused' in r) return { ...item, state: 'stopped', record: null, refused: r.refused, lines }
  // A record that started before this item did is an earlier run's, and says nothing about this one.
  const mine = r && r.startedAt >= item.startedAt ? r : null
  if (!mine) return { ...item, state: item.exit || item.error ? 'stopped' : 'starting', record: null, refused: null, lines }
  return { ...item, state: stateOf(mine), record: mine, refused: null, lines }
}

// ─── Running ────────────────────────────────────────────────────────────────

function processesMatching(pattern: RegExp): number[] {
  const out = spawnSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' })
  return (out.stdout ?? '').split('\n')
    .filter(l => pattern.test(l))
    .map(l => Number(l.trim().split(/\s+/)[0]))
    .filter(n => n !== process.pid)
}

/** The pids of every builder/live.ts process on this machine. */
export const liveProcesses = () => processesMatching(/ builder\/live\.ts\b/)

/** The pids of every restore drill, which retires the box a run would deploy to. */
export const drillProcesses = () => processesMatching(/restore-drill-run\.ts\b/)

const going = () => !!held && held.items.some(i => !i.exit && !i.error)

async function refusedToStart(o: Options): Promise<string | null> {
  if (going()) return `A ${held!.kind === 'run' ? 'run' : 'removal'} is going — one at a time`
  const others = (o.running ?? liveProcesses)()
  if (others.length) return `builder/live.ts is already running (pid ${others.join(', ')}), and two runs share apps/charter/oracle/`
  const drills = o.running ? [] : drillProcesses()
  if (drills.length) return `A restore drill is going (pid ${drills.join(', ')}), and it retires the Basecamp this would deploy to`
  if (!(await checkoutOf(o)).ok) return `No Charter checkout at ${charterDir(o)}: set CHARTER_DIR`
  try {
    const { designatedBasecamp } = await import('@frontierjs/cli/core/basecamps.js') as { designatedBasecamp: (x: { home?: string }) => { name: string } }
    designatedBasecamp({ home: o.home })
  } catch (e) { return (e as Error).message }
  return null
}

function spawnItem(item: Item, b: Batch, o: Options): Promise<void> {
  const dir = logDir(o)
  mkdirSync(dir, { recursive: true })
  item.startedAt = new Date().toISOString()
  item.log = join(dir, `charter-live.${item.case}.${item.startedAt.replace(/[:.]/g, '-')}.log`)
  const argv = ['builder/live.ts', item.file, '--date', b.date,
    ...(b.keep ? ['--keep'] : []), ...(item.from ? ['--from', item.from] : [])]
  const fd = openSync(item.log, 'a')
  let child
  try {
    child = spawn(process.execPath, argv, { cwd: charterDir(o), detached: true, stdio: ['ignore', fd, fd], env: { ...process.env, NO_COLOR: '1' } })
  } finally { closeSync(fd) }
  child.unref()
  item.pid = child.pid ?? null
  return new Promise(done => {
    child.on('error', e => { item.error = e.message; done() })
    child.on('exit', (code, signal) => { item.exit = { code, signal }; done() })
  })
}

async function drive(b: Batch, o: Options) {
  // A failed case does not stop the matrix: each case is its own run.
  for (const item of b.items) await spawnItem(item, b, o)
}

const blank = (c: { case: string, file: string }, from?: 'clean'): Item =>
  ({ case: c.case, file: c.file, ...(from ? { from } : {}), startedAt: null, pid: null, exit: null, log: null })

/** Run `cases` one after another, each destroyed when done unless `keep`. */
export async function startRun(input: { cases?: unknown, keep?: unknown, approved?: unknown }, o: Options = {}): Promise<Batch | { refused: string }> {
  const wanted = Array.isArray(input.cases) ? input.cases.filter((c): c is string => typeof c === 'string') : []
  if (!wanted.length) return { refused: 'Pick at least one case' }
  const known   = listCases(o)
  const missing = wanted.filter(w => !known.some(c => c.case === w))
  if (missing.length) return { refused: `No case named ${missing.map(m => `'${m}'`).join(', ')}` }
  if (input.approved !== true) return { refused: 'A run deploys to the designated Basecamp and spends model time: it was not approved' }
  const why = await refusedToStart(o)
  if (why) return { refused: why }

  held = { kind: 'run', date: today(), keep: input.keep === true, startedAt: new Date().toISOString(),
    items: known.filter(c => wanted.includes(c.case)).map(c => blank(c)) }
  void drive(held, o)
  return held
}

/** Remove a kept App through Charter's clean stage on its record. */
export async function removeKept(input: { record?: unknown, approved?: unknown }, o: Options = {}): Promise<Batch | { refused: string }> {
  const k = keptApps(o).find(a => a.record === input.record)
  if (!k) return { refused: `${String(input.record)} keeps no App` }
  if (input.approved !== true) return { refused: `Removing ${k.appName} was not approved` }
  const why = await refusedToStart(o)
  if (why) return { refused: why }
  held = { kind: 'remove', date: k.date, keep: false, startedAt: new Date().toISOString(), items: [blank({ case: k.case, file: k.charter }, 'clean')] }
  void drive(held, o)
  return held
}

/** Everything the page draws in one read. */
export async function stateOfRuns(o: Options = {}) {
  const checkout = await checkoutOf(o)
  const all      = checkout.ok ? allRecords(o) : []
  const latest   = all[0]?.date
  return {
    checkout,
    cases:   checkout.ok ? listCases(o) : [],
    batch:   held ? { ...held, items: held.items.map(i => viewOf(i, held!.date, o)) } : null,
    // With nothing held -- or after a restart -- the newest day's records.
    recent:  held ? [] : all.filter(r => r.date === latest).map(r => ({ ...r, state: r.record ? stateOf(r.record) : null })),
    kept:    keptApps(o),
    refused: all.filter(r => r.refused).map(r => ({ file: r.file, refused: r.refused })),
  }
}
