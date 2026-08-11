// web/config/sierra.config.js
export default {
  target:        'spa',
  routesDir:     'src/routes',
  trailingSlash: 'always',

  // The schema is found by convention: ../db/schema.lite, a sibling of web/ —
  // the same file api/db.ts reads. The build parses it with Litestone, generates
  // the JSON Schema and emits registerSchemas() into virtual:sierra, so every
  // resource is seeded before the first route module evaluates. The build prints
  // which file it found.

  junction: {
    // Same origin as the page: Vite proxies /api, /auth, /session and /ws.
    url:       typeof location !== 'undefined' ? location.origin : 'http://localhost:8010',
    apiPrefix: '/api',
    tokenKey:  'shop_token',
  },
}
