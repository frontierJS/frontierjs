---
title: ports:dev
description: Claim a port session for the current project and start dev servers
alias: dev
examples:
  - fli dev
  - fli dev --env test
  - fli dev --fe --be
  - fli dev --fe 2 --be 1
  - fli dev --dry
flags:
  env:
    type: string
    description: "Environment: dev | test | prod"
    defaultValue: dev
  fe:
    type: string
    description: Number of frontend service slots to claim (default 1 if flag present)
    defaultValue: ''
  be:
    type: string
    description: Number of backend service slots to claim (default 1 if flag present)
    defaultValue: ''
  tooling:
    type: boolean
    description: Claim a tooling port (prisma studio, etc.)
    defaultValue: false
---

<script>
import { resolve, basename } from 'path'
import { existsSync } from 'fs'
</script>

Claims port slots for this project from `~/.fli/sessions.lock` and injects
them as env vars (`FLI_PORT_FE`, `FLI_PORT_BE`, etc.) so your dev servers
can read them. Port slots are released automatically when the process exits.

The project name is derived from the current directory's `package.json` name,
falling back to the directory name.

## Port env vars injected

```
FLI_PORT_FE       →  frontend  (e.g. 8000)
FLI_PORT_BE       →  backend   (e.g. 8100)
FLI_PORT_TOOLING  →  tooling   (e.g. 8500)
```

Pass these into Vite via `--port $FLI_PORT_FE` or read them in your config.

```js
const { claimSession, autoRelease, port: makePort, GLOBAL, getSessionStatus } =
  await import(resolve(global.fliRoot, 'core/ports.js'))

const env = flag.env || 'dev'
if (!['dev', 'test', 'prod'].includes(env)) {
  log.error(`Invalid env "${env}" — must be dev | test | prod`)
  return
}

// Derive project name from package.json → dirname
let projectName
try {
  const pkg = JSON.parse(require('fs').readFileSync(resolve(context.paths.root, 'package.json'), 'utf8'))
  projectName = pkg.name?.replace(/^@[^/]+\//, '') || basename(context.paths.root)
} catch {
  projectName = basename(context.paths.root)
}

// Build category map from flags
const categories = {}
if (flag.fe !== '' || flag.fe === true) categories.fe = parseInt(flag.fe) || 1
if (flag.be !== '' || flag.be === true) categories.be = parseInt(flag.be) || 1
if (flag.tooling) categories.tooling = 1

// Default: fe + be if nothing specified
if (!Object.keys(categories).length) {
  categories.fe = 1
  categories.be = 1
}

log.info(`Project:    ${projectName}`)
log.info(`Env:        ${env}`)
log.info(`Requesting: ${Object.entries(categories).map(([k,v]) => `${v}× ${k}`).join(', ')}`)

if (flag.dry) {
  log.dry('Would claim session and inject:')
  let slot = 0
  for (const [cat, count] of Object.entries(categories)) {
    for (let i = 0; i < count; i++) {
      const p = makePort(cat, { env, projectId: 0, serviceId: i })
      log.dry(`  FLI_PORT_${cat.toUpperCase()}${count > 1 ? `_${i}` : ''} = ${p}`)
    }
  }
  return
}

let session
try {
  session = await claimSession(projectName, env, categories)
} catch (err) {
  log.error(err.message)
  return
}

log.success(`Session claimed  (project slot ${session.projectId})`)
echo('')

for (const [cat, ps] of Object.entries(session.ports)) {
  const list = Array.isArray(ps) ? ps : [ps]
  for (let i = 0; i < list.length; i++) {
    const varName = list.length > 1 ? `FLI_PORT_${cat.toUpperCase()}_${i}` : `FLI_PORT_${cat.toUpperCase()}`
    echo(`  ${varName.padEnd(22)} = ${list[i]}`)
  }
}

echo('')
echo(`  FLI_PORT_GUI = ${GLOBAL.gui}`)
echo('')

autoRelease(projectName)

log.info('Ports registered — start your dev servers:')
log.info('  vite --port $FLI_PORT_FE')
log.info('  node server.js --port $FLI_PORT_BE')
log.info('')
log.info('Session will be released on exit (Ctrl+C)')
```
