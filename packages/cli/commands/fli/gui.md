---
title: fli:gui
description: Start the Web GUI server
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
    description: Open the GUI in your browser after starting
    defaultValue: false
---

<script>
import { resolve, join, basename } from 'path'
import { existsSync, readFileSync } from 'fs'
</script>

Start the FLI Web GUI server. Commands from both `fliRoot/commands/` and
`projectRoot/cli/src/routes/` are available via the browser interface.

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
const port    = typed ? flag.port : guiPort(inApp ? $.paths.root : null, { env })
const url  = `http://localhost:${port}`

// Set port via env so server.js picks it up
process.env.FLI_PORT = String(port)

log.info(`Starting FLI Web GUI on ${url}`)
log.info(`Project: ${$.paths.root}`)

if (flag.dry) {
  log.dry(`Would start server on port ${port}`)
  if (flag.open) log.dry(`Would open ${url} in browser`)
  return
}

// Open browser if requested (non-blocking)
if (flag.open) {
  const { openUrl } = await import(resolve(global.fliRoot, 'core/open-url.js'))
  setTimeout(() => openUrl(url), 800)
}

// Start the server — import from fliRoot so it always finds core/server.js
const { startServer } = await import(resolve(global.fliRoot, 'core/server.js'))
startServer()

// Keep process alive
await new Promise(() => {})
```
