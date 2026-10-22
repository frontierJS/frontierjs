// core/call-as.ts
// One service method, as somebody, from outside the app — the call a request
// makes, without the request (`FJS-D1426`).
//
// Two callers: `junction call` (a booted copy of the app, then exit) and
// devtools' `POST /api/call` (inside the running app, so the announcement
// reaches the sockets and the console's `:live`). Both run this, so a call
// from either is graded the way an HTTP call is: the app's own caller inside
// `app.runAs`, its hooks, its gate and its envelope.
//
// Never throws. A call that cannot be made says why with a status, and a call
// that threw carries the status the one error owner gives it, so a caller can
// tell a refusal from a bug.

import type { App }                           from './app.ts'
import { CALL_OPTIONS_AT }                    from './app.ts'
import { toFrameworkError }                   from './errors.ts'
import { reenterAs }                          from './context.ts'
import { splitParams, unknownDirectives }     from '@frontierjs/toolbelt/directives'

export interface CallRequest {
  /** `<service>.<method>`, a CRUD verb or a custom method. */
  method:  string
  /** In the caller's own order: `find [query]`, `get <id>`, `patch <id> <data>`; a custom method takes an id and a body. */
  args?:   unknown[]
  /** A row of the `@@auth` model by email, username, name or id, or `Model:value`. Empty is nobody. */
  as?:     string
  /** Whose database, under `tenancy { strategy database }`. */
  tenant?: string
}

export type CallOutcome =
  | { ok: true;  standing: string; result: unknown }
  // `name` is set when the method ran and threw; without it the call was never made.
  | { ok: false; standing?: string; status: number; message: string; name?: string; data?: unknown }

export interface CallableService { name: string; methods: string[] }

const isBag = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

// The hook-bypass twins are never offered: a call from outside that skips the
// pipeline is sqlite3 against the file, with every gate off.
const callableOf = (described: { methods: string[]; customMethods: string[] }) => [...new Set([
  ...described.methods.filter(m => CALL_OPTIONS_AT[m] !== undefined && !m.startsWith('_')),
  ...described.customMethods,
])]

/** Every method a call from outside may name, per service. */
export function callable(app: App): CallableService[] {
  return app.services.list().map((name: string) => ({
    name,
    methods: callableOf(app.services.get(name)!.describe()),
  }))
}

