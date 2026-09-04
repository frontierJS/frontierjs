// config/index.ts
// Layered config system — default.ts + {NODE_ENV}.ts, deep merged.
// Config files are plain .ts — env vars, expressions, functions all valid.
// Fully typed via AppConfig interface.

import { join, resolve } from 'node:path'
import { existsSync }      from 'node:fs'
import type { TrustProxy } from '../transport/forwarded.ts'

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
    /**
     * How many proxies stand in front of this app, or which ones.
     *
     *   false      the socket address alone. The default.
     *   true       one trusted hop — what the shipped nginx template is.
     *   <n>        n trusted hops.
     *   [...]      trusted proxies, by address or CIDR (IPv4 and IPv6).
     *
     * It has to be declared, and being absent is not neutral in either
     * direction: unset behind a proxy keys the rate limiter and the DDoS
     * guard on the PROXY's address, so every caller in the world shares one
     * bucket; set wrongly, the caller picks their own key. The option existed
     * on the transport and reached it from nowhere — no config key, and
     * `app.ts` never passed one (`FJS-744`).
     */
    trustProxy?:  TrustProxy
    // Security headers. On unless declared false — the opt-out an app writes
    // as `http: { helmet: false }`, which app.ts has always read and this
    // shape did not declare, so the typed form of the documented opt-out was
    // the one spelling that did not compile.
    helmet?:      boolean
    // Grace period (ms) between stop() and process.exit — lets in-flight
    // requests complete. Default 5000ms.
    drainTimeout?: number
    // How much junction holds for a WebSocket that is not draining before it
    // closes it with 1013. Default 8MB. Past Bun's own buffer a frame is
    // DROPPED rather than queued, and that drop is silent — FJS-139.
    wsMaxQueued?: number
    // Caller-varied headers this app reads off a request — a basket token, a
    // tenant, an experiment arm. Junction's own protocol headers are always
    // allowed and are not listed here.
    //
    // ONE declaration, two readers, because it is one fact: cross-origin a
    // header absent from the CORS allow-list never arrives, and over the
    // socket a header the frame names is dropped unless it is here. Declaring
    // it in one place and not the other gives an app that works until the
    // socket connects, or until it is served from a second origin.
    //
    // It is an allow-list rather than a pass-through for one reason: a frame
    // that could name its own header could name Authorization, and the
    // caller's identity is established at upgrade.
    callHeaders?: string[]
    // What one WebSocket may do. Every bound above stops at the upgrade, so
    // without these the transport junction PREFERS is the cheapest way to
    // exhaust it (`FJS-705`). See `WsLimits` in transport/http.ts for what each
    // one is and why its default is the number it is.
    ws?: {
      maxFrameBytes?:       number
      maxPayloadLength?:    number
      maxFramesPerSecond?:  number
      maxInFlight?:         number
      maxConnectionsPerIp?: number
      maxConnections?:      number
    }
  }

  // What happens between SIGTERM and the process going away.
  //
  // Separate from `http.drainTimeout`, which bounds one step of it: that is how
  // long a socket gets, these are how long the whole thing gets and what
  // happens when it does not finish. A hung plugin shutdown used to end with
  // the process exiting **0** — every timer unref'd, the loop empty, node
  // leaving successfully — with the queue, the outbox and the database close
  // all skipped and nothing said. Zero is what an orchestrator reads as a clean
  // stop (`FJS-693`).
  shutdown?: {
    // Whole-shutdown deadline. Past it the process exits 1 rather than waiting.
    // Default 15000ms.
    timeout?: number
    // Per-plugin `shutdown()` deadline. One plugin that never settles must not
    // take the rest of the list with it. Default 5000ms.
    pluginTimeout?: number
    // Install `unhandledRejection` / `uncaughtException` handlers that log,
    // stop the app and exit 1. Skipped where the app has already installed its
    // own — a framework replacing the application's crash policy is worse than
    // not having one. Default true.
    crashHandlers?: boolean
  }

  // Cache
  cache: {
    defaultTtl: string   // e.g. '5 minutes'
    maxSize:    number   // max keys in memory
  }

  // Replay protection for a request carrying an Idempotency-Key. Applies to
  // mutating calls only, and only when the caller sent a key — see
  // core/idempotency.ts. Backed by the app cache, so it is per-process:
  // two instances behind a load balancer do not share it.
  idempotency?: import('../core/idempotency.ts').IdempotencyConfig

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
  /**
   * Outbound mail defaults.
   *
   * Here rather than only in the adapter's own options because a from-address is
   * the canonical per-tenant value (`FJS-D126`) — one deployment serving several
   * customers has one of these per customer — and a value captured in a
   * provider's constructor cannot vary per call. An adapter still takes its own
   * `from` for an app that has one; this is the floor a tenant overrides.
   */
  mail?: {
    from?:    string
    replyTo?: string
  }

  ai?: {
    openai?:    string   // API key
    anthropic?: string
  }

  /**
   * This build's identity — what a browser compares its own against.
   *
   * A deploy supplies it as `FJS_BUILD` in the container's environment;
   * `config.build` is how a test or an embedding app states one. Absent, every
   * reader is inert: an app nobody deployed announces nothing.
   * `core/build-id.ts` is the owner.
   */
  build?: string

  /**
   * Third-party services this app needs and does not own — an n8n, a mail
   * server, a search cluster.
   *
   * Declared here and BOUND per environment as ordinary environment variables,
   * which is what `fli deploy`'s binding set already supplies per target. A
   * missing or half-bound service refuses at startup rather than at 3am on the
   * first request that reaches it. `core/attachments.ts` is the owner.
   */
  attachments?: import('../core/attachments.ts').Attachments

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

  idempotency: {
    enabled:    true,
    ttl:        '24 hours',
    pendingTtl: '2 minutes',
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
  // Where the *.service.ts files are, resolved against the working directory.
  // Absent, junction probes `./services` then `./src/services` beside the ENTRY
  // — see `resolveServicesDir`. Stating one is a statement: a path that is not
  // there is reported, never probed around.
  dir?: string
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

  /**
   * Third-party services this app needs and does not own. Maps straight onto
   * `AppConfig.attachments` — it is a declaration about the app rather than a
   * section for a subsystem, so it is one of the few keys here with no
   * translation.
   */
  attachments?: import('../core/attachments.ts').Attachments
}

