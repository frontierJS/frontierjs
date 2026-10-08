// manifest.ts
// manifestPlugin — exposes GET /manifest (or custom path) returning a
// structural snapshot of the running app: services, hooks, channels, plugins.
//
// Consumed by FJSChain to build the App CoR Overview.
// Data is derived entirely from live runtime state — no AST, no file walking.
//
// Mounts in boot() — routes added there are still picked up by the
// router, and services registered in boot() are visible in the manifest.
//
// Usage:
//   app.configure(manifestPlugin({ db }))
//   // → GET /manifest   (includes schema from db.$schema)
//   // → GET /migrations (from db.$config.migrationsDir)
//
//   app.configure(manifestPlugin({ db, devOnly: true }))
//   // → only mounted in non-production

import type { App, DevService, Plugin } from '../../core/app.ts'
import { buildRoutes, serializeHookMap } from '../../core/app-model.ts'
import type { RouteManifest, HookManifest } from '../../core/app-model.ts'

// ─── Types ────────────────────────────────────────────────────────────────

export interface ManifestPluginOptions {
  /** Route to serve on. Default: '/manifest' */
  path?: string
  /** If true, skip mounting in production (NODE_ENV === 'production'). Default: true */
  devOnly?: boolean
  /**
   * Litestone client — enables schema embedding + migrations endpoint.
   * migrationsDir and schemaPath are read from db.$config automatically.
   * Raw db instance is read from db.$rawDbs.main automatically.
   */
  db?: unknown
}

export interface AppManifest {
  app:         AppMeta
  services:    ServiceManifest[]
  routes:      RouteManifest[]
  channels:    ChannelManifest[]
  appHooks:    HookManifest
  plugins:     string[]
  /** The second listeners this app announced through `app.registerDevService`.
   *  A sidecar mounts no route here, so nothing else in this document can see
   *  one. Empty for an app that started none. */
  devServices: DevService[]
  schema?:     unknown   // generateJsonSchema output — present when opts.schema provided
  // Migrations are served separately via GET {prefix}/migrations — not embedded here.
}

export interface AppMeta {
  name:    string
  version: string
  prefix:  string
  port:    number
}

export interface ServiceManifest {
  name:       string
  model:      string | null
  methods:    string[]      // CRUD + custom methods, after the `methods:` policy
  hooks:      HookManifest
  softDelete: boolean
  cache:      boolean
  idField:    string
}

export interface ChannelManifest {
  name:        string
  connections: number
}

// ─── Plugin ───────────────────────────────────────────────────────────────

export function manifestPlugin(opts: ManifestPluginOptions = {}): Plugin {
  const route          = opts.path    ?? '/manifest'
  const migrationsRoute = '/migrations'
  const devOnly        = opts.devOnly ?? true   // safe default — skip in production

  return {
    name: 'manifest',

    // Routes mount in register() — the standard phase for route mounting
    // across all plugins (webhooks, openapi, manifest). Manifest content is
    // generated lazily per request, so services registered in later phases
    // are still fully visible. (Previously mounted in boot() with a comment
    // explaining why ready() was too late — register() is simply earlier
    // and consistent.)
    // Synchronous: the awaits below are inside route handlers, not here.
    register(app: App): void {
      if (devOnly && process.env.NODE_ENV === 'production') return

      // app.get applies apiPrefix — see the route shortcuts in core/app.ts.
      app.get(route, async () =>
        Response.json(await buildManifest(app, opts))
      )

      if (opts.db) {
        app.get(migrationsRoute, async () =>
          Response.json(await buildMigrations(opts))
        )
      }
    }
  }
}

// ─── Builder ──────────────────────────────────────────────────────────────

async function buildManifest(app: App, opts: ManifestPluginOptions): Promise<AppManifest> {
  let schema: unknown = undefined

  if (opts.db) {
    try {
      // db.$schema is the already-parsed schema AST — no file read needed
      const dbSchema = (opts.db as Record<string, unknown>).$schema
      if (dbSchema) {
        const { generateJsonSchema } = await import('@frontierjs/litestone')
        schema = generateJsonSchema(dbSchema as Parameters<typeof generateJsonSchema>[0])
      }
    } catch {
      // Litestone not available — omit silently
    }
  }

  return {
    app:         buildAppMeta(app),
    services:    buildServices(app),
    routes:      buildRoutes(app),
    channels:    buildChannels(app),
    appHooks:    serializeHookMap(app._appHooks),
    plugins:     app._plugins ?? [],
    devServices: [...(app._devServices?.values() ?? [])],
    schema,
  }
}

async function buildMigrations(opts: ManifestPluginOptions): Promise<unknown> {
  try {
    const client = opts.db as Record<string, unknown>
    const { migrationsDir } =
      client.$config as { schemaPath: string; migrationsDir: string }
    const rawDb = (client.$rawDbs as Record<string, unknown>).main

    const { status } = await import('@frontierjs/litestone')
    return status(rawDb, migrationsDir)
  } catch {
    return []
  }
}

function buildAppMeta(app: App): AppMeta {
  const cfg = app.config as Record<string, unknown>
  return {
    name:    (cfg.name    as string) ?? 'junction',
    version: (cfg.version as string) ?? '',
    prefix:  (cfg.apiPrefix as string) ?? '',
    port:    (cfg.port as number) ?? 3000,
  }
}

function buildServices(app: App): ServiceManifest[] {
  // Straight off describe(). This used to read `_meta`, `_hookMap` and the
  // custom-method rule directly, through a cast — three internals, and three chances
  // to describe a different service than the one that answers the request. The
  // hardcoded method list here was also a fourth spelling of the CRUD set, and
  // it omitted `update`.
  return app.services.values().map(svc => {
    const d = svc.describe()
    return {
      name:       d.name,
      model:      d.model,
      // Policy-filtered: advertising a verb the service answers 405 to is worse
      // than not advertising it, because a generated client would call it.
      methods:    d.methods,
      hooks:      serializeHookMap(d.hooks),
      softDelete: !!d.softDelete,
      cache:      d.cache,
      idField:    d.idField,
    }
  })
}

function buildChannels(app: App): ChannelManifest[] {
  const list = app.channels?.stats?.().channelList ?? []
  return list.map(c => ({ name: c.name, connections: c.size }))
}
