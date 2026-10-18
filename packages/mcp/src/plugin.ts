/*
 * plugin.ts — the agent surface, mounted inside the API that is already running.
 *
 * ── Why a plugin and not a process ───────────────────────────────────────────
 *
 * stdio carries no request, so an MCP server spoken to over stdin has to boot
 * the app itself — and a boot here is not a read-only act. Every plugin's
 * `boot()` runs: Caravan starts a SECOND worker on `jobs.db` and begins claiming
 * the shop's payroll and dunning jobs, the migration differ runs against the
 * database, and any plugin that fails takes the agent surface down with it.
 * Two processes also means two event buses, so a write an agent makes announces
 * to nobody the open browser tabs are listening to, and a session revoked
 * mid-episode closes a socket that this process does not have.
 *
 * Mounted here, none of that is true: one boot, one worker, one bus, the real
 * `Host` header, and the standing re-read per request. It is `FJS-D258`'s
 * one-execution-path argument taken one process further.
 *
 * ── The two traps this file is arranged around ───────────────────────────────
 *
 *   1. The SSE keep-alive outlives the socket. The SDK's default interval is
 *      15s and Bun's idle timeout — junction's `http.idleTimeout` default — is
 *      10s, so the stream is cut five seconds before the frame that would have
 *      held it open. Measured: dead at 12s, alive past 13s with the interval
 *      under the timeout.
 *   2. The standing is the APP's, not this file's. `sessionGateLevel` is the
 *      fallback grader and an app that declares `GatePlugin({ getLevel })` has
 *      its own — measured a whole rung apart on basecamp. `principalGateLevel`
 *      asks the Data boundary, which is the only answer that matches what will
 *      actually refuse the call.
 *
 * Nothing here is a boundary (Invariant 6). Every tool this offers is graded
 * again by Litestone when it runs, so a tool wrongly shown costs a turn and a
 * 403 — never an escalation.
 */

import { CLIENT_CAPABILITIES_META_KEY, McpServer, WebStandardStreamableHTTPServerTransport, fromJsonSchema } from '@modelcontextprotocol/server'
import { RESOURCE_MIME_TYPE, getUiCapability, registerAppResource, registerAppTool } from '@modelcontextprotocol/ext-apps/server'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, isAbsolute, join } from 'node:path'
import { BadRequest, CALL_OPTIONS_AT, LEVELS, errorBody, principalGateLevel, scopeRefusal, toDataPrincipal, withholdProtected } from '@frontierjs/junction'
import type { App, Plugin } from '@frontierjs/junction'
import { AWAIT_META, JOBS_META, awaitJobs, describeOutcome, type JobsReader } from './await.ts'
import { BREADCRUMBS_META, answersOneRow, breadcrumbsFor, describeBreadcrumbs } from './breadcrumbs.ts'

import { projectTools, schemaViews, CRUD } from './projection.ts'
import type { Projection, SchemaViews, ServiceShape, Tool } from './projection.ts'

export interface McpOptions {
  /** Where the endpoint mounts, under the app's own api prefix. */
  path?: string
  /** What the server calls itself to a client. Defaults to the app's name. */
  name?: string
  version?: string
  /**
   * How often the open SSE stream sends a keep-alive frame.
   *
   * Must be UNDER the app's `http.idleTimeout`, which defaults to Bun's 10
   * seconds. The SDK's own default is 15s, which is above it — a stream that
   * dies before its first keep-alive, every time.
   */
  keepAliveMs?: number
  /**
   * The longest a `_meta: { 'frontierjs/await': true }` call is held for its
   * jobs (`FJS-D406`). Past it the call answers with where each job had got to.
   */
  awaitMs?: number
  /**
   * Guard: whether this caller is offered `tool` — `true` offers it and
   * anything else withholds it (`FJS-D407`).
   *
   * For an axis a standing is not: an API key's scopes, a plan's features.
   * The projection grades a LEVEL and a key's declared scopes (`FJS-D916`); a
   * rule an app holds in its own hook is invisible to both, so this is where
   * it withholds what that rule would refuse. It can only REMOVE — a tool it withholds is not registered and
   * cannot be called here, a tool it allows was already graded — so a wrong
   * answer costs an affordance and never a grant. A throw fails the list,
   * since a list after a broken guard is wrong in an unknown direction.
   *
   * A rule that IS a level belongs in `@@gate` or `methods: [{ method, gate }]`,
   * where the boundary enforces it too; restating one here is a second origin.
   */
  narrow?: (tool: Tool, principal: unknown) => boolean | Promise<boolean>
  /**
   * The MCP App views this surface offers a host that renders them (`FJS-D955`).
   *
   * `root` is the directory `fli mcp:build` wrote — one `<Model>.html` per
   * resource file, absolute, read once at boot. Absent, every tool is text-only.
   * A model with no file is offered no view and nothing is said, since text is
   * not wrong; a `root` that is relative or not a directory REFUSES the boot,
   * because the mistake that hides is the whole surface gone in production
   * with every tool still answering.
   */
  ui?: { root: string }
}

