---
title: 04-repo
description: Verify or clone the git repo on the server
---

```js
if (context.config.abort) return

const { host, serverPath } = context.config

// Check if repo already exists
let repoExists = false
try {
  context.exec({ command: `ssh ${host} "[ -d ${serverPath}/.git ]"` })
  repoExists = true
} catch {
  repoExists = false
}

if (repoExists) {
  log.success('Git repo already present on server')
  return
}

// Prompt for the remote URL — read from local git origin by default
let remoteUrl = ''
try {
  const result = context.exec({ command: `git remote get-url origin`, stdio: 'pipe' })
  remoteUrl = result?.toString('utf8').trim() ?? ''
} catch {}

const answer = await question(
  `Git remote URL to clone${remoteUrl ? ` [${remoteUrl}]` : ''}: `
)
const url = answer.trim() || remoteUrl

if (!url) {
  log.warn('No remote URL provided — skipping repo clone')
  log.info(`Clone manually: ssh ${host} "git clone <url> ${serverPath}"`)
  return
}

log.info(`Cloning ${url} into ${serverPath}...`)
context.exec({ command: `ssh ${host} "git clone ${url} ${serverPath}"` })
log.success('Repo cloned')
```
