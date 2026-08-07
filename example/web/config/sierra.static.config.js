// web/config/sierra.static.config.js
//
// A SECOND target for this app: the public, prerendered part of the shop.
//
// The SPA (sierra.config.js) is the signed-in application. This one emits plain
// HTML for the pages a stranger and a search engine see — no session, no
// script, nothing to hydrate.
//
// It is a separate config with its OWN routesDir rather than `render: static`
// frontmatter inside `src/routes/`, so the SPA's route table is untouched and
// `bun run verify`'s 37 browser checks keep testing exactly what they tested
// before.
//
// ── Why `db` is here ──────────────────────────────────────────────────────
//
// This is the point of the file. A prerendered page is PUBLIC: whatever `load()`
// put in it is served to anyone, cached by a CDN and indexed, and cannot be
// recalled. Sierra refuses to emit a static page unless it can say what data
// went into it (ISSUES.md FJS-081), and `db` is how it finds out — the build
// taps this client with `$tapQuery` while `load()` runs and compares every model
// read against that model's `@@gate` in the schema.
//
// Without `db`, a route with a `load()` is refused rather than assumed safe, and
// the only way past is to write `publishes:` in the route's own frontmatter —
// which is the point: publishing gated data should be a thing somebody wrote
// down and a reviewer can see, not a thing that happened.
//
// `api/db.ts` is the app's real client, gates and all. It is the same module the
// API boots from, so there is no second definition of what this app's data is.
export default {
  target:        'static',
  routesDir:     'src/public-site',
  outDir:        'dist/public',
  trailingSlash: 'always',

  db: '../api/db.ts',

  // The document Sierra wraps each prerendered page in. The stylesheets the
  // build emits are linked automatically; this is the other half of what
  // `index.html` does for the SPA — the theme is a class on <body>, so without
  // it a prerendered page renders in the token defaults and no brand colour.
  document: { bodyClass: 'app theme-default' },
}