const DEFAULT_KEEP_ALIVE_MS = 5_000
const DEFAULT_AWAIT_MS      = 10 * 60_000
const AWAIT_POLL_MS         = 500

export function mcp(opts: McpOptions = {}): Plugin {
  const path = opts.path ?? '/mcp'

  let views:     SchemaViews | null     = null
  let shapes:    ServiceShape[]         = []
  let trail:     string | null          = null
  let documents: Map<string, string> | null = null

  return {
    name: 'mcp',

    register(app: App) {
      const handler = async (ctx: RouteCtx<typeof app>) => {
        if (!views) return ctx.json({ error: 'The MCP surface is not ready yet.' }, 503)
        return answer(app, ctx, views, shapes, opts, trail, documents)
      }

      // No `app.all`, so the verbs are listed. DELETE is the client ending a
      // session; in stateless mode the transport answers it without state to
      // drop, and refusing it would read to a client as a broken server.
      app.post(path, handler)
      app.get(path, handler)
      app.delete(path, handler)

      app.get(`${path}/levels`, async (ctx: RouteCtx<typeof app>) => {
        if (!views) return ctx.json({ error: 'The MCP surface is not ready yet.' }, 503)
        return levels(app, ctx, views, shapes)
      })

      app.get(`${path}/calls`, async (ctx: RouteCtx<typeof app>) => calls(app, ctx, trail))
    },

    // Services register during `autoload-services`, which is above `boot-plugins`
    // — so a projection built in `register()` would be built over an empty
    // registry and answer an empty tool list with nothing failing.
    async boot(app: App) {
      views     = await buildViews(app)
      shapes    = describeAll(app)
      trail     = trailOf((app as { db?: unknown }).db, (await import('@frontierjs/litestone/ddl')).modelToAccessor)
      documents = opts.ui ? readDocuments(opts.ui.root) : null
      if (views) disclose(app, projectTools(shapes, views, 8), documents)
    },
  }
}

// ─── what the projection reads ────────────────────────────────────────────────

type RouteCtx<A extends App> = Parameters<Parameters<A['get']>[1]>[0]

/**
 * The three schema views, generated here rather than through `appJsonSchema`.
 *
 * `appJsonSchema` passes `{ mode }` and nothing else, so it cannot ask for the
 * audience or for inlined enums — and the audience is the one option on this
 * path that must never be got wrong. `schemaViews` owns both.
 */
async function buildViews(app: App): Promise<SchemaViews | null> {
  const schema = parsedSchema(app)
  if (!schema) return null

  const { generateJsonSchema } = await import('@frontierjs/litestone')
  return schemaViews(schema, generateJsonSchema as never)
}

/**
 * The parsed schema, from whichever of the two shapes this app has.
 *
 * **`app.db` is absent under `tenancy { strategy database }`** — one
 * `ctx.locals.db` cannot be many databases, so an app with a tenant registry has
 * no app-wide client at all, and `example` is exactly that shape. Reading only
 * `app.db` answered null there, which this plugin serves as a permanent 503:
 * the flagship app in this repo, and the surface would have been dead on it.
 *
 * `registry.schema` is the declared answer — the parsed schema for a reader that
 * needs declarations and no rows — and it is the right one rather than a
 * fallback: opening a tenant to read `@@gate` off a client would make listing
 * tools CREATE a database file.
 */
function parsedSchema(app: App): unknown {
  const registry = (app as { tenants?: { schema?: unknown } }).tenants
  if (registry?.schema) return registry.schema

  const db = (app as { db?: unknown }).db
  // `in` rather than a property read: a Litestone client THROWS on an unknown
  // property, so the probe is itself a throwing expression (`FJS-673`).
  if (!db || typeof db !== 'object' || !('$schema' in db)) return null
  return (db as { $schema?: unknown }).$schema ?? null
}

function describeAll(app: App): ServiceShape[] {
  const out: ServiceShape[] = []
  for (const name of app.services.list()) {
    const svc = app.services.get(name)
    if (!svc || typeof svc.describe !== 'function') continue
    const d = svc.describe()
    out.push({
      name:        d.name,
      model:       d.model,
      methods:     d.methods,
      inputs:      d.inputs,
      methodGates: d.methodGates,
    })
  }
  return out
}

// ─── one request ──────────────────────────────────────────────────────────────

