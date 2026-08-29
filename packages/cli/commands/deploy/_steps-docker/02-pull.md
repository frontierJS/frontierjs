---
title: 02-pull
description: Pull latest code on the server
---

```js
if (context.config.abort) return

const { hosts } = context.config

// Both halves build from source on their own machine, so both need the pull.
// Split or not, the SHA is read from the FIRST host and used to tag the image
// and name the web release — if the two ever disagree the deploy is shipping
// two different commits, which is worth a loud failure rather than a silent
// pair of versions.
const machines = new Map(hosts.map(h => [h.host, machineFor(context, h.host, h.path)]))

for (const h of hosts) {
  log.info(`Pulling latest code on ${h.host}...`)
  machines.get(h.host).run('git pull --ff-only', { cwd: h.path })
}

const readSha = (h) => machines.get(h.host).capture('git rev-parse --short HEAD', { cwd: h.path }) || null

const shas = hosts.map(h => ({ host: h.host, sha: readSha(h) }))
const distinct = [...new Set(shas.map(x => x.sha).filter(Boolean))]
if (distinct.length > 1) {
  log.error('The hosts are on different commits — refusing to deploy two versions:')
  for (const x of shas) log.error(`  ${x.host} → ${x.sha}`)
  context.config.abort = true
  return
}

const sha = shas[0]?.sha
const commit = sha ?? context.config.commit

context.config.commit  = commit
context.config.imageTag = `${context.config.appId}:${commit}`

log.success(`Pulled → ${commit}`)
```
