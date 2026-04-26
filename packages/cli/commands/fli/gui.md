---
title: fli:gui
description: Start the Web GUI server
alias: gui
examples:
  - fli gui
  - fli gui --port 8080
  - fli gui --open
flags:
  port:
    char: p
    type: number
    description: Port to listen on
    defaultValue: 8500
  open:
    char: o
    type: boolean
    description: Open the GUI in your browser after starting
    defaultValue: false
---

<script>
import { execSync, spawn } from 'child_process'
import { resolve } from 'path'
</script>

Start the FLI Web GUI server. Commands from both `fliRoot/commands/` and
`projectRoot/cli/src/routes/` are available via the browser interface.

```js
const { GLOBAL } = await import(resolve(global.fliRoot, 'core/ports.js'))
const port = flag.port || GLOBAL.gui
const url  = `http://localhost:${port}`

// Set port via env so server.js picks it up
process.env.FLI_PORT = String(port)

log.info(`Starting FLI Web GUI on ${url}`)
log.info(`Project: ${context.paths.root}`)

if (flag.dry) {
  log.dry(`Would start server on port ${port}`)
  if (flag.open) log.dry(`Would open ${url} in browser`)
  return
}

// Open browser if requested (non-blocking)
if (flag.open) {
  const opener = {
    linux:  `xdg-open ${url}`,
    darwin: `open ${url}`,
    win32:  `start ${url}`,
  }[process.platform] || `xdg-open ${url}`

  setTimeout(() => {
    try { execSync(opener, { stdio: 'ignore' }) } catch {}
  }, 800)
}

// Start the server — import from fliRoot so it always finds core/server.js
const { startServer } = await import(resolve(global.fliRoot, 'core/server.js'))
startServer()

// Keep process alive
await new Promise(() => {})
```