async function answer(
  app:    App,
  ctx:    RouteCtx<App>,
  views:  SchemaViews,
  shapes: ServiceShape[],
  opts:   McpOptions,
  trail:  string | null,
  documents: Map<string, string> | null,
): Promise<Response> {
  const user  = ctx.user ?? null
  const level = await standingOf(app, user)
  // Read HERE, in the route, where the request scope is certainly the one the
  // tool call's service calls run in — it is what Caravan stamped on every job
  // they dispatched, and what `--await` looks the jobs up by (`FJS-D406`).
  const correlationId = (app as { correlationId?: () => string | null }).correlationId?.() ?? null
  const { awaiting, renders } = readRequest(ctx)

  // A key's scopes withhold what the call would refuse, from junction's own
  // reading of them (`FJS-D916`); `narrow` is for a rule the app holds beyond it.
  const scoped = dispatchable(projectTools(shapes, views, level)).tools
    .filter(t => scopeRefusal(app.services.get(t.service) ?? {}, t.method, user as { scopes?: string[] } | null) === null)
  const tools  = opts.narrow ? await narrowTo(scoped, user, opts.narrow) : scoped

  const name   = opts.name ?? app.config.name
  const server = new McpServer({ name, version: opts.version ?? '0.0.0' })

  // One answer to *which models have a view here*, read by the resource list
  // and by the tool stamp alike, so a pointer never names a view the same
  // caller is not offered.
  const viewed = documents && renders ? viewedModels(tools, documents) : new Set<string>()
  const call   = { correlationId, awaitMs: opts.awaitMs ?? DEFAULT_AWAIT_MS, offered: tools, defs: views.full, trail, renders }
  for (const tool of tools) {
    const view = answersOneRow(tool) && viewed.has(tool.model as string) ? viewUri(name, tool.model as string) : null
    register(server, app, tool, user, call, view)
  }
  if (documents) offerViews(server, name, viewed, documents)

  const transport = new WebStandardStreamableHTTPServerTransport({
    // Stateless: the standing is re-read on every request, so there is nothing
    // worth keeping between two of them. A session here would be a second
    // lifetime beside the app's own, outliving a sign-out.
    sessionIdGenerator: undefined,
    // An awaited call is held open for as long as its jobs run, which is past
    // Bun's idle timeout — so it is answered as a stream, whose keep-alive
    // frames and progress notifications keep the socket alive. Every other
    // call is one JSON answer, as before.
    enableJsonResponse: !awaiting,
    keepAliveMs:        opts.keepAliveMs ?? DEFAULT_KEEP_ALIVE_MS,
  })
  await server.connect(transport)

  return transport.handleRequest((ctx.$raw as { $req: Request }).$req)
}

/**
 * What an agent at each level is offered, and what it is not, with the rule
 * that decided each — `GET {path}/levels`, for an operator's *who can do what*.
 *
 * The same `projectTools` and `dispatchable` the endpoint serves from, over the
 * same `describe()` shapes, so a level's `tools` is the list `tools/list` would
 * answer an agent standing there. Only the app's own services can say what a
 * custom method is and what gate it declared — which is why this is asked of
 * the running app and not worked out from the schema file.
 *
 * `narrow` is not applied: it grades a principal's key or plan, not a level,
 * and an operator asking *what does a USER see* is asking about the level.
 *
 * ADMINISTRATOR and above, since it lays out every rule at every rung and a
 * lower standing has its own list from the endpoint itself. Not a boundary
 * (Invariant 6): it reads declarations, never a row.
 */
async function levels(app: App, ctx: RouteCtx<App>, views: SchemaViews, shapes: ServiceShape[]): Promise<Response> {
  const standing = await standingOf(app, ctx.user ?? null)
  if (standing < LEVELS.ADMINISTRATOR) {
    return ctx.json({ error: 'Only an administrator can see what every level is offered.' }, 403)
  }

  const out: Projection[] = []
  for (let level = LEVELS.STRANGER; level <= LEVELS.SYSTEM; level++) {
    const p = projectTools(shapes, views, level)
    out.push({ ...p, tools: dispatchable(p).tools })
  }
  return ctx.json({ standing, levels: out })
}

/**
 * What agents did here, newest first — `GET {path}/calls?limit=`, for an
 * operator's *history*. The `mcp.call` entries `recordCall` wrote, read back
 * from the same trail database.
 *
 * ADMINISTRATOR and above, as `/levels` is: it names who called what on which
 * row, across every caller. An app with no trail database records nothing,
 * and says so rather than answering an empty list that reads as *no agent has
 * been here*.
 */
async function calls(app: App, ctx: RouteCtx<App>, trail: string | null): Promise<Response> {
  const standing = await standingOf(app, ctx.user ?? null)
  if (standing < LEVELS.ADMINISTRATOR) {
    return ctx.json({ error: 'Only an administrator can see what every agent did.' }, 403)
  }
  const limit = Math.min(Math.max(Number(ctx.query.limit) || 100, 1), 500)
  if (!trail) return ctx.json({ recorded: false, calls: [] })
  const rows = await app.withDb(async (db: unknown) => {
    const sys = (db as { asSystem(): Record<string, { findMany(a: unknown): Promise<TrailRow[]> }> }).asSystem()
    return sys[trail]!.findMany({ where: { operation: CALL_OPERATION }, orderBy: { createdAt: 'desc' }, limit })
  })
  return ctx.json({ recorded: true, calls: rows.map(callOf) })
}

/** The tools `narrow` allows, in their order. Only removes. */
async function narrowTo(tools: Tool[], user: unknown, narrow: NonNullable<McpOptions['narrow']>): Promise<Tool[]> {
  const keep = await Promise.all(tools.map(t => narrow(t, user)))
  return tools.filter((_, i) => keep[i] === true)
}

