// src/core/resource.ts
// The shape every workspace-scoped Basecamp service shares.
//
// Seven services do the same five things: list within a workspace, fetch one or
// 404, create with a derived slug, patch a narrowed field set, soft-delete.
// Written out seven times that is seven chances to forget `workspaceId` in a
// where-clause — which is a tenancy leak, not a style problem.
//
// These are helpers, not a factory. Each service still declares its own methods
// so the ones with real behavior (servers' drain/heartbeat, deployments'
// job handoff) read as themselves rather than as config for a base class.

import { NotFound, $, findWindow, serviceAccessor, accessorCandidates } from '@frontierjs/junction'
import type { ServiceContext } from '@frontierjs/junction'
import { generateJsonSchema } from '@frontierjs/litestone'
import { normalizeOrderBy, normalizeSelect, comparatorFor, type SortParam, type SelectParam } from '@frontierjs/toolbelt/query'

// ─── Reading the call ────────────────────────────────────────────────────
// `$` is the service call in progress — read-only, fresh per call, and it
// throws by name if one of these is ever called from outside a call. The
// caller-scoped Litestone client is `$.db`, so nothing here has to be handed
// a context to reach it and nothing threads one to pass it on.
//
// Two things `$` does not answer, because they are this app's and not the
// framework's: which workspace a call is acting in, and who counts as the
// actor when nobody asked. Both live on `$.locals`/`$.me` and are named here
// once rather than spelled out at 91 call sites.

/**
 * The caller-scoped Litestone client — `$.db`, typed for THIS app.
 *
 * `any` on purpose. Junction's `LitestoneClient` is a deliberate
 * minimal stand-in: it declares the surface junction's own adapter uses so the
 * adapter compiles without Litestone installed, not this schema's accessors.
 * So `$.db` alone does not know `exists()` or what a row of `App` looks like.
 * The cast belongs to the app that owns the schema, and it belongs here once.
 */
export function db(): any {
  return $.db
}

/** The acting workspace, stamped by requireWorkspace() in sessionScope. */
export function ws(): string {
  return $.locals.workspaceId as string
}

/** The acting user's id, or 'system' for job and outpost paths. */
export function actor(): string {
  return ($.me as { id?: string } | null | undefined)?.id ?? 'system'
}

export function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64)
}

// ─── Reads ───────────────────────────────────────────────────────────────

/**
 * List within the caller's workspace.
 *
 * Neither half of the scope is spelled out. `deletedAt IS NULL` is @@softDelete's
 * and `workspaceId` is the tenancy declaration's — both compile into the WHERE
 * for every read, and a restated clause is the one that disagrees when the
 * declaration moves.
 *
 * `opts.orderBy` is the service's default, and the caller's `$orderBy`,
 * `$select` and `$after` win over it: junction refuses a directive the method
 * never read, and this is where every list here reads them. `$after` is read
 * here and not passed in, so a caller of this cannot forget it and answer page
 * one to every press of "load more" (`FJS-D145`); `findWindow` owns the
 * cursor path and the `endCursor` every list carries.
 */
export async function findScoped(
  accessor: string,
  opts:     { where?: Record<string, unknown>; limit: number; offset: number; orderBy?: Record<string, unknown> | Record<string, unknown>[] },
) {
  const { after } = ($.directives ?? {}) as { after?: string }
  return findWindow(db()[accessor], {
    where:   opts.where ?? {},
    limit:   opts.limit,
    offset:  opts.offset,
    orderBy: callerOrder(opts.orderBy ?? { createdAt: 'desc' }),
    ...callerSelect(),
  }, after || undefined, `The ${accessor} list`)
}

/**
 * The caller's `$orderBy`, else the service's own order. A hand-written find
 * reads it here so junction's unread-directive check passes for the right
 * reason. A list that is not a table read (trash, portal) uses `shapedByCaller`.
 */
export function callerOrder<T>(fallback: T): T | ReturnType<typeof normalizeOrderBy> {
  const { orderBy } = ($.directives ?? {}) as { orderBy?: SortParam }
  return orderBy != null ? normalizeOrderBy(orderBy) : fallback
}

/**
 * The caller's `$select` as a spreadable `{ select }`, or nothing. A find that
 * `include`s a relation does not call it: a query takes `select` or `include`,
 * not both, so `$select` there stays a 400 rather than dropping the include.
 */
export function callerSelect(): { select?: Record<string, boolean> } {
  const { select } = ($.directives ?? {}) as { select?: SelectParam }
  return select != null ? { select: normalizeSelect(select) } : {}
}

/**
 * The caller's `$orderBy` and `$select` applied to rows already in memory, for
 * a list that is computed rather than read from a table (trash, portal, the
 * notification kinds). Without `$orderBy` the rows keep the order they came in;
 * the sort is stable, so the service's own order breaks ties.
 */
export function shapedByCaller<T extends Record<string, unknown>>(rows: T[]): T[] {
  const { orderBy, select } = ($.directives ?? {}) as { orderBy?: SortParam; select?: SelectParam }
  const compare = comparatorFor(orderBy)
  const sorted  = compare ? [...rows].sort(compare) : rows
  return select != null ? pickedByCaller(sorted) : sorted
}

/** The caller's `$select` over rows already in memory; no `$select` is the rows untouched. */
export function pickedByCaller<T extends Record<string, unknown>>(rows: T[]): T[] {
  const { select } = ($.directives ?? {}) as { select?: SelectParam }
  if (select == null) return rows
  const keys = Object.entries(normalizeSelect(select)).filter(([, on]) => on).map(([k]) => k)
  return rows.map(r => Object.fromEntries(keys.filter(k => k in r).map(k => [k, r[k]]))) as T[]
}