/** Make the call. `around` wraps the method alone — `junction call` silences the build's chatter with it. */
export async function callAs(
  app: App,
  req: CallRequest,
  { around = (fn) => fn() }: { around?: <T>(fn: () => Promise<T>) => Promise<T> } = {},
): Promise<CallOutcome> {
  const refuse = (status: number, message: string, standing?: string): CallOutcome =>
    ({ ok: false, status, message, ...(standing ? { standing } : {}) })

  const target = req.method ?? ''
  const dot    = target.lastIndexOf('.')
  if (dot <= 0 || dot === target.length - 1) return refuse(400, `Name a method as <service>.<method>, not '${target}'.`)

  const serviceName = target.slice(0, dot)
  const methodName  = target.slice(dot + 1)
  const args        = req.args ?? []

  const svc = app.services.get(serviceName)
  if (!svc) return refuse(404, `No service '${serviceName}'. This app has: ${app.services.list().join(', ')}`)

  if (methodName.startsWith('_'))
    return refuse(400, `${methodName} skips the hook pipeline, and a call from outside never should. Call ${methodName.slice(1)}.`)

  const described = svc.describe()
  const custom    = described.customMethods.includes(methodName)
  const offered   = callableOf(described)
  if (!offered.includes(methodName))
    return refuse(404, `'${serviceName}' has no method '${methodName}'. It answers: ${offered.join(', ') || '(nothing)'}`)

  // Positional arguments into the caller's own signature. A CRUD verb takes
  // them where CALL_OPTIONS_AT says its options begin; a custom method is
  // `call(name, id, data)`, with a lone bag read as the data and a lone scalar
  // as the id — the two shapes its HTTP route takes.
  let positional: unknown[]
  if (custom) {
    if (args.length > 2) return refuse(400, `${target} takes at most an id and a JSON body; got ${args.length} arguments.`)
    const [a, b] = args
    positional = args.length === 2 ? [a, b] : isBag(a) ? [null, a] : [a ?? null, null]
  } else {
    const at = CALL_OPTIONS_AT[methodName]
    if (args.length > at) return refuse(400, `${target} takes ${at} argument(s); got ${args.length}.`)
    positional = args.slice()
  }

  // `$limit` and its siblings are transport syntax (Invariant 10), and this is a
  // transport: they come off the query bag by the one table that knows them.
  // One the table does not name is refused by name — left in, it is a WHERE on
  // a column that does not exist.
  const opts: Record<string, unknown> = {}
  if (!custom && isBag(positional[0]) && methodName !== 'create' && methodName !== 'aggregate') {
    const unknown = unknownDirectives(positional[0])
    if (unknown.length) return refuse(400, `Unknown directive ${unknown.join(', ')} — a $ key is read only when it names one.`)
    const { query, directives } = splitParams(positional[0])
    positional[0] = query
    if (Object.keys(directives).length) opts.directives = directives
  }

  const who = await standingOf(app, req)
  if ('status' in who) return refuse(who.status, who.message)
  const { userId, standing, scope } = who

  const invoke = () => {
    const caller = app.service(serviceName) as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>
    if (custom) return caller.call(methodName, ...positional, opts)
    while (positional.length < CALL_OPTIONS_AT[methodName]) positional.push(undefined)
    return caller[methodName](...positional, opts)
  }

  try {
    // `runAs(null)` is the app's SYSTEM principal, not nobody — so a call as
    // nobody opens the tenant as the app and then drops to no principal at
    // all. Left at runAs(null), a stranger's call ships an order.
    const result = await around(() => asWhom(app, who, invoke))
    return { ok: true, standing, result }
  } catch (err) {
    const e = toFrameworkError(err, app)
    return { ok: false, standing, status: e.code, name: e.name, message: e.message, ...(e.data ? { data: e.data } : {}) }
  }
}

// ─── who ─────────────────────────────────────────────────────────────────

type Standing = { userId: string | null; standing: string; scope: { tenant?: string } }

// Looked up with the app's own client, in the tenant the call will run in —
// under `strategy database` that is where the person's row is.
async function standingOf(app: App, req: { as?: string; tenant?: string }): Promise<Standing | { status: number; message: string }> {
  const scope = req.tenant ? { tenant: req.tenant } : {}
  const where = req.tenant ? ` · tenant ${req.tenant}` : ''
  const who   = req.as
  if (!who) return { userId: null, standing: `nobody — STRANGER(0), which a gated method refuses${where}`, scope }
  const { findPrincipal } = await import('@frontierjs/litestone')
  let found: { row: Record<string, unknown> | null; model: string | null; tried: string[] }
  try {
    found = await app.runAs(null, scope, () => app.withDb(async (db: unknown) => {
      const client = db as { asSystem(): unknown; $schema: unknown }
      return findPrincipal(client.asSystem(), client.$schema, who)
    }))
  } catch (err) {
    const e = toFrameworkError(err, app)
    return { status: e.code, message: `as ${who}: ${e.message}` }
  }
  if (!found.model)
    return { status: 400, message: `as ${who}: the schema marks no @@auth model and has no User. Name one: Customer:${who}` }
  if (!found.row)
    return { status: 404, message: `as ${who}: no ${found.model} matches on ${found.tried.join(', ') || 'any column'}${req.tenant ? ` in tenant ${req.tenant}` : ''}.` }
  const userId = String(found.row.id)
  return { userId, standing: `${who} (${found.model} ${userId})${where}`, scope }
}

