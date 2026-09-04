// ============================================================
// Conduit — Junction Plugin
//
// Usage:
//   import { conduit }          from '@frontierjs/conduit'
//   import { createSQLiteStore } from '@frontierjs/conduit/stores/sqlite'
//
//   app.configure(conduit({
//     store:   createSQLiteStore(db),
//     targets: [hetznerTarget, githubTarget],
//   }))
//
//   // Anywhere after configure():
//   const result = await app.conduit.send({ target: 'provider:hetzner', ... })
// ============================================================

import type { App, Plugin } from '@frontierjs/junction'
import { NotFound, createService, requestMeta } from '@frontierjs/junction'
import { createConduit }    from './conduit.ts'
import { createTraceContext, parseTraceparent, traceIdFrom } from './trace.ts'
import type { ConduitOptions, IConduit, TargetDescriptor } from './types.ts'

// ─── App augmentation ────────────────────────────────────────
// Adds app.conduit to Junction's App type across the entire project.

// Augments Junction's `AppConduit` — the interface `App.conduit` points at —
// rather than redeclaring `App.conduit` itself.
//
// Redeclaring the property does not work: declaration merging requires every
// declaration of a property to have an identical type, and Junction already
// declares `conduit?: AppConduit` so its own email plugin can read the field
// without depending on this package. Two conflicting declarations mean the
// augmentation loses and `app.conduit` resolves to `{}` at every call site.
//
// `App.conduit` stays optional on Junction's side, so an app that installs
// this package but never calls configure(conduit()) is still typed honestly.
declare module '@frontierjs/junction' {
  interface AppConduit extends IConduit {}
}

// ─── Trace propagation ───────────────────────────────────────

/**
 * The default `trace`, and the reason there is one.
 *
 * `createTraceContext` shipped with nobody wiring it, so nothing this app sent
 * carried a correlation id or a `traceparent` — measured with a recorder, an
 * inbound request stating both produced an outbound call carrying neither, and
 * a target's logs could not be joined to the request that caused them
 * (`FJS-742`). Every ingredient was already here: junction holds the
 * correlation id on `requestMeta()` and conduit's default correlation header is
 * already `X-Request-Id`. What was missing is that they were never introduced.
 *
 * It is a DEFAULT and not a behavior: `createConduit({ trace, ...opts })`
 * puts it under the caller's, so an app wiring its own tracer replaces this
 * whole thing rather than fighting it, and `trace: () => null` turns it off.
 *
 * Outside a request — a job, a script, boot — `requestMeta()` answers
 * undefined, and a fresh trace per call is then the correct answer rather than
 * a missing one: there is no inbound request for the call to hang off.
 */
function junctionTrace() {
  return createTraceContext({
    current: () => {
      const meta = requestMeta()
      if (!meta) return null

      // An upstream trace wins over one derived here. Continuing it is the
      // whole point — a derived id would make this process the root of a
      // trace the caller is already in the middle of.
      const upstream = parseTraceparent(meta.traceparent)
      if (upstream) return upstream

      const traceId = traceIdFrom(meta.correlationId)
      return traceId ? { trace_id: traceId } : null
    },
    correlationId: () => requestMeta()?.correlationId,
  })
}

// ─── Plugin factory ──────────────────────────────────────────

