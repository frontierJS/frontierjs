// plugins/audit/index.ts
// auditPlugin({ model }) — one row per CALL that wrote: who acted, as whom,
// which method, on which row, and what changed (`FJS-D873`).
//
//   app.configure(auditPlugin({
//     model:   'AuditEvent',
//     except:  ['servers.heartbeat'],
//     columns: { workspaceId: (ctx, subject) => ctx.locals.workspaceId ?? subject?.workspaceId },
//   }))
//
// This is the CALL trail. Litestone's `@@trail(audit)` is the WRITE trail —
// every row change, system-only, forensic — and does not depend on this
// running. The app owns the table and its retention; this owns the capture.
//
// What counts as a call that wrote is `callService`'s own line: not a read by
// name or by `read: true` (`isReadMethod`), and not a call that declined to
// announce with `ctx.dispatch = false`. `except` names the writes that are
// real but must not be recorded — a machine on a timer buries every action a
// person took — and is not `dispatch = false`, which would also silence the
// channel those calls feed.
//
// The column contract is checked at boot, and a model that breaks it is
// refused by name. A write that fails is logged and swallowed: the trail must
// never break the request, and a required column the app forgot would
// otherwise fail every row in silence.

import { REDACTED }       from '@frontierjs/toolbelt/redact'
import { isReadMethod, serviceAccessor } from '../../core/service.ts'
import { accessorCandidates }  from '../../core/litestone.ts'
import { resultData }          from '../../core/envelope.ts'
import type { App, Plugin }      from '../../core/app.ts'
import type { ServiceContext }   from '../../core/context.ts'
import type { Hook }             from '../../core/hooks.ts'

type Row = Record<string, unknown>

/** One app-owned column: its value for this call, read off the call and the row it touched. */
export type AuditColumn = (ctx: ServiceContext, subject: Row | null) => unknown

export interface AuditPluginOptions {
  /** The model the rows go into (`'AuditEvent'`). Its shape is checked at boot. */
  model:    string
  /** `service.method` names that write and are not recorded. */
  except?:  readonly string[]
  /** Columns the app adds to every row, by name. A required column outside the contract must be named here. */
  columns?: Record<string, AuditColumn>
}

/** What `actorType` holds. A string column takes any; an enum must declare all four. */
export const AUDIT_ACTOR_KINDS = ['user', 'api_key', 'support', 'system'] as const

/** The columns this plugin writes. `optional` ones are null for a system actor or a create with no diff. */
export const AUDIT_COLUMNS: Readonly<Record<string, { types: readonly string[]; optional?: true }>> = {
  action:       { types: ['String'] },
  subjectType:  { types: ['String'] },
  subjectId:    { types: ['String'] },
  actorType:    { types: ['String', 'enum'] },
  actorId:      { types: ['String'], optional: true },
  onBehalfOfId: { types: ['String'], optional: true },
  diff:         { types: ['Json'],   optional: true },
}

// A trail row is read on a screen, and a 40KB script pasted into one column
// would push every other field off it. The entry says that it changed and to
// what, not a second copy of the column.
const DIFF_VALUE_LIMIT = 500

// ─── The client ──────────────────────────────────────────────────────────────

interface SchemaField { name: string; type?: { kind?: string; name?: string; optional?: boolean; array?: boolean }; attributes?: Array<{ kind?: string }> }
interface SchemaAst   { models?: Array<{ name: string; fields?: SchemaField[] }>; enums?: Array<{ name: string; values?: Array<{ name: string }> }> }

interface AuditClient {
  $schema?: SchemaAst
  $protectedFields?(accessor: string): Record<string, string>
  asSystem(): AuditClient
  [accessor: string]: unknown
}

interface Table {
  findUnique(args: { where: Row }): Promise<Row | null>
  create(args: { data: Row }): Promise<unknown>
}

const lowerFirst = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1)

/** The system client, and the accessor it holds `name` under — `in`, because a client throws on an unknown read. */
function tableOf(sys: AuditClient, name: string): Table | null {
  const accessor = lowerFirst(name)
  return accessor in sys ? sys[accessor] as Table : null
}

// ─── The contract ────────────────────────────────────────────────────────────

