// config/index.ts
// Layered config system — default.ts + {NODE_ENV}.ts, deep merged.
// Config files are plain .ts — env vars, expressions, functions all valid.
// Fully typed via AppConfig interface.

import { join, resolve } from 'node:path'

// ─── App config interface ─────────────────────────────────────────────────
// Extend this in your app's config/types.ts

export interface AppConfig {
  // Server
  port:       number
  hostname:   string
  protocol:   'http' | 'https'
  
  // App
  name:       string
  version:    string
  debug:      boolean
  // URL prefix for all auto-registered service routes.
  // Default '' → routes at /{service} and /{service}/{id}
  // Set to '/api' or '/api/v1' for versioned APIs.
  apiPrefix?: string
  
  // Auth
  // HTTP
  http: {
    maxBodySize:  number    // bytes
    compress:     boolean
    cors: {
      origins:    string[]
      methods:    string[]
      headers:    string[]
    }
    ddos: {
      enabled:    boolean
      limit:      number
      window:     number   // ms
    }
    static?: {
      root:       string
      maxAge:     number
    }
    powered:      string
    // Grace period (ms) between stop() and process.exit — lets in-flight
    // requests complete. Default 5000ms.
    drainTimeout?: number
  }

  // Cache
  cache: {
    defaultTtl: string   // e.g. '5 minutes'
    maxSize:    number   // max keys in memory
  }

  // Workers
  workers: {
    dir:        string
  }

  // Database
  database?: {
    url:        string         // bun:sqlite path or ':memory:'
    log?:       boolean        // log SQL statements to console
  }

  // AI
  ai?: {
    openai?:    string   // API key
    anthropic?: string
  }

  // Extensions — app can add anything here
  [key: string]: unknown
}

// ─── Default config ────────────────────────────────────────────────────────

export const defaultConfig: AppConfig = {
  port:     3000,
  hostname: '0.0.0.0',
  protocol: 'http',

  name:     'app',
  version:  '1.0.0',
  debug:    false,

  http: {
    maxBodySize: 256 * 1024,
    compress:    true,
    cors: {
      origins: [],   // must be set explicitly — '*' never applied by default
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      headers: ['Content-Type', 'Authorization', 'X-API-Key'],
    },
    // Security headers (helmet) are on by default — set helmet: false to disable
    // helmet: false,
    ddos: {
      enabled: false,
      limit:   100,
      window:  60_000,
    },
    powered: 'Junction',
  },

  cache: {
    defaultTtl: '5 minutes',
    maxSize:    10_000,
  },

  workers: {
    dir: './workers',
  },
}

// ─── JunctionConfig — full junction.config.js shape ──────────────────────
// The config file uses friendly section names that map onto AppConfig.
// loadConfig() flattens these into a plain AppConfig for the app to use.

export interface JunctionMiddlewareConfig {
  cors?:          { origins?: string[]; methods?: string[]; headers?: string[] }
  helmet?:        boolean
  requestLogger?: boolean
  correlationId?: boolean
  rateLimit?:     { windowMs?: number; max?: number }
  bodyLimit?:     { maxSize?: number }
  csrf?:          boolean
}

export interface JunctionPluginsConfig {
  health?:   boolean | { path?: string; token?: string }
  manifest?: boolean | { path?: string; devOnly?: boolean }
  openapi?:  boolean | { title?: string; version?: string; ui?: string | false }
  devtools?: boolean | { port?: number }
}

export interface JunctionServicesConfig {
  dir?: string   // path to services dir for autoloadServices, default './src/services'
}

export interface JunctionCaravanConfig {
  db?:           string
  jobsDir?:      string
  pollInterval?: number
  cleanupAfter?: number
  queues?:       Record<string, { concurrency?: number }>
  admin?:        boolean | { path?: string; secret?: string }
}

export interface JunctionConduitConfig {
  dir?: string   // path to conduit/ dir for auto-discovery
}

export interface JunctionConfig {
  app?:        Partial<AppConfig>
  middleware?: JunctionMiddlewareConfig
  plugins?:    JunctionPluginsConfig
  services?:   JunctionServicesConfig
  conduit?:    JunctionConduitConfig
  caravan?:    JunctionCaravanConfig
}

// ─── Config loader ────────────────────────────────────────────────────────

