// site/config/sierra.config.js — frontierjs.com, prerendered.
//
// The public site is `site/`, a surface of the `website/` app root (Invariant
// 3). The app root holds the data the pages read, not pages.
//
// There is no `db` here and there must not be one. Nothing on this site reads
// the framework's database — the only data it has is checked into the repo
// beside it (packages.js, projects.json) — so no route has a `load()` that
// touches a Litestone client and the static-safety check has nothing to
// observe. A route that DOES grow one will be refused by the build until it
// either wires a client or writes `publishes:` in its own frontmatter, which is
// the correct outcome for a marketing site: nothing gated should ever be baked
// into a page a CDN holds.
export default {
  target:    'static',
  routesDir: 'src/routes',
  outDir:    'dist',

  // Without it the sitemap's <loc>s are relative, which no crawler accepts, and
  // robots.txt carries no Sitemap line.
  siteUrl:   'https://frontierjs.com',

  // A directory per route, so `/showroom/` is a folder holding index.html and a
  // relative link resolves from where its author meant it to.
  trailingSlash: 'always',

  // The switcher doubles as a live demo of @frontierjs/css, which is half the
  // reason this site exists — it is that package's second consumer. A subset of
  // the themes it ships.
  theme: {
    themes:  ['theme-default', 'theme-sunset', 'theme-forest', 'theme-midnight', 'theme-dark', 'theme-elite'],
    default: 'theme-default',
    persist: true,
    key:     'fjs-theme',
    apply:   'class',
  },

  // No theme class here — the theme block above puts it on <html>, which is
  // where the switcher writes. On <body> it would shadow the switcher for
  // every token both define (FJS-501).
  document: {},
}