/**
 * Refuse a model this plugin cannot write.
 *
 * Every refusal here would otherwise be a write that throws, is swallowed, and
 * leaves a trail that reads as complete with nothing in it.
 */
export function assertAuditModel(db: unknown, model: string, columns: readonly string[] = []): void {
  const schema = (db as AuditClient | undefined)?.$schema
  const m = schema?.models?.find(x => x.name === model)
  const where = `[Junction] audit: model '${model}'`
  if (!m) throw new Error(`${where} is not declared in this schema. Declare it with the columns ${Object.keys(AUDIT_COLUMNS).join(', ')}, or name the model that holds the trail.`)

  const fields = new Map((m.fields ?? []).map(f => [f.name, f]))
  for (const [name, rule] of Object.entries(AUDIT_COLUMNS)) {
    const f = fields.get(name)
    if (!f) throw new Error(`${where} declares no '${name}'. The trail writes ${Object.keys(AUDIT_COLUMNS).join(', ')}.`)
    const type = f.type?.kind === 'enum' ? 'enum' : f.type?.name ?? '?'
    if (!rule.types.includes(type) || f.type?.array) {
      throw new Error(`${where}: '${name}' is ${f.type?.name ?? '?'}${f.type?.array ? '[]' : ''}; the trail writes it as ${rule.types.join(' or ')}.`)
    }
    if (rule.optional && !f.type?.optional) {
      throw new Error(`${where}: '${name}' must be optional — it is null for ${name === 'diff' ? 'a call that changed no column' : 'a call no person made'}.`)
    }
    if (type === 'enum') {
      const values = new Set((schema?.enums?.find(e => e.name === f.type?.name)?.values ?? []).map(v => v.name))
      const missing = AUDIT_ACTOR_KINDS.filter(k => !values.has(k))
      if (missing.length) throw new Error(`${where}: enum ${f.type?.name} has no ${missing.join(', ')}; '${name}' is written as one of ${AUDIT_ACTOR_KINDS.join(', ')}.`)
    }
  }

  for (const name of columns) {
    if (name in AUDIT_COLUMNS) throw new Error(`${where}: columns.${name} is written by the trail itself and cannot be supplied.`)
    if (!fields.has(name))     throw new Error(`${where} declares no '${name}', which columns.${name} writes.`)
  }

  const supplied = new Set([...Object.keys(AUDIT_COLUMNS), ...columns])
  for (const f of m.fields ?? []) {
    if (supplied.has(f.name) || f.type?.optional || f.type?.kind === 'relation') continue
    if (f.attributes?.some(a => a.kind === 'default' || a.kind === 'id' || a.kind === 'updatedAt')) continue
    throw new Error(`${where}: '${f.name}' is required and nothing writes it. Name it in columns, give it a default, or make it optional.`)
  }
}

// ─── What changed ────────────────────────────────────────────────────────────

function diffValue(v: unknown): unknown {
  if (typeof v !== 'string') return v
  return v.length <= DIFF_VALUE_LIMIT ? v : `${v.slice(0, DIFF_VALUE_LIMIT)}… +${v.length - DIFF_VALUE_LIMIT} chars`
}

/**
 * `{ field: { before, after } }` for every column that moved.
 *
 * `protectedFields` is `db.$protectedFields(accessor)`, litestone's reading of
 * the schema: a protected column still appears, because that it changed is the
 * fact, and its values never do.
 */
export function diffRows(before: Row | null, after: Row | null, protectedFields: Record<string, string>): Row | null {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])
  const diff: Row = {}

  for (const key of keys) {
    // Moves on every write and says nothing about what the write did.
    if (key === 'updatedAt') continue
    const from = before?.[key]
    const to   = after?.[key]
    // A Json column comes back as a fresh object on every read, so identity
    // would report it changed on every write.
    if (JSON.stringify(from) === JSON.stringify(to)) continue
    diff[key] = protectedFields[key]
      ? { before: from === undefined ? undefined : REDACTED, after: to === undefined ? undefined : REDACTED }
      : { before: diffValue(from), after: diffValue(to) }
  }

  return Object.keys(diff).length ? diff : null
}

// ─── The plugin ──────────────────────────────────────────────────────────────

