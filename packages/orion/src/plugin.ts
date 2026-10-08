/*
 * plugin.ts
 *
 * `orion()` — the Junction plugin that installs orion into an app, in
 * `@frontierjs/auth`'s shape (`FJS-D269`). It wires the engine to what the app
 * already has and owns nothing the app owns:
 *
 *   app.db      the litestone client: orion's models through `asSystem()`, and
 *               the app's models as the flow's owner
 *   app.jobs    Caravan: one job per run, cron, the sweep, and job.dispatch
 *   app.runAs   the owner re-resolved for every run and every service call
 *   $tapEvents  a write to one of the app's models starts its flows
 *   app.ai      the app's own AI models, for the ai node
 *   app.notify  the app's declared notifications, for the notify node
 *   conduit     an instance of orion's own, whose targets are FlowCredential
 *               rows (`FJS-D273`)
 *   routes      POST {prefix}/hooks/{path} and POST {prefix}/wait/{key}
 *   services    flows, runs, flowCredentials (`src/services.ts`)
 *
 * Each instance registers the triggers of the flows active when it boots and,
 * once its work starts, re-reads them on a timer, so an activation made anywhere reaches every
 * instance within `activationPollInterval`.
 *
 * `app.orion` is the runner — `start`, `emit`, `dryRun`, `activate` and the rest.
 * `app.orion.emit(name, payload)` is how the app's own code raises a named event
 * (`FJS-D293`); no service does.
 *
 * Configure it after Caravan: its run job has to be registered before the queue
 * starts, which happens in Caravan's `work`.
 */

import { generateJsonSchema } from "@frontierjs/litestone/jsonschema"
import { createConduit, type ConduitOptions } from "@frontierjs/conduit"
import { redactSecrets } from "@frontierjs/toolbelt/redact"
import { camel } from "@frontierjs/toolbelt/inflect"
import { toDataPrincipal } from "@frontierjs/junction"
import type { App, Plugin, SessionContext, TransportContext } from "@frontierjs/junction"
// `app.ai` is typed by the AI battery augmenting its slot (FJS-D640), so the
// slot is empty unless its subpath is in the program.
import type {} from "@frontierjs/junction/ai"

import { PluginRegistry } from "./engine/plugins"
import type { PluginManifest } from "./engine/plugins"
import { createNodeImplementations } from "./engine/nodes"
import type { INodeImplementation } from "./engine/executor"
import type { IAIModels, IJobDispatcher, INotifier, IServiceCaller } from "./engine/ports"
import { createRunner, FlowNotRunnableError, FlowRateLimitedError, type OrionJobs, type Runner } from "./runner"
import { litestoneModelActions, modelCatalog } from "./models"
import { litestoneKeyValue } from "./kv"
import { conduitOutbound, flowCredentialResolver } from "./outbound"
import { litestoneHost } from "./tenancy"
import { createOrionServices, type OrionServiceNames } from "./services"

// What a HOST needs to type a contribution, re-exported from the one entry
// point it imports. Without them an app writes its manifest as an object
// literal and TypeScript infers `category: string`, which is not the union —
// so the contribution fails to assign at `orion({ plugins })` and the sentence
// is a hundred-line structural mismatch about a field nobody got wrong. They
// are declared in `engine/` and reachable only from there, which the boundary
// test forbids an app from importing.
export type { PluginManifest, NodeTypeDescriptor, NodeCategory } from "./engine/plugins"
// `flows` and `runs` broadcast on a channel of their own name, which a host
// joins its connections to.
export { DEFAULT_SERVICE_NAMES } from "./services"
export type { INodeImplementation, NodeContext, NodeResult } from "./engine/executor"

// ─── options ─────────────────────────────────────────────────────────────────

