---
title: 01-preflight
description: Reach each machine, take the deploy lock, say what will go, and have a person type the app's id
---

```js
if ($.config.abort) return

const { appId, target, sides, dbDir, envFile, deployConf } = $.config
const container = apiContainer(appId, deployConf)
const keep      = $.flag['keep-data']

for (const s of sides) {
  if (!machineFor($, s.host, s.path).reach()) {
    log.error(`Cannot reach ${s.host} — check your SSH key and server address`)
    $.config.abort = true
    return
  }
}

// The SAME lock a deploy takes: a deploy landing halfway through a retire
// would start a container into a root this run is deleting.
const lock = await acquireLock($, { hosts: sides, target })
if (!lock.ok) {
  for (const [level, line] of await lockRefusal(lock, { verb: 'retire' })) log[level](line)
  $.config.abort = true
  return
}
$.config.lockAcquired = true

const apiMachine = machineFor($, $.config.api.host, $.config.api.path)
const running    = apiMachine.capture(`docker ps -a --format '{{.Names}}' 2>/dev/null | grep -x -e ${container} -e ${container}_replaced || true`).trim()
const images     = apiMachine.capture(`docker images -q ${appId} 2>/dev/null | sort -u | wc -l`).trim()
const outpost    = $.flag.outpost && deployConf.outpost === true &&
  apiMachine.capture('[ -x /usr/local/sbin/outpost-uninstall ] && echo yes || echo no').trim() === 'yes'
$.config.outpostPresent = outpost

// The uninstall takes the box's firewall with it while the apps the Outpost
// placed keep running, so a port one publishes on every interface without
// Outpost's fjs.exposed-port label is dropped from outside now and answers
// once this run ends.
const opened = !outpost ? [] : apiMachine
  .capture(`docker ps --format '{{.Names}}|{{.Label "fjs.exposed-port"}}|{{.Ports}}' 2>/dev/null || true`)
  .split('\n').filter(Boolean).map(l => l.split('|'))
  .filter(([name, declared]) => !declared && name !== container && name !== `${container}_replaced`)
  .map(([name, , ports = '']) => [name, [...new Set([...ports.matchAll(/(?:0\.0\.0\.0|\[::\]|::):(\d+)->/g)].map(m => m[1]))]])
  .filter(([, ports]) => ports.length)

echo('')
echo(`  ${appId} on ${target} — what goes:`)
echo(`    routes      fli-${appId} in Caddy on ${[...new Set(sides.map(s => s.host))].join(', ')}`)
if (outpost) {
  echo(`    outpost     outpost-uninstall on ${$.config.api.host} (Docker and Caddy stay)`)
  echo(`    firewall    ${$.config.api.host}'s, with the Outpost — inbound on any listening port is no longer dropped`)
  for (const [name, ports] of opened) echo(`                ${name} then answers from outside on ${ports.join(', ')}`)
}
echo(`    containers  ${running ? running.split('\n').join(', ') : 'none running'}`)
echo(`    images      ${images} of ${appId}`)
for (const s of sides) echo(`    files       ${s.host}:${s.path}${keep ? ' (db and env file kept)' : ''}`)
if (!keep) {
  echo(`    database    ${dbDir}`)
  echo(`    env file    ${envFile}`)
}
echo('')

// A replica somebody started against this database outlives the files it
// reads, and stopping it is theirs to decide.
const replica = apiMachine.capture(`pgrep -af litestream 2>/dev/null | grep -F ${$.config.api.path} || true`).trim()
if (replica) log.warn(`Litestream is replicating from ${$.config.api.path} — it is left running: ${replica.split('\n')[0]}`)

// `confirm: human` has already refused a run with no person behind it; a
// person at a terminal types the id, because the wrong app shares a prompt.
if (!$.flag.approved) {
  const typed = (await tty.line(`Type ${appId} to retire it: `)).trim()
  if (typed !== appId) {
    log.info('Nothing removed')
    $.config.abort = true
    return
  }
}
```