/**
 * Fetch one row inside the caller's workspace, or 404.
 *
 * The workspace clause is the schema's — a caller who knows an id reads nothing
 * outside their own tenant because the declaration compiles a predicate into
 * every query. What is left here is the 404, which is this app's sentence.
 */
export async function getScoped(
  accessor: string,
  label:    string,
  id:       string = $.id as string,
) {
  const row = await db()[accessor].findFirst({ where: { id } })
  if (!row) throw new NotFound(`${label} '${id}' not found`)
  return row
}

// ─── Writes ──────────────────────────────────────────────────────────────

/**
 * before/create hook: derive the slug the client does not send.
 *
 * `workspaceId` is not stamped here. The tenancy declaration desugars into a
 * `@default(auth().workspaceId)`, so the column is filled at the Data boundary
 * from the claim the principal already carries — which covers the paths no hook
 * runs on as well as this one.
 *
 * Must be a HOOK, not the first lines of create(). `model:` brings
 * autoValidate(model, 'create') with it, and Junction runs user hooks BEFORE
 * the derived ones precisely so a hook can shape ctx.data first.
 */
export function deriveSlug(ctx: ServiceContext): void {
  const data = ctx.data as Record<string, unknown>
  if (!data) return
  if (typeof data.name === 'string' && !data.slug) data.slug = slugify(data.name)
}

// ─── Writes: what a patch may not name ───────────────────────────────────

/**
 * The columns a caller never names in a patch, per model, read off litestone's
 * update schema: the row stamps, the tenant column, a set-once
 * `@immutable` column and the field a `@@transitions` moves, and the key
 * column(s), which the body carries. A client echoing
 * back the row it fetched names all of them, so they are dropped.
 *
 * Three readOnly kinds are left to the Data boundary. `version` rides along as a
 * precondition; a claimed mirror's column is the Provider verb's input; and a
 * `@system` column is refused BY NAME there, which a drop here would turn into
 * a 200 that wrote nothing.
 */
const KEPT = new Set(['version', 'mirror', 'system'])
const unwritableCache = new WeakMap<object, Map<string, Set<string>>>()

function unwritableFor(models: string[]): Set<string> {
  const schema = db().$schema as object
  let byModel = unwritableCache.get(schema)
  if (!byModel) {
    byModel = new Map()
    const defs = (generateJsonSchema(schema as never, {
      mode: 'update', includeTimestamps: true, includeDeletedAt: true,
    }) as { $defs: Record<string, { properties?: Record<string, Record<string, unknown>> }> }).$defs
    for (const [name, def] of Object.entries(defs))
      byModel.set(name, new Set(Object.entries(def.properties ?? {})
        .filter(([, p]) => p.readOnly === true &&
          !KEPT.has(p['x-litestone-kind'] as string))
        .map(([key]) => key)))
    unwritableCache.set(schema, byModel)
  }
  for (const model of models) {
    const dropped = byModel.get(model)
    if (dropped) return new Set([...dropped, ...primaryKeyOf(model)])
  }
  return new Set()
}

/** The key column(s), asked of the client: a patch body carries the row's own id. */
function primaryKeyOf(model: string): string[] {
  const client = db() as { $primaryKey(accessor: string): string[] }
  return client.$primaryKey(model[0]!.toLowerCase() + model.slice(1))
}

/** The model names the call's service is over: its declared `model:`, else its own name. */
function callModels(): string[] {
  const svc = ($.app as { services: { get(n: string): { model?: string | null } | undefined } }).services.get($.service)
  const accessor = serviceAccessor({ name: $.service, model: svc?.model })
  return accessor ? accessorCandidates(accessor) : []
}

/**
 * Narrow a validated patch payload to what a client may actually change.
 *
 * What it drops is the schema's, read off the model of the call in progress --
 * a list here would be the policy stated a second time, in a second language.
 *
 * Key presence, not `??` -- an explicit null must CLEAR a nullable column
 * (Invariant 9). With `??`, `{ ipAddress: null }` would mean "leave it alone"
 * and a decommissioned server would keep its old address forever.
 */
export function narrowPatch(data: Record<string, unknown>): Record<string, unknown> {
  const blocked = unwritableFor(callModels())
  const patch: Record<string, unknown> = {}
  for (const key of Object.keys(data ?? {}))
    if (!blocked.has(key)) patch[key] = typeof data[key] === 'string' && key === 'name'
      ? (data[key] as string).trim()
      : data[key]
  return patch
}

/**
 * Does a narrowed patch actually change anything?
 *
 * `version` rides along on every patch of a `@version` model — the client sends
 * back the value it read, as a precondition rather than a value to write. Count
 * it as a change and a form submitted with nothing edited becomes a real write,
 * which bumps the version and makes every OTHER open editor of that row stale
 * for a change nobody made.
 */
export function changesNothing(patch: Record<string, unknown>): boolean {
  return Object.keys(patch).every(key => key === 'version')
}

/** Soft-delete (schema declares @@softDelete) and return the stamped row. */
export async function removeScoped(accessor: string, label: string) {
  await getScoped(accessor, label)               // 404s outside the workspace
  const removed = await db()[accessor].remove({ where: { id: $.id as string } })
  return Array.isArray(removed) ? removed[0] : removed
}

/**
 * Un-delete the row `$.id` names and return it, or 404. For a service whose
 * `remove` did more than stamp the row — the service overrides `restore`, calls
 * this, and reverses its own side effect after it.
 */
export async function restoreScoped(accessor: string, label: string) {
  const [row] = await db()[accessor].restore({ where: { id: $.id as string } })
  if (!row) throw new NotFound(`${label} '${$.id}' is not in the trash`)
  return row
}
