// example/web/config/sierra.config.js
export default {
  target:        'spa',
  routesDir:     'src/routes',
  trailingSlash: 'always',

  // The schema is found by convention — ../db/schema.lite, a sibling of web/,
  // the same file api/ reads. The build parses it with Litestone, generates the
  // JSON schema, and emits registerSchemas() into virtual:sierra, so every
  // resource is seeded before the first route module evaluates.

  junction: {
    // Where there is no page. A page calls its own origin, and Vite proxies
    // /api and /ws to the API process.
    url:       'http://localhost:8030',
    apiPrefix: '/api',
    tokenKey:  'sierra_example_token',
  },
}
