---
title: 01-machine
description: Can this machine be a deploy target
---

## This machine, as a server

A deploy needs three things here: **Docker**, to build and run the image;
**git**, because the pipeline's second step is a `git pull` on the target; and
the port the container will answer on.

If Docker is not here the lesson stops rather than failing — there is nothing
wrong with your machine, this lesson just cannot be run on it.

```js
if (!await narrate(context)) return

context.config.__step = 1

for (const bin of ['docker', 'git']) {
  const found = probe.commandExists({ bin })
  if (!found.ok) {
    // `stop`, not `abort`: a deliberate early exit that SUCCEEDED. A refusal
    // would report a broken lesson, and the lesson is not broken — this machine
    // is not a deploy target and that is a legitimate answer.
    log.warn(`${bin} is not on this PATH, so there is no machine to deploy to — stopping here.`)
    log.info('  Lessons 1 and 2 need neither. This one is the only part of FrontierJS that does.')
    context.config.stop = true
    return
  }
  log.success(`${bin}`)
}

const daemon = sh('docker', ['version', '--format', '{{.Server.Version}}'])
if (daemon.code !== 0) {
  log.warn('the Docker daemon is not answering, so nothing can be built or run — stopping here.')
  log.info(`  ${daemon.stderr || daemon.error || 'docker version failed'}`)
  context.config.stop = true
  return
}
log.success(`the Docker daemon answers — ${daemon.stdout}`)

if (!await must(context, probe.portFree({ port: context.config.port, name: `port ${context.config.port} is free for the container` }), {
  likely:    'something is already listening there — an earlier run of this lesson, or a dev server',
  reproduce: `docker ps --filter publish=${context.config.port}`,
})) return
```
