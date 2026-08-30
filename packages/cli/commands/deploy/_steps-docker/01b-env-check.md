---
title: 01b-env-check
description: Validate that the server's .env.production has all required keys from .env.example
optional: true
skip: "!context.config.doApi || (!context.config.deployConf.api?.envCheck && !context.config.deployConf.api?.env_check && !Object.keys({ ...context.config.deployConf?.bindings, ...context.config.deployConf?.secrets, ...context.config.deployConf?.[context.config.target]?.bindings, ...context.config.deployConf?.[context.config.target]?.secrets }).length)"
---

```js
if (context.config.abort) return

const { target, deployConf } = context.config
const { host, path: serverPath } = context.config.api
const { existsSync, readFileSync } = await import('fs')
const { resolve } = await import('path')

// ─── Find reference file ──────────────────────────────────────────────────────
// Look for .env.example, then .env.keys — the local declaration of required keys
const candidates = ['.env.example', '.env.keys']
let refFile = null
for (const name of candidates) {
  const p = resolve(context.paths.root, name)
  if (existsSync(p)) { refFile = p; break }
}

// ─── The DECLARED keys ────────────────────────────────────────────────────────
//
// `deploy.bindings` and `deploy.secrets` are the second source, and folding them
// in here is what stops them being vacuous. Their VALUES are not applied by any
// step — `fli` writes no `.env` on a target, the operator owns that file, and
// the container is started with `--env-file` against it — so a block that only
// fed the Release hash was a declaration nothing on the target was ever graded
// against ([FJS-585](../../../../../ISSUES.md#fjs-585)).
//
// The keys are still worth declaring: they say what this environment is supposed
// to carry, per target, in a file that is reviewed. So they are checked for
// PRESENCE exactly as `.env.example`'s are, and the values stay the operator's.
//
// `bindingSet` is asked rather than the two objects merged here, because
// per-target-beats-app-wide is its rule and a second merge is a second answer.
const { bindingSet, BindingError } = await import(new URL('file://' + global.fliRoot + '/core/release.js'))

let declaredKeys = []
try {
  const set = bindingSet(deployConf, target)
  declaredKeys = [...Object.keys(set.values), ...Object.keys(set.secretRefs)]
} catch (err) {
  // A malformed binding set is the mint's refusal to make, not this step's — it
  // runs later and says it better. Nothing is checked from a set that would not
  // resolve, and the deploy is not stopped here.
  if (!(err instanceof BindingError)) throw err
  log.warn(`Env check: the binding set does not resolve (${err.message}) — checking .env.example only`)
}

if (!refFile && !declaredKeys.length) {
  log.info('Env check: no .env.example or .env.keys found, and no keys declared — skipping')
  log.info('  Create one, or declare deploy.bindings / deploy.secrets, to enable pre-deploy env validation')
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
for (const k of declaredKeys) source.set(k, 'deploy block')

const requiredKeys = [...source.keys()]

if (!requiredKeys.length) {
  log.info('Env check: nothing declares a required key — skipping')
  return
}

// ─── Read server env file ─────────────────────────────────────────────────────
const envFile   = deployConf.api?.env ?? `${serverPath}/.env.production`
let serverEnv = ''
try {
  serverEnv = machineFor(context, host, serverPath).capture(`cat ${envFile} 2>/dev/null || echo ''`)
} catch {
  log.warn(`Env check: could not read ${envFile} on ${host} — skipping`)
  return
}

// ─── Compare ──────────────────────────────────────────────────────────────────
const serverKeys = new Set(
  serverEnv
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'))
    .map(l => l.split('=')[0].trim())
    .filter(Boolean)
)

const missing = requiredKeys.filter(k => !serverKeys.has(k))

if (missing.length === 0) {
  log.success(`Env check: all ${requiredKeys.length} required keys present on ${target}` + (declaredKeys.length ? ` (${declaredKeys.length} from the deploy block)` : ''))
  return
}

// ─── Report missing keys ──────────────────────────────────────────────────────
log.error(`Env check: ${missing.length} key(s) missing from ${envFile} on ${host}:`)
for (const key of missing) {
  log.warn(`  ${key.padEnd(28)} declared in ${source.get(key)}`)
}
log.info('')
log.info(`Add the missing keys to ${envFile} on the server, then redeploy.`)
log.info(`You can set them with:  fli env:set --remote ${missing[0]}=value`)
log.info(`Or pull them from local: fli env:pull --from ssh --server ${target} --path ${envFile}`)

context.config.abort = true
```
