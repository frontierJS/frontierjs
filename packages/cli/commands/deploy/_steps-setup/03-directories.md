---
title: 03-directories
description: Create the app directory structure on the server
---

```js
if ($.config.abort) return

const { host, serverPath } = $.config
const machine = machineFor($, host, serverPath)

log.info(`Creating directory structure at ${serverPath}...`)

const dirs = [
  serverPath,
  `${serverPath}/db`,
  `${serverPath}/releases`,
].join(' ')

machine.run(`mkdir -p ${dirs}`)

// ─── The env file, seeded once ────────────────────────────────────────────────
// The local `.env.production` is copied up only when the target has none, and
// never over one: from then on the server's copy is the operator's, and a revert
// grades the configuration generation against it (FJS-D1186). Overwriting would
// let a stale laptop file replace production secrets in silence.
const { existsSync } = await import('fs')
const { resolve } = await import('path')
const envFile  = $.config.deployConf?.api?.env ?? `${serverPath}/.env.production`
const localEnv = resolve($.paths.root, '.env.production')
const present  = machine.capture(`[ -f ${envFile} ] && echo yes || echo no`).trim() === 'yes'

let envNote = 'populate before first deploy'
if (present) envNote = 'already there — left as it is'
else if (existsSync(localEnv)) {
  // Created 600 before the bytes arrive and set 600 again after, because scp
  // may carry the laptop's looser mode onto the file.
  machine.run(`umask 077 && : > ${envFile}`)
  machine.send(localEnv, envFile)
  machine.run(`chmod 600 ${envFile}`)
  envNote = 'seeded from your local .env.production (mode 600) — edit it on the server from here on'
} else {
  machine.run(`umask 077 && echo "# Add your production env vars here" > ${envFile}`)
}
$.config.envSeeded = !present && existsSync(localEnv)

log.success('Directories ready')
log.info(`  ${serverPath}/db          ← SQLite database`)
log.info(`  ${serverPath}/releases/   ← web release history`)
log.info(`  ${serverPath}/src/        ← the app as committed, written by each deploy`)
log.info(`  ${envFile}  ← ${envNote}`)
```
