// @frontierjs/testing — the Testing realm's environment.
//
// One `createTestEnv` across two realms. Litestone's version owns the Data half
// (a migrated database from a template clone, factories, `actingAs`, `atLevel`,
// the gate ladder, `setup`/`phases`); this adds the API half, which Litestone
// cannot: mounting a Junction app means importing Junction, and the dependency
// direction is Litestone ← Junction ← Sierra (Invariant 1).
//
//   const env = await createTestEnv({
//     schema:     'db/schema.lite',
//     migrations: 'db/migrations',
//     plugins:    [appGate],
//     api:        ({ db }) => buildApp(db),
//   })
//
//   const t = env.phases({ as: developer })
//   const lead = await t.arrange(({ factories }) => factories.lead.createOne())
//   await t.act(() => env.as(developer).service('leads').remove(lead.id))
//   await t.assert(read => expect(read.lead.count()).resolves.toBe(0))
//   expect(env.announced('leads:removed')).toHaveLength(1)
//
// ── Why the API tier is not the same test ────────────────────────────────────
//
// A Data-realm test grades the caller with the app's own `getLevel` and stops
// there. Above the boundary there is more derivation than that: Junction builds
// a `SessionContext`, `toDataPrincipal()` renames `userId` to `id`, and
// `withLitestoneDb` re-derives the scoped client from `ctx.auth.user` per call.
// Every one of those is a place a principal can arrive correct and land wrong,
// and none of them is reachable from `@frontierjs/litestone/testing`. `env.as(user)`
// puts a user through all of it — the same path a request takes, minus the socket.
//
// ── What this package deliberately does not do ───────────────────────────────
//
// It does not restate Junction's HTTP helper. `env.http` IS `request(app)` from
// `@frontierjs/junction/testing` — the full middleware → router → bridge → service
// pipeline with no port bound. A second copy would be one more thing to drift.

import { createTestEnv as createDataEnv } from '@frontierjs/litestone/testing'
import { request }                        from '@frontierjs/junction/testing'
import { verifyTransportParity }          from './parity.ts'
import type { ParityOptions, ParityMismatch } from './parity.ts'
import type { App }                       from '@frontierjs/junction'
import type { SessionContext }            from '@frontierjs/junction/auth'

export * from '@frontierjs/litestone/testing'
export { request, createStubAuth, testCtx, withTestMeta } from '@frontierjs/junction/testing'
export { verifyTransportParity } from './parity.ts'
export type { ParityCall, ParityPrincipal, ParityMismatch, ParityOptions } from './parity.ts'

// ─── types ────────────────────────────────────────────────────────────────────

/** What an `api` factory is handed — the same tools `setup`/`arrange` get. */
export interface ApiFactoryTools {
  /** The unscoped Litestone client. Pass this to `createApp({ db })`. */
  db:        unknown
  /** `db.asSystem()`. */
  system:    unknown
  factories: Record<string, unknown>
  schema:    unknown
  /** The main database file, for an app that wants a path rather than a client. */
  path:      string
  /** The throwaway directory holding this env's databases. */
  dir:       string
}

/** One announcement, exactly as `callService` put it on the bus. */
export interface Announcement {
  /** `'leads:created'` for CRUD, `'orders:pay'` for a custom method. */
  event: string
  data:  unknown
}

/**
 * A service caller bound to a principal. Every call carries `{ auth: { user } }`,
 * so the app's own hooks, gate and scoped client derive from it exactly as they
 * do for a request.
 */
export interface BoundCaller {
  service(name: string): ReturnType<App['service']>
}

export interface ApiTestEnvOptions extends Record<string, unknown> {
  schema:      string
  migrations?: string | string[]
  /**
   * The Junction app under test — an already-built one, or a factory handed the
   * Data-realm tools. A factory is the usual shape, because an app is built over
   * a client and the client does not exist until this call.
   */
  api?: App | ((tools: ApiFactoryTools) => App | Promise<App>)
  /**
   * Bind a real port and serve. Off by default — `env.as()` and `env.http` both
   * reach the whole pipeline without one, and a bound port is the only thing in
   * this env that another process can collide with.
   *
   * The port is asked for as 0 and read back, so parallel suites cannot collide
   * at all. A number binds that port instead, for a test that needs a URL a
   * browser was told about in advance.
   */
  listen?: boolean | number
}

