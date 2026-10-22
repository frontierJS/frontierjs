---
title: fli:gui
description: Start the console — in this terminal, or in the browser with --open
alias: gui
examples:
  - fli gui
  - fli gui --test
  - fli gui --port 8080
  - fli gui --open
flags:
  port:
    char: p
    type: number
    description: Port to listen on — default is the project's tooling port for its env, or 5500 outside a project
    defaultValue: 5500
  production:
    type: boolean
    description: The project's prod tooling port (9500 for project 0) rather than dev
    defaultValue: false
  open:
    char: o
    type: boolean
    description: Open the console in your browser instead of this terminal
    defaultValue: false
---

<script>
import { resolve, join, basename } from 'path'
import { existsSync, readFileSync } from 'fs'
</script>

Start the FLI console. Commands from both `fliRoot/commands/` and
`projectRoot/cli/src/routes/` are available through it.

Started in a terminal without `--open`, the console's screens draw in that
terminal, reading the server this process starts, and Ctrl+C stops both
(`FJS-D1389`). Otherwise the server runs alone and the browser is the console:
`--open`, or a start with no terminal on stdin and stdout.

In a project it is that project's GUI, on the project's tooling port for the
env — 8500 dev, 7500 with `--test`, 9500 with `--production` for project 0.
A scaffolded app adds its `fli dev` slot, so the app on 8001 has its GUI on
8501. Outside a project there is no env, and it is the global 5500.

```js
const { guiPort, claimSession, slotFor, projectIdFor, PROJECTS } = await import(resolve(global.fliRoot, 'core/ports.js'))
// The flag's declared default is the global port, so whether --port was typed
// is read off the argv: a default must not pin an in-project GUI to 5500.
const typed   = $.forwarded.some(a => /^(--port|-p)(=|$)/.test(a))
const inApp   = existsSync(join($.paths.root, 'package.json'))
const env     = flag.production ? 'prod' : flag.test ? 'test' : 'dev'
// A scaffolded app with no slot yet is claimed one here as `fli dev` would,
// or its GUI falls to slot 0 and meets the GUI of the app that holds it.
if (!typed && inApp && !flag.dry) {
  const manifest = JSON.parse(readFileSync(join($.paths.root, 'package.json'), 'utf8'))
  const scaffold = projectIdFor(manifest.name, basename($.paths.root)) === PROJECTS.scaffold
  if (scaffold && slotFor($.paths.root, { env }) === null) {
    await claimSession($.paths.root, { name: manifest.name, scripts: manifest.scripts, env })
  }
}
const port     = typed ? flag.port : guiPort(inApp ? $.paths.root : null, { env })
const url      = `http://localhost:${port}`
const terminal = !flag.open && !!process.stdin.isTTY && !!process.stdout.isTTY

// Set port via env so server.js picks it up
process.env.FLI_PORT = String(port)

log.info(`Starting FLI Web GUI on ${url}`)
log.info(`Project: ${$.paths.root}`)

if (flag.dry) {
  log.dry(`Would start server on port ${port}`)
  if (flag.open) log.dry(`Would open ${url} in browser`)
  if (terminal) log.dry('Would draw the console in this terminal')
  return
}

// Open browser if requested (non-blocking)
if (flag.open) {
  const { openUrl } = await import(resolve(global.fliRoot, 'core/open-url.js'))
  setTimeout(() => openUrl(url), 800)
}

// Start the server — import from fliRoot so it always finds core/server.js
const { startServer, shutdown } = await import(resolve(global.fliRoot, 'core/server.js'))
const server = startServer({ quiet: terminal })

if (terminal) {
  // A port another process holds fails the listen after it returns, and the
  // screen would draw every read failing against the wrong server.
  try {
    await new Promise((ok, fail) => { server.once('listening', ok); server.once('error', fail) })
    const { runTerminalConsole } = await import(resolve(global.fliRoot, 'core/console.js'))
    const { openUrl } = await import(resolve(global.fliRoot, 'core/open-url.js'))
    await runTerminalConsole({ api: url, openUrl })
  } catch (e) {
    log.error(e.code === 'EADDRINUSE' ? `Port ${port} already answers — another console holds it; --port picks another` : e.message)
    await shutdown(1)
  }
  await shutdown()
}

// Keep process alive
await new Promise(() => {})
```
