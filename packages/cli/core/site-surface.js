/**
 * core/site-surface.js — what a `site/` surface IS.
 *
 * The one owner of the site surface's shape, called by `fli make:site` and by
 * `fli new --site`. Two generators writing the same directory is how an app
 * scaffolded one way ends up unable to run the command that extends it.
 *
 * ── Why a public site is a surface and not a routesDir in web/ ────────────
 *
 * `site/` sits at the app root beside `api/` and `web/`, with the same six
 * directories every sub-project has. Invariant 3's test is whether config,
 * tests and release are a different set of answers from the SPA's, and here
 * all three are:
 *
 *   • **Config** — `target: 'static'`, which is a different BUILD: the bundle
 *     is the SPA's, and then every route declaring `render: static` is
 *     prerendered to its own HTML file. It also carries two keys the SPA has
 *     no use for — `db`, so the build can tap what `load()` read and refuse to
 *     publish anything gated (FJS-081), and `document`, because a prerendered
 *     page has no `index.html` to inherit a body class from.
 *   • **Testing** — the SPA is proved by driving a running app. This is proved
 *     against FILES: one per route, with the data already in them, plus the
 *     islands that come alive when a browser parses one. A page that renders
 *     perfectly and mounts nothing is the failure, and it is invisible to
 *     every assertion the SPA's drive makes.
 *   • **Release** — a bucket and a CDN, with no application server behind it.
 *     It ships when the content changes, which is not when the API ships, and
 *     it is reachable when the API is down.
 *
 * The fourth answer is the one that made this a defect rather than a
 * preference: **output**. Folded into `web/` the two builds share a Vite root,
 * so the static site's `outDir` lands inside the SPA's `dist/` — and Vite
 * empties `outDir` by default, so building the SPA deletes the site. Nothing
 * says so; the next command just tests a directory that is not there.
 *
 * ── Dev is an SPA, the build is files ─────────────────────────────────────
 *
 * `target: 'static'` uses the SPA's Vite config and prerenders afterwards, so
 * `vite dev` here serves the site as a client-routed application against
 * `index.html`. That is the writing loop. What SHIPS is the build, and only
 * the build has prerendered HTML, publish checks and islands — so a change to
 * a `load()` or to frontmatter is proved by building, never by the dev server.
 *
 * An app may have this surface and no `web/` at all: a project whose whole
 * product is a public site with live islands is a normal FrontierJS project,
 * and `db/` + `api/` + `site/` is its layout.
 */

import { frontmatterValue } from './compiler.js'
import {
  scaffoldPort, writeAbsent, viteScript, surfaceViteConfig, surfaceIndexHtml, surfaceServe, surfaceDockerfile,
} from './scaffold/surface.js'

/** The six, minus the ones a build writes. `dist/` is output, never scaffolded. */
export const SITE_SURFACE_DIRS = [
  'config',
  'src/routes',
  'src/islands',
  'src/components',
  'public',
  'test',
  'deploy',
]

// ─── config ───────────────────────────────────────────────────────────────────

export function siteSierraConfig({ hasApi = true } = {}) {
  const dbLine = hasApi
    ? `
  // ── Why \`db\` is here ────────────────────────────────────────────────────
  //
  // A prerendered page is PUBLIC: whatever load() put in it is served to
  // anyone, cached by a CDN and indexed, and cannot be recalled. Sierra
  // refuses to emit a static page unless it can say what data went into it —
  // it taps this client with $tapQuery while load() runs and compares every
  // model read against that model's @@gate.
  //
  // Without it, a route with a load() is REFUSED rather than assumed safe, and
  // the only way past is \`publishes: N\` in that route's own frontmatter, which
  // is the point: publishing gated data should be something somebody wrote
  // down and a reviewer can see.
  //
  // Point it at the app's real client, gates and all — the same module the API
  // boots from, so there is no second definition of what this app's data is.
  db: '../api/src/core/db.ts',
`
    : `
  // No API in this app, so nothing to tap. Add \`db: '../api/src/core/db.ts'\`
  // the day a load() reads the database: without it Sierra cannot say what a
  // page published and refuses to emit one that read anything.
`

  return `// site/config/sierra.config.js
// One config is one target. Paths are relative to the Vite root — the site/
// surface — since every site command runs from here, never from the app root.

export default {
  // The SPA's bundle, and then one prerendered HTML file per route declaring
  // \`render: static\` in its frontmatter. \`vite dev\` on this config serves the
  // same routes as a client-routed app, which is the writing loop; the checks
  // that matter — publishing, islands, one file per route — exist only in the
  // build.
  target:    'static',
  routesDir: 'src/routes',
  outDir:    'dist',

  // A directory per route, so \`/about/\` is a folder holding index.html. It is
  // what a static host serves without rewrite rules, and it keeps a relative
  // link from resolving one level up from where its author meant.
  trailingSlash: 'always',
${dbLine}
  // The document Sierra wraps each prerendered page in, and applies to
  // index.html too, so it is stated here only. The build's stylesheets are
  // linked automatically. The theme is BAKED rather than switched — a prerendered page
  // has no switcher and its first paint must be right with no JavaScript at
  // all — and it is the same class the SPA applies at runtime, not a second
  // mechanism.
  document: { bodyClass: 'app theme-default' },
}
`
}

