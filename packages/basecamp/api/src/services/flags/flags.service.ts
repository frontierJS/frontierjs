// src/services/flags/flags.service.ts
// Feature flags, and the per-environment overrides that make them useful.
//
// Mounted at /flags. Custom methods dispatch on X-Service-Method:
//   setOverride · clearOverride · resolve
//
// The mock kept per-environment state in a map keyed by TIER NAME —
// `production`, `staging`, `development`. That vocabulary already exists here
// as `model Environment`, one row per environment per project, so keying by the
// string would have meant every project in the workspace sharing one
// "production" belonging to none of them. `FlagOverride` points at the real row
// and the unique is `[flagId, environmentId]`.
//
// **`resolve` is the read an SDK would make**, and it is the reason the split
// matters: given an environment, what is this flag actually set to? The answer
// is the override if there is one, the flag's own default if not — one rule,
// stated once, in `resolveIn()`. A UI that reimplemented it would be a second
// owner of the only thing this service is for.
//
// Nothing here decides whether a given USER is in a rollout percentage. That is
// a bucketing decision that has to happen where the user is, per request, and
// inventing it here would produce a number the SDK could not reproduce.

import { createService, NotFound, BadRequest, Conflict, publishToChannels } from '@frontierjs/junction'
import { sessionScope, requireWorkspaceRole, workspaceChannel, getPagination } from '../../core/hooks.ts'
import { findScoped, getScoped, removeScoped, narrowPatch, changesNothing, dbOf, wsOf, actorOf }
  from '../../core/resource.ts'
import type { BasecampApp }    from '../../basecamp.types.ts'
import type { ServiceContext } from '@frontierjs/junction'

/**
 * What a flag is set to in one environment.
 *
 * The ONE definition. An override wins outright when it exists — it is not
 * merged field by field, because a half-inherited rollout is a number nobody
 * chose. `source` is returned so a screen can say *why* without guessing.
 */
export function resolveIn(
  flag:     Record<string, unknown>,
  override: Record<string, unknown> | null | undefined,
) {
  if (override) return {
    isEnabled:  !!override.isEnabled,
    rollout:    Number(override.rollout ?? 0),
    variantKey: (override.variantKey as string | null) ?? null,
    source:     'override' as const,
  }
  return {
    isEnabled:  !!flag.isEnabled,
    rollout:    Number(flag.rollout ?? 0),
    variantKey: null,
    source:     'default' as const,
  }
}

/** Variant weights have to add to 100, or the flag describes a split that
 *  cannot happen. Checked here rather than in the schema because it is a rule
 *  ABOUT a Json column's contents, which SQLite cannot express. */
function assertVariants(type: string, variants: unknown): void {
  if (type !== 'variant') return
  const list = Array.isArray(variants) ? variants : []
  if (list.length < 2)
    throw new BadRequest('A variant flag needs at least two variants')

  const keys = new Set<string>()
  let total = 0
  for (const v of list as Record<string, unknown>[]) {
    if (!v?.key) throw new BadRequest('Every variant needs a key')
    if (keys.has(v.key as string)) throw new BadRequest(`Duplicate variant key '${v.key}'`)
    keys.add(v.key as string)
    total += Number(v.weight ?? 0)
  }
  if (total !== 100)
    throw new BadRequest(`Variant weights must add to 100 — they add to ${total}`)
}

