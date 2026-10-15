// web/config/sierra.config.js
//
// Haven's client: one set of routes, two targets (`FJS-D985`). `fli haven`
// and `fli dev:tui` compile them for the terminal from this directory, and
// `--api` names a server other than the default below; `bun run web` (or
// `fli dev`) builds the same routes for a browser through config/vite.config.js.
// What differs per target is three modules, picked by the package's `imports`
// conditions rather than by anything here: `#paint`, `#cell` and `#sign-in`.
export default {
  target:        'spa',
  routesDir:     'src/routes',
  trailingSlash: 'always',
  siteName:      'Haven',

  // The schema is ../db/schema.lite by convention, the file api/ reads, so
  // every resource is seeded with the server's field rules.
  junction: {
    // The terminal's: it has no page, so it knocks on Haven's slot in the
    // global tooling block (`docs/PORTS.md`), a tool run beside whatever app is
    // open, so the number never moves. A page talks to its own origin, which
    // the dev server proxies to the API (config/vite.config.js).
    url:      'http://localhost:5505',
    tokenKey: 'haven_token',
  },
}