export async function loadConfig(configDir = './config'): Promise<AppConfig & { _junction?: JunctionConfig }> {

  // Resolve to absolute path from CWD — dynamic import() resolves relative to
  // the importing file (deep in junction package), not the app root
  const absConfigDir = resolve(process.cwd(), configDir)

  const env = process.env.NODE_ENV ?? 'development'

  // Load default
  let config = deepClone(defaultConfig) as AppConfig & { _junction?: JunctionConfig }

  // Try junction.config.js first — the primary config file for FJS apps.
  // Its `app` section maps onto AppConfig; other sections stored under _junction.
  const junctionCfg = await tryImport(join(absConfigDir, 'junction.config.js')) as JunctionConfig | null
  if (junctionCfg) {
    if (junctionCfg.app)        config = deepMerge(config, junctionCfg.app) as typeof config
    if (junctionCfg.middleware?.cors)   config.http = deepMerge(config.http ?? {}, { cors: junctionCfg.middleware.cors })
    if (junctionCfg.middleware?.rateLimit) config.http = deepMerge(config.http ?? {}, { ddos: { enabled: true, ...junctionCfg.middleware.rateLimit } })
    config._junction = junctionCfg
  }

  // Merge legacy default.ts / {env}.ts if present
  const appDefault = await tryImport(join(absConfigDir, 'default.ts'))
  if (appDefault) config = deepMerge(config, appDefault) as typeof config

  const envOverride = await tryImport(join(absConfigDir, `${env}.ts`))
  if (envOverride) config = deepMerge(config, envOverride) as typeof config

  // Always respect env vars for critical secrets (override everything)
  if (process.env.PORT)           config.port           = parseInt(process.env.PORT, 10)
  if (process.env.DEBUG === '1')  config.debug          = true

  return config
}

// ─── Deep merge ───────────────────────────────────────────────────────────
// Plain objects are merged. Arrays are replaced. Primitives are replaced.

export function deepMerge<T extends object>(base: T, override: Partial<T>): T {

  const result = deepClone(base)

  for (const key in override) {
    if (!Object.prototype.hasOwnProperty.call(override, key)) continue

    const bVal = (result as Record<string, unknown>)[key]
    const oVal = (override as Record<string, unknown>)[key]

    if (isPlainObject(bVal) && isPlainObject(oVal)) {
      ;(result as Record<string, unknown>)[key] = deepMerge(bVal, oVal)
    } else if (oVal !== undefined) {
      ;(result as Record<string, unknown>)[key] = deepClone(oVal)
    }
  }

  return result
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return val !== null && typeof val === 'object' && !Array.isArray(val)
}

function deepClone<T>(val: T): T {
  if (val === null || typeof val !== 'object') return val
  if (Array.isArray(val)) return val.map(deepClone) as unknown as T
  const result: Record<string, unknown> = {}
  for (const key in val as Record<string, unknown>)
    result[key] = deepClone((val as Record<string, unknown>)[key])
  return result as T
}

async function tryImport(path: string): Promise<Partial<AppConfig> | null> {
  try {
    const mod = await import(path)
    return mod.default ?? mod
  } catch (err) {
    // "File doesn't exist" is the expected miss for optional config files —
    // return null and fall through to defaults. Anything else means the
    // file EXISTS but is broken (syntax error, throwing top-level code,
    // bad import inside it) — swallowing that silently booted apps on
    // default config with no hint. Fail loudly instead.
    const e = err as { code?: string; message?: string }
    const notFound =
      e?.code === 'ERR_MODULE_NOT_FOUND' ||
      e?.code === 'MODULE_NOT_FOUND' ||
      /cannot find (module|package)/i.test(e?.message ?? '') ||
      /module not found/i.test(e?.message ?? '')
    if (notFound) return null
    throw new Error(`Config file '${path}' exists but failed to load: ${e?.message ?? err}`)
  }
}

// ─── TTL string → milliseconds ───────────────────────────────────────────
// Used by cache and scheduler

const TTL_MAP: Record<string, number> = {
  second: 1_000,
  seconds: 1_000,
  minute: 60_000,
  minutes: 60_000,
  hour: 3_600_000,
  hours: 3_600_000,
  day: 86_400_000,
  days: 86_400_000,
  week: 604_800_000,
  weeks: 604_800_000,
}

export function parseTtl(ttl: string): number {
  // '5 minutes' → 300000
  // '1h' → 3600000
  // '30s' → 30000
  // raw ms number string → ms
  const n = parseInt(ttl, 10)
  if (isNaN(n)) return 300_000  // default 5 min

  // Short suffixes: 300ms, 300s, 5m, 2h, 7d
  const short = ttl.replace(String(n), '').trim().toLowerCase()
  if (short === 'ms') return n
  if (short === 's')  return n * 1_000
  if (short === 'm')  return n * 60_000
  if (short === 'h')  return n * 3_600_000
  if (short === 'd')  return n * 86_400_000

  // Long form: '5 minutes'
  const word = ttl.slice(String(n).length).trim().toLowerCase()
  return n * (TTL_MAP[word] ?? 1_000)
}