/**
 * What this app grades this caller at.
 *
 * `principalGateLevel` rather than `sessionGateLevel`: an app maps its own
 * standing onto the ladder in `GatePlugin({ getLevel })` and THAT is the mapping
 * every read and write is graded with. Measured on basecamp, a workspace admin
 * is 5 to the schema and 3 to the fallback — a whole rung of tools, offered or
 * withheld wrongly. The principal is passed as an argument rather than read off
 * a scoped client, which is what lets this be asked from a plain route.
 *
 * Under `tenancy { strategy database }` there is no app-wide client to ask, and
 * this falls back to `sessionGateLevel`. That is the right answer for every app
 * that declares no `getLevel` — which is when `$levelOf` is absent and the ask
 * would answer null anyway — and the WRONG one for an app that is both
 * tenant-per-database and declares its own mapping. Named in `PROJECT_STATE.md`
 * rather than papered over: opening a tenant client here to grade a tool LIST
 * would make listing tools create a database file.
 *
 * **The principal is the one the app's resolver answers, not the session.**
 * Under `strategy row` with `createApp({ principal })` the standing is a claim
 * the resolver adds per call — basecamp's `memberRole` — and the session carries
 * none, so every member graded as the same bare sign-in and an owner, an admin
 * and a viewer were offered one identical list. `withDb` runs that resolver.
 */
async function standingOf(app: App, user: unknown): Promise<number> {
  const db = (app as { db?: unknown }).db
  if (!db) return principalGateLevel(db, undefined, toDataPrincipal(user as never), user)
  return app.withDb((scoped, resolved) =>
    principalGateLevel(scoped, undefined, toDataPrincipal((resolved ?? user) as never), resolved ?? user))
}

/**
 * Drop any tool no `ServiceCaller` signature can carry, and name it.
 *
 * `CALL_OPTIONS_AT` is where `CallOptions` sits per method, and a method missing
 * from it is one this Junction has no signature for — `upsert` is the live case.
 * Refused rather than guessed, for `@frontierjs/testing`'s reason: an options
 * object landing one argument early is read as data or as a query and the call
 * runs as STRANGER, which answers an empty result that reads as a correct one.
 */
function dispatchable(p: Projection): { tools: Tool[]; undispatchable: string[] } {
  const ok:  Tool[]   = []
  const bad: string[] = []
  for (const tool of p.tools) {
    if (CRUD.has(tool.method) && CALL_OPTIONS_AT[tool.method] === undefined) bad.push(tool.name)
    else ok.push(tool)
  }
  return { tools: ok, undispatchable: bad }
}

// ─── the views ────────────────────────────────────────────────────────────────

/** The `ui://` URI a host fetches `model`'s view by — one spelling, used by the resource and the tools that point at it. */
export function viewUri(server: string, model: string): string {
  return `ui://${server}/${model}`
}

/**
 * The documents `fli mcp:build` wrote under `root`, by model name.
 *
 * Read whole at boot: the image carries the API and its views from one commit,
 * so a file cannot change under a running server and a read per request would
 * buy nothing. Refused, not defaulted, when `root` is relative (a path resolved
 * from the process's cwd is the derived layout Invariant 3 forbids) or not a
 * directory (`FJS-D955`).
 */
function readDocuments(root: string): Map<string, string> {
  if (!isAbsolute(root)) {
    throw new Error(`mcp: ui.root must be absolute, got '${root}'. fli mcp:build supplies the app's own.`)
  }
  let isDir = false
  try { isDir = statSync(root).isDirectory() } catch { /* answered below */ }
  if (!isDir) {
    throw new Error(`mcp: ui.root '${root}' is not a directory. Run fli mcp:build, or drop the ui option for text-only tools.`)
  }
  const out = new Map<string, string>()
  for (const file of readdirSync(root)) {
    if (!file.endsWith('.html')) continue
    out.set(basename(file, '.html'), readFileSync(join(root, file), 'utf8'))
  }
  return out
}

/**
 * The models this caller is shown a view for: each it holds a one-row tool
 * for AND a document exists for — the projection's answer, read once, after
 * `narrow` and the key's scopes. A model whose every one-row tool is withheld
 * is not in the set, so a standing that cannot call the tool cannot load its
 * screen, and no tool of its points at one.
 */
function viewedModels(tools: Tool[], documents: Map<string, string>): Set<string> {
  return new Set(tools.filter(t => answersOneRow(t) && documents.has(t.model as string)).map(t => t.model as string))
}

/**
 * Register one `ui://` resource per viewed model.
 *
 * `connectDomains` is empty: the view makes no HTTP of its own, every call is
 * the host's `tools/call`. A caller offered no view is answered as a server
 * with no resources — `initialize` declares none and `resources/list` is
 * *method not found* — because the SDK installs the `resources/*` handlers
 * with the first registration and nowhere else; declaring the capability
 * without the handler would tell a host to call what then fails.
 */
