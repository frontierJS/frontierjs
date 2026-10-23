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

// /db is bound over the host's db directory, so that directory belongs to the
// uid the container runs as: on a box the app's own user (FJS-D1484), and on
// localhost the image's (FJS-D1120), where no other app shares the machine and
// making a user would need sudo. sudo for a login that is not root.
const { IMAGE_USER, appUser, ensureAppUser } = await import(new URL('file://' + global.fliRoot + '/core/deploy-image.js'))
let owner = `${IMAGE_USER.uid}:${IMAGE_USER.gid}`
if (!machine.local) {
  const user = appUser($.config.appId)
  machine.run(ensureAppUser(user))
  owner = `${user}:${user}`
}
// SQLite makes its files 644, so a uid of its own does not stop another app
// reading them through a 755 directory.
machine.run(`chown ${owner} ${dbDir} 2>/dev/null || sudo chown ${owner} ${dbDir}`)
machine.run(`chmod 750 ${dbDir} 2>/dev/null || sudo chmod 750 ${dbDir}`)

// ─── The env file, seeded once ────────────────────────────────────────────────
// The local `.env.production` is copied up only when the target has none, and
// never over one: from then on the server's copy is the operator's, and a revert
// grades the configuration generation against it (FJS-D1186). Overwriting would
// let a stale laptop file replace production secrets in silence.
const { existsSync } = await import('fs')
const { resolve } = await import('path')
const localEnv = resolve($.paths.root, '.env.production')
const present  = machine.capture(`[ -f ${envFile} ] && echo yes || echo no`).trim() === 'yes'
const keyFile  = `${secretsDir}/ENCRYPTION_KEY`

// A box with neither file is a first seed, and an app whose .env.example names
// ENCRYPTION_KEY would otherwise boot on nothing or be refused by 01b-env-check
// at its first deploy. The key is made into the LOCAL file, which the seed below
// then carries up, so the operator holds the copy a restore needs.
if (!present && machine.capture(`[ -e ${keyFile} ] && echo yes || echo no`).trim() === 'no') {
  const { fillKey } = await import(new URL('file://' + global.fliRoot + '/core/env-preflight.js'))
  if (fillKey($.paths.root, localEnv) === 'made') log.info(`  Made a new ENCRYPTION_KEY in ${localEnv} — it is the one copy off the box: keep it`)
}

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
  const lines   = readFileSync(localEnv, 'utf8').split('\n')
  // The seed carries the file as written, so a copy older than the mount at
  // CONTAINER_DB_DIR is named here rather than found after a build (FJS-3438).
  const { strayDatabasePaths } = await import(new URL('file://' + global.fliRoot + '/core/local-env.js'))
  for (const { key, value } of strayDatabasePaths(lines.join('\n'), CONTAINER_DB_DIR))
    log.warn(`  ${localEnv}: ${key}=${value} is outside ${CONTAINER_DB_DIR}, which a swap does not keep — the first deploy will refuse it; fix it before or after the seed`)
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

// The container reads secretsDir as the owner of dbDir, and after the seed
// above, which the login writes as itself.
machine.run(`chown -R ${owner} ${secretsDir} 2>/dev/null || sudo chown -R ${owner} ${secretsDir}`)

log.success('Directories ready')
log.info(`  ${serverPath}/db          ← SQLite database, owned by ${owner.split(':')[0]}`)
log.info(`  ${serverPath}/releases/   ← web release history`)
log.info(`  ${serverPath}/src/        ← the app as committed, written by each deploy`)
log.info(`  ${envFile}  ← ${envNote}`)
log.info(`  ${secretsDir}/  ← a secret as its own file (mode 400), passed to the API as <KEY>_FILE`)
```
