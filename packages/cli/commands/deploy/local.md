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
// Every failure below THROWS. `log.error` only writes a line — the exit code
// comes from a thrown error and nothing else — so these used to report a
// problem and exit 0, which makes this command unusable as a gate: the CI
// phase that runs it, and a person reading `echo $?`, both saw success.
const frontierConfig = await loadFrontierConfig(context.paths.root)
const deployConf     = frontierConfig?.deploy

if (!deployConf) {
  log.info('Run fli make:deploy to scaffold a deploy config')
  throw new Error('No deploy block found in frontier.config.js')
}

const appId      = deployConf.app_id ?? context.paths.root.split('/').pop()
const dockerfile = deployConf.api?.dockerfile ?? 'deploy/Dockerfile'
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
  log.info('Run fli make:deploy to scaffold one, or set deploy.api.dockerfile in frontier.config.js')
  throw new Error(`Dockerfile not found: ${dockerfile}`)
}

const envFilePath = resolve(context.paths.root, envFile)
if (!existsSync(envFilePath)) {
  log.warn(`${envFile} not found — container will start without env vars`)
  log.info('Create it or use --env-file to point at another file')
}

if (flag.dry) {
  log.dry(`Would vendor: ${GENERATED_DIR}/ (manifest + any link:/workspace: package)`)
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
    log.info('Stop it first with:  docker rm -f ' + container)
    log.info('Or rerun with:       fli deploy:local --clean')
    throw new Error(`Container '${container}' already exists`)
  } catch (err) {
    if (/already exists/.test(err?.message ?? '')) throw err
    // Good — doesn't exist yet
  }
}

// ─── Vendor ───────────────────────────────────────────────────────────────────
// The Dockerfile installs from deploy/generated/, never from package.json. An
// app scaffolded with `--source local` depends on the framework by `link:`,
// which a build cannot resolve — this is what makes it buildable at all
// (FJS-241), and it is why this command can now be run against the scaffold this
// repo produces by default.
log.info('Vendoring dependencies into the build context...')
vendorApp(context.paths.root, log)

// ─── Build check ──────────────────────────────────────────────────────────────
// Reported here and refused in `fli deploy`. The difference is what the two
// commands are for: this one answers *does the image build and start at all*,
// and blocking that on a promotion property would trade a working smoke test for
// a correctness argument the deploy is about to make anyway.
const bc = await import(new URL('file://' + global.fliRoot + '/core/build-check.js'))
const bcFindings = bc.inspectBuild(bc.gatherLocal({ root: context.paths.root, fs: await import('fs'), dockerfile }))

if (!bcFindings.length) {
  log.success(`Build check: ${bc.summarize(bcFindings)}`)
} else {
  log.info('')
  for (const f of bcFindings) {
    const [head, detail, fix] = bc.renderFinding(f)
    const say = f.level === 'error' ? log.error : log.warn
    say(`  ${head}`)
    log.info(`    ${detail}`)
    log.info(`    ${fix}`)
  }
  log.info('')
  if (bc.refuses(bcFindings)) log.warn(`Build check: ${bc.summarize(bcFindings)} — fli deploy will refuse this build`)
  else                        log.info(`Build check: ${bc.summarize(bcFindings)}`)
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
  // AFTER --env-file, so it wins. The image EXPOSEs 3000 and the port mapping
  // targets 3000, but the app binds whatever PORT says — and the scaffold's .env
  // says 8100, so without this the container listens on a port nothing forwards
  // and the health check reports "unreachable" as though the app were broken.
  `--env PORT=3000`,
  `--env NODE_ENV=production`,
  // Same cap as a real deploy. A test container that runs for a week is the
  // one nobody is watching the disk for.
  ...dockerLogArgs(frontierConfig?.deploy),
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
  log.info('')
  log.info('Container logs:')
  echo('')
  context.exec({ command: `docker logs --tail 50 ${container}` })
  echo('')
  log.info(`Stop the container with:  docker rm -f ${container}`)
  throw new Error(`Health check failed after ${attempts * intervalMs / 1000}s — http://localhost:${port}${healthPath}`)
}

log.success(`Health check passed → http://localhost:${port}${healthPath}`)
echo('')
log.info(`API running at:  http://localhost:${port}`)
log.info(`View logs with:  docker logs -f ${container}`)
log.info(`Stop with:       docker rm -f ${container}`)
```
