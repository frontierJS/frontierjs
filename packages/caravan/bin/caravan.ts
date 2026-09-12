#!/usr/bin/env bun
// ============================================================
// caravan — the operator verbs, from a shell (FJS-D198, FJS-D262).
//
//   caravan queue pause   [<name>] --actor <id> [--holder <id>] [--reason <text>]
//   caravan queue resume  [<name>] --actor <id> [--holder <id>]
//   caravan queue drain   [<name>] --actor <id> [--holder <id>] [--reason <text>] [--timeout <ms>]
//   caravan queue state   [<name>]
//   every verb takes [--db <path>] and [--pid <n>]
//
// No name is every queue, including one first named after the pause.
//
// It exists so something outside the app can pause work without writing
// Caravan's tables itself: `fli deploy:pause` runs it inside the serving
// container, so the code writing the row is the code the app reads it with.
//
// WHICH database: `--db` when stated. Otherwise the one a running process on
// this machine has OPEN — read from /proc, and graded by its tables — because
// the path is whatever the app decided, in configuration or in code, and a
// default guessed from outside matches neither app in this repo. `--pid` narrows
// the search to one process. With no /proc it falls back to ./db/jobs.db.
// `source` in the answer says which of the three it was.
//
// It answers FACTS as one line of JSON and leaves the judgement to the caller:
// `liveInstances` is how many instances have heartbeated on this file within a
// lease, and 0 on a running app means the pause went where nobody claims.
//
// Exit 0 an answer · 1 a refusal (the JSON carries `error`) · 2 a usage error.
//
// Traps:
//   • It never creates a database. Caravan's own open does, so the file and its
//     tables are checked first on a readonly connection — a pause written into
//     a fresh file at a mistyped path is a green answer to nothing.
//   • It never calls start(): an instance that started would heartbeat, and
//     count itself in the liveness it reports.
// ============================================================

import { Database }   from 'bun:sqlite'
import { existsSync, readdirSync, readlinkSync } from 'node:fs'
import { resolve }    from 'node:path'
import { createCaravan }                                  from '../src/index.ts'
import { DEFAULT_DB_PATH, DEFAULT_LEASE_MS, EVERY_QUEUE } from '../src/db.ts'
import type { PauseRow }                                  from '../src/db.ts'

const VERBS  = ['pause', 'resume', 'drain', 'state'] as const
const WRITES = new Set(['pause', 'resume', 'drain'])
const FLAGS  = new Set(['db', 'pid', 'actor', 'holder', 'reason', 'timeout'])

const USAGE = 'usage: caravan queue <pause|resume|drain|state> [<name>] [--db <path> | --pid <n>] [--actor <id>] [--holder <id>] [--reason <text>] [--timeout <ms>]'
const TABLES = ['jobs', 'job_owners', 'queue_pauses']

function answer(body: Record<string, unknown>, code = 0): never {
  console.log(JSON.stringify(body))
  process.exit(code)
}

function usage(message: string): never {
  console.error(`caravan: ${message}\n${USAGE}`)
  process.exit(2)
}

// ─── argv ─────────────────────────────────────────────────────────────────────

const [noun, verb, ...rest] = process.argv.slice(2)
if (noun !== 'queue') usage(noun ? `unknown command '${noun}'` : 'no command')
if (!VERBS.includes(verb as typeof VERBS[number])) usage(verb ? `unknown verb '${verb}'` : 'no verb')

const flags: Record<string, string> = {}
const names: string[] = []
for (let i = 0; i < rest.length; i++) {
  const arg = rest[i]
  if (!arg.startsWith('--')) { names.push(arg); continue }
  const [key, inline] = arg.slice(2).split(/=(.*)/s, 2)
  // Refused by name: a misspelled --holder dropped in silence is a resume that
  // lifts an operator's pause along with the deploy's.
  if (!FLAGS.has(key)) usage(`unknown flag --${key}`)
  const value = inline ?? rest[++i]
  if (value === undefined) usage(`--${key} needs a value`)
  flags[key] = value
}
if (names.length > 1) usage(`one queue name at most, got ${names.join(', ')}`)
// Stated rather than defaulted: there is no principal in a shell, and an audit
// row naming nobody is the one an incident review cannot use.
if (WRITES.has(verb) && !flags.actor) usage(`${verb} needs --actor`)

const timeout = flags.timeout === undefined ? undefined : Number(flags.timeout)
if (timeout !== undefined && !(Number.isInteger(timeout) && timeout >= 0))
  usage(`--timeout must be a whole number of milliseconds, got '${flags.timeout}'`)

if (flags.db !== undefined && flags.pid !== undefined) usage('--db and --pid each choose the database; state one')
if (flags.pid !== undefined && !/^[1-9]\d*$/.test(flags.pid)) usage(`--pid must be a process id, got '${flags.pid}'`)

