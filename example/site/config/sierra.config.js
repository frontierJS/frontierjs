// site/config/sierra.config.js
//
// The public storefront: the pages a stranger and a search engine see.
// One config is one target, and paths here are relative to the Vite root — the
// site/ surface — since every site command is run from it.
//
// This used to be `web/config/sierra.static.config.js`, a second target inside
// the SPA's own Vite root. It is a surface of its own now (`FJS-D127`), and the
// argument that settled it was OUTPUT: one Vite root is one `dist/`, and Vite
// empties `outDir`, so `bun run build` deleted the prerendered site. Silent,
// order-dependent, and indistinguishable from a stale build.
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
// down and a reviewer can see.
//
// `api/src/core/db.ts` is the app's real client, gates and all. It is the same module the
// API boots from, so there is no second definition of what this app's data is.
export default {
  target:    'static',
  routesDir: 'src/routes',
  outDir:    'dist',

  // A directory per route: `/products/explorer-tee/` is a folder holding
  // index.html. It is what a static host serves with no rewrite rules, and it
  // keeps a relative link from resolving one level up from where its author
  // meant it to.
  trailingSlash: 'always',

  db: '../api/src/core/db.ts',

  // The document Sierra wraps each prerendered page in. The stylesheets the
  // build emits are linked automatically; this is the other half of what
  // `index.html` does for the SPA — the theme is a class on <body>, so without
  // it a prerendered page renders in the token defaults and no brand color.
  // The theme is BAKED here rather than switched. A prerendered page has no
  // switcher and its first paint must be right with no JavaScript at all, so
  // the class goes in the file — which is the same class the SPA's `theme:`
  // block applies at runtime, not a second mechanism.
  document: { bodyClass: 'app theme-default' },
}
