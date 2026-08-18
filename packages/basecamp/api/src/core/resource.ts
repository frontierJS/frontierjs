// src/core/resource.ts
// The shape every workspace-scoped Basecamp service shares.
//
// Seven services do the same five things: list within a workspace, fetch one or
// 404, create with a derived slug, patch a narrowed field set, soft-delete.
// Written out seven times that is seven chances to forget `workspaceId` in a
// where-clause — which is a tenancy leak, not a style problem.
//
// These are helpers, not a factory. Each service still declares its own methods
// so the ones with real behaviour (servers' drain/heartbeat, deployments'
// engine handoff) read as themselves rather than as config for a base class.

import { NotFound, Conflict } from '@frontierjs/junction'
import type { ServiceContext } from '@frontierjs/junction'

// ─── Context accessors ───────────────────────────────────────────────────
// A ServiceContext has no `ctx.params`. It splits into auth / client / route /
// locals — see core/hooks.ts. These three exist so that fact is stated once.

/** The caller-scoped Litestone client, installed by createApp({ db }). */
export function dbOf(ctx: ServiceContext): any {
  return (ctx.locals as { db: any }).db
}

/** The acting workspace, stamped by requireWorkspace() in sessionScope. */
export function wsOf(ctx: ServiceContext): string {
  return ctx.locals.workspaceId as string
}

/** The acting user's id, or 'system' for engine/outpost paths. */
export function actorOf(ctx: ServiceContext): string {
  return (ctx.auth?.user as { userId?: string } | undefined)?.userId ?? 'system'
}

export function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64)
}

// ─── Reads ───────────────────────────────────────────────────────────────

/**
 * List within the caller's workspace.
 *
 * `deletedAt IS NULL` is never spelled out — @@softDelete makes exclusion the
 * default for every read, and restating it by hand is the one place that
 * disagrees when the convention changes.
 */
export async function findScoped(
  ctx:      ServiceContext,
  accessor: string,
  opts:     { where?: Record<string, unknown>; limit: number; offset: number; orderBy?: Record<string, string> | Record<string, string>[] },
) {
  const { rows, total } = await dbOf(ctx)[accessor].findManyAndCount({
    where:   { workspaceId: wsOf(ctx), ...(opts.where ?? {}) },
    limit:   opts.limit,
    offset:  opts.offset,
    orderBy: opts.orderBy ?? { createdAt: 'desc' },
  })
  return { total, limit: opts.limit, offset: opts.offset, data: rows }
}

/**
 * Fetch one row inside the caller's workspace, or 404.
 *
 * The workspace clause is the tenancy boundary: without it a caller who knows
 * an id can read another workspace's row. It is here rather than in each
 * service so it cannot be forgotten in one of them.
 */
export async function getScoped(
  ctx:      ServiceContext,
  accessor: string,
  label:    string,
  id:       string = ctx.id as string,
) {
  const row = await dbOf(ctx)[accessor].findFirst({ where: { id, workspaceId: wsOf(ctx) } })
  if (!row) throw new NotFound(`${label} '${id}' not found`)
  return row
}

/** Throw Conflict if a sibling already holds this slug. */
export async function assertSlugFree(
  ctx:      ServiceContext,
  accessor: string,
  where:    Record<string, unknown>,
  message:  string,
) {
  if (await dbOf(ctx)[accessor].exists({ where })) throw new Conflict(message)
}

// ─── Writes ──────────────────────────────────────────────────────────────

/**
 * before/create hook: stamp what the client does not send.
 *
 * Must be a HOOK, not the first lines of create(). `model:` brings
 * autoValidate(model, 'create') with it, which validates ctx.data against the
 * schema's required fields — and Junction runs user hooks BEFORE the derived
 * ones precisely so a hook can shape ctx.data first. Do this inside create()
 * and every request 400s on "workspaceId is required" for a field the client
 * was never meant to supply.
 */
export function stampWorkspace(ctx: ServiceContext): void {
  const data = ctx.data as Record<string, unknown>
  if (!data) return
  data.workspaceId = wsOf(ctx)
  if (typeof data.name === 'string' && !data.slug) data.slug = slugify(data.name)
}

/**
 * Narrow a validated patch payload to what a client may actually change.
 *
 * Key presence, not `??` — an explicit null must CLEAR a nullable column
 * (Invariant 9). With `??`, `{ ipAddress: null }` would mean "leave it alone"
 * and a decommissioned server would keep its old address forever.
 */
export function narrowPatch(
  data:      Record<string, unknown>,
  immutable: string[] = [],
): Record<string, unknown> {
  const blocked = new Set(['id', 'workspaceId', 'createdAt', 'updatedAt', 'deletedAt', ...immutable])
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
export async function removeScoped(ctx: ServiceContext, accessor: string, label: string) {
  await getScoped(ctx, accessor, label)          // 404s outside the workspace
  const removed = await dbOf(ctx)[accessor].remove({ where: { id: ctx.id as string } })
  return Array.isArray(removed) ? removed[0] : removed
}