function offerViews(server: McpServer, name: string, viewed: Set<string>, documents: Map<string, string>): void {
  for (const model of viewed) {
    const html = documents.get(model) as string
    const uri  = viewUri(name, model)
    registerAppResource(
      server, model, uri,
      { description: `One ${model}, as its form.`, _meta: { ui: { csp: { connectDomains: [] } } } },
      async () => ({ contents: [{ uri, mimeType: RESOURCE_MIME_TYPE, text: html }] }),
    )
  }
}

// ─── one tool ─────────────────────────────────────────────────────────────────

interface CallScope {
  correlationId: string | null
  awaitMs:       number
  /** This caller's tool list, which every breadcrumb must name a tool from. */
  offered:       Tool[]
  defs:          SchemaViews['full']
  /** The log model tool calls are recorded in, or null for none. */
  trail:         string | null
  /** Whether the host behind this request renders an MCP App view, as `readRequest` read it. */
  renders:       boolean
}

/**
 * What the request's own `_meta` says: whether a `tools/call` asks to be held
 * until its jobs finish, and whether the host renders an MCP App view.
 *
 * The one read of the body, and the capability is read HERE rather than at
 * `oninitialized` (the ext-apps helper's example): a `McpServer` here lives
 * for one HTTP request, so the instance answering `tools/list` never saw
 * `initialize`. The SDK's 2026-07-28 era carries the client's capabilities on
 * every request for that reason; a 2025-era client carries them nowhere a
 * stateless server can read. That silence is UNKNOWN, and unknown is
 * permissive as `x-gate` is in the browser (Invariant 6) — a view is an
 * affordance a host that does not speak the extension ignores, and reading
 * silence as a refusal would make the surface text-only for every host on the
 * older era. A host that declares its capabilities and names no view, or no
 * mime type this server emits, is read as asked.
 */
function readRequest(ctx: RouteCtx<App>): { awaiting: boolean; renders: boolean } {
  try {
    const body = JSON.parse(ctx.rawBody ?? '') as { method?: string; params?: { _meta?: Record<string, unknown> } }
    const meta = body.params?._meta
    const declared = meta?.[CLIENT_CAPABILITIES_META_KEY] as Parameters<typeof getUiCapability>[0] | undefined
    const ui = declared === undefined ? undefined : getUiCapability(declared)
    return {
      awaiting: body.method === 'tools/call' && meta?.[AWAIT_META] === true,
      renders:  declared === undefined || (ui !== undefined && (ui.mimeTypes?.includes(RESOURCE_MIME_TYPE) ?? true)),
    }
  } catch { return { awaiting: false, renders: true } }
}

/**
 * Register one tool; `view` is the `ui://` URI its answer is shown in, or null
 * for a text-only answer. A viewed tool goes through the extension's wrapper,
 * which mirrors the pointer into the key older hosts read, and `visibility`
 * stays the default: the verbs a view calls back (`patch`) are the model's,
 * offered to the agent as well.
 */
function register(server: McpServer, app: App, tool: Tool, user: unknown, call: CallScope, view: string | null): void {
  const config = {
    description: describeTool(tool),
    // `fromJsonSchema` installs its own default validator when none is passed,
    // so the SDK grades the argument BEFORE this handler runs. That is a
    // second engine over one schema and the two do not agree: `total: "2500"`
    // is refused here and COERCED by the Data boundary, measured. It fails in
    // the safe direction — the surface refuses what the app would have taken,
    // which costs a turn and admits nothing — and the message names the field,
    // so an agent corrects and retries. Passing a pass-through validator is
    // the one-owner answer and is an open question, not an oversight.
    ...(tool.input.schema ? { inputSchema: fromJsonSchema(tool.input.schema as never) } : {}),
  }
  const handler = async (args: unknown, ctx: HandlerCtx) => run(app, tool, args, user, call, ctx)
  if (view === null) server.registerTool(tool.name, config, handler)
  else registerAppTool(server, tool.name, { ...config, _meta: { ui: { resourceUri: view } } }, handler as never)
}

function describeTool(tool: Tool): string {
  const subject = tool.model ?? tool.service
  const what =
    tool.kind === 'transition'   ? `Runs the '${tool.method}' transition on one ${subject}.` :
    tool.kind === 'custom' ? `Calls '${tool.method}' on the ${tool.service} service.` :
    `${VERB[tool.method] ?? tool.method} ${subject}.`

  // What it takes, in one clause, because a tool with no argument schema is
  // otherwise indistinguishable from one that takes nothing.
  const takes = tool.input.schema
    ? ''
    : ' The seed does not describe this method\'s argument.'

  return `${what}${takes}`
}

const VERB: Record<string, string> = {
  find:      'Lists',
  get:       'Reads one',
  create:    'Creates one',
  update:    'Replaces one',
  patch:     'Changes fields on one',
  remove:    'Deletes one',
  restore:   'Restores one deleted',
  aggregate: 'Aggregates over',
}

/**
 * Dispatch one tool call.
 *
 * Through `app.service(name)` and never through `bridge.toContext()`, which is
 * HTTP-shaped: one execution path, or the hook pipeline and the boundary run
 * twice in two arrangements. `{ auth: { user } }` goes at `CALL_OPTIONS_AT`'s
 * index for the method — absent, the call INHERITS whatever principal is in
 * scope, which in a plugin route is the app's own.
 */