export interface OrionOptions {
  /** Where the raw routes mount, under the app's own `apiPrefix`. Default: `/orion`. */
  prefix?:     string
  /** The Caravan queue runs go on. Default: `orion`. */
  queue?:      string
  /** Node types the app contributes beside the built-ins. */
  plugins?:    Array<{ manifest: PluginManifest; implementations: INodeImplementation[] }>
  /**
   * Policy for orion's conduit — timeouts, retries, the breaker. Its targets and
   * its credential resolver are orion's and cannot be passed.
   */
  conduit?:    Omit<ConduitOptions, "targets" | "credentials" | "store">
  /**
   * Whether an inbound webhook may start its flow — a provider's signature,
   * checked over `ctx.rawBody`. The route is refused in production without one,
   * because a path is not a credential: whoever learns it could start the flow.
   */
  verifyWebhook?: (ctx: TransportContext, hook: { flowId: string; path: string }) => boolean | Promise<boolean>
  /** How long a sync webhook waits for its flow to answer. Default: 10s (`FJS-D280`). */
  deadlineMs?: number
  /**
   * How often this instance re-reads which flows are active, which is how an
   * activation or a pause made on another instance reaches it (`FJS-1155`).
   * Default: 5s.
   */
  activationPollInterval?: number
  /**
   * The names orion's services register under — `flows`, `runs`,
   * `flowCredentials` — each renameable or `false`, or `false` for none.
   */
  services?: OrionServiceNames | false
}

// What a run acts as in a Junction app: the client its model nodes write
// through, the id a service call re-enters as, and the tenant both are in.
// Valid only inside the `withActor` call that made it — the client is leased.
export interface JunctionActor {
  db:     unknown
  userId: string
  tenant: string | null
  /** The principal `db` is scoped to, claims included — what `$readAs` is asked about. */
  user:   SessionContext
}

// What `@frontierjs/notifications` puts on the app, stated so orion needs no
// import of it — an app without it runs every node but `notify`.
interface NotifyingApp {
  notify?:        (recipient: unknown, notification: unknown) => Promise<void>
  notifications?: ReadonlyMap<string, (payload: unknown) => unknown>
}

// ─── the plugin ──────────────────────────────────────────────────────────────