export function auditPlugin({ model, except = [], columns = {} }: AuditPluginOptions): Plugin {
  if (typeof model !== 'string' || !model) {
    throw new TypeError(`auditPlugin({ model }) names the model the trail writes, e.g. model: 'AuditEvent' — got ${JSON.stringify(model)}`)
  }
  const skip = new Set(except)
  let app: App

  function recordable(ctx: ServiceContext): boolean {
    if (skip.has(`${ctx.service}.${ctx.method}`)) return false
    if (ctx.dispatch === false) return false
    const service = app.services.get(ctx.service)
    return !!service && !isReadMethod(service, ctx.method as string)
  }

  /** The system client and the subject's table. Off the REGISTRY: `app.service(name)` is a caller and carries no `model`. */
  function subjectTable(ctx: ServiceContext): { sys: AuditClient; table: Table | null; accessor: string | null } {
    const sys = (app.db as AuditClient).asSystem()
    const accessor = serviceAccessor({ name: ctx.service, model: app.services.get(ctx.service)?.model })
    const found = accessor ? accessorCandidates(accessor).find(c => c in sys) ?? null : null
    return { sys, table: found ? sys[found] as Table : null, accessor: found }
  }

  // The row as it stands, parked on `ctx.locals` — per call, so a nested call
  // reads its own. Through the system client: a scoped read answers nothing for
  // a row a policy hides, which reads as "nothing changed".
  const preImage: Hook = async function auditPreImage(ctx: ServiceContext): Promise<void> {
    if (!recordable(ctx) || ctx.id === undefined || ctx.id === null) return
    try {
      const { table } = subjectTable(ctx)
      const row = await table?.findUnique({ where: { id: ctx.id } })
      if (row) ctx.locals.auditBefore = row
    } catch {
      // The row is recorded with no diff.
    }
  }

  const record: Hook = async function auditRecord(ctx: ServiceContext): Promise<void> {
    if (!recordable(ctx)) return

    // The envelope or a custom method's own row; `resultData` tells them apart.
    const result = resultData(ctx.result) as Row | null | undefined
    const before = (ctx.locals.auditBefore as Row | undefined) ?? null
    const user   = ctx.user

    try {
      const { sys, table, accessor } = subjectTable(ctx)
      let diff:    Row | null = null
      let subject: Row | null = null
      try {
        if (table && accessor) {
          // The after side is RE-READ, not taken from the result: a service may
          // answer a projection, and a scoped read strips protected columns, so
          // a patch to an `@encrypted` value would diff as the column removed.
          const id    = (result?.id ?? before?.id ?? ctx.id) as string | undefined
          const after = ctx.method === 'remove' || id === undefined
            ? null
            : await table.findUnique({ where: { id } }) ?? result ?? null
          subject = after ?? before
          diff = diffRows(before, after, sys.$protectedFields?.(accessor) ?? {})
        }
      } catch {
        // The call is still recorded, without what it changed.
      }

      // Inside a support episode the principal is the SUBJECT, so `user.id`
      // is who the write was made AS; the operator is the one who made it.
      const support = user?.support ?? null
      const extra: Row = {}
      for (const [name, fn] of Object.entries(columns)) extra[name] = fn(ctx, subject) ?? null

      await (tableOf(sys, model) as Table).create({
        data: {
          ...extra,
          actorId:      support?.operatorId ?? user?.id ?? null,
          onBehalfOfId: support ? user?.id ?? null : null,
          // No principal is a job or a machine acting for itself, not an anonymous person.
          actorType:    user ? (support ? 'support' : user.authMethod === 'apiKey' ? 'api_key' : 'user') : 'system',
          action:       `${ctx.service}.${ctx.method}`,
          subjectType:  ctx.service,
          subjectId:    String(result?.id ?? before?.id ?? ctx.id ?? 'unknown'),
          diff,
        },
      })
    } catch (err) {
      app.logger.warn(`audit: ${ctx.service}.${ctx.method} was not recorded`, { error: (err as Error)?.message ?? String(err) })
    }
  }

  return {
    name: 'audit',
    register(a: App) {
      app = a
      a.hooks({ before: { all: [preImage] }, after: { all: [record] } })
    },
    boot(a: App) {
      if (!a.db) throw new Error(`[Junction] audit: this app has no database to write '${model}' into`)
      assertAuditModel(a.db, model, Object.keys(columns))
    },
  }
}