export function createFlagsService(app: BasecampApp) {

  /** An environment inside the caller's workspace, or 404. Scoped to the
   *  WORKSPACE, not merely to existence: an id from another workspace would
   *  otherwise let a caller flip a flag in somebody else's environment. */
  async function environmentInWorkspace(ctx: ServiceContext, environmentId: string) {
    const env = await dbOf(ctx).environment.findFirst({
      where: { id: environmentId, workspaceId: wsOf(ctx) },
    })
    if (!env) throw new NotFound(`Environment '${environmentId}' not found in this workspace`)
    return env
  }

  /** A flag with its overrides, each resolved. The shape `get` answers, so
   *  setOverride/clearOverride can return the same record rather than a
   *  projection of it — a custom method's return shape is load-bearing
   *  (junction FJS-020). A plain function, not `this.get(ctx)`: a service's
   *  methods are collected into a definition object and calling one through
   *  `this` binds to whatever the pipeline happened to invoke it with. */
  async function flagWithOverrides(ctx: ServiceContext, flag: Record<string, unknown>) {
    const overrides = await dbOf(ctx).flagOverride.findMany({
      where:   { flagId: flag.id },
      include: { environment: true },
      orderBy: { createdAt: 'asc' },
    })
    return {
      ...flag,
      overrides: overrides.map((o: Record<string, unknown>) => ({ ...o, ...resolveIn(flag, o) })),
    }
  }

  return createService({
    name:  'flags',
    model: 'FeatureFlag',

    async find(ctx: ServiceContext) {
      const { limit, offset } = getPagination(ctx)
      const type = ctx.query.type as string | undefined
      const tag  = ctx.query.tag  as string | undefined

      const page = await findScoped(ctx, 'featureFlag', {
        where:   { ...(type ? { type } : {}) },
        orderBy: { key: 'asc' },
        limit, offset,
      })

      // `tags` is a Json array, which SQLite cannot filter on through the
      // accessor — so the tag filter is applied here rather than pretending
      // the where-clause can do it. Honest and bounded: the page is already
      // in memory and a workspace has tens of flags, not millions.
      const rows = tag
        ? (page.data as Record<string, unknown>[]).filter(f => (f.tags as string[] ?? []).includes(tag))
        : page.data as Record<string, unknown>[]

      // The override COUNT, not the rows: a flag overridden nowhere and one
      // overridden in production look identical without it, and `get` is the
      // read that pays for the join.
      const data = await Promise.all(rows.map(async f => ({
        ...f,
        override_count: await dbOf(ctx).flagOverride.count({ where: { flagId: f.id } }),
      })))
      return { ...page, data, total: tag ? data.length : page.total }
    },

    async get(ctx: ServiceContext) {
      return flagWithOverrides(ctx, await getScoped(ctx, 'featureFlag', 'Flag'))
    },

    async create(ctx: ServiceContext) {
      const data = ctx.data as Record<string, unknown>
      assertVariants((data.type as string) ?? 'boolean', data.variants)

      // The unique is [workspaceId, key]; a raw constraint violation reaches an
      // HTTP caller as a SQLite message rather than a sentence.
      if (await dbOf(ctx).featureFlag.exists({ where: { workspaceId: wsOf(ctx), key: data.key } }))
        throw new Conflict(`A flag with key '${data.key}' already exists in this workspace`)

      return flagWithOverrides(ctx, await dbOf(ctx).featureFlag.create({ data }))
    },

    async patch(ctx: ServiceContext) {
      const flag = await getScoped(ctx, 'featureFlag', 'Flag')
      const data = ctx.data as Record<string, unknown>

      if ('variants' in data || 'type' in data)
        assertVariants((data.type as string) ?? (flag.type as string), data.variants ?? flag.variants)

      // `key` is immutable: it is the name in somebody else's source code, and
      // half of a @@unique. Renaming it silently turns every SDK call into a
      // miss, which resolves to the default and looks like the flag being off.
      const patch = narrowPatch(data, ['key', 'createdBy'])
      if (changesNothing(patch)) return flagWithOverrides(ctx, flag)

      return flagWithOverrides(ctx, await dbOf(ctx).featureFlag.update({
        where: { id: flag.id }, data: patch,
      }))
    },

    async remove(ctx: ServiceContext) {
      // No refusal on attached overrides, unlike networks and channels. An
      // override is not an independent thing an operator arranged — it is part
      // of this flag's configuration, and the schema cascades it. What the two
      // refusals protect is a row somebody ELSE depends on; nothing depends on
      // an override but its flag.
      return removeScoped(ctx, 'featureFlag', 'Flag')
    },

    // ── setOverride ───────────────────────────────────────────────────
    // Upsert, deliberately: a screen toggling a flag in an environment should
    // not have to know whether an override already exists there, and the
    // @@unique means a blind create is a 409 half the time.
    async setOverride(ctx: ServiceContext) {
      const flag = await getScoped(ctx, 'featureFlag', 'Flag')
      const { environmentId, isEnabled, rollout, variantKey } =
        (ctx.data ?? {}) as Record<string, unknown>

      if (!environmentId) throw new BadRequest('environmentId is required')
      await environmentInWorkspace(ctx, environmentId as string)

      if (variantKey != null) {
        if (flag.type !== 'variant')
          throw new BadRequest('Only a variant flag can pin a variant')
        const known = (flag.variants as Record<string, unknown>[] ?? []).some(v => v.key === variantKey)
        if (!known) throw new BadRequest(`This flag declares no variant '${variantKey}'`)
      }

      const values = {
        isEnabled:  isEnabled === true || isEnabled === 'true',
        rollout:    Math.max(0, Math.min(100, Number(rollout ?? 0))),
        variantKey: (variantKey as string | null) ?? null,
      }

      const existing = await dbOf(ctx).flagOverride.findFirst({
        where: { flagId: flag.id, environmentId },
      })
      if (existing) await dbOf(ctx).flagOverride.update({ where: { id: existing.id }, data: values })
      else          await dbOf(ctx).flagOverride.create({ data: { flagId: flag.id, environmentId, ...values } })

      return flagWithOverrides(ctx, flag)
    },

    // ── clearOverride ─────────────────────────────────────────────────
    // The environment falls back to the flag's default. NOT the same as
    // setting the override to off — that is a decision this environment made,
    // and clearing it means "follow whatever the flag says", including later
    // changes to the flag.
    async clearOverride(ctx: ServiceContext) {
      const flag = await getScoped(ctx, 'featureFlag', 'Flag')
      const { environmentId } = (ctx.data ?? {}) as Record<string, string>
      if (!environmentId) throw new BadRequest('environmentId is required')

      const existing = await dbOf(ctx).flagOverride.findFirst({
        where: { flagId: flag.id, environmentId },
      })
      if (!existing) throw new NotFound('This flag has no override in that environment')

      await dbOf(ctx).flagOverride.remove({ where: { id: existing.id } })
      return flagWithOverrides(ctx, flag)
    },

    // ── resolve ───────────────────────────────────────────────────────
    // The read an SDK makes: what is every flag set to in ONE environment?
    //
    // Collection-level — there is no subject row, so it is `POST /flags` with
    // the header rather than `POST /flags/{id}`. Read-shaped, so it opts out
    // of the announcement the after-hook makes for every other method.
    async resolve(ctx: ServiceContext) {
      ctx.dispatch = false
      const environmentId = (ctx.query.environmentId ?? (ctx.data as Record<string, string>)?.environmentId) as string
      if (!environmentId) throw new BadRequest('environmentId is required')
      await environmentInWorkspace(ctx, environmentId)

      const flags = await dbOf(ctx).featureFlag.findMany({
        where: { workspaceId: wsOf(ctx) }, orderBy: { key: 'asc' }, limit: 500,
      })
      if (!flags.length) return { total: 0, environmentId, data: [] }

      const overrides = await dbOf(ctx).flagOverride.findMany({
        where: { environmentId, flagId: { in: flags.map((f: { id: string }) => f.id) } },
      })
      const byFlag = new Map(overrides.map((o: Record<string, unknown>) => [o.flagId, o]))

      return {
        total: flags.length,
        environmentId,
        data: flags.map((f: Record<string, unknown>) => ({
          key:      f.key,
          type:     f.type,
          variants: f.type === 'variant' ? f.variants : undefined,
          ...resolveIn(f, byFlag.get(f.id) as Record<string, unknown> | undefined),
        })),
      }
    },

    hooks: {
      before: {
        all:    [sessionScope(app)],
        // Authoring a flag is a developer act — it is part of shipping the code
        // that reads it, and holding it at admin would put the person who wrote
        // the feature behind a ticket.
        create: [requireWorkspaceRole(app, 'developer', 'admin', 'owner'), stampFlag],
        patch:  [requireWorkspaceRole(app, 'developer', 'admin', 'owner')],
        remove: [requireWorkspaceRole(app, 'admin', 'owner')],
        // Overriding is the same bar as authoring: it is how a flag is rolled
        // out, which is the normal working use of the feature.
        setOverride:   [requireWorkspaceRole(app, 'developer', 'admin', 'owner')],
        clearOverride: [requireWorkspaceRole(app, 'developer', 'admin', 'owner')],
      },
      after: {
        all: [publishToChannels(workspaceChannel(app))],
      },
    },
  })
}

/** FeatureFlag has no `slug` column, so the shared stampWorkspace — which
 *  derives one from `name` — would add a key autoValidate then strips. This
 *  model's identifier is `key`, and `@slug` in the schema is what shapes it. */
function stampFlag(ctx: ServiceContext): void {
  const data = ctx.data as Record<string, unknown>
  if (!data) return
  data.workspaceId = wsOf(ctx)
  data.createdBy   = actorOf(ctx)
}
