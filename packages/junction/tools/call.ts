#!/usr/bin/env bun
// tools/call.ts
// One service method, once, as somebody — then exit.
//
//   junction call --app api/src/app.ts order.find '{"status":"paid","$limit":5}' --as sam@shop.test
//   junction call --app api/src/app.ts order.patch 12 '{"note":"late"}' --as sam@shop.test
//   junction call --app api/src/app.ts order.refund 12 --as ops@shop.test --tenant flagship
//
// Without this, calling a service as a person meant a dev server started in the
// background, a login by curl, a token copied by hand, a sleep and a kill — and
// when that got tedious, sqlite3 against the file, which answers with every gate
// off. This is the call without the socket: the app's own caller inside
// `app.runAs`, so the hooks, the gate and the envelope are the ones a request gets.
//
// The answer is JSON on stdout and nothing else is: the build's chatter, the
// standing and a refusal all go to stderr, so `| jq` reads it.

import { getFlag, fatal, loadApp, quietly, stopApp, writeOut } from './app-module.ts'
import { CALL_OPTIONS_AT }                                      from '../src/core/app.ts'
import { toFrameworkError }                                     from '../src/core/errors.ts'
import { reenterAs }                                            from '../src/core/context.ts'
import { splitParams, unknownDirectives }                       from '@frontierjs/toolbelt/directives'

// ─── args ─────────────────────────────────────────────────────────────────────

// The flags that take a value, so the value is not read as an argument to the
// method. A flag named here and not handled below is a flag silently ignored.
const VALUED = new Set(['app', 'export', 'services', 'as', 'tenant'])

const argv = Bun.argv.slice(2)
const words: string[] = []
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a.startsWith('--')) {
    const name = a.slice(2).split('=')[0]
    if (!VALUED.has(name)) fatal(`Unknown flag --${name}. junction call takes ${[...VALUED].map(f => `--${f}`).join(', ')}.`)
    if (!a.includes('=')) i++
    continue
  }
  words.push(a)
}

const USAGE =
  `junction call --app <module> <service>.<method> [id] [json] [--as <who>] [--tenant <id>]`

const appPath = getFlag('app')
if (!appPath) fatal(`Name the app module: ${USAGE}`)

const target = words[0]
const dot    = target?.lastIndexOf('.') ?? -1
if (!target || dot <= 0 || dot === target.length - 1)
  fatal(`Name a method as <service>.<method> — ${USAGE}`)

const serviceName = target.slice(0, dot)
const methodName  = target.slice(dot + 1)

// A word that parses as JSON is that value, anything else is a string — so `12`
// is an id, `'{"a":1}'` is a bag, and `abc-123` is a string id without quoting
// it twice.
const args: unknown[] = words.slice(1).map(w => { try { return JSON.parse(w) } catch { return w } })

const isBag = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

// ─── the call ─────────────────────────────────────────────────────────────────

const app = await loadApp(appPath, getFlag('export'), getFlag('services'))

// Every exit goes through here, because `stop()` is what drains a job the boot's
// worker already claimed — exiting past it strands the job until its lease lapses.
async function finish(code: number, out?: string): Promise<never> {
  await stopApp(app)
  if (out !== undefined) await writeOut(out + '\n')
  process.exit(code)
}

const refuse = async (message: string): Promise<never> => {
  console.error(`\n  ✗  ${message}\n`)
  return finish(1)
}

const svc = app.services.get(serviceName)
if (!svc) await refuse(`No service '${serviceName}'. This app has: ${app.services.list().join(', ')}`)

const described = svc!.describe()
const crud      = CALL_OPTIONS_AT[methodName] !== undefined && !methodName.startsWith('_')
const custom    = described.customMethods.includes(methodName)

// The hook-bypass twins are refused rather than offered: a call from outside
// that skips the pipeline is the sqlite3 this exists to replace.
if (methodName.startsWith('_'))
  await refuse(`${methodName} skips the hook pipeline, and a call from outside never should. Call ${methodName.slice(1)}.`)
if (!custom && !(crud && described.methods.includes(methodName))) {
  const offered = [...new Set([...described.methods, ...described.customMethods])]
  await refuse(`'${serviceName}' has no method '${methodName}'. It answers: ${offered.join(', ') || '(nothing)'}`)
}

