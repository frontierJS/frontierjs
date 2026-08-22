// src/services/recipes/recipes.service.ts
// Saved shell scripts, run on machines in the fleet.
//
// Mounted at /recipes. Custom methods dispatch on X-Service-Method:
//   run  — queue this recipe on one server or on every server with an outpost
//   runs — the history for one recipe, read-shaped
//
// **A recipe is arbitrary code, and no vocabulary can make it safe.** The
// dashboards ruling — a saved view names a declared KIND, never a stored query
// — does not transfer here, and the reason is the interesting part. A stored
// query is dangerous because the Data boundary grades a CALLER against a MODEL
// and a string cannot be graded, so the row would run at whoever opened it. A
// script is not run at this boundary at all: it is handed to an outpost and run
// on a machine, where there is no model, no caller and no grade. It runs at
// whatever the outpost has, every time, for everyone.
//
// So the safeguard is the record, and the split between authoring and running:
//
//   • Authoring is admin/owner. Writing the script IS the privileged act.
//   • Running is developer and up, which is the whole point of a saved recipe —
//     somebody who may not write one may run a vetted one.
//   • Every run keeps the script it ran (`RecipeRun.script`). A recipe is
//     editable, and output read against a script that has since changed is not
//     evidence of anything.
//
// **One run row per SERVER.** Running across the fleet is N executions with N
// exit codes; a single row has to pick one status for "three succeeded and two
// failed", which is the answer an operator most needs.
//
// Execution is not here. `run` queues, and `jobs/recipe-run.job.ts` carries it
// out through `app.conduit` at the `outpost:<id>` target a heartbeat registers —
// a script with a five-minute timeout on twenty machines is not an HTTP
// request, and a request that dies mid-fleet leaves half of it done with
// nothing recording which half.

import { createService, NotFound, BadRequest, $ } from '@frontierjs/junction'
import { sessionScope, requireWorkspaceRole, workspaceChannel, getPagination, WORKSPACE_QUERY } from '../../core/hooks.ts'
import { db, ws, actor, slugify, findScoped, getScoped, assertSlugFree, removeScoped, narrowPatch, changesNothing } from '../../core/resource.ts'
import type { BasecampApp }    from '../../basecamp.types.ts'
import type { ServiceContext } from '@frontierjs/junction'
import recipeRun from '../../jobs/recipe-run.job.ts'

/** How many runs a screen is handed at once. A fleet run writes one row per
 *  machine, so a recipe on fifty servers is fifty rows from a single click. */
const RUN_PAGE = 50

