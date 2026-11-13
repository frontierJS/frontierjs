---
title: make:desktop
description: Create the desktop/ surface — a native shell with its screens bundled in, a peer of api/ and web/
alias: mkd
examples:
  - fli make:desktop --wraps web
  - fli make:desktop --wraps web --sidecar
  - fli make:desktop
flags:
  wraps:
    type: string
    description: Bundle another surface's screens (usually web) instead of desktop/src/
  sidecar:
    type: boolean
    description: The installed app runs its own API — a compiled bun sidecar the shell starts, supervises and tray-hosts
---

<script>
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { resolve, join } from 'path'
</script>

Creates `desktop/` — a native window around screens bundled into the binary.
The shell is a Tauri 2 crate under `desktop/shell/`, and building it needs Rust;
on Linux also WebKitGTK 4.1.

**A shell that adds a tray or `tauri-plugin-single-instance` needs more at run
time on Linux** (`FJS-3966`): the tray links libayatana-appindicator3, and both
take a name on the session D-Bus, so a launch with no `XDG_RUNTIME_DIR` finds
none. A `.deb` must list `libayatana-appindicator3-1` under
`bundle.linux.deb.depends`; `fli check` (`desktop-tray-depends`) warns when a
bundled shell with a tray does not. The tray's title is the binary name unless
the shell sets one.

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

**`--sidecar`: the app carries its own API** (`FJS-D1815`). Without it the
shell is a window onto an API somewhere else. With it the API is compiled into
one bun binary (`desktop/sidecar/make-sidecar.ts`, run by `build:desktop`) and
shipped beside the shell, which:

- starts it on a free 127.0.0.1 port with its data in the OS app-data
  directory's `api/` (`api-debug/` in a debug build, so a dev run never
  touches the installed app's data; the webview's own storage stays beside
  them), and builds the window only once `<apiPrefix>/health` answers;
- hands the page that origin as `globalThis.__sierraApiUrl`, so no build
  inlines one and `build.mjs` refuses a bundle whose sierra does not read it;
- stops it by closing its stdin, which also ends it when the shell dies some
  other way, `kill -9` included;
- restarts one that dies on the same port with a backoff, and gives up with a
  dialog after five deaths in a minute;
- closes to a tray (Open, Start at login, Quit), and focuses the running copy
  on a second launch;
- puts the dialog plugin on `window.__TAURI__` and grants the page
  `dialog:allow-open` and nothing else.

The packages compiled in are derived from the API's own `@frontierjs/*` imports
under `api/src` and `api/config`, again on every build, into
`desktop/sidecar/bundled.ts`. Other dependencies ship whole beside the app's
files (`FJS-3959`). `bun run build:desktop -- --release --target bun-windows-x64`
cross-compiles the sidecar as `<app>-api-x86_64-pc-windows-msvc.exe`, where
the Tauri bundle expects it; the shell itself still compiles on Windows.

```
desktop/
  sidecar/launcher.ts        the sidecar's entry: the app's API, bound to 127.0.0.1
  sidecar/make-sidecar.ts    stages app files and compiles shell/sidecar/<app>-api-<triple>
  sidecar/sidecar-fns.ts     the import-scanning functions, untyped (@ts-nocheck)
  sidecar/bundled.ts         generated: the packages compiled in
  shell/capabilities/        default.json — dialog:allow-open only
```

**The API is always another origin.** The page is served from
`tauri://localhost`, so `api` is stated in `desktop.config.js` and
`deploy/build.mjs` refuses a build that does not state it, or whose bundle does
not carry it afterwards. The API's CORS list has to name the shell's origin.

```js
const { scaffoldDesktopSurface, desktopScripts, desktopDevDeps, desktopNames, desktopAppName } =
  await import(resolve(global.fliRoot, 'core/desktop-surface.js'))
const { port: portFor, projectIdFor } =
  await import(resolve(global.fliRoot, 'core/ports.js'))
const { addSurfaceToTsconfig } = await import(resolve(global.fliRoot, 'core/scaffold/surface.js'))

const root    = $.paths.root
const surface = resolve(root, 'desktop')
const wraps   = flag.wraps || null
const sidecar = Boolean(flag.sidecar)

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

// The sidecar is the app's own API; with no api/ there is nothing to compile.
if (sidecar && !existsSync(join(root, 'api'))) {
  log.error('--sidecar compiles this app\'s api/ into the shell, and there is no api/ here.')
  return
}

if (flag.dry) {
  log.dry(`Would create the desktop/ surface${wraps ? `, wrapping ${wraps}/` : ''}${sidecar ? ', with its own API sidecar' : ''}`)
  return
}

const appPkgPath = join(root, 'package.json')
const appPkg     = existsSync(appPkgPath) ? JSON.parse(readFileSync(appPkgPath, 'utf8')) : null
const appName    = desktopAppName(root)
const projectId  = projectIdFor(appPkg?.name ?? null, appName)
const apiPort    = portFor('be',         { env: 'dev', projectId })
const devPort    = portFor('desktopDev', { env: 'dev', projectId })
const hasApi     = existsSync(join(root, 'api'))

const { written, skipped } = scaffoldDesktopSurface({ root, appName, wraps, hasApi, apiPort, devPort, sidecar })

for (const f of written) log.done(`Created ${f}`)
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
  // The screens' own build and UI realm, which an api-only app has none of.
  const tools = []
  for (const [key, spec] of Object.entries(desktopDevDeps(appPkg, { wraps }))) {
    appPkg.devDependencies ??= {}
    appPkg.devDependencies[key] = spec
    tools.push(key)
  }
  if (added.length || tools.length) {
    writeFileSync(appPkgPath, `${JSON.stringify(appPkg, null, 2)}\n`, 'utf8')
    if (added.length) log.done(`Added scripts: ${added.join(', ')}`)
    if (tools.length) log.done(`Added devDependencies: ${tools.join(', ')} — run bun install before dev:desktop.`)
  }
}

const tsconfig = addSurfaceToTsconfig(root, 'desktop', { src: !wraps })
if (tsconfig.message) log[tsconfig.ok ? 'success' : 'warn'](tsconfig.message)
const { identifier } = desktopNames(appName)

log.info('')
if (!wraps) log.info(`  bun run dev:desktop     write the screens in a browser, at :${devPort}`)
log.info(`  bun run build:desktop   → desktop/shell/target/debug/, the screens compiled in${sidecar ? ', the API beside them' : ''}`)
log.info(`  fli desktop:run         build it, start the API if nothing answers, open the window`)
log.info(`  fli dev:desktop         the window on the dev server, with HMR`)
log.info(`  fli desktop:install     add it to this machine's app launcher (Linux)`)
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