async function run(app: App, tool: Tool, args: unknown, user: unknown, call: CallScope, ctx?: HandlerCtx): Promise<CallResult> {
  const caller = app.service(tool.service) as Record<string, (...a: unknown[]) => Promise<unknown>>
  const a      = (args ?? {}) as Record<string, unknown>
  // `'mcp'`, never the `'internal'` an in-process caller defaults to: an agent
  // is outside, and an *is this call from inside* check must say so (`FJS-D609`).
  const opts   = { auth: { user }, transport: 'mcp' } as Record<string, unknown>
  const since  = Date.now()
  const base   = ctx?.mcpReq?._meta?.[BASE_META]

  try {
    if (base !== undefined) {
      if (!isRecord(base)) throw new BadRequest(`_meta['${BASE_META}'] is the row the writer read, and this is ${Array.isArray(base) ? 'a list' : base === null ? 'null' : typeof base}`)
      opts.base = base
    }
    // `app.service()` is the in-process caller and answers the app whole; an
    // agent is on a wire, so what it is handed is what HTTP would hand it
    // (`FJS-D473`) -- a system write's `@secret` included. Under `strategy
    // database` there is no `app.db`, and with no client the protected list is
    // empty and the row went out whole (`FJS-1835`); `withDb` is the tenant
    // client the call itself just opened, so no database file is created.
    const raw    = await invoke(caller, tool, a, opts)
    const appDb  = (app as { db?: unknown }).db
    const withhold = (db: unknown) => withholdProtected(raw, {
      locals: { db } as never, model: tool.model ?? undefined, service: tool.service,
    })
    const result = appDb ? withhold(appDb) : await app.withDb(withhold)
    await recordCall(app, call.trail, tool, a, user, { outcome: 'done', result })
    const answer: CallResult = { content: [{ type: 'text', text: JSON.stringify(result ?? null) }] }
    // `result` is already the wire shape -- `app.service()` unwrapped it as the
    // socket's `service_result` is unwrapped, a list keeping its envelope and a
    // single being the row -- so a view's relayed call resolves what `forward()`
    // would have, and the client's own `find()`/`get()` read it unchanged.
    // Rebuilding the envelope here would be a second wrap of one answer and
    // would hand `get()` a `{ kind, data }` it never unwraps. The field is an
    // object by the protocol, so a scalar or array answer rides in the text
    // alone; the text stays beside the object for a host that reads only text.
    if (isRecord(result)) answer.structuredContent = result
    if (answersOneRow(tool)) {
      // Read off the row the CALLER was answered, so a foreign key their read
      // withheld names nothing (`FJS-D398`).
      const crumbs = breadcrumbsFor(tool, result, a, call.offered, call.defs as never)
      if (crumbs.length) answer.content.push({ type: 'text', text: describeBreadcrumbs(crumbs) })
      answer._meta = { [BREADCRUMBS_META]: crumbs }
    }
    if (ctx?.mcpReq?._meta?.[AWAIT_META] !== true) return answer
    return await held(app, call, since, ctx, answer)
  } catch (err) {
    const body = await refusalBody(app, tool, err)
    const code = body.code ?? 500
    await recordCall(app, call.trail, tool, a, user, {
      outcome: code === 401 || code === 403 ? 'refused' : code < 500 ? 'rejected' : 'failed',
      code, ...(code < 500 ? { message: body.message } : {}),
    })
    // The text is for an agent and the object for a view: the view rebuilds
    // `code` and `data` from it as the client does from an HTTP body, and a
    // validation refusal with no `data` lands nothing under its field.
    return { content: [{ type: 'text', text: body.message }], structuredContent: body, isError: true }
  }
}

/**
 * The refusal body every other wire sends — `errorBody()`, the call's
 * protected values redacted out of `data`, and a 5xx message replaced and
 * logged with the correlation id it is replaced by. A 5xx message can carry a
 * table name or a file path, so it is never re-emitted here on its own.
 *
 * Redaction needs the call's client. When there is none to be had — the
 * tenant would not resolve, which may be the very refusal — `data` goes as
 * null, since a unique violation's `data` can carry the value it collided on.
 */
async function refusalBody(app: App, tool: Tool, err: unknown): Promise<ReturnType<typeof errorBody>> {
  const ctx   = (db: unknown) => ({ app, locals: { db }, model: tool.model ?? undefined, service: tool.service }) as never
  const appDb = (app as { db?: unknown }).db
  if (appDb) return errorBody(err, ctx(appDb))
  try {
    return await app.withDb((db: unknown) => errorBody(err, ctx(db)))
  } catch {
    return { ...errorBody(err, ctx(null)), data: null }
  }
}

// ─── the trail ────────────────────────────────────────────────────────────────

/** The one `operation` every tool call is filed under. */
const CALL_OPERATION = 'mcp.call'

type Outcome = 'done' | 'refused' | 'rejected' | 'failed'

interface TrailRow {
  records?:   string[] | null
  actorId?:   string | null
  meta?:      Record<string, unknown> | null
  createdAt?: string
}

