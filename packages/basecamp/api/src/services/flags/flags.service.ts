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
// **Who is in a rollout percentage is a rule, not a number** (`FJS-124`). It has
// to be decided where the user is — per request, in whatever language the SDK is
// written in — so what this file owns is the RULE, published beside `resolveIn`
// and reproducible anywhere: MurmurHash3 x86 32-bit over `<flagKey>:<unitId>`,
// mod 100. `resolve` will apply it for a stated `unitId`, which is what makes it
// checkable against an SDK rather than merely described.

import { createService, NotFound, BadRequest, Conflict, $ } from '@frontierjs/junction'
import { sessionScope, requireWorkspaceRole, workspaceChannel, getPagination, WORKSPACE_QUERY } from '../../core/hooks.ts'
import { db, findScoped, getScoped, removeScoped, narrowPatch, changesNothing, ws, actor }
  from '../../core/resource.ts'
import type { BasecampApp }    from '../../basecamp.types.ts'

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
    rollout:    Number(override.rollout ?? 100),
    variantKey: (override.variantKey as string | null) ?? null,
    source:     'override' as const,
  }
  return {
    isEnabled:  !!flag.isEnabled,
    rollout:    Number(flag.rollout ?? 100),
    variantKey: null,
    source:     'default' as const,
  }
}

// ─── bucketing ──────────────────────────────────────────────────────────────
//
// `rollout` was stored, returned, and applied by nothing, so a flag at 10%
// behaved as on-or-off (`FJS-124`). Closing that is not code so much as an
// agreement: the server and every SDK must land on the same answer for the same
// user, or the percentage is a different 10% in each of them.
//
// **MurmurHash3 x86 32-bit, over `<flagKey>:<unitId>`, mod 100.** Every part of
// that is load-bearing:
//
//   • **Murmur3** because it is synchronous, dependency-free, ~30 lines, and has
//     a stock implementation in every language an SDK might be written in. A
//     crypto hash would be reproducible too, but WebCrypto is async — a flag
//     check sits in a render path and cannot await.
//   • **The flag key is in the hash**, so two flags at 10% do not select the
//     same tenth of the population. Hashing the unit alone gives every flag the
//     same cohort, which is the carryover bias that makes a staged rollout test
//     one unlucky group over and over.
//   • **mod 100**, matching `rollout Int @gte(0) @lte(100)`. A finer bucket
//     would be a number the column cannot express.
//
// Two properties follow and both are asserted rather than assumed: raising a
// percentage only ever ADDS units (nobody loses the feature when 10 becomes 20),
// and the same unit lands in the same bucket in every environment — so a cohort
// tested in staging is the cohort that gets it in production.
//
// The `unitId` is the caller's to choose: a user id, an account id, a device id.
// This service never invents one. Absent, no bucketing is reported at all.

/** MurmurHash3 x86 32-bit, seed 0. Verified against the canonical vectors —
 *  see `api/test/flags.test.ts`, which is the contract an SDK is written to. */
export function murmur3(text: string): number {
  const bytes  = new TextEncoder().encode(text)
  const n      = bytes.length
  const blocks = n >> 2
  let   h      = 0

  for (let i = 0; i < blocks; i++) {
    const j = i << 2
    let k = bytes[j]! | (bytes[j + 1]! << 8) | (bytes[j + 2]! << 16) | (bytes[j + 3]! << 24)
    k = Math.imul(k, 0xcc9e2d51)
    k = (k << 15) | (k >>> 17)
    k = Math.imul(k, 0x1b873593)
    h ^= k
    h = (h << 13) | (h >>> 19)
    h = (Math.imul(h, 5) + 0xe6546b64) | 0
  }

  // The trailing 1–3 bytes, which get the k-mix and none of the h-mix.
  const tail = blocks << 2
  const rem  = n & 3
  if (rem) {
    let k = 0
    if (rem === 3) k ^= bytes[tail + 2]! << 16
    if (rem >= 2)  k ^= bytes[tail + 1]! << 8
    k ^= bytes[tail]!
    k = Math.imul(k, 0xcc9e2d51)
    k = (k << 15) | (k >>> 17)
    k = Math.imul(k, 0x1b873593)
    h ^= k
  }

  h ^= n
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return h >>> 0
}

/** Which of the hundred buckets this unit falls in for this flag. 0–99. */
export function bucketFor(flagKey: string, unitId: string): number {
  return murmur3(`${flagKey}:${unitId}`) % 100
}

