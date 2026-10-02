// content/settings/site.js — what makes this site frontierjs.com rather than
// any other site-kit site. Everything else in the Sierra config is site-kit's
// (packages/site-kit/config/vite.js).
//
// The browser imports this file whole to read `theme` (FJS-1544), so it stays
// plain data: an import here ships to every visitor.
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
  // Without it the sitemap's <loc>s are relative, which no crawler accepts, and
  // robots.txt carries no Sitemap line.
  siteUrl: 'https://frontierjs.com',

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
}