/**
 * The log model of the app's first trail database — the one `$audit` writes
 * to when no `database` is named — or null when it declares none. A logger
 * database's model is always `<name>Trail`; a SQL one names its own, and the
 * accessor is that model's.
 *
 * Asked of the app-wide client at boot: a scoped client answers `$databases`
 * by throwing. Under `tenancy { strategy database }` there is none, so calls
 * there go unrecorded and `/calls` says so.
 */
function trailOf(db: unknown, accessorOf: (model: string) => string): string | null {
  let dbs: Record<string, { driver?: string, trailModel?: string }> = {}
  // A Litestone client THROWS on an unknown property (`FJS-673`).
  try { dbs = (db as { $databases?: typeof dbs }).$databases ?? {} } catch { return null }
  const found = Object.entries(dbs).find(([, d]) => d?.driver === 'trail' || d?.trailModel)
  if (!found) return null
  const [name, d] = found
  return d.trailModel ? accessorOf(d.trailModel) : `${name}Trail`
}

/**
 * Put one tool call in the app's audit trail: who, which tool, how it ended,
 * and which rows it named. `@@trail` records a write and cannot say it came from
 * an agent, nor see a call that was refused — and the refused call is the one
 * an operator most needs to find.
 *
 * Field NAMES only, never values: an argument can carry anything, and `meta`
 * is written as given with nothing redacting it. Never throws — the call has
 * already been answered, and a trail that cannot be written must not turn a
 * done call into a failed one. It warns instead.
 */
async function recordCall(
  app:   App,
  trail: string | null,
  tool:  Tool,
  a:     Record<string, unknown>,
  user:  unknown,
  how:   { outcome: Outcome; result?: unknown; code?: number; message?: string },
): Promise<void> {
  if (!trail) return
  const data    = tool.method === 'create' ? a : (a.data && typeof a.data === 'object' ? a.data as Record<string, unknown> : {})
  const fields  = Object.keys(data)
  const row     = how.result && typeof how.result === 'object' && !Array.isArray(how.result) ? how.result as { id?: unknown } : null
  const id      = a.id ?? (tool.method === 'create' ? row?.id : undefined)
  const actor   = toDataPrincipal(user as never) as { id?: unknown } | null
  const key     = (user as { credentialId?: string } | null)?.credentialId
  // A find answers its page in an envelope, `{ data, total }`.
  const list    = Array.isArray(how.result) ? how.result
    : Array.isArray((row as { data?: unknown } | null)?.data) ? (row as { data: unknown[] }).data : null
  try {
    await app.withDb(async (db: unknown) => {
      await (db as { $audit(e: Record<string, unknown>): Promise<unknown> }).$audit({
        operation: CALL_OPERATION,
        model:     tool.model ?? tool.service,
        records:   id == null ? [] : [String(id)],
        ...(actor?.id != null ? { actorId: String(actor.id), actorType: 'user' } : {}),
        meta: {
          tool: tool.name, kind: tool.kind, method: tool.method, outcome: how.outcome,
          ...(fields.length ? { fields } : {}),
          ...(list ? { count: list.length } : {}),
          ...(how.code ? { code: how.code } : {}),
          ...(how.message ? { message: how.message } : {}),
          ...(key ? { key } : {}),
        },
      })
    })
  } catch (err) {
    const log = (app as { log?: { warn?: (m: string) => void } }).log
    const m   = `mcp: could not record ${tool.name} in the audit trail: ${(err as Error)?.message}`
    log?.warn ? log.warn(m) : console.warn(`[mcp] ${m}`)
  }
}

/** One trail row as `/calls` answers it. */
function callOf(r: TrailRow) {
  return {
    at:      r.createdAt ?? null,
    actorId: r.actorId ?? null,
    records: r.records ?? [],
    ...r.meta,
  }
}

interface CallResult {
  content: Array<{ type: 'text'; text: string }>
  /** The first text block, parsed -- present when the answer is an object. */
  structuredContent?: Record<string, unknown>
  isError?: boolean
  _meta?:   Record<string, unknown>
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * The row a write was made against, for `@@sync(field)`'s per-column merge
 * (`FJS-D334`) -- the call option `base`, which no tool argument spells. Sent
 * by an MCP App view's relay (`@frontierjs/sierra/mcp`, which restates the
 * key), and read for any tool as every transport reads it: untrusted input to
 * a comparison, never authority. A host that drops a request's `_meta` sends
 * the write without it, and a moved `@version` then answers 409.
 */
const BASE_META = 'frontierjs/base'

/** The slice of the SDK's handler context this file reads. */
interface HandlerCtx {
  mcpReq?: {
    _meta?:  Record<string, unknown> & { progressToken?: string | number }
    signal?: AbortSignal
    notify?: (n: { method: string; params: Record<string, unknown> }) => Promise<void>
  }
}

/**
 * The call has answered; now wait on the jobs it started, telling the client
 * as each one moves, and answer with where each ended up. A job that is DEAD is
 * reported, not raised: the method did what it was asked, and the second text
 * block is what an agent reading only text is told.
 */
