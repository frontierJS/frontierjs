---
title: dev:desktop
description: Open the desktop window on the screens' dev server, so an edit reaches it by HMR
examples:
  - fli dev:desktop
  - fli dev:desktop --no-build
flags:
  build:
    type: boolean
    description: Open the shell already built instead of compiling it first
    defaultValue: true
  api:
    type: boolean
    description: Never start the API, even when nothing answers at desktop.config.js's api
    defaultValue: true
---

<script>
import { existsSync } from 'fs'
import { join, relative, resolve } from 'path'
import { pathToFileURL } from 'url'
import { spawn } from 'child_process'
</script>

**The window loads the screens' dev server, not the bundle.** A debug shell
reads `FRONTIER_DESKTOP_URL` and opens that URL instead of the page compiled into
it, so an edit under `src/` reaches the window the way it reaches a browser. A
release build ignores the variable — `desktop:run` is what shows the page that
ships.

**The page's origin is the dev server's**, not `tauri://localhost`. Calls go
through Vite's proxy as they do in a browser, so a CORS list missing the shell's
origin, or a fetch that assumes a same-origin API, passes here and fails in the
bundled build. Check those with `fli desktop:run`.

**The dev server is the wrapped surface's** (`wraps` in `desktop.config.js`) or
this surface's own, on the port `fli dev` gives it. It and the API are reused
when something answers and started when nothing does; one this command started
is stopped when the window closes. A port that answers is not proof it is this
app's server (`FJS-740`), so one whose listener runs outside this app's
directory is refused with its pid named rather than reused.

**The build compiles the shell only.** The screens are served, so only the Rust
half is built — a no-op after the first time — unless `desktop/dist` is missing,
which the shell's compile needs, and then the whole of `deploy/build.mjs` runs.

```js
const { desktopBinary, desktopApiTarget, offerDesktopSurface, ensureServer, movedShellBuild, stopServer, surfaceRow } =
  await import(resolve(global.fliRoot, 'core/desktop-surface.js'))
const { detectRunner } = await import(resolve(global.fliRoot, 'core/db-preflight.js'))

const root       = $.paths.root
const surface    = $.paths.desktop
const configFile = join(surface, 'config', 'desktop.config.js')

if (!await offerDesktopSurface({ root, configFile, tty, exec: $.exec, fli: $.fli, log, dry: flag.dry })) process.exit(1)

const { default: config } = await import(pathToFileURL(configFile).href)
const screens = config.wraps ?? 'desktop'
const dev     = surfaceRow(root, screens)
if (!dev) {
  log.error(`No ${screens}/ surface to serve the screens from — desktop.config.js wraps '${screens}'.`)
  process.exit(1)
}

if (flag.build) {
  const command = existsSync(join(surface, 'dist'))
    ? `cargo build --manifest-path ${JSON.stringify(join(surface, 'shell', 'Cargo.toml'))}`
    // tauri-build reads frontendDist at compile time, so a first build needs the screens too.
    : `${JSON.stringify(process.execPath)} ${JSON.stringify(join(surface, 'deploy', 'build.mjs'))}`
  try {
    $.exec({ command, cwd: surface, dry: flag.dry })
  } catch (err) {
    const was = movedShellBuild(surface)
    if (!was) throw err
    log.error(`The shell's build cache was compiled at ${was}, and this app has moved since — cargo reused output that names the old place.`)
    log.error(`Clear it, then run this again: cargo clean --manifest-path ${relative(process.cwd(), join(surface, 'shell', 'Cargo.toml'))}`)
    process.exit(1)
  }
}

const binary = desktopBinary(surface)
if (!flag.dry && (!binary || !existsSync(binary))) {
  log.error(`No shell at ${binary ? relative(root, binary) : relative(root, join(surface, 'shell'))}.`)
  log.error(flag.build ? 'The build finished and left no binary — check desktop/shell/Cargo.toml.' : 'Run without --no-build.')
  process.exit(1)
}

const api    = desktopApiTarget(config.api)
const runner = detectRunner(root)

const started = []
const stopAll = () => { while (started.length) stopServer(started.pop()) }
process.on('exit', stopAll)

async function ensure(opts, hint) {
  try {
    const child = await ensureServer({ root, runner, log, dry: flag.dry, ...opts })
    if (child) started.push(child)
  } catch (err) {
    log.error(err.message)
    if (hint && !err.holder) log.error(hint)
    process.exit(1)
  }
}

if (!api) {
  log.info('API: none — desktop.config.js says api: null')
} else if (!api.local || !flag.api) {
  log.info(`API: ${api.origin}`)
} else {
  await ensure({
    script: surfaceRow(root, 'api')?.script, port: api.port, label: 'API',
    env: { FRONTIER_PORT_BE: String(api.port) },
  }, 'Start the API yourself, or run with --no-api to open the window without one.')
}

await ensure({
  script: dev.script, port: dev.port, label: `${dev.label} dev server`,
  env: dev.env ? { [dev.env]: String(dev.port) } : {},
}, `Start the ${screens}/ dev server yourself on port ${dev.port}.`)

const url = `http://localhost:${dev.port}/`
if (flag.dry) {
  log.dry(`FRONTIER_DESKTOP_URL=${url} ${binary ?? join(surface, 'shell', 'target', 'debug', '<crate>')}`)
  return
}

log.info(`window: ${relative(root, binary)} on ${url}${started.length ? ' — closing it stops what this started' : ''}`)
const code = await new Promise((done) => {
  const shell = spawn(binary, [], { cwd: surface, stdio: 'inherit', env: { ...process.env, FRONTIER_DESKTOP_URL: url } })
  shell.on('error', (err) => { log.error(`The shell could not be started: ${err.message}`); done(1) })
  shell.on('exit',  (status, signal) => done(status ?? (signal ? 1 : 0)))
})
// A started server's handle holds the event loop open until it exits.
stopAll()
process.exit(code)
```
