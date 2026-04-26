---
title: 01b-env-check
description: Validate that the server's .env.production has all required keys from .env.example
optional: true
skip: "!context.config.deployConf.api?.envCheck && !context.config.deployConf.api?.env_check"
---

```js
if (context.config.abort) return

const { host, serverPath, target, deployConf } = context.config
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

if (!refFile) {
  log.info('Env check: no .env.example or .env.keys found — skipping')
  log.info('  Create one to enable pre-deploy env validation')
  return
}

// ─── Parse required keys from reference file ──────────────────────────────────
// Lines that are not blank and not comments declare required keys.
// Values in .env.example are placeholders — only the keys matter here.
const refContent  = readFileSync(refFile, 'utf8')
const requiredKeys = refContent
  .split('\n')
  .map(l => l.trim())
  .filter(l => l && !l.startsWith('#'))
  .map(l => l.split('=')[0].trim())
  .filter(Boolean)

if (!requiredKeys.length) {
  log.info('Env check: reference file is empty — skipping')
  return
}

// ─── Read server env file ─────────────────────────────────────────────────────
const envFile   = deployConf.api?.env ?? `${serverPath}/.env.production`
let serverEnv = ''
try {
  const result = context.exec({
    command: `ssh ${host} "cat ${envFile} 2>/dev/null || echo ''"`,
    stdio: 'pipe',
  })
  serverEnv = result?.toString('utf8') ?? ''
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
  log.success(`Env check: all ${requiredKeys.length} required keys present on ${target}`)
  return
}

// ─── Report missing keys ──────────────────────────────────────────────────────
log.error(`Env check: ${missing.length} key(s) missing from ${envFile} on ${host}:`)
for (const key of missing) {
  log.warn(`  ${key}`)
}
log.info('')
log.info(`Add the missing keys to ${envFile} on the server, then redeploy.`)
log.info(`You can set them with:  fli env:set --remote ${missing[0]}=value`)
log.info(`Or pull them from local: fli env:pull --from ssh --server ${target} --path ${envFile}`)

context.config.abort = true
```
