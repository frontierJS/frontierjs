// web/config/sierra.config.js
export default {
  target:        'spa',
  routesDir:     'src/routes',
  trailingSlash: 'always',

  // The schema is found by convention: ../db/schema.lite, a sibling of web/ —
  // the same file api/src/core/db.ts reads. The build parses it with Litestone, generates
  // the JSON Schema and emits registerSchemas() into virtual:sierra, so every
  // resource is seeded before the first route module evaluates. The build prints
  // which file it found.

  // The themes this app offers, and the key they persist under. Sierra puts the
  // class on <html> and emits a <head> script that applies the stored one
  // BEFORE first paint — the one part an app cannot write for itself, since
  // anything it runs happens after its own bundle has loaded and every reader
  // on a non-default theme would see the default first.
  theme: {
    themes: [
      'theme-default', 'theme-dark', 'theme-forest',
      'theme-midnight', 'theme-sunset', 'theme-elite',
    ],
    default: 'theme-default',
    key:     'shop_theme',
  },

  // The app opens with no network: sierra writes `sw.js` from what this build
  // emitted and registers it from every page (`IDEAS/homestead.md` phase 3).
  // Opt-in with one word, because a service worker is the longest-lived thing a
  // build can leave on somebody's device.
  //
  // It answers for precached files and for navigations, and for nothing else —
  // `/api` and `/ws` are never in its path, so a read is never served from a
  // cache the live layer does not know about. A write made offline is the
  // pending queue's job (`FJS-D298`), not this.
  // `db: true` adds the device's own SQLite beside the shell — the `@@sync`
  // models in a worker over OPFS (`FJS-D307`), so a read offline is a real
  // query rather than a replay of the exact list that was asked for last.
  offline: { db: true },

  // The toolbar in the corner, dev server only — routes, live stores, the call
  // feed and the N+1 warning. Its only source of data is junction's own
  // `devtools()` plugin on 8503, which `bun run api` turns on here, so the
  // block is the opt-in: declaring it is what injects the script, and an app
  // without a console must not have a toolbar retrying a socket nobody holds.
  devtools: {},

  junction: {
    // Same origin as the page while Vite proxies /api and /ws. An API on its own
    // origin, or a build a native shell bundles, is named at build time with
    // VITE_API_URL. Guarded twice because Vite also loads this file in Node.
    url:       import.meta.env?.VITE_API_URL ?? (typeof location !== 'undefined' ? location.origin : 'http://localhost:8010'),
    apiPrefix: '/api',
    tokenKey:  'shop_token',
    // Every call logged to the browser console — `{ request }` on the way out,
    // `{ response }` with its duration coming back, both transports. It is the
    // answer the toolbar's feed cannot give: junction's telemetry event carries
    // no payload, so the console on 8503 knows a call happened and not what it
    // returned.
    //
    // Opt-in per app and not per dev session, because devtools retains every
    // object logged: on a socket-heavy screen each response stays reachable for
    // the life of the tab, which skews a memory profile taken beside it.
    debug: true,
  },
}
