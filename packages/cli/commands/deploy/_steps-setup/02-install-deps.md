---
title: 02-install-deps
description: Offer to install any missing dependencies
skip: "$.config.missingDeps?.length === 0"
---

```js
const { host, missingDeps } = $.config
const machine = machineFor($, host, $.config.serverPath)

const names = missingDeps.map(d => d.name).join(', ')
log.info(`${missingDeps.length} missing dependenc${missingDeps.length === 1 ? 'y' : 'ies'}: ${names}`)

// One answer for the lot; anything but y falls back to asking per dependency.
const all = $.flag['auto-install'] ||
  /^y(es)?$/i.test((await tty.line(`Install all missing dependencies on ${host}? (y/N) `)).trim())

// Asked before the first install and not before the loop, so a person who
// answers no to everything is not made to wait on the box's own apt.
let aptReady = false
const waitForApt = () => {
  if (aptReady) return
  aptReady = true
  log.info('Waiting until nothing else holds apt — a fresh box runs its own updates for its first minutes')
  const waited = machine.capture(`sudo sh -c '${aptIdle()}'`).trim()
  if (waited) log.info(`  apt was busy for ${waited}s`)
}

// Each dependency not installed, as 'declined' or 'failed' — what a later
// one's `needs` is checked against, and which reason it inherits.
const absent = new Map()
const failed = []

for (const dep of missingDeps) {
  const blocker = dep.needs?.find(n => absent.has(n))
  if (blocker) {
    log.warn(`Skipped ${dep.name} — its install runs ${blocker}, which is not there`)
    absent.set(dep.name, absent.get(blocker))
    if (absent.get(blocker) === 'failed' && !dep.optional) failed.push(dep)
    continue
  }

  const answer = all ? 'y' : await tty.line(`Install ${dep.name} on ${host}? (y/N) `)

  if (answer.trim().toLowerCase() !== 'y') {
    log.warn(`Skipped ${dep.name} — you will need to install it manually before deploying`)
    log.info(`  ${dep.install}`)
    absent.set(dep.name, 'declined')
    continue
  }

  try {
    waitForApt()
  } catch (err) {
    log.error(`apt never came free on ${host}: ${err.message}`)
    $.config.abort = true
    return
  }

  log.info(`Installing ${dep.name}...`)
  try {
    machine.run(`sudo sh -c '${dep.install}'`)
    log.success(`${dep.name} installed`)
  } catch (err) {
    log.warn(`${dep.name} install failed: ${err.message}`)
    log.info(`Install manually: ${dep.install}`)
    absent.set(dep.name, 'failed')
    if (!dep.optional) failed.push(dep)
  }
}

// A required install that failed stops setup here: every step after this one
// assumes it, and 05-caddy failing on a Caddy that was never installed reads as
// a Caddy that is misconfigured. A dependency the person declined is theirs to
// install and does not stop it.
if (failed.length) {
  log.error(`Setup stops here — ${failed.map(d => d.name).join(', ')} did not install, and the steps after this need ${failed.length === 1 ? 'it' : 'them'}`)
  log.info('Run fli deploy:setup again once the cause above is fixed; what is already installed is skipped')
  $.config.abort = true
}
```
