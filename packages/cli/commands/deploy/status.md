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

// ─── Is the machine reachable ─────────────────────────────────────────────────
const machine = machineFor(context, host, path, deployConf.transport)
const ask = (script) => {
  try { return machine.capture(script) }
  catch { return '' }
}

if (!machine.reach()) {
  log.error(`Cannot reach ${host}`)
  return
}

echo(`\n── ${appId} · ${target} · ${host} ─────────────────────────────────`)

// ─── API container ────────────────────────────────────────────────────────────
echo('\nAPI')
try {
  const line = ask(`docker inspect ${container} --format '{{.State.Status}} {{.Config.Image}} {{.State.StartedAt}}' 2>/dev/null || echo 'not found'`) || 'not found'

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
  const code = ask(`curl -s -o /dev/null -w '%{http_code}' http://localhost:${apiPort}${healthPath} 2>/dev/null || echo 'unreachable'`) || 'unreachable'
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
    const current = ask(`readlink ${path}/current 2>/dev/null || echo 'not set'`) || 'not set'
    const relName = current.split('/').pop()
    echo(`  current:    ${relName === 'not set' ? 'not deployed yet' : relName}`)

    // Available releases
    const releases = ask(`ls -1dt ${path}/releases/* 2>/dev/null | head -5 | xargs -I{} basename {} 2>/dev/null || echo ''`).split('\n').filter(Boolean)
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
  const { lockPath, parseLock, describeLock } =
    await import(new URL('file://' + global.fliRoot + '/core/lock.js'))
  const held = parseLock(ask(`cat ${lockPath(path)} 2>/dev/null || true`))
  if (!held) {
    echo(`  lock:       clear`)
  } else {
    const d = describeLock(held)
    echo(`  lock:       ACTIVE — ${d.lines[0]}`)
    for (const line of d.lines.slice(1)) echo(`              ${line}`)
    echo(`  ⚠ If that run is dead: fli deploy --resume, or fli deploy:unlock`)
  }
} catch {
  echo(`  lock:       error reading`)
}

// ─── Disk usage ───────────────────────────────────────────────────────────────
echo('\nDisk')
try {
  // The awk program keeps its own quotes — the script goes to the machine's
  // shell on stdin, so nothing here is parsed twice.
  echo(`  server:     ${ask(`df -h ${path} 2>/dev/null | tail -1 | awk '{print $3" used / "$2" total ("$5" full)"}'`) || '—'}`)
  echo(`  db/:        ${ask(`du -sh ${path}/db 2>/dev/null | cut -f1 || echo '—'`) || '—'}`)
  echo(`  releases/:  ${ask(`du -sh ${path}/releases 2>/dev/null | cut -f1 || echo '—'`) || '—'}`)
} catch {
  echo(`  disk:       error reading`)
}

// ─── Litestream ───────────────────────────────────────────────────────────────
echo('\nLitestream')
try {
  const ls = litestreamStatus(ask)

  if (ls.running) {
    if (ls.supported === false) {
      // "running" here used to be the whole answer, and it is the wrong one:
      // 0.3.x runs forever against a litestone database and replicates nothing.
      echo(`  status:     running (pid ${ls.pid}) — ${ls.version} is TOO OLD, replicating NOTHING`)
      echo(`  ⚠  ${LITESTREAM_MIN_LABEL}+ required — 0.3.x cannot parse STRICT tables and loops without exiting`)
    } else if (ls.supported === null) {
      echo(`  status:     running (pid ${ls.pid}) — version unreadable, cannot confirm ${LITESTREAM_MIN_LABEL}+`)
    } else {
      echo(`  status:     running (pid ${ls.pid}, ${ls.version})`)
    }

    // Try to find what replica URL it's replicating to
    const yml = ask(`cat ${path}/.litestone/litestream.yml 2>/dev/null || echo ''`)
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