/**
 * Which variant this unit gets, by cumulative weight.
 *
 * Salted apart from the rollout bucket (`:variant`), so a unit's position in
 * the rollout says nothing about which arm it lands in — sharing one bucket
 * would put everyone at the front of the rollout in the first variant.
 *
 * `assertVariants` already refuses weights that do not add to 100, so the walk
 * cannot fall off the end; the last variant is returned if it ever does, which
 * is a rounding answer rather than a null one.
 */
export function variantFor(
  flagKey:  string,
  unitId:   string,
  variants: Record<string, unknown>[],
): string | null {
  if (!variants.length) return null
  const b = murmur3(`${flagKey}:variant:${unitId}`) % 100
  let seen = 0
  for (const v of variants) {
    seen += Number(v.weight ?? 0)
    if (b < seen) return (v.key as string) ?? null
  }
  return (variants[variants.length - 1]!.key as string) ?? null
}

/**
 * The resolved config, decided for ONE unit.
 *
 * `isEnabled` stays what it was — the switch somebody set — and `on` is the
 * answer for this unit, which is the only field an SDK branches on. Both are
 * returned because a screen explaining *why* needs the pair, and `bucket` is
 * there for the same reason: "this user is at 47, the rollout is 10" is the
 * sentence that makes a percentage trustworthy.
 */