// ─── binding the principal ────────────────────────────────────────────────────
//
// Where `CallOptions` sits in each `ServiceCaller` method — the one place the
// principal can be attached. Stated rather than inferred: the position varies
// (`find(query, opts)` vs `patch(id, data, opts)`), an overload with a defaulted
// argument makes `fn.length` lie, and "the last argument if it looks like
// options" mistakes `create({ auth: … })` for a call option.
//
// A method missing from this table is REFUSED, not guessed. Junction's
// ServiceCaller is the source; adding a method there and not here is a loud
// error in one test rather than a silent anonymous call in every test.

const OPTS_AT: Record<string, number> = {
  find: 1, get: 1, create: 1, remove: 1, restore: 1,
  patch: 2, update: 2,
  call: 3,
  // Hook-bypass twins — same signatures, minus the pipeline.
  _find: 1, _get: 1, _create: 1, _remove: 1, _restore: 1,
  _patch: 2,
}

// ─── createTestEnv ────────────────────────────────────────────────────────────

export async function createTestEnv(opts: ApiTestEnvOptions): Promise<Record<string, unknown>> {
  const { api, listen, ...dataOpts } = opts

  const base = await createDataEnv(dataOpts as { schema: string }) as Record<string, any>

  if (!api) return base

  const app: App = typeof api === 'function'
    ? await api({
        db:        base.db,
        system:    base.system,
        factories: base.factories,
        schema:    base.schema,
        path:      base.path,
        dir:       base.dir,
      })
    : api

  // Plugins register, hooks compile, service routes mount — the whole start
  // list except the phases needing a port. Eagerly, not on first request: an
  // internal `env.as(u).service('x')` call must meet the same pipeline the wire
  // meets, and a plugin's guard that has not registered yet refuses nothing.
  await app._startForTest()

  // ── The port, when one is asked for ────────────────────────────────────────
  // `_startForTest()` skips the `listen` phase along with everything else that
  // needs a host; this is that one phase, run on its own. The alternative —
  // `app.start()` — also loads config from the working directory, autoloads
  // services from beside `Bun.main` (the test runner) and installs process
  // signal handlers, none of which belongs to a test that wanted a socket.
  const server = listen ? app.http.start(listen === true ? 0 : listen) : null
  const port   = server ? app.http.port : null
  const url    = port ? `http://127.0.0.1:${port}` : null

  // ── Announcements ──────────────────────────────────────────────────────────
  // `callService` is the one origin (Invariant 4) and puts every mutation on
  // `app.events` as `<service>:<past>`. Buffering here rather than asking the
  // caller to subscribe is what makes the assertion a question instead of a
  // setup step; clearing it at the top of `act` is what makes it exact — the
  // alternative is "everything since the test began", with arrange's writes in it.
  const announcements: Announcement[] = []
  const unsubscribe = app.events.onAny((event: string, data: unknown) => {
    // `app:*` and `junction.*` are lifecycle and telemetry, not announcements.
    // A test asking what its act announced does not mean the app booting.
    if (event.startsWith('app:') || event.startsWith('junction.')) return
    announcements.push({ event, data })
  })

  const callerFor = (user: unknown): BoundCaller => ({
    service(name: string) {
      const caller = app.service(name) as Record<string, any>

      // Asked here rather than per call, because here is where a real caller
      // exists to ask. A method Junction adds and this does not know about
      // would otherwise be bound at a guessed position — and a guess that lands
      // wrong runs the call as STRANGER, which reads as an empty list rather
      // than an error.
      const unknown = Object.keys(caller)
        .filter(k => typeof caller[k] === 'function' && OPTS_AT[k] === undefined)
      if (unknown.length) throw new Error(
        `@frontierjs/testing: Junction's ServiceCaller has ${unknown.length} method(s) this ` +
        `does not know how to bind a principal to — ${unknown.join(', ')}. Add each to OPTS_AT ` +
        `in @frontierjs/testing/src/index.ts with the argument index its CallOptions sits at. ` +
        `Refused rather than guessed: a call bound at the wrong argument runs anonymous, and ` +
        `an empty result reads as a correct answer.`
      )

      // Bind the principal into every call rather than asking each test to pass
      // it. Threading it by hand is the shape of FJS-097: one call that forgets
      // runs as STRANGER, the gate refuses, the policy filters to nothing, and
      // the test reads an empty list as a correct answer.
      return new Proxy({}, {
        get(_, method: string | symbol) {
          if (typeof method !== 'string') return undefined
          const fn = caller[method]
          if (typeof fn !== 'function') return fn
          const at = OPTS_AT[method] as number

          return (...args: unknown[]) => {
            const bound = args.slice()
            while (bound.length < at) bound.push(undefined)
            const stated = bound[at] as Record<string, unknown> | undefined
            bound[at] = { ...(stated ?? {}), auth: { user } }
            return fn(...bound)
          }
        },
      }) as ReturnType<App['service']>
    },
  })

  return {
    ...base,

    app,

    /** A service caller bound to a principal — the full request path, no socket. */
    as: callerFor,

    /** A caller with no principal. STRANGER(0), which is what a job or a stray fetch is. */
    service: (name: string) => callerFor(null).service(name),

    /**
     * Junction's own HTTP helper against this app, unchanged. Auth is the app's
     * to issue: `env.http.get('/leads').auth(token)`.
     */
    http: request(app),

    /** The bound origin, or null without `listen`. `http://127.0.0.1:<port>`. */
    url,
    port,

    /**
     * HTTP and WS answering the same call the same way, over a real socket.
     * Needs `listen: true`, and needs the app to `configure(channels())` —
     * without it the client falls back to HTTP and compares HTTP against HTTP.
     */
    verifyTransportParity: (parityOpts: ParityOptions = {}): Promise<ParityMismatch[]> => {
      if (!url) throw new Error(
        'verifyTransportParity: this env has no port. Pass `listen: true` to createTestEnv. ' +
        'The whole claim is that a real socket and a real request agree, so `request(app)` ' +
        'cannot stand in for one of them.'
      )
      return verifyTransportParity(
        { app, url, db: base.db, system: base.system, schema: base.schema },
        parityOpts,
      )
    },

    /** Everything `callService` announced since the current act began. */
    announced: (event?: string) =>
      event ? announcements.filter(a => a.event === event) : [...announcements],

    clearAnnounced: () => { announcements.length = 0 },

    phases: (phaseOpts: { as?: unknown } = {}) => {
      const t = base.phases(phaseOpts) as Record<string, any>
      return {
        ...t,
        act: (fn: (as: unknown) => unknown) => {
          // The act boundary IS the announcement window. Arrange writes through
          // `asSystem()`, below the boundary, and announces nothing — but an
          // arrange that goes through a service does, and that is not what the
          // assertion is about.
          announcements.length = 0
          return t.act(fn)
        },
      }
    },

    close: async () => {
      unsubscribe()
      // Force, and before app.stop(). Bun's graceful stop never closes a
      // WebSocket and one never drains on its own, so shutting down with a live
      // socket waits the whole drain window — 5s by default, which is longer
      // than most suites give an afterAll hook and reads as a hang.
      server?.stop(true)
      await app.stop().catch(() => {})
      base.close()
    },
  }
}

// ─── session ──────────────────────────────────────────────────────────────────

/**
 * A `SessionContext` from the fields a test cares about. The required three
 * (`userId`, `userType`, `authMethod`) are filled, and nothing else is invented:
 * the standing fields grade a caller through `sessionGateLevel()`, where absent
 * means *the app does not model this stage* and only `null` grades down. A
 * helper that defaulted `verifiedAt: null` would silently drop every session it
 * built to VISITOR(1).
 */
export function session(fields: Partial<SessionContext> & { userId?: string } = {}): SessionContext {
  return {
    userId:     fields.userId   ?? 'test-user',
    userType:   fields.userType ?? 'user',
    authMethod: fields.authMethod ?? 'session',
    ...fields,
  }
}
