// config/index.ts
// Layered config system — default.ts + {NODE_ENV}.ts, deep merged.
// Config files are plain .ts — env vars, expressions, functions all valid.
// Fully typed via AppConfig interface.

import { join, resolve } from 'node:path'
import { existsSync }      from 'node:fs'
import type { TrustProxy } from '../transport/forwarded.ts'
import type { PageBounds } from '../core/directives.ts'

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
  // The page size of every model service that declares no `paginate` of its
  // own. Absent, `{ default: 20, max: 100 }`.
  paginate?:  PageBounds
  
  // Auth
  // HTTP
  http: {
    maxBodySize:  number    // bytes
    compress:     boolean
    /**
     * Seconds a connection may go without progress before the RUNTIME closes
     * it. Bun's own bound; its default is 10 and it could not be reached from
     * an app at all, so a request slower than that was reset with no status,
     * no body and no line in this app's log. 0 disables; above 255 is refused
     * at boot, because that is the runtime's ceiling.
     */
    idleTimeout?: number    // seconds, default 10 (the runtime's)
    /**
     * Milliseconds a handler may take before the app answers 503 itself.
     * Absent means no bound. Setting it also raises the runtime's per-request
     * timer, so this answer wins the race instead of the socket resetting.
     */
    requestTimeout?: number // ms, default off
    /**
     * Serve https from a PEM cert and key, given as paths. Development only:
     * a client that refuses `http://` (the Bitwarden CLI, localhost included)
     * needs the app itself to speak TLS, and in production a proxy does.
     */
    tls?: { cert: string; key: string }
    /**
     * Requests being handled at once before the next is refused 503 with
     * `Retry-After`. Counts requests, not sockets (Bun has no connection
     * hook); a WebSocket upgrade falls under `ws.maxConnections`. 0 or absent
     * is unlimited.
     */
    maxConcurrentRequests?: number
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
      // Directories a symlink inside `root` may resolve into. A link out of
      // the root is otherwise refused — it is served to anyone who can guess
      // the URL — and a shared assets directory is a real deployment, so it
      // is named rather than followed blindly (`FJS-746`).
      allowOutside?: string[]
      // Bytes strangers uploaded: anything outside the inline allow-list is
      // answered as an attachment (`FJS-D314`). The block reaches
      // `serveStatic` whole, so a key it reads is named here.
      untrusted?: boolean
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
     *
     * Undeclared, `FJS_TRUST_PROXY` in the environment supplies a hop count:
     * `fli deploy` and outpost pass it to a container they put Caddy in front
     * of (`FJS-D617`). A declared value wins over it.
     */
    trustProxy?:  TrustProxy
    // Security headers. On unless declared false — the opt-out an app writes
    // as `http: { helmet: false }`, which app.ts has always read and this
    // shape did not declare, so the typed form of the documented opt-out was
    // the one spelling that did not compile.
    helmet?:      boolean
    // The rest of the middleware an app declares rather than constructs.
    // `junction.config.js`'s `middleware:` section normalizes onto these, so
    // there is one shape the runtime reads and one place a phase looks. A key
    // declared in one file and read from another is typed, documented and
    // inert, and nothing reports it (`FJS-D256`).
    requestLogger?:  boolean | import('../transport/middleware.ts').RequestLoggerOptions
    correlationId?:  boolean | import('../transport/middleware.ts').CorrelationIdOptions
    csrf?:           import('../transport/middleware.ts').CsrfOptions
    rateLimit?:      import('../transport/middleware.ts').RateLimitOptions
    bodyLimit?:      { maxSize?: number }
    // Grace period (ms) between stop() and process.exit — lets in-flight
    // requests complete. Default 5000ms.
    drainTimeout?: number
    // How much junction holds for a WebSocket that is not draining before it
    // closes it. Default 8MB. Past Bun's own buffer a frame is
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
      reverifySeconds?:     number
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
   * which is what `fli deploy`'s configuration set already supplies per target. A
   * missing or half-bound service refuses at startup rather than at 3am on the
   * first request that reaches it. `core/attachments.ts` is the owner.
   */
  attachments?: import('../core/attachments.ts').Attachments

  /**
   * Junction's own plugins, declared rather than constructed (`FJS-D256`).
   *
   * `junction.config.js`'s `plugins:` section normalizes onto this. A plugin
   * needing CODE — health's `checks`, manifest's `db` — is configured by hand
   * instead and declared here NOT AT ALL: both is two owners for one route,
   * and `start()` refuses it by name.
   */
  plugins?: JunctionPluginsConfig

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
}

// ─── JunctionConfig — full junction.config.js shape ──────────────────────
// The config file uses friendly section names that map onto AppConfig.
// loadConfig() flattens these into a plain AppConfig for the app to use.

/**
 * The middleware an app DECLARES. Junction installs each one at `start()`.
 *
 * Everything here is data, which is what decides the section: a middleware
 * taking a function — `csrf`'s `onRejected`, a `rateLimit` keyed by a callback
 * — is constructed in `app.ts` and left out of this file entirely (`FJS-D256`).
 */