export function orion(options: OrionOptions = {}): Plugin {
  const prefix = options.prefix ?? "/orion"
  let runner: Runner
  let unwatch: (() => void) | undefined

  return {
    name:     "orion",
    requires: ["caravan"],

    register(app: App) {
      if (!app.jobs) throw new Error("[orion] needs Caravan configured before it: app.configure(createCaravan(…))")
      const tenants = (app as unknown as { tenants?: { schema?: { models: Array<{ name: string }> } } }).tenants
      const db      = app.db as any
      if (!tenants && (!db || typeof db.asSystem !== "function")) {
        throw new Error("[orion] needs a litestone client or a tenant registry: createApp({ db }) or createApp({ tenants })")
      }

      // Where orion's rows are, per tenant (`FJS-D294`).
      const host   = tenants ? litestoneHost({ registry: tenants }) : litestoneHost({ db })
      const schema = (tenants ? tenants.schema : db.$schema) as { models: Array<{ name: string }> }
      const names  = schema.models.map(m => m.name)

      const actorOf  = (actor: unknown) => actor as JunctionActor
      // Inside a run, as its owner in its tenant, so a service, an adapter or a
      // job reached from a node is graded as the flow's owner too.
      const asOwner  = <T>(actor: unknown, fn: () => T | Promise<T>) =>
        app.runAs(actorOf(actor).userId, { tenant: actorOf(actor).tenant }, fn)
      const systemOf = (actor: unknown) => (actorOf(actor).db as { asSystem(): any }).asSystem()

      const services: IServiceCaller = {
        call: (actor, service, method, input) => asOwner(actor, () => callService(app, service, method, input)),
      }

      const ai: IAIModels = {
        complete: (actor, model, req) => asOwner(actor, () => {
          if (!app.ai) throw new Error("This app registered no AI models: createApp({ ai })")
          return app.ai.get(model).complete(req)
        }),
      }

      // Caravan stores who the work is for and resolves them when it runs, so
      // the owner and the tenant are stated rather than read from the scope.
      const jobs: IJobDispatcher = {
        dispatch: (actor, job, data, { id }) =>
          app.jobs!.dispatch(job, data, { id, actor: actorOf(actor).userId, tenant: actorOf(actor).tenant }),
      }

      const notifier: INotifier = {
        notify: (actor, notification, recipient, payload) => asOwner(actor, async () => {
          const notifying = app as unknown as NotifyingApp
          if (typeof notifying.notify !== "function") {
            throw new Error("This app sends no notifications: app.configure(notificationsPlugin(…))")
          }
          const define = notifying.notifications?.get(notification)
          if (!define) throw new Error(`This app declares no notification "${notification}"`)
          await notifying.notify(recipient, define(payload))
        }),
      }

      const outbound = conduitOutbound({
        conduit:       createConduit({ ...options.conduit, credentials: flowCredentialResolver(host) }) as never,
        credentialsOf: (actor) => ({ db: systemOf(actor), tenant: actorOf(actor).tenant }),
      })

      const registry = new PluginRegistry()
      for (const impl of createNodeImplementations({
        kv:       litestoneKeyValue(systemOf),
        models:   litestoneModelActions(names, { clientOf: (actor) => actorOf(actor).db }),
        services,
        outbound,
        ai,
        jobs,
        notifier,
      })) registry.registerImpl(impl)
      for (const plugin of options.plugins ?? []) registry.register(plugin.manifest, plugin.implementations)

      runner = createRunner({
        host,
        jobs:     app.jobs as unknown as OrionJobs,
        registry,
        queue:    options.queue,
        catalog:  {
          models: modelCatalog({
            create: generateJsonSchema(schema as never, { mode: "create" }),
            update: generateJsonSchema(schema as never, { mode: "update" }),
            models: names,
          }),
          // Asked when a flow compiles, which is after boot, so a job file or a
          // notification the loader finds late is still in the list.
          jobs:          { names: () => (app.jobs as unknown as { registrations(): Array<{ name: string }> }).registrations().map(r => r.name) },
          notifications: { names: () => [...((app as unknown as NotifyingApp).notifications?.keys() ?? [])] },
        },
        // The owner re-resolved, in the run's tenant, with the client a service
        // call of theirs would get — the tenant's database, the resolver's claims.
        withActor: (actorId, tenant, fn) => {
          if (actorId === null) return Promise.reject(new Error("the run records no owner"))
          return app.runAs(actorId, { tenant }, (session) => {
            if (!session) throw new Error(`no user "${actorId}"`)
            return app.withDb((client, user) => fn({ db: client, userId: String(actorId), tenant, user: user ?? session } satisfies JunctionActor))
          })
        },
        // The owner's client is what a model node writes through, so it is what the
        // transaction binds; a service call or an outbound one is recorded by the
        // dry-run flag rather than rolled back.
        inTransaction: <T>(actor: unknown, fn: (txActor: unknown) => Promise<T>) => {
          const { db: client, ...rest } = actorOf(actor)
          return (client as { $transaction: (fn: (tx: unknown) => Promise<T>) => Promise<T> }).$transaction((tx) => fn({ ...rest, db: tx }))
        },
        // The owner's own client grades the row, with the claims the app resolves
        // for them; an undecidable policy throws there, and a throw is a refusal.
        readAs: async (actor, model, record) => {
          const { db: client, user } = actorOf(actor)
          try {
            return await (client as { $readAs(a: string, r: unknown, p: unknown): Promise<unknown> }).$readAs(camel(model), record, toDataPrincipal(user))
          } catch { return null }
        },
        onTriggerError:    (err, at) => app.logger.warn(`[orion] flow "${at.flowId}" did not start: ${(err as Error).message}`),
        onActivationError: (flowId, error) => app.logger.warn(`[orion] flow "${flowId}" is active and did not activate: ${error}`),
      })
      runner.register()
      app.claim("orion", runner)

      if (options.services !== false) {
        for (const svc of createOrionServices({ runner, names: options.services })) {
          if (app.services.has(svc.name)) {
            throw new Error(`[orion] service '${svc.name}' is already registered by this app. Rename orion's: orion({ services: { ${svc.name}: '…' } }), or false to leave it out.`)
          }
          app.services.register(svc)
        }
      }

      // A model trigger hears a write in the tenant that made it. Under
      // `strategy database` that is each tenant's client as the app opens it;
      // otherwise the one client, where a row names its own tenant.
      if (tenants) {
        app.onTenantClient((client, tenant) => {
          ;(client as { $tapEvents(fn: (e: any) => void): unknown }).$tapEvents((event) => runner.onWrite(event, { tenant }))
        })
      } else {
        const column = (() => { try { return db.$tenancy?.strategy === "row" ? db.$tenancy.column as string : null } catch { return null } })()
        db.$tapEvents((event: any) => {
          const row    = (event.result ?? event.record ?? null) as Record<string, unknown> | null
          const tenant = column === null ? null : row?.[column] != null ? String(row[column]) : app.tenant()
          runner.onWrite(event, { tenant })
        })
      }

      mountRoutes(app, runner, prefix, options)
    },

    // The first sync is boot(): it registers each active flow's model
    // trigger, an in-process tap on this process's client, so a write a
    // one-shot call makes still starts its flows. Only the re-read is work().
    async boot() {
      await runner.syncActivations()
    },

    async work() {
      unwatch = runner.watch(options.activationPollInterval ?? 5_000)
    },

    async shutdown() {
      unwatch?.()
    },
  }
}

