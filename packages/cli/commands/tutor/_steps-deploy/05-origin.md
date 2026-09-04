---
title: 05-origin
description: The machine's copy — a git clone, and the environment it runs with
---

## What is on the machine

The pipeline's second step is `git pull` on the target, so the target needs a
checkout. Here that is a **clone of the app itself** into `server/` beside it —
the app is its own origin, which is the whole trick that makes this runnable
without a remote.

Then `.env.production`, which lives on the machine and in no repository. `fli`
never writes it: what a deploy checks is that the keys the app declares are
**bound here**, and what binds them is you.

```js
if (!await narrate(context)) return

context.config.__step = 5

if (!needs(context, ['appDir', 'serverDir'], { from: { appDir: '02-app', serverDir: '03-target' } })) return

const app = context.config.appDir
const srv = context.config.serverDir

if (!existsSync(join(app, '.git'))) {
  git(app, ['init', '-q', '.'])
}
git(app, ['add', '-A'])
git(app, ['commit', '-qm', 'the app, as the tutorial built it'])

if (existsSync(srv)) rmSync(srv, { recursive: true, force: true })
const cloned = sh('git', ['clone', '-q', app, srv])

if (!await must(context, {
  ok:    cloned.code === 0 && existsSync(join(srv, 'package.json')),
  name:  'the machine has a checkout of the app',
  asked: `a clone at ${srv}`,
  got:   cloned.code === 0 ? 'it is there' : (cloned.stderr || `git clone exited ${cloned.code}`),
}, {
  likely: 'the app has no commits — git commit found nothing to record',
})) return

mkdirSync(join(srv, 'db'), { recursive: true })
copyFileSync(join(app, '.env'), join(srv, '.env.production'))
// PORT is the container's own, inside it; APP_URL is what the app tells the
// world it is. The deploy's env check compares the keys here against
// .env.example, so a missing one stops the deploy before it builds anything.
appendFileSync(join(srv, '.env.production'), `PORT=3000\nAPP_URL=http://127.0.0.1:${context.config.port}\n`)

for (const key of ['ENCRYPTION_KEY', 'DATABASE_URL', 'PORT', 'APP_URL']) {
  if (!await must(context, probe.fileContains({
    path:   join(srv, '.env.production'),
    needle: new RegExp(`^${key}=.+`, 'm'),
    name:   `.env.production binds ${key}`,
  }), {
    likely: 'the environment on the machine is incomplete — the deploy would refuse before building',
  })) return
}

log.info(`  the machine   ${srv}`)
```
