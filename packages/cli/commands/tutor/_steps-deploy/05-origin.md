---
title: 05-origin
description: A commit to ship, and the environment it runs with on the machine
---

## What is on the machine

The pipeline's second step ships a **commit**: `git archive` of the app's HEAD,
extracted into `server/src/` — so the app needs one, and the machine needs no
repository and no key to read one.

Then `.env.production`, which lives on the machine and in no repository. `fli`
never writes it: what a deploy checks is that the keys the app declares are
**bound here**, and what binds them is you.

```js
if (!await narrate($)) return

$.config.__step = 5

if (!needs($, ['appDir', 'serverDir', 'deployEnv'], { from: { appDir: '02-app', serverDir: '03-target', deployEnv: '02-app' } })) return

const app = $.config.appDir
const srv = $.config.serverDir

if (!existsSync(join(app, '.git'))) {
  git(app, ['init', '-q', '.'])
}
git(app, ['add', '-A'])
git(app, ['commit', '-qm', 'the app, as the tutorial built it'])

const head = sh('git', ['rev-parse', '--short', 'HEAD'], { cwd: app })

if (!await must($, {
  ok:    head.code === 0,
  name:  'the app has a commit to ship',
  asked: `a HEAD in ${app}`,
  got:   head.code === 0 ? String(head.stdout).trim() : (head.stderr || `git rev-parse exited ${head.code}`),
}, {
  likely: 'the app has no commits — git commit found nothing to record',
})) return

if (existsSync(srv)) rmSync(srv, { recursive: true, force: true })

mkdirSync(join(srv, 'db'), { recursive: true })
// The container's environment, not the app's — `02-app` writes it beside the
// workspace so a course does not lose its own `.env` to a deploy.
copyFileSync($.config.deployEnv, join(srv, '.env.production'))
// The port inside the container is the deploy's to hand (FRONTIER_PORT_BE);
// FRONTIER_APP_URL is where a person reaches the app, which a reset link names.
// The deploy's env check compares the keys here against .env.example, so a
// missing one stops the deploy before it builds anything.
appendFileSync(join(srv, '.env.production'), `FRONTIER_APP_URL=http://127.0.0.1:${$.config.port}\n`)

for (const key of ['ENCRYPTION_KEY', 'DATABASE_URL', 'FRONTIER_APP_URL']) {
  if (!await must($, probe.fileContains({
    path:   join(srv, '.env.production'),
    needle: new RegExp(`^${key}=.+`, 'm'),
    name:   `.env.production binds ${key}`,
  }), {
    likely: 'the environment on the machine is incomplete — the deploy would refuse before building',
  })) return
}

log.info(`  the machine   ${srv}`)
```