/**
 * Where an island finds the API. A site is its own origin, so the relative
 * `/api/...` every other surface uses lands on the site's own SPA fallback:
 * 200 or 404 from a server that has no API, which an island reports as an empty
 * answer. The origin is a build-time constant because a static page has no
 * server to ask.
 */
export function siteApiModule({ apiPort = scaffoldPort('be') } = {}) {
  return `// site/src/api.js -- where this site's islands find the API.
//
// Never fetch a relative '/api/...' from an island: this surface is its own
// origin, so that path resolves against the site, which has no API. The page
// then renders whatever the empty answer means -- no times, no products -- over
// a request that never reached anything.
//
// Set FRONTIER_PUBLIC_API_URL in the app's .env for a deployment. Empty ('') means the
// API is behind the same origin as the site, one proxy in front of both. Unset
// is this app's own API port in dev.
export const API_ORIGIN = import.meta.env?.FRONTIER_PUBLIC_API_URL ?? 'http://localhost:${apiPort}'

/**
 * What createJunctionClient needs, and it is TWO keys: \`url\` is the ORIGIN
 * and \`apiPrefix\` is the PATH the app mounts its services under, which must
 * match the server's own. Leave \`url\` out and it is the site's origin.
 */
export const clientOptions = { url: API_ORIGIN, apiPrefix: '/api' }
`
}

export function siteViteConfig({ port = scaffoldPort('siteDev') } = {}) {
  return surfaceViteConfig({ surface: 'site', port, about: `
vite dev here is how the site is WRITTEN -- routes served as a client-routed
app, so a page's markup can be iterated on without a build.

fli site:build is what SHIPS: it emits the bundle and then prerenders every
route declaring render: static. The publish check, the island chunks and
the one-file-per-route output exist only there, so anything touching a
load() or frontmatter is proved by building.
` })
}

// ─── the dev shell ────────────────────────────────────────────────────────────

export function siteIndexHtml({ appName = 'app' } = {}) {
  return surfaceIndexHtml({ title: appName, body: `    <!-- The DEV shell. A built page does not use this file: each route is
         prerendered into its own HTML, wrapped in the \`document\` block from
         config/sierra.config.js. Sierra applies that block here too, so the
         body class is stated there and only there.

         Never mention the closing body tag inside a comment — Vite injects the
         built script at the first textual match and does not skip comments, so
         the build succeeds and the page loads no JavaScript. -->
    <div id="app"></div>
    <script type="module" src="virtual:sierra"></script>
` })
}

export function siteMainEntry() {
  return `// site/src/main.js — the DEV entry's side-effect imports.
//
// A built page mounts its islands and nothing else; this file is in none of
// it. In \`vite dev\` index.html loads virtual:sierra, which boots the router,
// imports this file and mounts the routes, so a link behaves as in the SPA.
import '@frontierjs/css'
`
}

// ─── a starter route ──────────────────────────────────────────────────────────

export function siteHomePage({ appName = 'app' } = {}) {
  return `---
title: ${frontmatterValue(appName)}
render: static
---
<!--
  A prerendered page. Everything outside an island tag ships as HTML and
  nothing else — no application, no hydration, no JavaScript at all.

  \`render: static\` is the unit of control. A route without it is not emitted,
  and the build says so rather than quietly shipping an empty site.
-->
<div class="container stack">
  <h1>${appName}</h1>
  <p class="text-muted">
    Prerendered at build time. Add <code>src/routes/</code> pages beside this
    one, and put anything that has to be current in an island.
  </p>
</div>
`
}