// ─── Config loader ────────────────────────────────────────────────────────

export async function loadConfig(configDir = './config'): Promise<AppConfig & { _junction?: JunctionConfig }> {

  // Resolve to absolute path from CWD — dynamic import() resolves relative to
  // the importing file (deep in junction package), not the app root
  const absConfigDir = resolve(process.cwd(), configDir)

  const env = process.env.NODE_ENV ?? 'development'

  // A missing config FILE is an optional miss and stays silent — an app is
  // allowed to declare nothing. A missing config DIRECTORY is a different fact:
  // it is where the app pointed, and nothing is ever going to be read from it.
  // The two were indistinguishable, so an app whose path was wrong booted on
  // defaults looking like it had loaded something — measured in `basecamp`,
  // which read `api/config` for its whole life without that directory existing
  // and took junction's default CORS every boot.
  //
  // A warning rather than a throw: `loadConfig()` is also called speculatively
  // by `createApp` for an app that legitimately keeps no config at all, and
  // refusing to boot over that would be a rule nobody asked for.
  if (!existsSync(absConfigDir)) {
    console.warn(
      `[Junction] no config directory at '${absConfigDir}' — booting on defaults. ` +
      `Create it with a junction.config.js, or pass the directory this app actually uses.`
    )
    return { ...deepClone(defaultConfig) as AppConfig, ...envOverrides() }
  }

  // Load default
  let config = deepClone(defaultConfig) as AppConfig & { _junction?: JunctionConfig }

  // Try junction.config.js first — the primary config file for FJS apps.
  // Its `app` section maps onto AppConfig; other sections stored under _junction.
  const junctionCfg = await tryImport(join(absConfigDir, 'junction.config.js')) as JunctionConfig | null
  if (junctionCfg) {
    if (junctionCfg.app)        config = deepMerge(config, junctionCfg.app) as typeof config
    if (junctionCfg.middleware?.cors)   config.http = deepMerge(config.http ?? {}, { cors: junctionCfg.middleware.cors } as Partial<typeof config.http>) as typeof config.http
    if (junctionCfg.middleware?.rateLimit) config.http = deepMerge(config.http ?? {}, { ddos: { enabled: true, ...junctionCfg.middleware.rateLimit } } as Partial<typeof config.http>) as typeof config.http
    // Straight through, because it maps 1:1 onto AppConfig. Everything not
    // named here is stashed under `_junction` and read by whichever subsystem
    // owns it — a section a reader forgets to look up is a config block that
    // silently does nothing (FJS-431), and the attachment check reads
    // `config.attachments`.
    if (junctionCfg.attachments) config.attachments = junctionCfg.attachments
    config._junction = junctionCfg
  }

  // Merge legacy default.ts / {env}.ts if present
  const appDefault = await tryImport(join(absConfigDir, 'default.ts'))
  if (appDefault) config = deepMerge(config, appDefault) as typeof config

  const envOverride = await tryImport(join(absConfigDir, `${env}.ts`))
  if (envOverride) config = deepMerge(config, envOverride) as typeof config

  return { ...config, ...envOverrides() }
}

/**
 * The env vars that beat every file, applied on both exits — the early return
 * for a missing directory takes them too, or pointing at a directory that is
 * not there would also silently drop `PORT`.
 */
function envOverrides(): Partial<AppConfig> {
  const out: Partial<AppConfig> = {}
  if (process.env.PORT)          out.port  = parseInt(process.env.PORT, 10)
  if (process.env.DEBUG === '1') out.debug = true
  return out
}

// ─── Deep merge ───────────────────────────────────────────────────────────
// Plain objects are merged. Arrays are replaced. Primitives are replaced.

/**
 * `Partial`, all the way down — what `deepMerge` actually accepts.
 *
 * A one-level `Partial<AppConfig>` says a caller must restate every key of
 * `http` to change one of them, which is the opposite of what this function
 * does with it. Arrays and functions are left whole, because deepMerge
 * replaces those rather than merging them.
 */
export type DeepPartial<T> = {
  [K in keyof T]?:
    T[K] extends readonly unknown[] ? T[K]
  : T[K] extends (...args: never[]) => unknown ? T[K]
  : T[K] extends object ? DeepPartial<T[K]>
  : T[K]
}

export function deepMerge<T extends object>(base: T, override: DeepPartial<T>): T {

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
