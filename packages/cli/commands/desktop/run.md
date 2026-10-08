---
title: desktop:run
description: Build the desktop app, start its API if nothing answers, and open the window
alias: desktop
examples:
  - fli desktop:run
  - fli desktop:run --no-build
  - fli desktop:run --release
flags:
  build:
    type: boolean
    description: Open the binary already built instead of rebuilding it first
    defaultValue: true
  release:
    type: boolean
    description: Build and open the release shell instead of the debug one
    defaultValue: false
  api:
    type: boolean
    description: Never start the API, even when nothing answers at desktop.config.js's api
    defaultValue: true
---

<script>
import { existsSync, readFileSync } from 'fs'
import { join, relative, resolve } from 'path'
import { pathToFileURL } from 'url'
import { spawn } from 'child_process'
</script>

**The build runs by default because the screens are inside the binary.** A
binary built before an edit under `src/` shows the screens from before it, and
nothing in the window says so. `--no-build` is for opening the same build twice.

**The API is reused when something answers, and started when nothing does.**
The origin is `api` in `desktop/config/desktop.config.js` — the one the build
inlined — and it is started with the app's own `api` script on that port. One
this command started is stopped when the window closes; one already running is
left alone. A non-local `api` is never started here.

**A port that answers is not proof it is this app's API** (`FJS-740`). The line
naming the reused origin is the one place that is said; a window showing the
wrong data with that line above it is a stale server, and `fli ps` names it.

```js
const { desktopBinary, desktopApiTarget } =
  await import(resolve(global.fliRoot, 'core/desktop-surface.js'))
const { appPorts }      = await import(resolve(global.fliRoot, 'core/ports.js'))
const { portAnswering } = await import(resolve(global.fliRoot, 'core/probe.js'))
const { detectRunner }  = await import(resolve(global.fliRoot, 'core/db-preflight.js'))

const root       = $.paths.root
const surface    = $.paths.desktop
const configFile = join(surface, 'config', 'desktop.config.js')

if (!existsSync(configFile)) {
  log.error(`There is no ${relative(root, configFile)}. fli make:desktop --wraps web creates the surface.`)
  process.exit(1)
}

// fli runs under bun, and build.mjs is a bun script, so the running bun builds
// it rather than whichever one PATH finds first.
const build = `${JSON.stringify(process.execPath)} ${JSON.stringify(join(surface, 'deploy', 'build.mjs'))}${flag.release ? ' --release' : ''}`
if (flag.build) $.exec({ command: build, cwd: root, dry: flag.dry })

const binary = desktopBinary(surface, { release: flag.release })
if (!flag.dry && (!binary || !existsSync(binary))) {
  log.error(`No shell at ${binary ? relative(root, binary) : relative(root, join(surface, 'shell'))}.`)
  log.error(flag.build ? 'The build finished and left no binary — check desktop/shell/Cargo.toml.' : 'Run without --no-build.')
  process.exit(1)
}

const { default: config } = await import(pathToFileURL(configFile).href)
const api    = desktopApiTarget(config.api)
const runner = detectRunner(root)

let started = null
function stopApi() {
  if (!started) return
  try { process.kill(-started.pid, 'SIGTERM') } catch { /* already gone */ }
  started = null
}
if (!api) {
  log.info('API: none — desktop.config.js says api: null')
} else if (!api.local || !flag.api) {
  log.info(`API: ${api.origin}`)
} else if ((await portAnswering({ port: api.port })).ok) {
  log.info(`API: ${api.origin} already answers — using it`)
} else {
  let manifest = {}
  try { manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) } catch { /* no manifest, no script */ }
  const script = appPorts(root, { name: manifest.name, scripts: manifest.scripts ?? {} })
    .find(r => r.surface === 'api')?.script

  if (!script) {
    log.error(`Nothing answers at ${api.origin}, and package.json declares no api script to start.`)
    log.error('Start the API yourself, or run with --no-api to open the window without one.')
    process.exit(1)
  }

  if (flag.dry) {
    log.dry(`${runner} run ${script}   # on port ${api.port}`)
  } else {
    log.info(`API: nothing at ${api.origin} — starting ${runner} run ${script}`)
    // Its own process group, stopped as one: `bun run api` is a launcher, and
    // signaling its pid alone leaves the server it started holding the port.
    started = spawn(runner, ['run', script], {
      cwd: root, stdio: 'inherit', detached: true,
      // A scaffolded API reads FLI_PORT_BE and an older one PORT; the port is
      // the one the bundle was built to call, so both are set.
      env: { ...process.env, FLI_PORT_BE: String(api.port), PORT: String(api.port) },
    })
    process.on('exit', stopApi)

    const ready = await portAnswering({ port: api.port, retries: 60, everyMs: 500 })
    if (!ready.ok) {
      log.error(`The API did not answer at ${api.origin} within 30s.`)
      process.exit(1)
    }
  }
}

if (flag.dry) {
  log.dry(binary ?? join(surface, 'shell', 'target', flag.release ? 'release' : 'debug', '<crate>'))
  return
}

log.info(`window: ${relative(root, binary)}${started ? ' — closing it stops the API this started' : ''}`)
const code = await new Promise((done) => {
  const shell = spawn(binary, [], { cwd: surface, stdio: 'inherit' })
  shell.on('error', (err) => { log.error(`The shell could not be started: ${err.message}`); done(1) })
  shell.on('exit',  (status, signal) => done(status ?? (signal ? 1 : 0)))
})
// The API's handle holds the event loop open until it exits.
stopApi()
process.exit(code)
```