export interface JunctionMiddlewareConfig {
  // `credentials` is read by `applyConfiguredCors` and was undeclared, so a
  // config that works had a type saying it did not.
  cors?:          { origins?: string[]; methods?: string[]; headers?: string[]; credentials?: boolean; maxAge?: number }
  /**
   * The app's own per-call headers, ADDED to junction's CORS allow-list and
   * let through on a socket frame — lands on `http.callHeaders` (`FJS-1226`).
   */
  callHeaders?:   string[]
  helmet?:        boolean
  requestLogger?: boolean | { level?: 'info' | 'debug'; format?: 'common' | 'json' }
  correlationId?: boolean | { header?: string }
  rateLimit?:     { max: number; window: string | number; message?: string }
  bodyLimit?:     { maxSize?: number }
  /**
   * `true` borrows `middleware.cors.origins` as the origins besides the app's
   * own, and with no cors list allows the app's own origin only. Cookie mode
   * installs it undeclared (`FJS-D610`). A cors `'*'` is not borrowed, since
   * it names who may read; a `'*'` in `csrf.origins` refuses to start.
   */
  csrf?:          boolean | { origins?: string[]; methods?: string[]; allowMissingOrigin?: boolean }
}

/**
 * Junction's own plugins, declared rather than constructed.
 *
 * Same line as the middleware above: a plugin needing CODE is configured by
 * hand and does not appear here. `health.checks`, `health.authFn` and
 * `manifest.db` are the three that exist — and `manifest.db` is not a gap,
 * because a config-installed manifest is handed `app.db` already.
 */
export interface JunctionPluginsConfig {
  health?:   boolean | { path?: string; token?: string; checkTimeout?: number }
  manifest?: boolean | { path?: string; devOnly?: boolean }
  openapi?:  boolean | { title?: string; version?: string; description?: string; path?: string; ui?: boolean | string }
  devtools?: boolean | { port?: number; hostname?: string; maxEntries?: number }
}

export interface JunctionCaravanConfig {
  db?:           string
  busyTimeout?:  number
  synchronous?:  'NORMAL' | 'FULL'
  pollInterval?: number
  cleanupAfter?: number
  drainTimeout?: number
  heartbeat?:    number
  lease?:        number
  queues?:       Record<string, { concurrency?: number }>
  admin?:        boolean | { path?: string; secret?: string }
}

export interface JunctionConfig {
  app?:        Partial<AppConfig>
  middleware?: JunctionMiddlewareConfig
  plugins?:    JunctionPluginsConfig
  caravan?:    JunctionCaravanConfig

  /**
   * Third-party services this app needs and does not own. Maps straight onto
   * `AppConfig.attachments` — it is a declaration about the app rather than a
   * section for a subsystem, so it is one of the few keys here with no
   * translation.
   */
  attachments?: import('../core/attachments.ts').Attachments
}

// ─── What a junction.config.js may declare ────────────────────────────────

/**
 * The sections `junction.config.js` has, and the only list of them.
 *
 * A section this does not name is stashed under `_junction` and read by
 * nothing, so `plugin:` for `plugins:` and `middlewares:` for `middleware:`
 * both merge with no error and no warning — the app boots on defaults looking
 * like it loaded something (`FJS-431`'s shape, ruled `FJS-D199`).
 *
 * The keys INSIDE a section are not read off the interfaces above, which are
 * erased at runtime and drift from what reads them (`middleware.cors.credentials`
 * was read and undeclared). Each is a list its reader exports and `unknownKeys`
 * checks (`FJS-940`, `FJS-D483`).
 */
export const JUNCTION_SECTIONS = [
  'app', 'middleware', 'plugins', 'caravan', 'attachments',
] as const

/**
 * The keys of the sections junction itself reads, and the only list of each
 * (`FJS-D483`): the reader owns what it reads. A section owned by a plugin
 * states its own through `Plugin.configKeys`.
 *
 * `rateLimit` is the MIDDLEWARE and not the transport's `ddos` guard. Two
 * different layers on purpose — `ddos` is per-IP ahead of the router, this is
 * per-route behind it — and the transport is constructed before `load-config`
 * runs, so a value routed there from this file arrives after the only reader
 * has taken its copy (`FJS-1066`).
 */
export const MIDDLEWARE_CONFIG_KEYS = [
  'cors', 'rateLimit', 'callHeaders', 'helmet', 'requestLogger', 'correlationId', 'csrf', 'bodyLimit',
] as const satisfies ReadonlyArray<keyof JunctionMiddlewareConfig>

export const PLUGINS_CONFIG_KEYS = [
  'health', 'manifest', 'openapi', 'devtools',
] as const satisfies ReadonlyArray<keyof JunctionPluginsConfig>

/** Section → the keys junction reads in it. `app` and `attachments` are open shapes and have no entry. */
const OWN_SECTION_KEYS: Record<string, readonly string[]> = {
  middleware: MIDDLEWARE_CONFIG_KEYS,
  plugins:    PLUGINS_CONFIG_KEYS,
}

