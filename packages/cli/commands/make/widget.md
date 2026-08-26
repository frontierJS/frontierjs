---
title: make:widget
description: Create an embeddable widget in widgets/src/Embeds/ — scaffolding the widgets/ surface on first use
alias: mkw
examples:
  - fli make:widget Booking
  - fli make:widget CleaningLead --prefix mt-
  - fli mkw Chat --open
args:
  -
    name: name
    description: Widget name — PascalCase, singular. It is also the tag a host page writes
    required: true
flags:
  prefix:
    type: string
    description: Tag/class prefix for the surface, e.g. mt- (only used when creating widgets/)
    defaultValue: ''
  dir:
    type: string
    description: Surface directory, relative to the app root
    defaultValue: widgets
  open:
    char: o
    type: boolean
    description: Open the widget in $EDITOR after creating
    defaultValue: false
---

<script>
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { resolve, join, basename } from 'path'
</script>

Creates a widget — one component, built as one self-contained script, mounted on
a page this app does not own.

**The first one creates the surface.** `widgets/` is a sub-project at the app
root beside `api/` and `web/`, with the same six folders, and it comes into
existence the first time a widget does. Its config, its host pages and its
release are its own: a widget ships to a stranger's page on the cadence of the
pages that embed it, from a static origin rather than the API's container.

```
widgets/
  config/sierra.config.js    target: 'widget', the tag prefix, the output dir
  config/vite.config.js      the Vite root is widgets/, on this app's own
                             widgetDev port (8200 for a fresh scaffold)
  index.html                 the dev harness — vite dev, while a widget is written
  src/Embeds/<Name>.mesa     the widget. A directory holding index.mesa also works,
                             and a .mesa BESIDE that index is its part, not a widget
  test/<tag>.html            a host page per widget, with hostile CSS on purpose
  deploy/                    serve.js + Dockerfile — the widget origin, CORS and all
  dist/embeds/<Name>.js      the built script, one <script src> for a host page
```

A host page writes `<fjs-booking data-pid="42">` and one deferred script tag
pointing at the built file — no bundler, no framework, no init call. The
generated `test/<tag>.html` is that page, spelled out.

Props are `data-*` attributes and arrive as strings. Build with `fli
widgets:build`, serve with `fli widgets:serve` (CORS and cache headers matching
what deploys), and prove it with a real browser against `test/`.

```js
const { scaffoldWidgetSurface, isWidgetName, widgetTag, widgetScripts } =
  await import(resolve(global.fliRoot, 'core/widget-surface.js'))
const { port: portFor, projectIdFor } =
  await import(resolve(global.fliRoot, 'core/ports.js'))

const name = arg.name.replace(/\.mesa$/, '').replace(/^.*\//, '')
const dir  = flag.dir || 'widgets'
const root = context.paths.root

if (!isWidgetName(name)) {
  log.error(
    `"${name}" is not a widget name — PascalCase and singular, like a component ` +
    `(Invariant 19). It is also the tag a host page writes: ${name} → <${widgetTag(name)}>.`
  )
  return
}

const surface = resolve(root, dir)
const fresh   = !existsSync(surface)

// The prefix belongs to the SURFACE, not to one widget — it is what keeps two
// vendors' widgets off each other's tag names, so it is set when widgets/ is
// created and read from the config after that.
let prefix = flag.prefix || ''
if (!fresh) {
  const cfg = join(surface, 'config/sierra.config.js')
  const src = existsSync(cfg) ? readFileSync(cfg, 'utf8') : ''
  const hit = src.match(/prefix:\s*['"]([^'"]*)['"]/)
  if (hit) prefix = hit[1]
  if (flag.prefix && hit && hit[1] !== flag.prefix) {
    log.warn(`--prefix ignored: ${dir}/config/sierra.config.js already sets '${hit[1]}' for every widget here.`)
  }
}

const target = join(surface, 'src/Embeds', `${name}.mesa`)
if (existsSync(target)) {
  log.error(`${dir}/src/Embeds/${name}.mesa already exists — edit it, or pick another name.`)
  return
}

if (flag.dry) {
  log.dry(`Would ${fresh ? `create the ${dir}/ surface and ` : ''}write ${dir}/src/Embeds/${name}.mesa`)
  return
}

const appName = basename(root)

// Derived, not chosen. `port = env*1000 + category*100 + project*10 + service`,
// and the two categories a widget surface needs are widgetDev (2, the server
// you write against) and widgetServe (3, the origin a stranger's page loads
// from). Written into this app's own numbers rather than the template's,
// because every generated file below carries one: the Vite port, the host
// page's `<script src>`, the deploy entry and the Dockerfile's EXPOSE.
//
// The templates said 8200/8300 unconditionally, which is project 0 — right for
// a fresh scaffold and wrong for every app with a number. `strictPort` turns
// that into a refusal rather than a silent hop, so the way it went wrong was a
// second app's widget server failing to start, naming a port nobody had chosen.
const appPkgPath = join(root, 'package.json')
const appPkgName = existsSync(appPkgPath)
  ? (JSON.parse(readFileSync(appPkgPath, 'utf8')).name ?? null)
  : null
const projectId = projectIdFor(appPkgName, basename(root))
const devPort   = portFor('widgetDev',   { env: 'dev', projectId })
const servePort = portFor('widgetServe', { env: 'dev', projectId })

const { written, skipped } = scaffoldWidgetSurface({
  root, dir, name, prefix, appName, devPort, servePort,
})

for (const f of written) log.success(`Created ${f}`)
if (skipped.length) log.info(`Kept ${skipped.length} existing file(s) — a scaffold never overwrites your config.`)

// The scripts, merged into the app's package.json. Only added when absent: an
// app that renamed one meant to.
if (fresh) {
  const pkgPath = join(root, 'package.json')
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    pkg.scripts ??= {}
    const added = []
    for (const [key, value] of Object.entries(widgetScripts({ dir, servePort }))) {
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
log.info(`  <${widgetTag(name, prefix)}></${widgetTag(name, prefix)}>  — the tag a host page writes`)
log.info('')
log.info(`  bun run dev:widgets     write it, live at :${devPort}`)
log.info(`  bun run build:widgets   → ${dir}/dist/embeds/${name}.js`)
log.info(`  bun run serve:widgets   the widget origin, headers and all`)
log.info('')

if (flag.open) {
  const editor = process.env.EDITOR || 'vi'
  context.exec({ command: `${editor} "${target}"` })
}
```
