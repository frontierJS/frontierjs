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

  junction: {
    // Same origin as the page while Vite proxies /api and /ws. An API on its own
    // origin, or a build a native shell bundles, is named at build time with
    // VITE_API_URL. Guarded twice because Vite also loads this file in Node.
    url:       import.meta.env?.VITE_API_URL ?? (typeof location !== 'undefined' ? location.origin : 'http://localhost:8010'),
    apiPrefix: '/api',
    tokenKey:  'shop_token',
  },
}