export function conduit(opts: ConduitOptions = {}): Plugin {
  // One conduit PER APP, created in register().
  //
  // This used to be created here, at factory time, so a single plugin object
  // configured on two apps gave both the same conduit — and the second
  // register() overwrote the first's app.conduit. boot() worked around that by
  // closing over `instance` rather than reading app.conduit, which made
  // shutdown of one app destroy the other's conduit. The type never said any
  // of this; only a comment did.
  //
  // Creating per app makes reuse actually correct, and lets the lifecycle
  // hooks read the instance off the app they were handed. register() stays
  // synchronous, which is what the factory-time instance was protecting.
  const instances = new WeakMap<App, IConduit>()

  const conduitFor = (app: App, phase: string): IConduit => {
    const instance = instances.get(app)
    if (!instance) {
      throw new Error(
        `[conduit] ${phase}() ran for an app that never had register() called. ` +
        `Configure the plugin with app.configure(conduit(...)) before starting.`
      )
    }
    return instance
  }

  return {
    name: 'conduit',

    // register() runs at configure() time — synchronous setup only.
    // Creates this app's conduit, attaches it, wires metrics, and registers
    // the management service.
    register(app: App): void {
      const instance = createConduit({ trace: junctionTrace(), ...opts })
      instances.set(app, instance)

      // claim() rather than `app.conduit = instance`: a second plugin
      // claiming the same name used to win silently and leave this one dead.
      app.claim('conduit', instance)

      // Wire into Junction's /metrics endpoint. Called straight rather than
      // behind a presence check: this plugin imports Junction's own App type,
      // so a missing seam is a compile error here instead of metrics that
      // quietly stop appearing.
      app.registerMetricsSource('conduit', () => instance.stats())

      if (opts.management) {
        registerManagementService(app, instance, opts.management)
      }
    },

    // boot() runs during app.start() — safe to do async work here.
    // Initialises the store and loads any static targets from opts.targets.
    async boot(app: App): Promise<void> {
      await conduitFor(app, 'boot').init()
    },

    // ready() fires after the server is listening.
    // Reserved for warming up persistent outbound connections
    // (e.g. WebSocket transport pre-connect) — nothing needed yet.
    ready(_app: App): void {},

    // shutdown() runs during app.stop() — close open WS connections cleanly.
    // Destroys THIS app's conduit, so stopping one app cannot tear down another's.
    async shutdown(app: App): Promise<void> {
      await conduitFor(app, 'shutdown').destroy()
    },
  }
}

// ─── Management service ──────────────────────────────────────
// Registered as a Junction service so it goes through the full
// hook pipeline — auth, logging, error handling all apply.
//
// Exposes:
// Registered as a service, so these sit under the app's `apiPrefix` — which
// Junction defaults to '' (services at /{service}), not '/api':
//   find   → GET    {apiPrefix}/<path>       — list all registered targets
//   get    → GET    {apiPrefix}/<path>/:id   — resolve a single target
//   remove → DELETE {apiPrefix}/<path>/:id   — deregister a target by ID
//
// <path> must be a single path segment — see the check below.
//
// Disabled by default. Enabling it requires saying who may reach it:
//
//   conduit({ management: { hooks: { before: { all: [authenticate()] } } } })
//   conduit({ management: { public: true } })          // deliberate, documented
//
// Descriptors returned here carry credential *refs* only — the secret
// material lives behind the CredentialResolver and is never loaded into
// a descriptor. But these routes still enumerate every target in the
// system and can deregister them, so "forgot to add the hook" must not be
// a silently reachable state.

function registerManagementService(
  app:        App,
  instance:   IConduit,
  management: NonNullable<ConduitOptions['management']>
): void {
  const name = management.path ?? 'conduit-targets'

  // Structural problems first — a path that can never route is worth
  // reporting before a policy decision that only matters once it can.
  //
  // Junction registers service routes as `{apiPrefix}/{service}`, and
  // `{service}` matches exactly one path segment. A name containing a slash
  // registers fine and then never routes — every request 404s with no
  // indication why. Fail at configure() instead, where the stack points at
  // the call site.
  if (name.includes('/')) {
    throw new Error(
      `[conduit] management path '${name}' contains a '/'. Junction service ` +
      `names are a single path segment — use '${name.replace(/\//g, '-')}' instead.`
    )
  }

  // Fail closed, loudly, at configure() — rather than serving an open endpoint.
  if (!management.hooks && !management.public) {
    throw new Error(
      `[conduit] management routes need an access decision. Either attach auth:\n` +
      `  conduit({ management: { hooks: { before: { all: [authenticate()] } } } })\n` +
      `or opt out explicitly if your app already authenticates every service:\n` +
      `  conduit({ management: { public: true } })`
    )
  }

  app.services.register(createService({
    name,
    ...(management.hooks ? { hooks: management.hooks as never } : {}),

    async find(_ctx) {
      return instance.list()
    },

    async get(ctx) {
      const target = await instance.resolve(String(ctx.id))
      if (!target) throw new NotFound(`Conduit target '${ctx.id}' not found`)
      return target
    },

    async remove(ctx) {
      const target = await instance.resolve(String(ctx.id))
      if (!target) throw new NotFound(`Conduit target '${ctx.id}' not found`)
      await instance.deregister(String(ctx.id))
      return target
    },
  }))
}


