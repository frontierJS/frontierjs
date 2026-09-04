---
title: 09-revert
description: Taking it back, and taking the taking-back back
---

## Reverting

```console
fli deploy:revert
```

The container goes back to the image the previous release ran, and the app
answers health again. That is the sentence the whole Release design exists to
make true.

Two things are asked here, and the second is not decoration. **A revert must
itself be a revert target** — otherwise the way back is one-way, and a revert
made in a hurry cannot be undone when it turns out the new release was not the
problem. A revert runs no build, so nothing recorded which image it put back
until the swap step started doing it.

`fli deploy:revert` is not `fli deploy:rollback`. Rollback puts the previous
image back with no journal, no history and no questions, and works on a machine
that has never deployed through one. Revert restores the **pair** — a Release
and the environment generation it ran with — and refuses by name when it
cannot: no recorded image, a deploy in flight, nothing prior. Three of its
refusals carry no override at all, because they are not judgement calls.

```js
narrate(context)

context.config.__step = 9

if (!needs(context, ['appDir', 'firstImage', 'secondImage'], { from: { appDir: '02-app', firstImage: '06-deploy', secondImage: '08-change' } })) return

const app       = context.config.appDir
const container = context.config.container

context.exec({ command: `${context.fli} deploy:revert`, cwd: app })

const back = imageBehind(container)

if (!await must(context, {
  ok:    back === context.config.firstImage,
  name:  'the previous release is serving again',
  asked: `the container on ${String(context.config.firstImage).slice(0, 19)}`,
  got:   back ? back.slice(0, 19) : 'there is no container',
}, {
  likely:    back === context.config.secondImage
    ? 'the revert reported success and moved nothing'
    : 'the revert restored something that is neither release',
  reproduce: `cd ${app} && fli deploy:journal --steps`,
})) return

if (!await must(context, probe.httpStatus({
  url:     `http://127.0.0.1:${context.config.port}/api/health`,
  retries: 20,
  name:    'and the release it went back to still works',
}), {
  reproduce: `docker logs --tail 40 ${container}`,
})) return

// The way back from the way back.
context.exec({ command: `${context.fli} deploy:revert`, cwd: app })

if (!await must(context, {
  ok:    imageBehind(container) === context.config.secondImage,
  name:  'and a revert can itself be reverted',
  asked: `the container back on ${String(context.config.secondImage).slice(0, 19)}`,
  got:   imageBehind(container)?.slice(0, 19) || 'there is no container',
}, {
  likely: 'the revert recorded no image for itself, so there is nothing to go back to',
})) return

const steps = sh('bun', [join(global.fliRoot, 'bin', 'fli.js'), 'deploy:journal', '--steps'], { cwd: app })

if (!await must(context, {
  ok:    /revert/.test(steps.stdout),
  name:  'the journal records the reverts as transitions of their own',
  asked: 'a revert transition in the journal',
  got:   /revert/.test(steps.stdout) ? 'it is there' : 'the journal names no revert',
}, {
  reproduce: `cd ${app} && fli deploy:journal --steps`,
})) return
```
