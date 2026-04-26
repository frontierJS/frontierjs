---
title: deploy:local
description: Build and run the API Docker image locally — validates the container before deploying
alias: dlocal
examples:
  - fli deploy:local
  - fli deploy:local --clean
  - fli deploy:local --dry
flags:
  clean:
    char: c
    type: boolean
    description: Stop and remove any existing local test container first
    defaultValue: false
  env-file:
    type: string
    description: Local env file to pass into the container
    defaultValue: '.env'
  port:
    char: p
    type: string
    description: Local port to bind the container to
    defaultValue: '3001'
---

```js
const frontierConfig = await loadFrontierConfig(context.paths.root)
const deployConf     = frontierConfig?.deploy

if (!deployConf) {
  log.error('No deploy block found in frontier.config.js')
  log.info('Run fli make:deploy to scaffold a deploy config')
  return
}

const appId      = deployConf.app_id ?? context.paths.root.split('/').pop()
const dockerfile = deployConf.api?.dockerfile ?? 'api/deploy/Dockerfile'
const healthPath = deployConf.api?.health ?? '/health'
const port       = flag.port
const envFile    = flag['env-file']
const tag        = `${appId}:local`
const container  = `${appId}-local`
const dbDir      = './db'

// ─── Check Dockerfile exists ──────────────────────────────────────────────────
const { existsSync } = await import('fs')
const { resolve }    = await import('path')

const dockerfilePath = resolve(context.paths.root, dockerfile)
if (!existsSync(dockerfilePath)) {
  log.error(`Dockerfile not found: ${dockerfile}`)
  log.info('Run fli make:deploy to scaffold one, or set deploy.api.dockerfile in frontier.config.js')
  return
}

const envFilePath = resolve(context.paths.root, envFile)
if (!existsSync(envFilePath)) {
  log.warn(`${envFile} not found — container will start without env vars`)
  log.info('Create it or use --env-file to point at another file')
}

if (flag.dry) {
  log.dry(`Would build: docker build -t ${tag} -f ${dockerfile} .`)
  log.dry(`Would run:   docker run -d --name ${container} -p 127.0.0.1:${port}:3000 ...`)
  return
}

// ─── Clean up existing test container ────────────────────────────────────────
if (flag.clean) {
  log.info(`Removing existing container: ${container}`)
  try {
    context.exec({ command: `docker stop ${container} 2>/dev/null || true` })
    context.exec({ command: `docker rm   ${container} 2>/dev/null || true` })
  } catch {}
} else {
  // Check if test container already exists
  try {
    context.exec({ command: `docker inspect ${container} > /dev/null 2>&1` })
    log.error(`Container '${container}' already exists`)
    log.info('Stop it first with:  docker rm -f ' + container)
    log.info('Or rerun with:       fli deploy:local --clean')
    return
  } catch {
    // Good — doesn't exist yet
  }
}

// ─── Build ────────────────────────────────────────────────────────────────────
log.info(`Building ${tag} from ${dockerfile}...`)
context.exec({ command: `docker build -t ${tag} -f ${dockerfile} ${context.paths.root}` })
log.success(`Image built → ${tag}`)

// ─── Run ──────────────────────────────────────────────────────────────────────
log.info(`Starting ${container} on port ${port}...`)

const envArg = existsSync(envFilePath) ? `--env-file ${envFilePath}` : ''
const runCmd = [
  'docker run -d',
  `--name ${container}`,
  `-p 127.0.0.1:${port}:3000`,
  `--volume ${resolve(context.paths.root, dbDir)}:/db`,
  envArg,
  `--env NODE_ENV=production`,
  tag,
].filter(Boolean).join(' ')

context.exec({ command: runCmd })
log.success(`Container started → ${container}`)
log.info('  Migrations running in entrypoint...')

// ─── Health check ─────────────────────────────────────────────────────────────
const attempts   = 10
const intervalMs = 2000

log.info(`Waiting for ${healthPath} on :${port}...`)

let healthy = false
for (let i = 1; i <= attempts; i++) {
  await new Promise(r => setTimeout(r, intervalMs))
  try {
    const result = context.exec({
      command: `curl -s -o /dev/null -w "%{http_code}" http://localhost:${port}${healthPath}`,
      stdio: 'pipe',
    })
    const code = result?.toString('utf8').trim()
    if (code === '200') { healthy = true; break }
    log.info(`  attempt ${i}/${attempts}: ${code}`)
  } catch {
    log.info(`  attempt ${i}/${attempts}: unreachable`)
  }
}

if (!healthy) {
  log.error(`Health check failed after ${attempts * intervalMs / 1000}s`)
  log.info('')
  log.info('Container logs:')
  echo('')
  context.exec({ command: `docker logs --tail 50 ${container}` })
  echo('')
  log.info(`Stop the container with:  docker rm -f ${container}`)
  return
}

log.success(`Health check passed → http://localhost:${port}${healthPath}`)
echo('')
log.info(`API running at:  http://localhost:${port}`)
log.info(`View logs with:  docker logs -f ${container}`)
log.info(`Stop with:       docker rm -f ${container}`)
```
