---
title: 02-pull
description: Pull latest code on the server
---

```js
if (context.config.abort) return

const { host, serverPath } = context.config

log.info('Pulling latest code on server...')
context.exec({ command: `ssh ${host} "cd ${serverPath} && git pull --ff-only"` })

// Capture the commit SHA we just pulled — used to tag the Docker image
const sha = context.exec({
  command: `ssh ${host} "cd ${serverPath} && git rev-parse --short HEAD"`,
  stdio: 'pipe',
})
// execSync with stdio:pipe returns a Buffer — normalise to string
const commit = (typeof sha === 'object' && sha?.toString)
  ? sha.toString('utf8').trim()
  : context.config.commit

context.config.commit  = commit
context.config.imageTag = `${context.config.appId}:${commit}`

log.success(`Pulled → ${commit}`)
```