export function siteIslandStarter() {
  return `<script>
  // An island is the only way a prerendered page does anything at runtime, and
  // it is where DATA THAT MOVES belongs: whatever load() read is a snapshot of
  // the moment the site was built, and a price or a count read from the API
  // here is what it is now.
  //
  // The page declares WHEN it runs — \`client:load\` immediately, \`client:visible\`
  // when it scrolls into view — so a component below the fold costs nothing
  // until somebody reaches it.
  let clicks = $state(0)
</script>

<button class="btn" onclick={() => clicks++}>
  Clicked {clicks} {clicks === 1 ? 'time' : 'times'}
</button>
`
}

// ─── deployment ───────────────────────────────────────────────────────────────

export function siteServeEntry({ servePort = scaffoldPort('siteServe') } = {}) {
  return surfaceServe({
    surface: 'site', dist: 'dist', label: 'site', servePort,
    serve: 'serveSite', from: '@frontierjs/sierra/site/serve',
    about: `
Static files and nothing else, with the two answers a prerendered site
depends on: a directory index, so /about/ resolves to about/index.html the
way every static host does it, and a cache answer per file kind -- HTML must
be revalidated (its URL is permanent and its content is a build artefact),
hashed assets are immutable.

Most real deployments are a bucket and a CDN and never run this file; it
exists so the same answers can be had locally and in a container.
`,
  })
}

export function siteDockerfile({ servePort = scaffoldPort('siteServe') } = {}) {
  return surfaceDockerfile({
    surface: 'site', dist: 'dist', servePort,
    script: 'build:site',
    about: `
It is not in the API's image: a public site is released when its content
changes, which is not when the API is, and it stays up when the API is down.
A bucket and a CDN is the usual answer and needs no image at all; this is for
the deployments that want one process per surface.
`,
  })
}

// ─── writing it ───────────────────────────────────────────────────────────────

/** Create the surface, writing only what is absent (`writeAbsent`). */
export function scaffoldSiteSurface({
  root, dir = 'site', appName = 'app', hasApi = true,
  devPort = scaffoldPort('siteDev'), servePort = scaffoldPort('siteServe'), apiPort = scaffoldPort('be'),
} = {}) {
  return writeAbsent(root, dir, { dirs: SITE_SURFACE_DIRS, files: [
    ['config/sierra.config.js',  siteSierraConfig({ hasApi })],
    ['config/vite.config.js',    siteViteConfig({ port: devPort })],
    ['index.html',               siteIndexHtml({ appName })],
    ['src/main.js',              siteMainEntry()],
    ['src/api.js',               siteApiModule({ apiPort })],
    ['src/routes/index.mesa',    siteHomePage({ appName })],
    ['src/islands/Counter.mesa', siteIslandStarter()],
    ['deploy/serve.js',          siteServeEntry({ servePort })],
    ['deploy/Dockerfile',        siteDockerfile({ servePort })],
  ] })
}

/**
 * What the app installs for the prerender. Mesa's `renderToHTML` runs on
 * happy-dom and declares it an optional peer so a browser-only app never
 * installs it, which makes it this app's to name: without it `build:site`
 * fails in `closeBundle`, after the bundle is written. The range is mesa's own
 * peer range, kept equal by test/app-config.test.js. Merged by the caller.
 */
export function siteDevDeps() {
  return {
    'happy-dom': '^20.11.6',
  }
}

/**
 * The scripts an app with this surface runs. Merged into package.json by the
 * caller, because `fli new` writes that file once and `make:site` edits one
 * that exists.
 *
 * `build:site` and `serve:site` are separate because they are separate
 * questions — the build is what CI runs and the serve is what a drive points a
 * browser at, and a combined script would rebuild on every check.
 */
export function siteScripts({ dir = 'site', servePort = scaffoldPort('siteServe') } = {}) {
  return {
    'dev:site':   viteScript(dir),
    'build:site': viteScript(dir, { build: true }),
    'serve:site': `cd ${dir} && sierra site --serve --port ${servePort}`,
  }
}