async function held(app: App, call: CallScope, since: number, ctx: HandlerCtx, answer: CallResult): Promise<CallResult> {
  const jobs = ('jobs' in app ? app.jobs : undefined) as Partial<JobsReader> | undefined
  if (!call.correlationId || typeof jobs?.findByCorrelation !== 'function') {
    answer.content.push({ type: 'text', text: 'Nothing to wait on: this app has no job queue this surface can read.' })
    answer._meta = { ...answer._meta, [JOBS_META]: [] }
    return answer
  }

  const token  = ctx.mcpReq?._meta?.progressToken
  const notify = ctx.mcpReq?.notify
  const outcome = await awaitJobs(jobs as JobsReader, call.correlationId, since, {
    timeoutMs: call.awaitMs, pollMs: AWAIT_POLL_MS, signal: ctx.mcpReq?.signal,
    onProgress: token === undefined || !notify ? undefined : (done, total, list) => {
      const moving = list.find(j => j.status !== 'done' && j.status !== 'dead' && j.status !== 'cancelled')
      void notify({ method: 'notifications/progress', params: {
        progressToken: token, progress: done, total,
        message: moving ? `${moving.name}: ${moving.status}` : 'finished',
      } }).catch(() => {})
    },
  })
  answer.content.push({ type: 'text', text: describeOutcome(outcome) })
  answer._meta = { ...answer._meta, [JOBS_META]: outcome.jobs, 'frontierjs/settled': outcome.settled }
  return answer
}

/**
 * A tool's arguments → the service call. An MCP App view builds these
 * arguments in `@frontierjs/sierra/mcp`'s `toolCall()`, which cannot import
 * this, so a shape changed here moves sierra's `test/mcp-relay.test.js` too.
 */
function invoke(
  caller: Record<string, (...a: unknown[]) => Promise<unknown>>,
  tool:   Tool,
  a:      Record<string, unknown>,
  opts:   Record<string, unknown>,
): Promise<unknown> {
  const m = tool.method

  // Every non-CRUD verb is one signature: `call(name, id, data, opts)`. The
  // projection shapes their inputs to match it, which is why a transition carries an
  // id at all.
  if (!CRUD.has(m)) {
    return caller.call(m, (a.id ?? null) as never, (a.data ?? null) as never, opts)
  }

  if (m === 'find') {
    // Directives are an OPTION and never a filter — Invariant 10. Flattened into
    // the query they are refused by name at the bridge, which is the good case;
    // silently treated as a column is the bad one.
    return caller.find((a.query ?? {}) as never, { ...opts, directives: a.directives })
  }
  if (m === 'get' || m === 'remove' || m === 'restore') return caller[m](a.id as never, opts)
  if (m === 'create')                                   return caller.create(a as never, opts)
  if (m === 'patch' || m === 'update')                  return caller[m](a.id as never, (a.data ?? {}) as never, opts)
  return caller[m](a as never, opts)
}

/**
 * Say once, at boot, what this surface could not grade or could not offer.
 *
 * An open tool list and an ungoverned one are the same list to look at, so the
 * three ways this projection can be quietly wrong are stated to the operator
 * rather than left to be noticed: a service whose `model` named no definition
 * (every rule on those rows read as *nothing declared*), two methods that
 * derived one tool name, and a method no `ServiceCaller` signature can carry.
 *
 * At SYSTEM, because these are facts about the app and not about a caller.
 */
function disclose(app: App, p: Projection, documents: Map<string, string> | null): void {
  const log  = (app as { log?: { warn?: (m: string) => void } }).log
  const warn = (m: string) => (log?.warn ? log.warn(m) : console.warn(`[mcp] ${m}`))

  // Over no model a verb is graded only by a declared level, so what is worth
  // saying is which verbs declare none — not which services have no model,
  // which a fully declared service like a hub is and should be.
  const open = p.tools.filter(t => t.model === null && t.verdict === 'ungraded').map(t => t.name)
  if (open.length) {
    warn(`mcp: ${open.length} tool(s) on services over no model are graded by nothing: ${open.join(', ')}. ` +
         'Declare a level with methods: [{ method, gate }], or a model: if one exists — a service with no ' +
         '`model:` reports its own name, which is camelCase and plural.')
  }
  for (const clash of p.collisions) {
    warn(`mcp: '${clash.name}' is derived by ${clash.methods.join(' and ')}. Both are withheld — rename one.`)
  }
  const bad = dispatchable(p).undispatchable
  if (bad.length) warn(`mcp: no ServiceCaller signature for ${bad.join(', ')} — withheld.`)

  // A view whose model no tool answers is a file nothing will ever point at —
  // a renamed model, or a build older than the schema.
  const answered = new Set(p.tools.filter(answersOneRow).map(t => t.model))
  const stale    = [...documents?.keys() ?? []].filter(m => !answered.has(m))
  if (stale.length) warn(`mcp: ${stale.map(m => `${m}.html`).join(', ')} name(s) no model a one-row tool answers — rebuild with fli mcp:build.`)
}
