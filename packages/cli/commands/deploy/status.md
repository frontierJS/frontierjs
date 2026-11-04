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
const head = await deployTargetFor($, flag, log)
if (!head) return
const { target, deployConf, resolved, appId } = head

const { server, path } = resolved
const apiPort    = deployConf.api?.port ?? 3000
const host       = resolved.host
const container  = apiContainer(appId, deployConf)

// ─── Is the machine reachable ─────────────────────────────────────────────────
const machine = machineFor($, host, path, deployConf.transport)
const ask = (script) => {
  try { return machine.capture(script) }
  catch { return '' }
}

if (!machine.reach()) {
  log.error(`Cannot reach ${host}`)
  $.config.abort = true
  return
}

// One labelled row: the label dim, the value as it comes. A value that is a
// verdict arrives already painted, so the tone is the caller's.
const row   = (label, value) => echo(`  ${chalk.dim(label.padEnd(11))}${value}`)
const bad   = (text) => chalk.red(text)
const warnT = (text) => chalk.yellow(text)
const note  = (text) => echo(`  ${chalk.yellow('⚠')} ${text}`)

echo(chalk`\n  {bold ${appId}}  {dim · ${target} · ${host}}`)

// ─── API container ────────────────────────────────────────────────────────────
echo(chalk`\n  {bold API}`)
try {
  const line = ask(`docker inspect ${container} --format '{{.State.Status}} {{.Config.Image}} {{.State.StartedAt}}' 2>/dev/null || echo 'not found'`) || 'not found'

  if (line === 'not found' || line === '') {
    row('container', bad('not running'))
  } else {
    const [status, image, startedAt] = line.split(' ')
    const started = startedAt ? new Date(startedAt).toLocaleString() : '—'
    row('container', container)
    row('status', status === 'running' ? chalk.green(status) : bad(status))
    row('image', image)
    row('started', chalk.dim(started))
  }
} catch {
  row('container', bad('error reading status'))
}

// ─── Health check ─────────────────────────────────────────────────────────────
const healthPath = deployConf.api?.health ?? '/health'
try {
  const port = await livePort(machine, container, apiPort)
  const code = ask(`curl -s -o /dev/null -w '%{http_code}' http://localhost:${port}${healthPath} 2>/dev/null || echo 'unreachable'`) || 'unreachable'
  const ok   = code === '200'
  row('health', `${healthPath} ${chalk.dim('→')} ${code} ${ok ? chalk.green('✓') : bad('✗')}`)
} catch {
  row('health', bad('unreachable'))
}

// ─── Pause ────────────────────────────────────────────────────────────────────
// Two answers to one question, printed side by side and never reconciled. The
// journal records an intent somebody had; the file records what is in force. A
// reader that printed one of them would be right until the day they differ,
// which is the only day this section matters.
echo(chalk`\n  {bold Pause}`)
try {
  const { driftVerdict, pausedFile, guardProbeScript } =
    await import(new URL('file://' + global.fliRoot + '/core/pause.js'))

  const filePresent = ask(`[ -f ${pausedFile(path)} ] && echo yes || echo no`).trim() === 'yes'
  const hasGuard    = ask(guardProbeScript(appId)).trim() === '200'

  let journalPaused = false, since = null, actor = null, behind = null
  if (deployConf.journal !== false) {
    try {
      // A reader, so it does not migrate: answering a question must not change
      // the schema of the thing being asked.
      const j = await connectJournal($, { host, serverPath: path, deployConf })
      const opened = await j.open({ app: appId, host, migrate: false })
      if (opened.verdict.kind === 'behind') behind = opened.verdict.from
      const st = await j.state({ app: appId, environment: target })
      journalPaused = st.paused
      since         = st.since
      actor         = st.actor
    } catch (err) {
      row('journal', warnT(`could not be read — ${err.message}`))
    }
  }

  const v = driftVerdict({ journalPaused, filePresent })
  row('state', `${v.state === 'paused' ? warnT(v.summary) : v.summary}${v.drift ? `  ${bad('⚠ DRIFT')}` : ''}`)
  if (v.state === 'paused' && since) row('since', chalk.dim(`${since}${actor ? ` · ${actor}` : ''}`))
  if (v.drift) {
    echo(`  ${chalk.dim(v.detail)}`)
    note(v.fix)
  }
  if (!hasGuard) {
    row('guard', warnT(`Caddy holds no route for ${appId} with a pause guard`))
    echo(chalk`  {dim ℹ  fli deploy:setup writes the routes}`)
  }
  if (behind !== null)
    row('journal', `${chalk.dim(`format ${behind}`)} — the next deploy migrates it`)

  // The other half of a pause (FJS-D262), asked of Caravan's own bin in the
  // container. Printed beside the edge and never reconciled with it.
  const { queueScript, queueStateLine } = await import(new URL('file://' + global.fliRoot + '/core/pause.js'))
  const q = queueStateLine({ output: ask(queueScript({ container, verb: 'state' })), edgePaused: filePresent })
  row('queues', `${q.text}${q.drift ? `  ${bad('⚠ DRIFT')}` : ''}`)
  if (q.drift) note(filePresent
    ? `the edge is paused and jobs are running — fli deploy:pause drains them`
    : `a deploy's queue pause is still in force with the edge serving — fli deploy:unpause lifts it`)
} catch {
  row('state', bad('could not read'))
}

