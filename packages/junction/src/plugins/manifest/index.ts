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

import type { App, Plugin } from '../../core/app.ts'
import type { HookMap }     from '../../core/hooks.ts'

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
  app:      AppMeta
  services: ServiceManifest[]
  channels: ChannelManifest[]
  appHooks: HookManifest
  plugins:  string[]
  schema?:  unknown   // generateJsonSchema output — present when opts.schema provided
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
  model:      string
  methods:    string[]      // CRUD + custom methods
  hooks:      HookManifest
  softDelete: boolean
  cache:      boolean
  idField:    string
}

export interface HookManifest {
  before: Record<string, string[]>
  after:  Record<string, string[]>
  around: Record<string, string[]>
  error:  Record<string, string[]>
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

    // boot() runs after all plugins have registered but before the HTTP server
    // starts — routes added here are still accepted by the router.
    // ready() runs after the server starts — router is already built, too late.
    async boot(app: App): Promise<void> {
      if (devOnly && process.env.NODE_ENV === 'production') return
      const prefix = (app.config as Record<string, unknown>).apiPrefix as string ?? ''

      app.get(`${prefix}${route}`, async () =>
        Response.json(await buildManifest(app, opts))
      )

      if (opts.db) {
        app.get(`${prefix}${migrationsRoute}`, async () =>
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
        schema = generateJsonSchema(dbSchema as Record<string, unknown>)
      }
    } catch {
      // Litestone not available — omit silently
    }
  }

  return {
    app:      buildAppMeta(app),
    services: buildServices(app),
    channels: buildChannels(app),
    appHooks: serializeHookMap(app._appHooks),
    plugins:  app._plugins ?? [],
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

// Standard service keys — not custom methods
const STANDARD_KEYS = new Set([
  'find', 'get', 'create', 'patch', 'remove', 'restore',
  '_find', '_get', '_create', '_patch', '_remove', '_restore',
  'hooks', 'name', 'model', '_hookMap', '_pipelines', '_compiledPipelines',
  '_schemas', '_meta',
])

function buildServices(app: App): ServiceManifest[] {
  return app.services.values().map(svc => {
    const s    = svc as Record<string, unknown>
    const meta = (s._meta as Record<string, unknown>) ?? {}

    const customMethods = Object.keys(svc)
      .filter(k => !STANDARD_KEYS.has(k) && typeof s[k] === 'function')

    return {
      name:       svc.name,
      model:      svc.model ?? svc.name,
      methods:    ['find', 'get', 'create', 'patch', 'remove', 'restore', ...customMethods],
      hooks:      serializeHookMap(svc._hookMap),
      softDelete: !!(meta.softDelete),
      cache:      !!(meta.cache),
      idField:    (meta.idField as string) ?? 'id',
    }
  })
}

function buildChannels(app: App): ChannelManifest[] {
  const manager = (app as Record<string, unknown>).channels as
    { stats?: () => { channelList: { name: string; size: number }[] } } | undefined

  const list = manager?.stats?.().channelList ?? []
  return list.map(c => ({ name: c.name, connections: c.size }))
}

function serializeHookMap(map: HookMap = {}): HookManifest {
  const phases = ['before', 'after', 'around', 'error'] as const
  const out: HookManifest = { before: {}, after: {}, around: {}, error: {} }

  for (const phase of phases) {
    const phaseMap = (map as Record<string, unknown>)[phase] as
      Record<string, unknown> | undefined ?? {}

    for (const [method, hooks] of Object.entries(phaseMap)) {
      if (!Array.isArray(hooks)) continue
      out[phase][method] = (hooks as ((...a: unknown[]) => unknown)[])
        .map(fn => (typeof fn === 'function' ? fn.name || 'anonymous' : String(fn)))
    }
  }

  return out
}
