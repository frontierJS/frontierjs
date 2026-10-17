---
title: 02-install-deps
description: Offer to install any missing dependencies
skip: "$.config.missingDeps?.length === 0"
---

```js
if ($.config.abort) return

const { host, missingDeps } = $.config
const machine = machineFor($, host, $.config.serverPath)

const names = missingDeps.map(d => d.name).join(', ')
log.info(`${missingDeps.length} missing dependenc${missingDeps.length === 1 ? 'y' : 'ies'}: ${names}`)

// One answer for the lot; anything but y falls back to asking per dependency.
const all = $.flag['auto-install'] ||
  /^y(es)?$/i.test((await tty.line(`Install all missing dependencies on ${host}? (y/N) `)).trim())

for (const dep of missingDeps) {
  const answer = all ? 'y' : await tty.line(`Install ${dep.name} on ${host}? (y/N) `)

  if (answer.trim().toLowerCase() !== 'y') {
    log.warn(`Skipped ${dep.name} — you will need to install it manually before deploying`)
    log.info(`  ${dep.install}`)
    continue
  }

  log.info(`Installing ${dep.name}...`)
  try {
    machine.run(`sudo sh -c '${dep.install}'`)
    log.success(`${dep.name} installed`)
  } catch (err) {
    log.warn(`${dep.name} install failed: ${err.message}`)
    log.info(`Install manually: ${dep.install}`)
  }
}
```