const name = names[0]

// ─── which database ───────────────────────────────────────────────────────────

/** The tables of Caravan's that a file lacks, on a readonly connection that cannot create them. */
function missingTables(path: string): string[] {
  try {
    const ro = new Database(path, { readonly: true })
    try {
      const have = new Set(ro.query<{ name: string }, []>(`SELECT name FROM sqlite_master WHERE type = 'table'`).all().map(r => r.name))
      return TABLES.filter(t => !have.has(t))
    } finally { ro.close() }
  } catch { return TABLES }
}

/** Every SQLite-looking file a process has open, or null where there is no /proc to ask. */
function openDatabases(pid?: string): string[] | null {
  if (!existsSync('/proc/self/fd')) return null
  const pids = pid ? [pid] : readdirSync('/proc').filter(d => /^\d+$/.test(d))
  const found = new Set<string>()
  for (const p of pids) {
    let fds: string[]
    // Another user's process, or one that exited between the two reads.
    try { fds = readdirSync(`/proc/${p}/fd`) } catch { continue }
    for (const fd of fds) {
      let target: string
      try { target = readlinkSync(`/proc/${p}/fd/${fd}`) } catch { continue }
      // The -wal and -shm files name the same database; a deleted one is a
      // database the next open would not find.
      if (target.startsWith('/') && !/-(wal|shm|journal)$/.test(target) && !target.endsWith(' (deleted)')) found.add(target)
    }
  }
  return [...found].filter(f => missingTables(f).length === 0).sort()
}

let db: string
let source: 'flag' | 'open' | 'default'
if (flags.db !== undefined) {
  db = resolve(flags.db); source = 'flag'
} else {
  const open = openDatabases(flags.pid)
  if (open === null) {
    db = resolve(DEFAULT_DB_PATH); source = 'default'
  } else if (open.length === 1) {
    db = open[0]; source = 'open'
  } else if (open.length === 0) {
    answer({ source: 'open', exists: false, error: `no process${flags.pid ? ` ${flags.pid}` : ' here'} has a Caravan jobs database open` }, 1)
  } else {
    // Refused rather than chosen: pausing the first of two is a pause of one app
    // reported as a pause of this one.
    answer({ source: 'open', candidates: open, error: `${open.length} Caravan jobs databases are open here — choose one with --db` }, 1)
  }
}

// ─── the file, before anything can create it ──────────────────────────────────

if (!existsSync(db))
  answer({ db, source, exists: false, error: `no jobs database at ${db}` }, 1)

const missing = missingTables(db)
if (missing.length)
  answer({ db, source, exists: true, caravan: false, error: `${db} is not a Caravan jobs database — it has no ${missing.join(', ')}` }, 1)

let liveInstances: number
{
  const ro = new Database(db, { readonly: true })
  liveInstances = ro.query<{ count: number }, [number]>(`SELECT COUNT(*) AS count FROM job_owners WHERE seen_at >= ?`)
    .get(Date.now() - DEFAULT_LEASE_MS)!.count
  ro.close()
}

// ─── the verb ─────────────────────────────────────────────────────────────────

const caravan = createCaravan({ db, cleanupAfter: 0 })
const base    = { db, source, exists: true, caravan: true, liveInstances }

try {
  const target = name === undefined ? caravan : caravan.queue(name)
  const opts   = {
    actor: flags.actor,
    ...(flags.holder !== undefined ? { holder: flags.holder } : {}),
    ...(flags.reason !== undefined ? { reason: flags.reason } : {}),
  }

  let result: Record<string, unknown>
  if (verb === 'pause')       result = target.pause(opts)
  else if (verb === 'resume') result = target.resume(opts)
  else if (verb === 'drain')  result = await target.drain({ ...opts, ...(timeout !== undefined ? { timeout } : {}) })
  else if (name !== undefined) result = caravan.queue(name).state({ events: 20 })
  else {
    const ro = new Database(db, { readonly: true })
    const every = ro.query<PauseRow, [string]>(`SELECT queue, paused_at, actor_id, reason, holder FROM queue_pauses WHERE queue = ?`).get(EVERY_QUEUE)
    ro.close()
    const stats = caravan.stats()
    result = {
      paused: every && { queue: every.queue, pausedAt: every.paused_at, actor: every.actor_id, reason: every.reason, holder: every.holder },
      queues: Object.fromEntries(Object.keys(stats.queues).map(q => [q, caravan.queue(q).state({ events: 0 })])),
    }
  }

  await caravan.stop()
  answer({ ...base, queue: name ?? EVERY_QUEUE, verb, ...result })
} catch (err) {
  await caravan.stop().catch(() => {})
  answer({ ...base, queue: name ?? EVERY_QUEUE, verb, error: (err as Error).message }, 1)
}
