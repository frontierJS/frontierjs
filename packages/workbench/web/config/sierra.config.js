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

  // Every theme @frontierjs/css ships, picked at /settings/. theme-dark stays
  // the default rather than 'system': a fresh install opens dark on any OS.
  theme: {
    themes: [
      'theme-dark', 'theme-default', 'theme-midnight', 'theme-forest',
      'theme-sunset', 'theme-elite', 'theme-dracula', 'theme-twilight',
      'theme-notebook', 'theme-press', 'theme-field', 'theme-expedition',
      'theme-catppuccin', 'theme-survey', 'theme-basecamp',
    ],
    default: 'theme-dark',
    // Unstated, the pair is the first two themes as light then dark, and this
    // list leads with theme-dark: "Match system" would pick the inverse.
    system:  { light: 'theme-default', dark: 'theme-dark' },
  },

  junction: {
    // Where there is no page. A page calls its own origin, which Vite proxies to
    // :5501 (config/vite.config.js).
    url:        'http://localhost:5501',
    apiPrefix:  '',
    tokenKey:   'workbench_token',
  },
}