export function decideFor(
  resolved: ReturnType<typeof resolveIn>,
  flagKey:  string,
  unitId:   string,
  type:     string,
  variants: Record<string, unknown>[] | null | undefined,
) {
  const bucket    = bucketFor(flagKey, unitId)
  const inRollout = resolved.rollout >= 100 || (resolved.rollout > 0 && bucket < resolved.rollout)
  const on        = resolved.isEnabled && inRollout

  return {
    ...resolved,
    unitId,
    bucket,
    inRollout,
    on,
    // A pinned variant is a decision the override made and outranks the split.
    variantKey: type === 'variant' && on
      ? (resolved.variantKey ?? variantFor(flagKey, unitId, variants ?? []))
      : resolved.variantKey,
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
  async function environmentInWorkspace(environmentId: string) {
    const env = await db().environment.findFirst({
      where: { id: environmentId, workspaceId: ws() },
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
  async function flagWithOverrides(flag: Record<string, unknown>) {
    const overrides = await db().flagOverride.findMany({
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
    // Announced by the service DEFINITION, not by an after hook: `callService`
    // is junction's one announcement point and it excludes `find`/`get` by name,
    // where an `after: { all: [...] }` hook broadcast every read to every browser
    // in the workspace (FJS-031). Declaring both is refused at construction.
    channel: workspaceChannel(app),
    reservedQuery: WORKSPACE_QUERY,   // ?workspace_id= is not a filter — see core/hooks.ts

    async find() {
      const { limit, offset } = getPagination()
      const type = $.query.type as string | undefined
      const tag  = $.query.tag  as string | undefined

      const page = await findScoped('featureFlag', {
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
        override_count: await db().flagOverride.count({ where: { flagId: f.id } }),
      })))
      return { ...page, data, total: tag ? data.length : page.total }
    },

    async get() {
      return flagWithOverrides(await getScoped('featureFlag', 'Flag'))
    },

    async create() {
      const data = $.data as Record<string, unknown>
      assertVariants((data.type as string) ?? 'boolean', data.variants)

      // The unique is [workspaceId, key]; a raw constraint violation reaches an
      // HTTP caller as a SQLite message rather than a sentence.
      if (await db().featureFlag.exists({ where: { workspaceId: ws(), key: data.key } }))
        throw new Conflict(`A flag with key '${data.key}' already exists in this workspace`)

      return flagWithOverrides(await db().featureFlag.create({ data }))
    },

    async patch() {
      const flag = await getScoped('featureFlag', 'Flag')
      const data = $.data as Record<string, unknown>

      if ('variants' in data || 'type' in data)
        assertVariants((data.type as string) ?? (flag.type as string), data.variants ?? flag.variants)

      // `key` is immutable: it is the name in somebody else's source code, and
      // half of a @@unique. Renaming it silently turns every SDK call into a
      // miss, which resolves to the default and looks like the flag being off.
      const patch = narrowPatch(data, ['key', 'createdBy'])
      if (changesNothing(patch)) return flagWithOverrides(flag)

      return flagWithOverrides(await db().featureFlag.update({
        where: { id: flag.id }, data: patch,
      }))
    },

    async remove() {
      // No refusal on attached overrides, unlike networks and channels. An
      // override is not an independent thing an operator arranged — it is part
      // of this flag's configuration, and the schema cascades it. What the two
      // refusals protect is a row somebody ELSE depends on; nothing depends on
      // an override but its flag.
      return removeScoped('featureFlag', 'Flag')
    },

    // ── setOverride ───────────────────────────────────────────────────
    // Upsert, deliberately: a screen toggling a flag in an environment should
    // not have to know whether an override already exists there, and the
    // @@unique means a blind create is a 409 half the time.
    async setOverride() {
      const flag = await getScoped('featureFlag', 'Flag')
      const { environmentId, isEnabled, rollout, variantKey } =
        ($.data ?? {}) as Record<string, unknown>

      if (!environmentId) throw new BadRequest('environmentId is required')
      await environmentInWorkspace(environmentId as string)

      if (variantKey != null) {
        if (flag.type !== 'variant')
          throw new BadRequest('Only a variant flag can pin a variant')
        const known = (flag.variants as Record<string, unknown>[] ?? []).some(v => v.key === variantKey)
        if (!known) throw new BadRequest(`This flag declares no variant '${variantKey}'`)
      }

      const values = {
        isEnabled:  isEnabled === true || isEnabled === 'true',
        rollout:    Math.max(0, Math.min(100, Number(rollout ?? 100))),
        variantKey: (variantKey as string | null) ?? null,
      }

      const existing = await db().flagOverride.findFirst({
        where: { flagId: flag.id, environmentId },
      })
      if (existing) await db().flagOverride.update({ where: { id: existing.id }, data: values })
      else          await db().flagOverride.create({ data: { flagId: flag.id, environmentId, ...values } })

      return flagWithOverrides(flag)
    },

    // ── clearOverride ─────────────────────────────────────────────────
    // The environment falls back to the flag's default. NOT the same as
    // setting the override to off — that is a decision this environment made,
    // and clearing it means "follow whatever the flag says", including later
    // changes to the flag.
    async clearOverride() {
      const flag = await getScoped('featureFlag', 'Flag')
      const { environmentId } = ($.data ?? {}) as Record<string, string>
      if (!environmentId) throw new BadRequest('environmentId is required')

      const existing = await db().flagOverride.findFirst({
        where: { flagId: flag.id, environmentId },
      })
      if (!existing) throw new NotFound('This flag has no override in that environment')

      await db().flagOverride.remove({ where: { id: existing.id } })
      return flagWithOverrides(flag)
    },

    // ── resolve ───────────────────────────────────────────────────────
    // The read an SDK makes: what is every flag set to in ONE environment?
    //
    // Collection-level — there is no subject row, so it is `POST /flags` with
    // the header rather than `POST /flags/{id}`. Read-shaped, so it opts out
    // of the announcement the after-hook makes for every other method.
    async resolve() {
      $.dispatch = false
      const environmentId = ($.query.environmentId ?? ($.data as Record<string, string>)?.environmentId) as string
      if (!environmentId) throw new BadRequest('environmentId is required')
      await environmentInWorkspace(environmentId)

      // Who the answer is FOR. Optional, and absent means the caller wants the
      // configuration rather than a decision — which is every screen in this
      // app. Stated, never invented: bucketing the calling operator would
      // answer a question about the wrong person entirely.
      const unitId = ($.query.unitId ?? ($.data as Record<string, string>)?.unitId) as string | undefined

      const flags = await db().featureFlag.findMany({
        where: { workspaceId: ws() }, orderBy: { key: 'asc' }, limit: 500,
      })
      if (!flags.length) return { total: 0, environmentId, ...(unitId ? { unitId } : {}), data: [] }

      const overrides = await db().flagOverride.findMany({
        where: { environmentId, flagId: { in: flags.map((f: { id: string }) => f.id) } },
      })
      const byFlag = new Map(overrides.map((o: Record<string, unknown>) => [o.flagId, o]))

      return {
        total: flags.length,
        environmentId,
        ...(unitId ? { unitId } : {}),
        data: flags.map((f: Record<string, unknown>) => {
          const resolved = resolveIn(f, byFlag.get(f.id) as Record<string, unknown> | undefined)
          return {
            key:      f.key,
            type:     f.type,
            variants: f.type === 'variant' ? f.variants : undefined,
            ...(unitId
              ? decideFor(resolved, f.key as string, unitId,
                          f.type as string, f.variants as Record<string, unknown>[])
              : resolved),
          }
        }),
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
    },
  })
}

/** FeatureFlag has no `slug` column, so the shared deriveSlug — which
 *  derives one from `name` — would add a key autoValidate then strips. This
 *  model's identifier is `key`, and `@slug` in the schema is what shapes it. */
function stampFlag(): void {
  const data = $.data as Record<string, unknown>
  if (!data) return
  data.createdBy   = actor()
}
