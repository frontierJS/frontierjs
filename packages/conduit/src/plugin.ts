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
import { NotFound, createService } from '@frontierjs/junction'
import { createConduit }    from './conduit.ts'
import type { ConduitOptions, IConduit, TargetDescriptor } from './types.ts'

// ─── App augmentation ────────────────────────────────────────
// Adds app.conduit to Junction's App type across the entire project.

declare module '@frontierjs/junction' {
  interface App {
    conduit: IConduit
  }
}

// ─── Plugin factory ──────────────────────────────────────────

export function conduit(opts: ConduitOptions = {}): Plugin {
  // Create the instance at factory time so register() can attach it
  // synchronously — boot() will call init() when the app starts.
  const instance = createConduit(opts)

  return {
    name: 'conduit',

    // register() runs at configure() time — synchronous setup only.
    // Attaches app.conduit, wires metrics, and registers management service.
    register(app: App): void {
      app.conduit = instance

      // Wire into Junction's /metrics endpoint
      if (app._metricsProviders instanceof Map) {
        app._metricsProviders.set('conduit', () => instance.stats())
      }

      if (opts.management) {
        registerManagementService(app, opts.management)
      }
    },

    // boot() runs during app.start() — safe to do async work here.
    // Initialises the store and loads any static targets from opts.targets.
    async boot(app: App): Promise<void> {
      await app.conduit.init()
    },

    // ready() fires after the server is listening.
    // Reserved for warming up persistent outbound connections
    // (e.g. WebSocket transport pre-connect) — nothing needed yet.
    ready(_app: App): void {},

    // shutdown() runs during app.stop() — close open WS connections cleanly.
    async shutdown(app: App): Promise<void> {
      await app.conduit.destroy()
    },
  }
}

// ─── Management service ──────────────────────────────────────
// Registered as a Junction service so it goes through the full
// hook pipeline — auth, logging, error handling all apply.
//
// Exposes:
//   find   → GET    /api/<path>       — list all registered targets
//   get    → GET    /api/<path>/:id   — resolve a single target
//   remove → DELETE /api/<path>/:id   — deregister a target by ID
//
// Disabled by default. Enable with: conduit({ management: true })
// or conduit({ management: { path: 'conduit/targets' } })

function registerManagementService(
  app:        App,
  management: NonNullable<ConduitOptions['management']>
): void {
  const name = (typeof management === 'object' && management.path)
    ? management.path
    : 'conduit/targets'

  app.services.register(createService({
    name,

    async find(_ctx) {
      return app.conduit.list()
    },

    async get(ctx) {
      const target = await app.conduit.resolve(String(ctx.id))
      if (!target) throw new NotFound(`Conduit target '${ctx.id}' not found`)
      return target
    },

    async remove(ctx) {
      const target = await app.conduit.resolve(String(ctx.id))
      if (!target) throw new NotFound(`Conduit target '${ctx.id}' not found`)
      await app.conduit.deregister(String(ctx.id))
      return target
    },
  }))
}


