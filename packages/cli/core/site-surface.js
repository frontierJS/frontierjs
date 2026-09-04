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

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'

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
  // The document Sierra wraps each prerendered page in. The build's stylesheets
  // are linked automatically; this is the other half of what index.html does
  // for the SPA. The theme is BAKED rather than switched — a prerendered page
  // has no switcher and its first paint must be right with no JavaScript at
  // all — and it is the same class the SPA applies at runtime, not a second
  // mechanism.
  document: { bodyClass: 'app theme-default' },
}
`
}

export function siteViteConfig({ port = 8600 } = {}) {
  return `// site/config/vite.config.js
// \`vite dev\` here is how the site is WRITTEN — routes served as a client-routed
// app, so a page's markup can be iterated on without a build.
//
// \`fli site:build\` is what SHIPS: it emits the bundle and then prerenders every
// route declaring \`render: static\`. The publish check, the island chunks and
// the one-file-per-route output exist only there, so anything touching a
// load() or frontmatter is proved by building.

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { createSierraViteConfig } from '@frontierjs/sierra/build'
import sierraConfig from './sierra.config.js'

// The Vite root is the surface root, one level up from config/ — the same
// relationship web/config/vite.config.js has to web/.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const base = createSierraViteConfig(sierraConfig)

export default defineConfig({
  ...base,
  root: ROOT,
  server: {
    ...base.server,
    // dev / siteDev / this app's project id — derived, never chosen. A public
    // site is a third server while it is being written and its own origin once
    // it is served, and neither is the SPA's. See packages/cli/core/ports.js.
    port:       parseInt(process.env.SITE_PORT ?? process.env.FLI_PORT_SITE ?? '${port}', 10),
    // Vite hops to the next free port without a word, and a drive pointed at
    // the port it hopped from then tests whatever else is listening.
    strictPort: true,
  },
})
`
}

// ─── the dev shell ────────────────────────────────────────────────────────────

export function siteIndexHtml({ appName = 'app' } = {}) {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${appName}</title>
  </head>
  <body class="app theme-default">
    <!-- The DEV shell. A built page does not use this file: each route is
         prerendered into its own HTML, wrapped in the \`document\` block from
         config/sierra.config.js. Keep the body class in both, or the dev server
         and the built site are two different themes.

         Never mention the closing body tag inside a comment — Vite injects the
         built script at the first textual match and does not skip comments, so
         the build succeeds and the page loads no JavaScript. -->
    <div id="app"></div>
    <script type="module" src="/src/main.js"></script>
  </body>
</html>
`
}

export function siteMainEntry() {
  return `// site/src/main.js — the DEV entry.
//
// A built page mounts its islands and nothing else; this file is what makes
// \`vite dev\` navigable while the site is being written. It is deliberately the
// same router the SPA uses, so a link behaves the same in both.

// Same three lines the SPA's entry uses, in the same order. \`virtual:sierra\`
// boots the router and — where the app has a schema — registers it, and it is
// imported FIRST: a route module that evaluates before the schemas are
// registered gets a bare make() with no field rules.
import 'virtual:sierra'
import '@frontierjs/css'

import { mount } from '@frontierjs/mesa/runtime'
import { RouterView } from '@frontierjs/sierra/router'

// mount()'s first argument is an anchor NODE, not an element id — Mesa inserts
// the component immediately after it, so the anchor must already be in the tree.
const root   = document.getElementById('app')
const anchor = document.createTextNode('')
root.appendChild(anchor)

mount(anchor, RouterView, { root })
`
}

// ─── a starter route ──────────────────────────────────────────────────────────

