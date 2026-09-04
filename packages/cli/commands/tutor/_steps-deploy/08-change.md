---
title: 08-change
description: Change a line, and watch different bytes start
---

## A second deploy

Change one line, commit, pull it onto the machine, deploy again.

What is asserted is the **image id the container is on** — not that the command
succeeded, and not what the journal says about it. The image is the ground
truth: it is the bytes actually running, and a pipeline that reported success
while leaving the old container up would pass every other check here.

```js
narrate(context)

context.config.__step = 8

if (!needs(context, ['appDir', 'serverDir', 'firstImage'], { from: { appDir: '02-app', serverDir: '03-target', firstImage: '06-deploy' } })) return

const app       = context.config.appDir
const srv       = context.config.serverDir
const container = context.config.container

appendFileSync(join(app, 'api', 'index.ts'), `\n// changed by the tutorial at ${new Date().toISOString()}\n`)
git(app, ['add', '-A'])
git(app, ['commit', '-qm', 'a change to deploy'])
sh('git', ['pull', '-q', '--ff-only'], { cwd: srv })

context.exec({ command: `${context.fli} deploy --api`, cwd: app })

const now = imageBehind(container)

if (!await must(context, {
  ok:    Boolean(now) && now !== context.config.firstImage,
  name:  'a changed source is running as different bytes',
  asked: 'the container to be on a different image than the first deploy',
  got:   now ? (now === context.config.firstImage ? 'it is on the same image' : now.slice(0, 19)) : 'there is no container',
}, {
  likely:    'the build was fully cached, or the swap did not happen',
  reproduce: `docker inspect -f '{{.Image}}' ${container}`,
})) return

if (!await must(context, probe.httpStatus({
  url:     `http://127.0.0.1:${context.config.port}/api/health`,
  retries: 20,
  name:    'and it answers health',
}), {
  reproduce: `docker logs --tail 40 ${container}`,
})) return

remember(context, '08-change', { secondImage: now })
```
