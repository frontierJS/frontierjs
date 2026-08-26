// src/services/blueprints/blueprints.service.ts
// The deployment catalogue — what an operator can pick from, and the fields
// they fill in before it becomes an App.
//
// Mounted at /blueprints. **The one service here that takes no workspace.**
// `Blueprint` is `@@tenant(none)` because the catalogue is curated for the whole
// installation rather than authored per tenant — see the model's own comment —
// so there is no `sessionScope` on this file and no `X-Workspace-Id` to send.
// What stands in for it is the gate: `@@gate("1.7")` reads at VISITOR(1), so a
// caller with no session is refused at the Data boundary rather than by a hook,
// and every write is `requireSystemAdmin()`.
//
// ─── Params are set by setParams, and only by setParams ───────────────────
//
// `BlueprintParam` is ORDERED, and a partial update of an ordered list is the
// problem `DashboardWidget.reorder` already documents: sending one row's
// position races every other row's. `setParams` takes the whole sequence and
// rewrites it in one call, so the order that arrives is the order that lands.
//
// It is also the ONLY door, and that is forced rather than chosen. The create
// and patch schemas litestone derives are CLOSED (`additionalProperties: false`)
// and `params` is a relation, so `autoValidate` strips it before a method sees
// it — a caller sending a blueprint with its params inline would get a
// blueprint with no params and no error. The usual answer is `@transient`, and
// it is unavailable here for one flat reason: the relation already owns the
// name, so the column could not be called `params`.
//
// So the payload is refused by name instead, in a hook that runs BEFORE the
// derived validator — user hooks lead, which is what makes the key still
// visible. A refusal naming the method to call is worth more than a second
// spelling of the same list.

import { createService, BadRequest, Conflict, NotFound, $ } from '@frontierjs/junction'
import { requireSystemAdmin, getPagination } from '../../core/hooks.ts'
import { db, slugify }                       from '../../core/resource.ts'
import type { BasecampApp }                  from '../../basecamp.types.ts'

/**
 * A blueprint always travels with the form it implies, IN ORDER.
 *
 * An include carries its own nested read, so the ordering belongs here rather
 * than to whoever renders it: `position` is the order the author chose, and
 * `key` is the tiebreak, because two params at the same position otherwise come
 * back in whatever order SQLite feels like — which is stable enough to look
 * correct in development and is not a guarantee.
 */
const WITH_PARAMS = { params: { orderBy: [{ position: 'asc' }, { key: 'asc' }] } }