// Positional arguments into the caller's own signature. A CRUD verb takes them
// where CALL_OPTIONS_AT says its options begin; a custom method is
// `call(name, id, data)`, with a lone bag read as the data and a lone scalar
// as the id — the two shapes its HTTP route takes.
let positional: unknown[]
if (custom) {
  if (args.length > 2) await refuse(`${target} takes at most an id and a JSON body; got ${args.length} arguments.`)
  const [a, b] = args
  positional = args.length === 2 ? [a, b] : isBag(a) ? [null, a] : [a ?? null, null]
} else {
  const at = CALL_OPTIONS_AT[methodName]
  if (args.length > at) await refuse(`${target} takes ${at} argument(s); got ${args.length}.`)
  positional = args
}

// `$limit` and its siblings are transport syntax (Invariant 10), and this is a
// transport: they come off the query bag here, by the one table that knows
// them, and travel as directives. One this table does not name is refused by
// name — left in, it is a WHERE on a column that does not exist.
const opts: Record<string, unknown> = {}
const queryAt = custom ? -1 : isBag(positional[0]) && methodName !== 'create' && methodName !== 'aggregate' ? 0 : -1
if (queryAt === 0) {
  const bag = positional[0] as Record<string, unknown>
  const unknown = unknownDirectives(bag)
  if (unknown.length) await refuse(`Unknown directive ${unknown.join(', ')} — a $ key is read only when it names one.`)
  const { query, directives } = splitParams(bag)
  positional[0] = query
  if (Object.keys(directives).length) opts.directives = directives
}

// ─── as whom ──────────────────────────────────────────────────────────────────

const who    = getFlag('as')
const tenant = getFlag('tenant')
const scope  = tenant ? { tenant } : {}

// Looked up with the app's own client, in the tenant the call will run in —
// under `strategy database` that is where the person's row is.
let userId: string | null = null
let label = 'nobody — STRANGER(0), which a gated method refuses'
if (who) {
  const { findPrincipal } = await import('@frontierjs/litestone')
  const found = await app.runAs(null, scope, () => app.withDb(async (db: unknown) => {
    const client = db as { asSystem(): unknown; $schema: unknown }
    return findPrincipal(client.asSystem(), client.$schema, who)
  })) as { row: Record<string, unknown> | null; model: string | null; tried: string[] }

  if (!found.model)
    await refuse(`--as ${who}: the schema marks no @@auth model and has no User. Name one: --as Customer:${who}`)
  if (!found.row)
    await refuse(`--as ${who}: no ${found.model} matches on ${found.tried.join(', ') || 'any column'}${tenant ? ` in tenant ${tenant}` : ''}.`)

  userId = String(found.row!.id)
  label  = `${who} (${found.model} ${userId})`
}

console.error(`  Standing: ${label}${tenant ? ` · tenant ${tenant}` : ''}`)

// ─── run it ───────────────────────────────────────────────────────────────────

const json = (value: unknown) => JSON.stringify(value, (_, v) => {
  if (typeof v === 'bigint')   return `${v}n`
  if (v instanceof Uint8Array) return `<${v.length} bytes>`
  return v
}, 2) ?? String(value)

try {
  const invoke = () => {
    const caller = app.service(serviceName) as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>
    if (custom) return caller.call(methodName, ...positional, opts)
    const bound = positional.slice()
    while (bound.length < CALL_OPTIONS_AT[methodName]) bound.push(undefined)
    return caller[methodName](...bound, opts)
  }
  // `runAs(null)` is the app's SYSTEM principal, not nobody — so a call with no
  // --as opens the tenant as the app and then drops to no principal at all.
  // Left at runAs(null), a stranger's call ships an order.
  const result = await quietly(() => userId
    ? app.runAs(userId, scope, invoke)
    : app.runAs(null, scope, () => reenterAs(null, invoke)))
  await finish(0, json(result))
} catch (err) {
  // The status comes from the one owner that turns a throw into one, so this
  // says 403 where HTTP would and a caller can tell a refusal from a bug.
  const e = toFrameworkError(err)
  console.error(`  ${e.name} (${e.code}): ${e.message}`)
  if (e.data) console.error(`  ${json(e.data).split('\n').join('\n  ')}`)
  await finish(1)
}
