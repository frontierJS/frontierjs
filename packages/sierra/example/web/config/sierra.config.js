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
    // Same origin as the page: Vite proxies /api and /ws to the API process.
    url:       typeof location !== 'undefined' ? location.origin : 'http://localhost:5273',
    apiPrefix: '/api',
    tokenKey:  'sierra_example_token',
  },
}