/** The candidate nearest to `key` by edit distance, or null when none is close. */
function nearestOf(key: string, known: readonly string[]): string | null {
  let nearest: string | null = null
  let best = Math.floor(key.length / 2) + 1
  for (const candidate of known) {
    const d = editDistance(key, candidate)
    if (d < best) { best = d; nearest = candidate }
  }
  return nearest
}

/**
 * Sections of a `junction.config.js` nothing will read, each with the nearest
 * name that would have been read. `owned` names the sections plugins configured
 * on this app read, which are sections too.
 *
 * Nearest by edit distance rather than by a table of known typos: a table can
 * only ever name the mistakes somebody already made. A suggestion is offered
 * only when it is closer than half the word, so an unrelated key is reported
 * as unknown rather than corrected towards something the author never meant.
 */
export function unknownSections(cfg: unknown, owned: readonly string[] = []): Array<{ key: string; nearest: string | null }> {
  if (!isPlainObject(cfg)) return []
  const known = [...JUNCTION_SECTIONS, ...owned] as readonly string[]
  const out: Array<{ key: string; nearest: string | null }> = []
  for (const key of Object.keys(cfg)) {
    if (known.includes(key)) continue
    out.push({ key, nearest: nearestOf(key, known) })
  }
  return out
}

/**
 * Keys inside a section that nothing reads. `owners` is what plugins state
 * through `configKeys`, by section name; junction's own sections are added
 * here. A section with no list is not checked, since a check without an owner
 * is a second origin (`FJS-D483`).
 */
export function unknownKeys(
  cfg: unknown,
  owners: Record<string, readonly string[]> = {},
): Array<{ section: string; key: string; nearest: string | null }> {
  if (!isPlainObject(cfg)) return []
  const lists = { ...owners, ...OWN_SECTION_KEYS }
  const out: Array<{ section: string; key: string; nearest: string | null }> = []
  for (const [section, known] of Object.entries(lists)) {
    const body = (cfg as Record<string, unknown>)[section]
    if (!isPlainObject(body)) continue
    for (const key of Object.keys(body)) {
      if (!known.includes(key)) out.push({ section, key, nearest: nearestOf(key, known) })
    }
  }
  return out
}

/** Levenshtein, iterative, one row at a time. */
function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
    }
    prev = row
  }
  return prev[b.length]
}

// ─── Config loader ────────────────────────────────────────────────────────

/** `null` is an app with no root: defaults and the environment, no file. */
export async function loadConfig(configDir: string | null): Promise<AppConfig & { _junction?: JunctionConfig }> {
  if (configDir === null) return { ...deepClone(defaultConfig) as AppConfig, ...envOverrides() }

  // Absolute, because dynamic import() resolves against this file, not the app.
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
    // Every `middleware:` key normalizes onto `config.http`, which is the one
    // shape the start phases read. A key missing from MIDDLEWARE_CONFIG_KEYS is
    // declarable and inert — `helmet` sits one letter from the `http.helmet`
    // that is read, so the miss looks like a working opt-out (`FJS-D256`).
    //
    // Mapped one listed key at a time rather than spread wholesale: a section
    // that merged itself in would carry a typo through as an extension key.
    const mw = junctionCfg.middleware
    if (mw) {
      const http: Record<string, unknown> = {}
      for (const key of MIDDLEWARE_CONFIG_KEYS) {
        if (mw[key] !== undefined) http[key] = mw[key]
      }
      config.http = deepMerge(config.http ?? {}, http as Partial<typeof config.http>) as typeof config.http
    }
    if (junctionCfg.plugins) config.plugins = deepMerge(config.plugins ?? {}, junctionCfg.plugins) as JunctionPluginsConfig
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
  // PORT is a deploy's word and FLI_PORT_BE the broker's (`fli dev`), so an
  // app that reads neither itself still lands on the slot it was handed.
  const port = process.env.PORT || process.env.FLI_PORT_BE
  if (port)                      out.port  = parseInt(port, 10)
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
    if (!Object.hasOwn(override, key)) continue

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

/**
 * The parse, with no opinion about what an unreadable value means.
 *
 * Split from `parseTtl` rather than duplicated: a caller that must REFUSE an
 * unreadable duration (`scheduler.every`, where the 5-minute fallback turned
 * `every('nonsense')` into a job on a schedule nobody wrote) needs to know the
 * parse failed, and a caller that wants the fallback keeps it. One
 * implementation, two entry points, no second grammar.
 */
export function parseTtlOrNull(ttl: string): number | null {
  const parsed = parseTtlImpl(ttl)
  return parsed
}

export function parseTtl(ttl: string): number {
  // The fallback every existing caller has always had.
  return parseTtlImpl(ttl) ?? 300_000
}

function parseTtlImpl(ttl: string): number | null {
  // '5 minutes' → 300000
  // '1h' → 3600000
  // '30s' → 30000
  // raw ms number string → ms
  const n = parseInt(ttl, 10)
  if (Number.isNaN(n)) return null

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
