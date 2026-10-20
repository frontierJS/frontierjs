---
title: 03-directories
description: Create the app directory structure on the server
---

```js
if ($.config.abort) return

const { host, serverPath } = $.config
const machine = machineFor($, host, serverPath)
const { dbDir, envFile, secretsDir } = apiFiles($.config.deployConf, serverPath)

log.info(`Creating directory structure at ${serverPath}...`)

const dirs = [
  serverPath,
  dbDir,
  `${serverPath}/releases`,
].join(' ')

machine.run(`mkdir -p ${dirs} && (umask 077 && mkdir -p ${secretsDir})`)

// The container runs as the image's user and /db is bound over the host's db
// directory, so that directory belongs to the same uid (FJS-D1120). sudo for a
// login that is not root; a box where the login already owns uid 1000 needs none.
const { IMAGE_USER } = await import(new URL('file://' + global.fliRoot + '/core/deploy-image.js'))
machine.run(`chown ${IMAGE_USER.uid}:${IMAGE_USER.gid} ${dbDir} 2>/dev/null || sudo chown ${IMAGE_USER.uid}:${IMAGE_USER.gid} ${dbDir}`)

// ─── The env file, seeded once ────────────────────────────────────────────────
// The local `.env.production` is copied up only when the target has none, and
// never over one: from then on the server's copy is the operator's, and a revert
// grades the configuration generation against it (FJS-D1186). Overwriting would
// let a stale laptop file replace production secrets in silence.
const { existsSync } = await import('fs')
const { resolve } = await import('path')
const localEnv = resolve($.paths.root, '.env.production')
const present  = machine.capture(`[ -f ${envFile} ] && echo yes || echo no`).trim() === 'yes'

let envNote = 'populate before first deploy'
if (present) envNote = 'already there — left as it is'
else if (existsSync(localEnv)) {
  // ENCRYPTION_KEY goes to its own file in secretsDir rather than the env
  // file, because `--env-file` puts every line in the container's Config.Env and
  // `docker inspect` shows that to the docker group (FJS-3359). Both are written
  // from a private temp copy, created 600/400 before the bytes arrive and set
  // again after, because scp may carry the laptop's looser mode onto the file.
  const { readFileSync, writeFileSync, mkdtempSync, rmSync } = await import('fs')
  const { tmpdir } = await import('os')
  const keyFile = `${secretsDir}/ENCRYPTION_KEY`
  const lines   = readFileSync(localEnv, 'utf8').split('\n')
  const keyAt   = lines.findIndex(l => /^ENCRYPTION_KEY=./.test(l.trim()))
  const tmp     = mkdtempSync(resolve(tmpdir(), 'fli-setup-'))
  try {
    if (keyAt >= 0) {
      const keyThere = machine.capture(`[ -e ${keyFile} ] && echo yes || echo no`).trim() === 'yes'
      if (keyThere) log.info(`  ${keyFile} is already there — left as it is, and your local ENCRYPTION_KEY is not sent`)
      else {
        writeFileSync(resolve(tmp, 'key'), lines[keyAt].trim().slice('ENCRYPTION_KEY='.length) + '\n', { mode: 0o600 })
        machine.run(`umask 077 && : > ${keyFile}`)
        machine.send(resolve(tmp, 'key'), keyFile)
        machine.run(`chmod 400 ${keyFile}`)
      }
      lines.splice(keyAt, 1)
    }
    writeFileSync(resolve(tmp, 'env'), lines.join('\n'), { mode: 0o600 })
    machine.run(`umask 077 && : > ${envFile}`)
    machine.send(resolve(tmp, 'env'), envFile)
    machine.run(`chmod 600 ${envFile}`)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
  envNote = 'seeded from your local .env.production (mode 600) — edit it on the server from here on' +
            (keyAt >= 0 ? `; ENCRYPTION_KEY went to ${keyFile} (mode 400)` : '')
} else {
  machine.run(`umask 077 && echo "# Add your production env vars here" > ${envFile}`)
}
$.config.envSeeded = !present && existsSync(localEnv)

// The container reads secretsDir as the image's user, as it does dbDir, and
// after the seed above, which the login writes as itself.
machine.run(`chown -R ${IMAGE_USER.uid}:${IMAGE_USER.gid} ${secretsDir} 2>/dev/null || sudo chown -R ${IMAGE_USER.uid}:${IMAGE_USER.gid} ${secretsDir}`)

log.success('Directories ready')
log.info(`  ${serverPath}/db          ← SQLite database`)
log.info(`  ${serverPath}/releases/   ← web release history`)
log.info(`  ${serverPath}/src/        ← the app as committed, written by each deploy`)
log.info(`  ${envFile}  ← ${envNote}`)
log.info(`  ${secretsDir}/  ← a secret as its own file (mode 400), passed to the API as <KEY>_FILE`)
```
