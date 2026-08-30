---
title: 01-preflight
description: Check SSH and take the deploy lock — a revert is a deploy going the other way
---

```js
if (context.config.abort) return

const { hosts, target } = context.config

for (const h of hosts) {
  const m = machineFor(context, h.host, h.path)
  log.info(`Checking ${m.kind === 'local' ? 'the local machine' : `SSH → ${h.host}`}`)
  if (!m.reach()) {
    log.error(`Cannot reach ${h.host} — check your SSH key and server address`)
    context.config.abort = true
    return
  }
}

// The SAME lock file a deploy takes. A revert that ran beside a deploy would
// have two writers on one SQLite database and two answers to what is serving,
// which is the state the journal exists to make impossible.
log.info('Acquiring deploy lock...')
const lock = await acquireLock(context, { hosts, target })
if (!lock.ok) {
  for (const [level, line] of await lockRefusal(lock, { verb: 'revert' })) log[level](line)
  context.config.abort = true
  return
}

context.config.lockAcquired = true
log.success(`Preflight passed → ${context.config.appId} (${target})`)
```
