---
title: make:site
description: Create the site/ surface — the public, prerendered site, a peer of api/ and web/
alias: mks
examples:
  - fli make:site
  - fli make:site --dir marketing
flags:
  dir:
    type: string
    description: Surface directory, relative to the app root
    defaultValue: site
  open:
    char: o
    type: boolean
    description: Open the home page in $EDITOR after creating
    defaultValue: false
---

<script>
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { resolve, join, basename } from 'path'
</script>

Creates `site/` — the public, prerendered site. One HTML file per route with
the data already in it, islands for the parts that have to be current, and no
application server behind any of it.

**It is a peer of `api/` and `web/`, never a routes directory inside `web/`.**
Its config, its tests and its release are a different set of answers from the
SPA's (Invariant 3), and the fourth answer is what makes it a defect rather
than a preference: folded into `web/` the two builds share a Vite root, so the
site's output lands inside the SPA's `dist/` — and Vite empties `outDir` by
default, so building the SPA deletes the site with nothing said.

```
site/
  config/sierra.config.js    target: 'static', the db to tap, the document wrapper
  config/vite.config.js      the Vite root is site/, on this app's own siteDev port
  index.html                 the DEV shell — a built page never uses it
  src/main.js                the dev entry: the same router the SPA uses
  src/routes/                file-tree routes, the same convention as web/
  src/islands/               the only JavaScript a prerendered page runs
  test/                      what proves the BUILD — files, not a running app
  deploy/                    serve.js + Dockerfile — the site origin
  dist/                      one index.html per route, plus island chunks
```

**Dev is an SPA and the build is files.** `target: 'static'` uses the SPA's Vite
config and prerenders afterwards, so `fli site:dev` serves the routes as a
client-routed app — that is the writing loop. The publish check, the island
chunks and the one-file-per-route output exist only in the build, so anything
touching a `load()` or frontmatter is proved with `fli site:build`.

**A prerendered page is public and cannot be recalled.** The build taps the
client named by `db:` while `load()` runs and compares every model read against
that model's `@@gate`, fail-closed. A route that read something gated is
refused rather than emitted; `publishes: N` in that route's own frontmatter is
the override, so publishing gated data is something a reviewer can see.

```js
const { scaffoldSiteSurface, siteScripts } =
  await import(resolve(global.fliRoot, 'core/site-surface.js'))
const { port: portFor, projectIdFor } =
  await import(resolve(global.fliRoot, 'core/ports.js'))

const dir  = flag.dir || 'site'
const root = context.paths.root

const surface = resolve(root, dir)
const fresh   = !existsSync(surface)

if (existsSync(join(surface, 'config/sierra.config.js'))) {
  log.error(`${dir}/ already exists — add pages under ${dir}/src/routes/, or pick another --dir.`)
  return
}

if (flag.dry) {
  log.dry(`Would create the ${dir}/ surface`)
  return
}

const appName = basename(root)

// Derived, not chosen. `port = env*1000 + category*100 + project*10 + service`,
// and the two categories a site surface needs are siteDev (6, the server you
// write against) and siteServe (7, the origin the built files are served
// from). A surface that is both written against AND served as its own origin
// takes two categories rather than two service slots — putting the served half
// in the fe row would say it is the SPA's second server, which is the one
// thing it is not.
const appPkgPath = join(root, 'package.json')
const appPkgName = existsSync(appPkgPath)
  ? (JSON.parse(readFileSync(appPkgPath, 'utf8')).name ?? null)
  : null
const projectId = projectIdFor(appPkgName, basename(root))
const devPort   = portFor('siteDev',   { env: 'dev', projectId })
const servePort = portFor('siteServe', { env: 'dev', projectId })

// An app with no api/ has nothing to tap, and a `db:` pointing at a file that
// is not there is a build that fails before it says anything useful.
const hasApi = existsSync(join(root, 'api'))

const { written, skipped } = scaffoldSiteSurface({
  root, dir, appName, hasApi, devPort, servePort,
})

for (const f of written) log.success(`Created ${f}`)
if (skipped.length) log.info(`Kept ${skipped.length} existing file(s) — a scaffold never overwrites your config.`)

if (!hasApi) {
  log.warn(
    `No api/ in this app, so config/sierra.config.js declares no \`db\`. Add one the ` +
    `day a load() reads the database — without it Sierra cannot say what a page ` +
    `published and refuses to emit one that read anything.`
  )
}

// The scripts, merged into the app's package.json. Only added when absent: an
// app that renamed one meant to.
if (fresh) {
  const pkgPath = join(root, 'package.json')
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    pkg.scripts ??= {}
    const added = []
    for (const [key, value] of Object.entries(siteScripts({ dir, servePort }))) {
      if (pkg.scripts[key]) continue
      pkg.scripts[key] = value
      added.push(key)
    }
    if (added.length) {
      writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
      log.success(`Added scripts: ${added.join(', ')}`)
    }
  }
}

log.info('')
log.info(`  bun run dev:site      write it, live at :${devPort}`)
log.info(`  bun run build:site    → ${dir}/dist/, one index.html per route`)
log.info(`  bun run serve:site    the site origin, at :${servePort}`)
log.info('')
log.info(`  Every page needs \`render: static\` in its frontmatter — the build emits`)
log.info(`  nothing for a route without it, and says so rather than shipping an`)
log.info(`  empty site.`)
log.info('')

if (flag.open) {
  const editor = process.env.EDITOR || 'vi'
  context.exec({ command: `${editor} "${join(surface, 'src/routes/index.mesa')}"` })
}
```