// `runAs(null)` is the app's SYSTEM principal, not nobody — so nobody opens
// the tenant as the app and then drops to no principal at all. Left at
// runAs(null), a stranger's call ships an order and a stranger's read sees
// every row.
const asWhom = <T>(app: App, who: Standing, fn: () => Promise<T>): Promise<T> => who.userId
  ? app.runAs(who.userId, who.scope, fn)
  : app.runAs(null, who.scope, () => reenterAs(null, fn))

// ─── anything else, as somebody ─────────────────────────────────────────
//
// The console's `:ask`: one MCP request answered as a declared principal
// (`FJS-D1428`). `fn` is handed the principal in scope, which the mcp plugin
// grades its tool list and its calls by, as it grades a session's.

export type AsOutcome<T> =
  | { ok: true;  standing: string; result: T }
  | { ok: false; status: number; message: string }

/** Run `fn` as somebody. Throws only what `fn` throws. */
export async function actAs<T>(app: App, req: { as?: string; tenant?: string }, fn: (user: unknown) => Promise<T>): Promise<AsOutcome<T>> {
  const who = await standingOf(app, req)
  if ('status' in who) return { ok: false, status: who.status, message: who.message }
  return { ok: true, standing: who.standing, result: await asWhom(app, who, () => fn(app.principal())) }
}

// ─── rows, as somebody ───────────────────────────────────────────────────
//
// The console's `:data`: a model's rows through the app's own client, in the
// principal's scope, so a gate refuses, a row policy narrows and a protected
// field redacts exactly as for a request. Below the services on purpose: a
// model with no service still has rows somebody may or may not read.

export interface RowsRequest {
  /** The model's name, as the schema writes it. */
  model:   string
  as?:     string
  tenant?: string
  limit?:  number
  offset?: number
}

export type RowsOutcome =
  | { ok: true;  standing: string; rows: Record<string, unknown>[]; total: number }
  | { ok: false; standing?: string; status: number; message: string; name?: string }

export const ROWS_MAX = 200

type Client = { $schema: { models: { name: string }[]; views?: { name: string }[] } } & Record<string, unknown>
type Table  = { findMany(a: object): Promise<Record<string, unknown>[]>; count(a?: object): Promise<number> }

// No Litestone client is no schema, which reads as an app with no models.
const namesOf = (db: unknown) => {
  const s = db && typeof db === 'object' && '$schema' in db ? (db as Client).$schema : null
  return s ? [...s.models, ...(s.views ?? [])].map(m => m.name) : []
}

/** Every model and view the app's schema names, in its order. */
export async function readable(app: App, tenant?: string): Promise<{ models: string[] } | { status: number; message: string }> {
  try {
    return { models: await app.runAs(null, tenant ? { tenant } : {}, () => app.withDb(async (db: unknown) => namesOf(db))) }
  } catch (err) {
    const e = toFrameworkError(err, app)
    return { status: e.code, message: e.message }
  }
}

/** Read one page of a model as somebody. Never throws, as `callAs`. */
export async function rowsAs(app: App, req: RowsRequest): Promise<RowsOutcome> {
  const who = await standingOf(app, req)
  if ('status' in who) return { ok: false, status: who.status, message: who.message }
  const { standing } = who
  const limit  = Math.min(Math.max(1, Math.trunc(req.limit ?? 50) || 50), ROWS_MAX)
  const offset = Math.max(0, Math.trunc(req.offset ?? 0) || 0)
  try {
    return await asWhom(app, who, () => app.withDb(async (db: unknown) => {
      const names = namesOf(db)
      if (!names.includes(req.model))
        return { ok: false as const, standing, status: 404, message: `No model '${req.model}'. This schema has: ${names.join(', ')}` }
      const { modelToAccessor } = await import('@frontierjs/litestone')
      const table = (db as Record<string, Table>)[modelToAccessor(req.model)]
      const rows  = await table.findMany({ limit, offset })
      return { ok: true as const, standing, rows, total: await table.count() }
    }))
  } catch (err) {
    const e = toFrameworkError(err, app)
    return { ok: false, standing, status: e.code, name: e.name, message: e.message }
  }
}
