// web/config/sierra.config.js
//
// Configuration lives in config/, beside vite.config.js — the standard FJS
// layout (config/ src/ public/ test/ dist/). Sierra looks for this file next to
// vite.config.js first, so nesting needs no _configPath escape hatch.
export default {
  target:        'spa',
  routesDir:     'src/routes',
  trailingSlash: 'always',

  // The schema is found by convention — ../db/schema.lite, a sibling of web/,
  // the same file api/ reads. The build parses it with Litestone, generates the
  // JSON schema and emits registerSchemas() into virtual:sierra, so every
  // resource is seeded before the first route module evaluates. That is why
  // web/ sits one level down from the package root (repo invariant 3) — do not
  // flatten it.

  junction: {
    // Same origin as the page: Vite proxies the API paths to :3001.
    url: typeof location !== 'undefined' ? location.origin : 'http://localhost:5274',

    // Both of these are the client's own defaults, spelled out because they are
    // load-bearing. Basecamp mounts services at /{service} (junction's default
    // apiPrefix, ''), and @frontierjs/auth at /auth. The API carried an /api
    // prefix on auth and setup until 2026-08-04; it was removed precisely so
    // these two lines could be the defaults rather than an app-specific pairing.
    apiPrefix:  '',
    authPrefix: '/auth',

    tokenKey: 'basecamp_token',
  },
}