export function siteHomePage({ appName = 'app' } = {}) {
  return `---
title: ${appName}
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

export function siteServeEntry({ servePort = 8700 } = {}) {
  return `// site/deploy/serve.js — the site origin.
//
// Static files and nothing else, with the two answers a prerendered site
// depends on: a directory index, so /about/ resolves to about/index.html the
// way every static host does it, and a cache answer per file kind — HTML must
// be revalidated (its URL is permanent and its content is a build artefact),
// hashed assets are immutable.
//
// The server itself is Sierra's, so what is tested locally is what runs here.
// Most real deployments are a bucket and a CDN and never run this file; it
// exists so the same answers can be had locally and in a container.

import { serveSite } from '@frontierjs/sierra/site/serve'

const { url } = await serveSite({
  dir:  new URL('../dist', import.meta.url).pathname,
  port: Number(process.env.PORT ?? ${servePort}),
})

console.log(\`site serving at \${url}\`)
`
}

export function siteDockerfile({ servePort = 8700 } = {}) {
  return `# site/deploy/Dockerfile — the site surface ships on its own.
#
# It is not in the API's image: a public site is released when its content
# changes, which is not when the API is, and it stays up when the API is down.
# A bucket and a CDN is the usual answer and needs no image at all; this is for
# the deployments that want one process per surface.

FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile || bun install
COPY . .
RUN cd site && bunx vite build -c config/vite.config.js

FROM oven/bun:1-slim
WORKDIR /app
COPY --from=build /app/site/dist ./site/dist
COPY --from=build /app/site/deploy ./site/deploy
COPY --from=build /app/node_modules ./node_modules
ENV PORT=${servePort}
EXPOSE ${servePort}
CMD ["bun", "run", "site/deploy/serve.js"]
`
}

// ─── writing it ───────────────────────────────────────────────────────────────

/**
 * Create the surface.
 *
 * Every file is written only when it is absent — this is called to top one up
 * as often as to create one, and a scaffold that overwrites a config is a
 * scaffold nobody runs twice.
 *
 * @returns {{ written: string[], skipped: string[] }} paths relative to `root`
 */
export function scaffoldSiteSurface({
  root, dir = 'site', appName = 'app', hasApi = true,
  devPort = 8600, servePort = 8700,
} = {}) {
  const base = resolve(root, dir)
  for (const d of SITE_SURFACE_DIRS) mkdirSync(resolve(base, d), { recursive: true })

  const files = [
    ['config/sierra.config.js', siteSierraConfig({ hasApi })],
    ['config/vite.config.js',   siteViteConfig({ port: devPort })],
    ['index.html',              siteIndexHtml({ appName })],
    ['src/main.js',             siteMainEntry()],
    ['src/routes/index.mesa',   siteHomePage({ appName })],
    ['src/islands/Counter.mesa', siteIslandStarter()],
    ['deploy/serve.js',         siteServeEntry({ servePort })],
    ['deploy/Dockerfile',       siteDockerfile({ servePort })],
  ]

  const written = []
  const skipped = []
  for (const [rel, body] of files) {
    const abs = resolve(base, rel)
    if (existsSync(abs)) { skipped.push(`${dir}/${rel}`); continue }
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, body, 'utf8')
    written.push(`${dir}/${rel}`)
  }
  return { written, skipped }
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
export function siteScripts({ dir = 'site', servePort = 8700 } = {}) {
  return {
    // `bun --bun` on BOTH, and for one reason: a `render: static` route's
    // `load()` imports the app's own Litestone client, which is TypeScript and
    // opens `bun:sqlite`. The build has always needed it — node's stripper
    // refuses a parameter property, and Vite reports that as *could not load
    // the db*, which reads like a path problem and is a runtime one.
    //
    // Dev needs it now too, because the dev server RUNS that loader (Sierra's
    // static-data middleware) so the page can be seen with its data instead of
    // correctly empty. Under node it fails as `Only URLs with a scheme in:
    // file, data, and node are supported — received protocol 'bun:'`, which
    // names nothing an app author did.
    // And `--env-file=../.env`, because both commands run from the SURFACE:
    // bun auto-loads `.env` from the working directory, so the app's own one is
    // not read, and a client that validates a required variable refuses to load
    // at all. A missing file here is silently fine.
    'dev:site':   `cd ${dir} && bun --bun --env-file=../.env vite -c config/vite.config.js`,
    'build:site': `cd ${dir} && bun --bun --env-file=../.env vite build -c config/vite.config.js`,
    'serve:site': `cd ${dir} && bunx sierra site --serve --port ${servePort}`,
  }
}
