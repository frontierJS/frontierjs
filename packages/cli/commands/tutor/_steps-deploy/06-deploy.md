---
title: 06-deploy
description: The real pipeline — journal, build, swap, health
---

## Deploying

```console
fli deploy --api
```

Twelve steps on the machine: a preflight, an env check, the pull, the build, a
backup, the **journal** opened, the swap, a health poll, and cleanup. It is the
same pipeline whether the machine is `localhost` or a host across the world.

Three things are asserted, and the third is the one worth knowing about.

The container is running and answers `/api/health` — the obvious two. And
`x-fjs-build`: the header the app states, which must be the commit this deploy
built. **Two packages decide that value and neither can be asked alone** — the
CLI stamps the build into the bundle, junction states it on every response, and
only a deployed container answers with it. It is what lets a browser know it is
running against a build that no longer exists.

```js
narrate(context)

context.config.__step = 6

if (!needs(context, ['appDir', 'serverDir'], { from: { appDir: '02-app', serverDir: '03-target' } })) return

const app       = context.config.appDir
const container = context.config.container

context.exec({ command: `${context.fli} deploy --api`, cwd: app })

if (!await must(context, probe.dockerRunning({ container, name: `the container ${container} is running` }), {
  likely:    'the deploy did not reach the swap, or the container exited — its output is above',
  reproduce: `docker logs --tail 40 ${container}`,
})) return

if (!await must(context, probe.httpStatus({
  url:     `http://127.0.0.1:${context.config.port}/api/health`,
  retries: 20,
  name:    'the deployed app answers health',
}), {
  likely:    'the container is up and the app inside it is not',
  reproduce: `docker logs --tail 40 ${container}`,
})) return

const commit = shortCommit(app)

if (!await must(context, probe.header({
  url:    `http://127.0.0.1:${context.config.port}/api/health`,
  name:   'x-fjs-build',
  expect: commit,
  label:  'the app states the build a browser compares against',
}), {
  likely:    'the stamp and the statement disagree — the cli writes VITE_FJS_BUILD and the container is passed FJS_BUILD',
  reproduce: `curl -sI http://127.0.0.1:${context.config.port}/api/health | grep -i x-fjs-build`,
})) return

remember(context, '06-deploy', { firstImage: imageBehind(container), firstCommit: commit })
```