// ─── Web release ─────────────────────────────────────────────────────────────
if (deployConf.web !== false) {
  echo(chalk`\n  {bold Web}`)
  try {
    // Current symlink target
    const current = ask(`readlink ${path}/current 2>/dev/null || echo 'not set'`) || 'not set'
    const relName = current.split('/').pop()
    row('current', relName === 'not set' ? warnT('not deployed yet') : relName)

    // Available releases
    const releases = ask(`ls -1dt ${path}/releases/* 2>/dev/null | head -5 | xargs -I{} basename {} 2>/dev/null || echo ''`).split('\n').filter(Boolean)
    row('releases', releases.length > 0 ? chalk.dim(releases.join('  ')) : chalk.dim('none'))
  } catch {
    row('releases', bad('error reading'))
  }
}

// ─── Deploy lock ──────────────────────────────────────────────────────────────
echo(chalk`\n  {bold Deploy}`)
try {
  const { lockPath, parseLock, describeLock } =
    await import(new URL('file://' + global.fliRoot + '/core/lock.js'))
  const held = parseLock(ask(`cat ${lockPath(path)} 2>/dev/null || true`))
  if (!held) {
    row('lock', chalk.green('clear'))
  } else {
    const d = describeLock(held)
    row('lock', `${warnT('ACTIVE')} — ${d.lines[0]}`)
    for (const line of d.lines.slice(1)) echo(`  ${' '.repeat(11)}${chalk.dim(line)}`)
    note(`If that run is dead: fli deploy --resume, or fli deploy:unlock`)
  }
} catch {
  row('lock', bad('error reading'))
}

// ─── Disk usage ───────────────────────────────────────────────────────────────
echo(chalk`\n  {bold Disk}`)
try {
  // The awk program keeps its own quotes — the script goes to the machine's
  // shell on stdin, so nothing here is parsed twice.
  row('server', ask(`df -h ${path} 2>/dev/null | tail -1 | awk '{print $3" used / "$2" total ("$5" full)"}'`) || '—')
  row('db/', ask(`du -sh ${path}/db 2>/dev/null | cut -f1 || echo '—'`) || '—')
  row('releases/', ask(`du -sh ${path}/releases 2>/dev/null | cut -f1 || echo '—'`) || '—')
} catch {
  row('disk', bad('error reading'))
}

// ─── Litestream ───────────────────────────────────────────────────────────────
echo(chalk`\n  {bold Litestream}`)
try {
  const ls = litestreamStatus(ask)

  if (ls.running) {
    if (ls.supported === false) {
      // 0.3.x runs forever against a litestone database and replicates nothing.
      row('status', bad(`running (pid ${ls.pid}) — ${ls.version} is TOO OLD, replicating NOTHING`))
      note(`${LITESTREAM_MIN_LABEL}+ required — 0.3.x cannot parse STRICT tables and loops without exiting`)
    } else if (ls.supported === null) {
      row('status', warnT(`running (pid ${ls.pid}) — version unreadable, cannot confirm ${LITESTREAM_MIN_LABEL}+`))
    } else {
      row('status', `${chalk.green('running')} ${chalk.dim(`(pid ${ls.pid}, ${ls.version})`)}`)
    }

    // Try to find what replica URL it's replicating to
    const yml = ask(`cat ${path}/.litestone/litestream.yml 2>/dev/null || echo ''`)
    const urlMatch = yml.match(/url:\s*(.+)/)
    if (urlMatch) {
      row('replica', urlMatch[1].trim())
    }
  } else {
    row('status', bad('not running'))
    echo(chalk`  {dim ℹ  Start with: litestone replicate litestone.config.js}`)
  }
} catch {
  row('status', bad('could not check'))
}

echo('')
```
