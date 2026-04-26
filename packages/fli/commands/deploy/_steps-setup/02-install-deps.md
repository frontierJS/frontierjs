---
title: 02-install-deps
description: Offer to install any missing dependencies
skip: "context.config.missingDeps?.length === 0"
---

```js
if (context.config.abort) return

const { host, missingDeps } = context.config

log.info(`${missingDeps.length} missing dependenc${missingDeps.length === 1 ? 'y' : 'ies'} — reviewing...`)

for (const dep of missingDeps) {
  const answer = await question(`Install ${dep.name} on ${host}? (y/N) `)

  if (answer.trim().toLowerCase() !== 'y') {
    log.warn(`Skipped ${dep.name} — you will need to install it manually before deploying`)
    log.info(`  ${dep.install}`)
    continue
  }

  log.info(`Installing ${dep.name}...`)
  try {
    // bun needs to be installed as the deploy user so it's on their PATH
    const installCmd = dep.name === 'bun'
      ? dep.install
      : `sudo sh -c "${dep.install}"`

    context.exec({ command: `ssh ${host} "${installCmd}"` })
    log.success(`${dep.name} installed`)
  } catch (err) {
    log.warn(`${dep.name} install failed: ${err.message}`)
    log.info(`Install manually: ${dep.install}`)
  }
}
```