export function createBlueprintsService(_app: BasecampApp) {
  return createService({
    name:  'blueprints',
    model: 'Blueprint',

    // No `channel:`. A catalogue change is the hub editing one shared row, not
    // a workspace's data moving — and `workspaceChannel` is the only channel
    // this app has, which would broadcast a hub edit into whichever workspace
    // the editor happened to be looking at.

    methods: ['find', 'get', 'create', 'patch', 'remove', 'categories', 'setParams'],

    async find() {
      const { limit, offset } = getPagination()

      // Withdrawn entries are out unless asked for. A deprecated blueprint is
      // still readable by id — the apps built from it point at it — but it is
      // not on offer.
      const includeDeprecated = String($.query.includeDeprecated ?? '') === 'true'
      const category          = $.query.category as string | undefined

      const where: Record<string, unknown> = {}
      if (!includeDeprecated) where.deprecatedAt = null
      if (category)           where.category     = category

      const { rows, total } = await db().blueprint.findManyAndCount({
        where, limit, offset,
        include: WITH_PARAMS,
        orderBy: [{ category: 'asc' }, { name: 'asc' }],
      })
      return { total, limit, offset, data: rows }
    },

    async get() {
      const row = await db().blueprint.findFirst({
        where: { id: $.id as string }, include: WITH_PARAMS,
      })
      if (!row) throw new NotFound(`Blueprint '${$.id}' not found`)
      return row
    },

    /**
     * The filter chips, off the rows.
     *
     * `Blueprint.category` is a free string and not an enum, which the schema
     * argues for at length: a category names nothing the server implements, so
     * making it an enum would turn adding a blueprint into a migration. The
     * cost is that the list of them has to be asked for, which is this.
     */
    async categories() {
      const rows = await db().blueprint.findMany({
        where: { deprecatedAt: null }, orderBy: { category: 'asc' },
      })
      const counts = new Map<string, number>()
      for (const r of rows) counts.set(r.category, (counts.get(r.category) ?? 0) + 1)
      return {
        total:      rows.length,
        categories: [...counts].map(([name, count]) => ({ name, count })),
      }
    },

    async create() {
      const data = $.data as Record<string, unknown>
      if (!data.slug && typeof data.name === 'string') data.slug = slugify(data.name)

      // `slug` is `@unique`, so SQLite would refuse this anyway — but its
      // sentence names a physical table. Litestone translates it now
      // (`UniqueConflictError`), and this is the same answer with the word a
      // person uses for the thing.
      if (await db().blueprint.exists({ where: { slug: data.slug } }))
        throw new Conflict(`A blueprint with the slug '${data.slug}' already exists`)

      const created = await db().blueprint.create({ data })
      return await db().blueprint.findFirst({ where: { id: created.id }, include: WITH_PARAMS })
    },

    async patch() {
      const id = $.id as string
      if (!await db().blueprint.exists({ where: { id } }))
        throw new NotFound(`Blueprint '${id}' not found`)

      // `slug` is immutable. It is the natural key an operator types and the
      // half of `@unique` a URL is built from.
      const data = { ...($.data as Record<string, unknown>) }
      delete data.slug

      if (Object.keys(data).length) await db().blueprint.update({ where: { id }, data })
      return await db().blueprint.findFirst({ where: { id }, include: WITH_PARAMS })
    },

    /**
     * Withdraw, do not delete.
     *
     * An App built from a blueprint keeps pointing at it, and the record of what
     * something was built from outlives the offer to build it again — the same
     * reason `Recipe` soft-deletes. `Blueprint` has no `@@softDelete`, so the
     * withdrawal is a column: `deprecatedAt`.
     */
    async remove() {
      const id  = $.id as string
      const row = await db().blueprint.findFirst({ where: { id } })
      if (!row) throw new NotFound(`Blueprint '${id}' not found`)

      // `revision` is `@version`, so every update must carry the revision it
      // read — including this one, which is a state change rather than a form
      // save. Read it here rather than reaching for `asSystem()`: the bypass
      // would drop the gate, the audit actor and the announcement to withdraw
      // one row, and a 409 from a genuine race is the right answer anyway.
      return await db().blueprint.update({
        where: { id },
        data:  { deprecatedAt: new Date().toISOString(), revision: row.revision },
      })
    },

    /** Replace a blueprint's parameters, in the order given. */
    async setParams() {
      const id = $.id as string
      if (!await db().blueprint.exists({ where: { id } }))
        throw new NotFound(`Blueprint '${id}' not found`)

      await writeParams(id, readParams($.data as Record<string, unknown>))
      return await db().blueprint.findFirst({ where: { id }, include: WITH_PARAMS })
    },

    hooks: {
      before: {
        // Reads are the gate's — `@@gate("1.7")` refuses a caller with no
        // session, which is every reader this catalogue has to keep out.
        create:    [requireSystemAdmin(), refuseInlineParams],
        patch:     [requireSystemAdmin(), refuseInlineParams],
        remove:    [requireSystemAdmin()],
        setParams: [requireSystemAdmin()],
      },
    },
  })
}

// ─── params ───────────────────────────────────────────────────────────────

interface ParamInput {
  key:           string
  label:         string
  hint?:         string | null
  defaultValue?: string | null
  required?:     boolean
  secret?:       boolean
  generate?:     string | null
}

/**
 * before/create and before/patch: refuse a payload carrying `params`.
 *
 * Runs ahead of `autoValidate`, which is the only reason it can see the key at
 * all — the derived create schema is closed and `params` is a relation, so by
 * the time a method runs the key is gone and the loss is silent.
 */
function refuseInlineParams(ctx: { data?: unknown }): void {
  const data = ctx.data as Record<string, unknown> | undefined
  if (data && 'params' in data) throw new BadRequest(
    'A blueprint\'s params are set with `setParams`, not inline — they are ordered, ' +
    'and the whole sequence is replaced at once so the order that arrives is the order ' +
    'that lands. Create the blueprint, then call setParams with the list.')
}

/** The list off a custom method's payload. No `autoValidate` here — a custom
 *  method's payload is not derived from the model — so this is where the shape
 *  is checked. */
function readParams(data: Record<string, unknown>): ParamInput[] {
  const raw = data?.params
  if (raw == null) return []
  if (!Array.isArray(raw)) throw new BadRequest('`params` must be an array')
  return raw as ParamInput[]
}

/**
 * Rewrite the whole ordered list.
 *
 * Delete-then-insert rather than a diff, and the reason is `position`: a diff
 * has to decide what to do about a key that moved, and every answer to that is
 * a reorder. The sequence sent IS the sequence, which is what makes it safe.
 */
async function writeParams(blueprintId: string, params: ParamInput[]): Promise<void> {
  const seen = new Set<string>()
  for (const p of params) {
    if (!p?.key)        throw new BadRequest('Every param needs a `key`')
    if (seen.has(p.key)) throw new Conflict(`Duplicate param key '${p.key}'`)
    seen.add(p.key)
  }

  await db().blueprintParam.deleteMany({ where: { blueprintId } })
  let position = 0
  for (const p of params) {
    await db().blueprintParam.create({
      data: {
        blueprintId,
        key:          p.key,
        label:        p.label ?? p.key,
        hint:         p.hint ?? null,
        defaultValue: p.defaultValue ?? null,
        required:     p.required === true,
        secret:       p.secret   === true,
        generate:     p.generate ?? null,
        position:     position++,
      },
    })
  }
}
