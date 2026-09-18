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
 * ── The three traps this file is arranged around ─────────────────────────────
 *
 *   1. The body is GONE by the time a route handler runs. `transport/http.ts`
 *      parses every matched request before dispatch and `body.ts` reads
 *      `req.arrayBuffer()` with no clone, so handing `ctx.$raw.$req` to a
 *      fetch-style handler hands over a Request whose body is spent. The MCP
 *      transport answers `400 Parse error: Invalid JSON`, which says nothing
 *      about what actually happened. Measured, with the rebuild beside it.
 *   2. The SSE keep-alive outlives the socket. The SDK's default interval is
 *      15s and Bun's idle timeout — junction's `http.idleTimeout` default — is
 *      10s, so the stream is cut five seconds before the frame that would have
 *      held it open. Measured: dead at 12s, alive past 13s with the interval
 *      under the timeout.
 *   3. The standing is the APP's, not this file's. `sessionGateLevel` is the
 *      fallback grader and an app that declares `GatePlugin({ getLevel })` has
 *      its own — measured a whole rung apart on basecamp. `principalGateLevel`
 *      asks the Data boundary, which is the only answer that matches what will
 *      actually refuse the call.
 *
 * Nothing here is a boundary (Invariant 6). Every tool this offers is graded
 * again by Litestone when it runs, so a tool wrongly shown costs a turn and a
 * 403 — never an escalation.
 */

import { McpServer, WebStandardStreamableHTTPServerTransport, fromJsonSchema } from '@modelcontextprotocol/server'
import { CALL_OPTIONS_AT, principalGateLevel, toDataPrincipal, toFrameworkError } from '@frontierjs/junction'
import type { App, Plugin } from '@frontierjs/junction'

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
}

const DEFAULT_KEEP_ALIVE_MS = 5_000

export function mcpPlugin(opts: McpOptions = {}): Plugin {
  const path = opts.path ?? '/mcp'

  let views:  SchemaViews | null = null
  let shapes: ServiceShape[]     = []

  return {
    name: 'mcp',

    register(app: App) {
      const handler = async (ctx: RouteCtx<typeof app>) => {
        if (!views) return ctx.json({ error: 'The MCP surface is not ready yet.' }, 503)
        return answer(app, ctx, views, shapes, opts)
      }

      // No `app.all`, so the verbs are listed. DELETE is the client ending a
      // session; in stateless mode the transport answers it without state to
      // drop, and refusing it would read to a client as a broken server.
      app.post(path, handler)
      app.get(path, handler)
      app.delete(path, handler)
    },

    // Services register during `autoload-services`, which is above `boot-plugins`
    // — so a projection built in `register()` would be built over an empty
    // registry and answer an empty tool list with nothing failing.
    async boot(app: App) {
      views  = await buildViews(app)
      shapes = describeAll(app)
      if (views) disclose(app, projectTools(shapes, views, 8))
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
): Promise<Response> {
  const user  = ctx.user ?? null
  const level = standingOf(app, user)

  const tools = dispatchable(projectTools(shapes, views, level)).tools

  const server = new McpServer({
    name:    opts.name ?? 'frontierjs',
    version: opts.version ?? '0.0.0',
  })

  for (const tool of tools) register(server, app, tool, user)

  const transport = new WebStandardStreamableHTTPServerTransport({
    // Stateless: the standing is re-read on every request, so there is nothing
    // worth keeping between two of them. A session here would be a second
    // lifetime beside the app's own, outliving a sign-out.
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    keepAliveMs:        opts.keepAliveMs ?? DEFAULT_KEEP_ALIVE_MS,
  })
  await server.connect(transport)

  return transport.handleRequest(replayBody(ctx))
}

/**
 * The Request, with its body put back.
 *
 * junction reads the body off the wire before any route handler runs, so the
 * original Request is spent and the MCP transport's own read finds nothing.
 * `ctx.rawBody` is the bytes it read — present for every single-string body,
 * which is every MCP request, since the protocol is JSON over POST.
 */
function replayBody(ctx: RouteCtx<App>): Request {
  const req = (ctx.$raw as { $req: Request }).$req
  if (req.method === 'GET' || req.method === 'HEAD') return req

  const raw = ctx.rawBody ?? (ctx.body == null ? '' : JSON.stringify(ctx.body))
  return new Request(req.url, { method: req.method, headers: req.headers, body: raw })
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
 */
function standingOf(app: App, user: unknown): number {
  const db = (app as { db?: unknown }).db
  return principalGateLevel(db, undefined, toDataPrincipal(user as never), user)
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

// ─── one tool ─────────────────────────────────────────────────────────────────

function register(server: McpServer, app: App, tool: Tool, user: unknown): void {
  server.registerTool(
    tool.name,
    {
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
    },
    async (args: unknown) => run(app, tool, args, user),
  )
}

function describeTool(tool: Tool): string {
  const subject = tool.model ?? tool.service
  const what =
    tool.kind === 'move'   ? `Runs the '${tool.method}' transition on one ${subject}.` :
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
async function run(app: App, tool: Tool, args: unknown, user: unknown): Promise<CallResult> {
  const caller = app.service(tool.service) as Record<string, (...a: unknown[]) => Promise<unknown>>
  const a      = (args ?? {}) as Record<string, unknown>
  const opts   = { auth: { user } } as Record<string, unknown>

  try {
    const result = await invoke(caller, tool, a, opts)
    return { content: [{ type: 'text', text: JSON.stringify(result ?? null) }] }
  } catch (err) {
    const fe = toFrameworkError(err)
    // A 4xx is the caller's own mistake and the message is written for them —
    // *which* field, *which* level. A 5xx message is not: it can carry a table
    // name or a file path, and `sanitizeError` only runs on the transport's own
    // error path, never on one re-emitted here.
    const text = (fe.code ?? 500) < 500
      ? fe.message
      : `${tool.name} failed. The API logged the reason.`
    return { content: [{ type: 'text', text }], isError: true }
  }
}

interface CallResult {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

function invoke(
  caller: Record<string, (...a: unknown[]) => Promise<unknown>>,
  tool:   Tool,
  a:      Record<string, unknown>,
  opts:   Record<string, unknown>,
): Promise<unknown> {
  const m = tool.method

  // Every non-CRUD verb is one signature: `call(name, id, data, opts)`. The
  // projection shapes their inputs to match it, which is why a move carries an
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
function disclose(app: App, p: Projection): void {
  const log  = (app as { log?: { warn?: (m: string) => void } }).log
  const warn = (m: string) => (log?.warn ? log.warn(m) : console.warn(`[mcp] ${m}`))

  if (p.unresolved.length) {
    warn(`mcp: ${p.unresolved.length} service(s) name no model in the schema, so nothing grades them: ${p.unresolved.join(', ')}. ` +
         'A service with no `model:` reports its own name, which is camelCase and plural.')
  }
  for (const clash of p.collisions) {
    warn(`mcp: '${clash.name}' is derived by ${clash.methods.join(' and ')}. Both are withheld — rename one.`)
  }
  const bad = dispatchable(p).undispatchable
  if (bad.length) warn(`mcp: no ServiceCaller signature for ${bad.join(', ')} — withheld.`)
}
