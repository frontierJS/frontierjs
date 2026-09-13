---
title: make:desktop
description: Create the desktop/ surface — a native shell with its screens bundled in, a peer of api/ and web/
alias: mkd
examples:
  - fli make:desktop --wraps web
  - fli make:desktop
flags:
  wraps:
    type: string
    description: Bundle another surface's screens (usually web) instead of desktop/src/
---

<script>
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { resolve, join, basename } from 'path'
</script>

Creates `desktop/` — a native window around screens bundled into the binary.
The shell is a Tauri 2 crate under `desktop/shell/`, and building it needs Rust;
on Linux also WebKitGTK 4.1.

**Two shapes, one surface** (`FJS-D263`). With `--wraps web` the desktop app is
the SPA: `web/src` is built into `desktop/dist` and nothing is written under
`desktop/src/`. Without it the surface owns its screens, which is what a
desktop-only app has, and gets a dev server of its own.

```
desktop/
  config/desktop.config.js   wraps, and api — the origin the bundled page calls
  config/sierra.config.js    only when the surface owns its screens
  config/vite.config.js      ditto, on this app's own desktopDev port
  src/routes/                ditto
  deploy/build.mjs           the screens, then the shell
  shell/                     the Tauri crate: Cargo.toml, tauri.conf.json, src/main.rs
  test/                      a drive reaches the page through the debug probe
  dist/                      the screens, compiled into the binary
```

**The API is always another origin.** The page is served from
`tauri://localhost`, so `api` is stated in `desktop.config.js` and
`deploy/build.mjs` refuses a build that does not state it, or whose bundle does
not carry it afterwards. The API's CORS list has to name the shell's origin.

```js
const { scaffoldDesktopSurface, desktopScripts, desktopNames } =
  await import(resolve(global.fliRoot, 'core/desktop-surface.js'))
const { port: portFor, projectIdFor } =
  await import(resolve(global.fliRoot, 'core/ports.js'))

const root    = context.paths.root
const surface = resolve(root, 'desktop')
const wraps   = flag.wraps || null

if (existsSync(join(surface, 'config/desktop.config.js'))) {
  log.error('desktop/ already exists — its config is desktop/config/desktop.config.js.')
  return
}

// A wrapped surface must exist and must be buildable the way build.mjs builds
// it, or the scaffold succeeds and the first build refuses.
if (wraps && !existsSync(join(root, wraps, 'config', 'vite.config.js'))) {
  log.error(`--wraps ${wraps}: there is no ${wraps}/config/vite.config.js to build the screens with.`)
  return
}

if (flag.dry) {
  log.dry(`Would create the desktop/ surface${wraps ? `, wrapping ${wraps}/` : ''}`)
  return
}

const appPkgPath = join(root, 'package.json')
const appPkg     = existsSync(appPkgPath) ? JSON.parse(readFileSync(appPkgPath, 'utf8')) : null
const appName    = basename(root)
const projectId  = projectIdFor(appPkg?.name ?? null, appName)
const apiPort    = portFor('be',         { env: 'dev', projectId })
const devPort    = portFor('desktopDev', { env: 'dev', projectId })
const hasApi     = existsSync(join(root, 'api'))

const { written, skipped } = scaffoldDesktopSurface({ root, appName, wraps, hasApi, apiPort, devPort })

for (const f of written) log.success(`Created ${f}`)
if (skipped.length) log.info(`Kept ${skipped.length} existing file(s) — a scaffold never overwrites your config.`)

// Only added when absent: an app that renamed one meant to.
if (appPkg) {
  appPkg.scripts ??= {}
  const added = []
  for (const [key, value] of Object.entries(desktopScripts({ wraps }))) {
    if (appPkg.scripts[key]) continue
    appPkg.scripts[key] = value
    added.push(key)
  }
  if (added.length) {
    writeFileSync(appPkgPath, `${JSON.stringify(appPkg, null, 2)}\n`, 'utf8')
    log.success(`Added scripts: ${added.join(', ')}`)
  }
}

const { identifier } = desktopNames(appName)

log.info('')
if (!wraps) log.info(`  bun run dev:desktop     write the screens in a browser, at :${devPort}`)
log.info(`  bun run build:desktop   → desktop/shell/target/debug/, the screens compiled in`)
log.info('')
if (!wraps && existsSync(join(root, 'web'))) {
  log.info('  This surface owns its screens. To bundle web/ instead, delete desktop/ and run')
  log.info('  fli make:desktop --wraps web')
  log.info('')
}
log.warn(
  `The shell's identifier is ${identifier}, in desktop/shell/tauri.conf.json. The OS keeps ` +
  `the app's data — its session included — under it, so change it before anyone installs ` +
  `the app: afterwards a change loses that data and nothing reports it.`
)