// ─── routes ──────────────────────────────────────────────────────────────────

function mountRoutes(app: App, runner: Runner, prefix: string, options: OrionOptions) {
  const production = process.env.NODE_ENV === "production"

  app.post(`${prefix}/hooks/{path}`, async (ctx: TransportContext) => {
    const hook = runner.webhook(ctx.route.path ?? "")
    if (!hook) return ctx.json({ error: "No active flow answers this webhook" }, 404)
    // A path names one flow across the host. Where the request itself names a
    // tenant — a shop's subdomain — it must be the flow's, or one tenant's host
    // would start another tenant's flow.
    const resolved = tenantOfRequest(app, ctx)
    if (resolved !== undefined && resolved !== hook.tenant) {
      return ctx.json({ error: "No active flow answers this webhook" }, 404)
    }

    if (options.verifyWebhook) {
      if (!(await options.verifyWebhook(ctx, { flowId: hook.flowId, path: ctx.route.path! }))) {
        return ctx.json({ error: "Webhook refused" }, 401)
      }
    } else if (production) {
      return ctx.json({ error: "Webhooks are refused in production until orion({ verifyWebhook }) is configured" }, 401)
    }

    // The trigger is stored on the run, so a credential a caller sent in a
    // header is not.
    const trigger = {
      body:    ctx.body ?? null,
      headers: redactSecrets(ctx.headers),
      query:   ctx.query,
      method:  ctx.method,
      path:    ctx.route.path,
    }

    try {
      if (hook.mode === "async") {
        return ctx.json({ runId: await runner.start(hook.flowId, trigger, { tenant: hook.tenant }) }, 202)
      }
      const out = await runner.runInline(hook.flowId, trigger, { deadlineMs: options.deadlineMs, tenant: hook.tenant })
      if ("response" in out) {
        const { status, headers, body } = out.response
        return new Response(typeof body === "string" ? body : JSON.stringify(body ?? null), {
          status,
          headers: { "content-type": "application/json", ...headers },
        })
      }
      if ("timedOut" in out) return ctx.json({ runId: out.runId, error: "The flow did not answer in time" }, 504)
      return ctx.json({ runId: out.runId, status: out.record.status }, out.record.status === "failed" ? 500 : 200)
    } catch (err) {
      return refusal(ctx, err)
    }
  })

  // The key is the credential: 32 random bytes, single use.
  app.post(`${prefix}/wait/{key}`, async (ctx: TransportContext) => {
    try {
      const resumed = await runner.resume(ctx.route.key ?? "", ctx.body ?? null)
      return resumed
        ? ctx.json({ resumed: true }, 202)
        : ctx.json({ error: "No run is waiting on this key" }, 404)
    } catch (err) {
      return refusal(ctx, err)
    }
  })
}

// The tenant a request names by itself under `strategy database`, or undefined
// where nothing but a principal could name one.
function tenantOfRequest(app: App, ctx: TransportContext): string | null | undefined {
  const registry = (app as unknown as { tenants?: { tenantFor?(from: object): string | null } }).tenants
  if (!registry?.tenantFor) return undefined
  const host = (ctx.headers.host ?? null) as string | null
  return registry.tenantFor({ host, headers: ctx.headers, principal: null }) ?? undefined
}

function refusal(ctx: TransportContext, err: unknown): Response {
  if (err instanceof FlowRateLimitedError) return ctx.json({ error: err.message }, 429)
  if (err instanceof FlowNotRunnableError) return ctx.json({ error: err.message }, 409)
  throw err
}

// ─── services ────────────────────────────────────────────────────────────────

// The six verbs by their own calls, and anything else as a custom method.
function callService(app: App, service: string, method: string, input: { id?: unknown; data?: unknown; query?: unknown }) {
  const svc  = app.service(service)
  const id   = input.id as string | number
  const data = (input.data ?? {}) as Record<string, unknown>
  switch (method) {
    case "find":   return svc.find((input.query ?? {}) as Record<string, unknown>)
    case "get":    return svc.get(id)
    case "create": return svc.create(data)
    case "patch":  return svc.patch(id, data)
    case "update": return svc.update(id, data)
    case "remove": return svc.remove(id)
    default:       return svc.call(method, (input.id ?? null) as string | number | null, input.data === undefined ? null : data)
  }
}