export function createRecipesService(app: BasecampApp) {

  /** The caller's fleet, as id → name. */
  async function fleetOf(): Promise<Map<string, string>> {
    const rows = await db().server.findMany({
      where:  { workspaceId: ws() },
      select: { id: true, name: true },
      limit:  500,
    })
    return new Map(rows.map((s: { id: string; name: string }) => [s.id, s.name]))
  }

  /** Runs for a recipe, newest first, with the machine's name resolved here
   *  rather than by the browser — a history of `4f3a-…` is a history nobody
   *  reads, and the alternative ships a whole server row per run. */
  async function runsFor(recipeId: string, limit = RUN_PAGE) {
    const fleet = await fleetOf()
    const rows  = await db().recipeRun.findMany({
      where: { recipeId }, orderBy: { createdAt: 'desc' }, limit,
    })
    return rows.map((r: Record<string, unknown>) => ({
      ...r, serverName: fleet.get(r.serverId as string) ?? null,
    }))
  }

  return createService({
    name:  'recipes',
    model: 'Recipe',
    // Announced by the service DEFINITION, not by an after hook: `callService`
    // is junction's one announcement point and it excludes `find`/`get` by name,
    // where an `after: { all: [...] }` hook broadcast every read to every browser
    // in the workspace (FJS-031). Declaring both is refused at construction.
    channel: workspaceChannel(app),
    reservedQuery: WORKSPACE_QUERY,   // ?workspace_id= is not a filter — see core/hooks.ts

    // The whole surface, declared. `model:` brings Junction's Litestone base,
    // which answers every CRUD verb this service leaves out — PUT included,
    // which would replace a whole row from the wire and take `workspaceId`
    // with it.
    methods: ['find', 'get', 'create', 'patch', 'remove', 'run', 'runs'],

    // ── find ──────────────────────────────────────────────────────────
    async find(ctx: ServiceContext) {
      const { limit, offset } = getPagination()
      const search = $.query.search as string | undefined

      return findScoped('recipe', {
        where: search ? { name: { contains: search } } : {},
        limit, offset,
        orderBy: { name: 'asc' },
      })
    },

    // ── get ───────────────────────────────────────────────────────────
    async get(ctx: ServiceContext) {
      const recipe = await getScoped('recipe', 'Recipe')
      return { ...recipe, runs: await runsFor(recipe.id as string) }
    },

    // ── create ────────────────────────────────────────────────────────
    async create() {
      const data = $.data as Record<string, unknown>
      if (!(data.script as string | undefined)?.trim())
        throw new BadRequest('script is required — a recipe with no script is a name')

      await assertSlugFree('recipe', { workspaceId: ws(), slug: data.slug },
        `A recipe called '${data.name}' already exists in this workspace`)

      const recipe = await db().recipe.create({ data })
      // The same shape `get` answers, so a screen that selects the new recipe
      // renders it rather than a record with no runs key.
      return { ...recipe, runs: [] }
    },

    // ── patch ─────────────────────────────────────────────────────────
    async patch(ctx: ServiceContext) {
      const recipe = await getScoped('recipe', 'Recipe')
      const data   = $.data as Record<string, unknown>

      // The counters belong to the job: a client that could set `runCount`
      // could say a script had never been run.
      const patch = narrowPatch(data, ['slug', 'createdBy', 'runCount', 'lastRunAt'])
      if (typeof patch.name === 'string' && patch.name !== recipe.name) {
        patch.slug = slugify(patch.name as string)
        await assertSlugFree('recipe',
          { workspaceId: ws(), slug: patch.slug, id: { not: recipe.id } },
          `A recipe called '${patch.name}' already exists in this workspace`)
      }

      if (changesNothing(patch)) return { ...recipe, runs: await runsFor(recipe.id as string) }

      const updated = await db().recipe.update({ where: { id: recipe.id }, data: patch })
      return { ...updated, runs: await runsFor(recipe.id as string) }
    },

    // ── remove ────────────────────────────────────────────────────────
    // Soft delete, and the runs stay: what a script did to a machine is not
    // undone by deleting the script, and the run rows carry their own copy of
    // it. They are reachable through the server's own history rather than
    // through a recipe that is gone.
    async remove() {
      return removeScoped('recipe', 'Recipe')
    },

    // ── run — POST /recipes/:id  X-Service-Method: run ────────────────
    // Queue this recipe. `{ serverId }` names one machine; omitting it means
    // every machine in the workspace an outpost has registered for.
    //
    // Nothing is executed here. The rows are written `pending` and the job
    // picks them up, so the answer to the click is *what was queued and where*
    // — which is also what the screen renders while it waits.
    async run(ctx: ServiceContext) {
      const recipe   = await getScoped('recipe', 'Recipe')
      const serverId = ($.data as { serverId?: string } | null)?.serverId
      const fleet    = await fleetOf()

      if (serverId && !fleet.has(serverId)) throw new NotFound(`Server '${serverId}' not found`)

      const candidates = serverId ? [serverId] : [...fleet.keys()]
      if (!candidates.length) throw new BadRequest('There are no servers in this workspace to run this on')

      if (!app.conduit)
        throw new BadRequest('Outbound delivery is not configured on this server — no conduit plugin')

      // A machine with no registered outpost cannot be reached, and queueing a
      // run against it would produce a row that fails a minute later for a
      // reason the operator could have been told at the click. An outpost
      // registers itself on its first heartbeat.
      const reachable: string[] = []
      const unreachable: string[] = []
      for (const id of candidates) {
        if (await app.conduit.resolve(`outpost:${id}`)) reachable.push(id)
        else unreachable.push(fleet.get(id) as string)
      }

      if (!reachable.length)
        throw new BadRequest(
          `No outpost is registered for ${unreachable.join(', ')} — nothing was run. ` +
          'An outpost registers itself on its first heartbeat.'
        )

      const script = recipe.script as string
      const runs   = []

      for (const id of reachable) {
        // The script AS RUN. The recipe is editable and the run is evidence.
        const run = await db().recipeRun.create({
          data: { recipeId: recipe.id, serverId: id, script, requestedBy: actor(), status: 'pending' },
        })
        await app.jobs.dispatch(recipeRun,
          { runId: run.id, workspaceId: ws() },
          { queue: 'fleet', priority: 5 })
        runs.push({ ...run, serverName: fleet.get(id) ?? null })
      }

      // The whole row plus what was queued: a client assigning this over the
      // record it renders keeps every field. The fourth time that pattern bit
      // (setVariable, the deploy job's projection, servers.heartbeat,
      // jobs.trigger) it stopped being a coincidence.
      return { ...recipe, runs, queued: runs.length, unreachable }
    },

    // ── runs — POST /recipes/:id  X-Service-Method: runs ──────────────
    async runs(ctx: ServiceContext) {
      $.dispatch = false   // read-shaped
      const recipe = await getScoped('recipe', 'Recipe')
      const { limit } = getPagination({ limit: RUN_PAGE, max: 200 })
      // Named keys, not `{ total, data }`: only `find` is built into a list
      // envelope, and that envelope holds total/limit/offset/data/errors and
      // refuses anything else. A single travels whole, so naming the keys is
      // what lets this answer two things at once.
      return { recipeId: recipe.id, runs: await runsFor(recipe.id as string, limit) }
    },

    hooks: {
      before: {
        all:    [sessionScope(app)],
        // Authorship is the privileged act — the script is the payload, and
        // editing one edits what runs on every machine it is pointed at.
        create: [requireWorkspaceRole(app, 'admin', 'owner'), stampRecipe],
        patch:  [requireWorkspaceRole(app, 'admin', 'owner')],
        remove: [requireWorkspaceRole(app, 'admin', 'owner')],
        // Running is the ordinary act, and the separation is the point: a
        // developer runs a script an admin vetted, and the run says who.
        run:    [requireWorkspaceRole(app, 'developer', 'admin', 'owner')],
      },
    },
  })
}

/**
 * before/create: stamp what the client does not send.
 *
 * Must be a hook rather than the first lines of create(): `model:` brings
 * autoValidate(model, 'create'), which checks $.data against the schema's
 * required fields, and Junction runs user hooks BEFORE the derived ones exactly
 * so a hook can shape $.data first.
 */
function stampRecipe(): void {
  const data = $.data as Record<string, unknown>
  if (!data) return
  data.createdBy   = actor()
  if (typeof data.name === 'string' && !data.slug) data.slug = slugify(data.name)
}
