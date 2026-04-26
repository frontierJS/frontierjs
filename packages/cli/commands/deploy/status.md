---
title: deploy:status
description: Show what's running on the server — containers, web release, disk, last deploy
alias: dstatus
examples:
  - fli deploy:status
  - fli deploy:status --production
  - fli deploy:status --stage
flags:
  production:
    type: boolean
    description: Check production server
    defaultValue: false
  stage:
    type: boolean
    description: Check staging server
    defaultValue: false
---

```js
const target = resolveTarget(flag, context.git)

// ─── Load config ──────────────────────────────────────────────────────────────
const frontierConfig = await loadFrontierConfig(context.paths.root)
const deployConf     = frontierConfig?.deploy

if (!deployConf?.server) {
  log.error('No deploy block found in frontier.config.js')
  context.config.abort = true
  return
}

const targetConf = deployConf[target] ?? {}
const server     = targetConf.server ?? deployConf.server
const user       = targetConf.user   ?? deployConf.user ?? 'deploy'
const path       = targetConf.path   ?? deployConf.path
const appId      = deployConf.app_id ?? path.split('/').pop()
const apiPort    = deployConf.api?.port ?? 3000
const host       = `${user}@${server}`
const container  = `${appId}-api`

// ─── SSH check ────────────────────────────────────────────────────────────────
try {
  context.exec({ command: `ssh -o ConnectTimeout=5 -o BatchMode=yes ${host} "echo ok" > /dev/null` })
} catch {
  log.error(`Cannot reach ${host}`)
  return
}

echo(`\n── ${appId} · ${target} · ${host} ─────────────────────────────────`)

// ─── API container ────────────────────────────────────────────────────────────
echo('\nAPI')
try {
  const result = context.exec({
    command: `ssh ${host} "docker inspect ${container} --format '{{.State.Status}} {{.Config.Image}} {{.State.StartedAt}}' 2>/dev/null || echo 'not found'"`,
    stdio: 'pipe',
  })
  const line  = result?.toString('utf8').trim() ?? 'not found'

  if (line === 'not found' || line === '') {
    echo(`  container: not running`)
  } else {
    const [status, image, startedAt] = line.split(' ')
    const started = startedAt ? new Date(startedAt).toLocaleString() : '—'
    echo(`  container:  ${container}`)
    echo(`  status:     ${status}`)
    echo(`  image:      ${image}`)
    echo(`  started:    ${started}`)
  }
} catch {
  echo(`  container: error reading status`)
}

// ─── Health check ─────────────────────────────────────────────────────────────
const healthPath = deployConf.api?.health ?? '/health'
try {
  const result = context.exec({
    command: `ssh ${host} "curl -s -o /dev/null -w '%{http_code}' http://localhost:${apiPort}${healthPath} 2>/dev/null || echo 'unreachable'"`,
    stdio: 'pipe',
  })
  const code = result?.toString('utf8').trim() ?? 'unreachable'
  const ok   = code === '200'
  echo(`  health:     ${healthPath} → ${code}${ok ? ' ✓' : ' ✗'}`)
} catch {
  echo(`  health:     unreachable`)
}

// ─── Web release ─────────────────────────────────────────────────────────────
if (deployConf.web !== false) {
  echo('\nWeb')
  try {
    // Current symlink target
    const currentResult = context.exec({
      command: `ssh ${host} "readlink ${path}/current 2>/dev/null || echo 'not set'"`,
      stdio: 'pipe',
    })
    const current = currentResult?.toString('utf8').trim() ?? 'not set'
    const relName = current.split('/').pop()
    echo(`  current:    ${relName === 'not set' ? 'not deployed yet' : relName}`)

    // Available releases
    const relResult = context.exec({
      command: `ssh ${host} "ls -1dt ${path}/releases/* 2>/dev/null | head -5 | xargs -I{} basename {} 2>/dev/null || echo ''"`,
      stdio: 'pipe',
    })
    const releases = relResult?.toString('utf8').trim().split('\n').filter(Boolean) ?? []
    if (releases.length > 0) {
      echo(`  releases:   ${releases.join('  ')}`)
    } else {
      echo(`  releases:   none`)
    }
  } catch {
    echo(`  releases:   error reading`)
  }
}

// ─── Deploy lock ──────────────────────────────────────────────────────────────
echo('\nDeploy')
try {
  const lockResult = context.exec({
    command: `ssh ${host} "cat ${path}/.deploy.lock 2>/dev/null || echo ''"`,
    stdio: 'pipe',
  })
  const lock = lockResult?.toString('utf8').trim() ?? ''
  if (lock) {
    // Lock format: pid:timestamp:target
    const [pid, ts, tgt] = lock.split(':')
    echo(`  lock:       ACTIVE — pid ${pid}, target ${tgt}, since ${ts}`)
    echo(`  ⚠ Remove if stale: ssh ${host} "rm ${path}/.deploy.lock"`)
  } else {
    echo(`  lock:       clear`)
  }
} catch {
  echo(`  lock:       error reading`)
}

// ─── Disk usage ───────────────────────────────────────────────────────────────
echo('\nDisk')
try {
  const diskResult = context.exec({
    command: `ssh ${host} "df -h ${path} 2>/dev/null | tail -1 | awk '{print $3\\" used / \\"$2\\" total (\\"$5\\" full)\\"}'  "`,
    stdio: 'pipe',
  })
  echo(`  server:     ${diskResult?.toString('utf8').trim() ?? '—'}`)

  const dbResult = context.exec({
    command: `ssh ${host} "du -sh ${path}/db 2>/dev/null | cut -f1 || echo '—'"`,
    stdio: 'pipe',
  })
  echo(`  db/:        ${dbResult?.toString('utf8').trim() ?? '—'}`)

  const relResult = context.exec({
    command: `ssh ${host} "du -sh ${path}/releases 2>/dev/null | cut -f1 || echo '—'"`,
    stdio: 'pipe',
  })
  echo(`  releases/:  ${relResult?.toString('utf8').trim() ?? '—'}`)
} catch {
  echo(`  disk:       error reading`)
}

// ─── Litestream ───────────────────────────────────────────────────────────────
echo('\nLitestream')
try {
  const pidResult = context.exec({
    command: `ssh ${host} "pgrep -x litestream 2>/dev/null || echo ''"`,
    stdio: 'pipe',
  })
  const pid = pidResult?.toString('utf8').trim() ?? ''

  if (pid) {
    echo(`  status:     running (pid ${pid})`)

    // Try to find what replica URL it's replicating to
    const configResult = context.exec({
      command: `ssh ${host} "cat ${path}/.litestone/litestream.yml 2>/dev/null || echo ''"`,
      stdio: 'pipe',
    })
    const yml = configResult?.toString('utf8').trim() ?? ''
    const urlMatch = yml.match(/url:\s*(.+)/)
    if (urlMatch) {
      echo(`  replica:    ${urlMatch[1].trim()}`)
    }
  } else {
    echo(`  status:     not running`)
    echo(`  ℹ  Start with: litestone replicate litestone.config.js`)
  }
} catch {
  echo(`  status:     could not check`)
}

echo('')
```
