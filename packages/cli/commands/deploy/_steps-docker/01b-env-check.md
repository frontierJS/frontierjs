---
title: 01b-env-check
description: Validate that the server's .env.production has all required keys from .env.example
optional: true
skip: "!$.config.doApi || (!$.config.deployConf.api?.envCheck && !Object.keys({ ...$.config.deployConf?.configuration, ...$.config.deployConf?.secrets, ...$.config.deployConf?.[$.config.target]?.configuration, ...$.config.deployConf?.[$.config.target]?.secrets }).length)"
---

```js
const { target, deployConf } = $.config
const { host, path: serverPath } = $.config.api
const { existsSync, readFileSync } = await import('fs')
const { resolve } = await import('path')

// ─── Find reference file ──────────────────────────────────────────────────────
// Look for .env.example, then .env.keys — the local declaration of required keys
const candidates = ['.env.example', '.env.keys']
let refFile = null
for (const name of candidates) {
  const p = resolve($.paths.root, name)
  if (existsSync(p)) { refFile = p; break }
}

// ─── The DECLARED keys ────────────────────────────────────────────────────────
//
// `deploy.secrets` is the second source: a secret is never applied by a deploy (a
// deploy writes no `.env` on a target, FJS-D1186, and `docker inspect` shows what
// `--env` carries), so its key is checked for PRESENCE in the operator's file exactly
// as `.env.example`'s are. `deploy.configuration` is applied by `06-swap`
// (FJS-D1029), so its keys are not required there -- but one ALSO set in the file is
// a line the declared value silently overrides, and that is warned.
//
// `configurationSet` is asked rather than the two objects merged here, because
// per-target-beats-app-wide is its rule and a second merge is a second answer.
const { configurationSet, ConfigurationError } = await import(new URL('file://' + global.fliRoot + '/core/release.js'))

let declaredKeys = []
let appliedKeys  = []
try {
  const set = configurationSet(deployConf, target)
  declaredKeys = Object.keys(set.secretRefs)
  appliedKeys  = Object.keys(set.values)
} catch (err) {
  // A malformed configuration set is the mint's refusal to make, not this step's — it
  // runs later and says it better. Nothing is checked from a set that would not
  // resolve, and the deploy is not stopped here.
  if (!(err instanceof ConfigurationError)) throw err
  log.warn(`Env check: the configuration set does not resolve (${err.message}) — checking .env.example only`)
}

if (!refFile && !declaredKeys.length && !appliedKeys.length) {
  log.info('Env check: no .env.example or .env.keys found, and no keys declared — skipping')
  log.info('  Create one, or declare deploy.configuration / deploy.secrets, to enable pre-deploy env validation')
  return
}

// ─── Parse required keys from reference file ──────────────────────────────────
// Lines that are not blank and not comments declare required keys.
// Values in .env.example are placeholders — only the keys matter here.
const fileKeys = refFile
  ? readFileSync(refFile, 'utf8')
      .split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'))
      .map(l => l.split('=')[0].trim())
      .filter(Boolean)
  : []

// Which source named a key is carried, because the fix differs: a key from
// `.env.example` is a convention somebody wrote down, and a key from the deploy
// block is a statement this environment carries it.
const source = new Map()
for (const k of fileKeys)     source.set(k, refFile.split('/').pop())
for (const k of declaredKeys) source.set(k, 'deploy.secrets')

const requiredKeys = [...source.keys()]

if (!requiredKeys.length && !appliedKeys.length) {
  log.info('Env check: nothing declares a required key — skipping')
  return
}

// ─── Read server env file ─────────────────────────────────────────────────────
const { envFile } = apiFiles(deployConf, serverPath)
let serverEnv = ''
try {
  serverEnv = machineFor($, host, serverPath).capture(`cat ${envFile} 2>/dev/null || echo ''`)
} catch {
  log.warn(`Env check: could not read ${envFile} on ${host} — skipping`)
  return
}

// ─── Compare ──────────────────────────────────────────────────────────────────
// A key in the secrets directory is present too: the swap passes it as a file.
const { secretsDir } = apiFiles(deployConf, serverPath)
const serverKeys = new Set([
  ...serverEnv
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'))
    .map(l => l.split('=')[0].trim())
    .filter(Boolean),
  ...secretNames(machineFor($, host, serverPath), secretsDir, log),
])

const shadowed = appliedKeys.filter(k => serverKeys.has(k))
for (const key of shadowed)
  log.warn(`Env check: ${key} is set in ${envFile} and in deploy.configuration — the declared value wins`)

// ─── A database the swap would not keep ───────────────────────────────────────
// The file is read whole by the container, so a DATABASE_URL or *_PATH outside
// the mount -- a relative one too, which lands under the WORKDIR -- is otherwise
// found only by 07-health, after the build, and then rolled back (FJS-3175).
const { strayDatabasePaths } = await import(new URL('file://' + global.fliRoot + '/core/local-env.js'))
const strays = strayDatabasePaths(serverEnv, CONTAINER_DB_DIR)
if (strays.length) {
  log.error(`Env check: ${envFile} on ${host} names a database outside ${CONTAINER_DB_DIR}, the one directory a swap keeps:`)
  for (const { key, value } of strays) log.warn(`  ${key.padEnd(28)} ${value}`)
  log.info(`Point each under ${CONTAINER_DB_DIR} (e.g. ${CONTAINER_DB_DIR}/app.db), then redeploy:`)
  log.info(`  ssh -t ${host} vi ${envFile}`)
  $.config.abort = true
}

const missing = requiredKeys.filter(k => !serverKeys.has(k))

if (missing.length === 0 && strays.length) return

if (missing.length === 0) {
  log.success(`Env check: all ${requiredKeys.length} required keys present on ${target}` + (declaredKeys.length ? ` (${declaredKeys.length} from deploy.secrets)` : ''))
  return
}

// ─── Report missing keys ──────────────────────────────────────────────────────
log.error(`Env check: ${missing.length} key(s) missing from ${envFile} on ${host}:`)
for (const key of missing) {
  log.warn(`  ${key.padEnd(28)} declared in ${source.get(key)}`)
}
log.info('')
log.info(`Add the missing keys to ${envFile} on the server, or a secret as its own file in ${secretsDir}/, then redeploy:`)
log.info(`  ssh -t ${host} vi ${envFile}`)
log.info(`Or pull them from local: fli env:pull --from ssh --server ${target} --path ${envFile}`)

$.config.abort = true
```
