// web/config/sierra.config.js
//
// Configuration lives in config/, beside vite.config.js. The schema is found by
// convention -- ../db/schema.lite, the file api/ reads -- so web/ sits one level
// down from the package root (repo invariant 3); do not flatten it.
export default {
  target:        'spa',
  routesDir:     'src/routes',
  trailingSlash: 'always',
  siteName:      'Workbench',

  theme: {
    themes:  ['theme-dark', 'theme-default'],
    default: 'theme-dark',
  },

  junction: {
    // Where there is no page. A page calls its own origin, which Vite proxies to
    // :5501 (config/vite.config.js).
    url:        'http://localhost:5501',
    apiPrefix:  '',
    tokenKey:   'workbench_token',
  },
}
