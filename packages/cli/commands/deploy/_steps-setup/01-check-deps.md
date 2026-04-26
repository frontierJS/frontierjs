---
title: 01-check-deps
description: Check SSH connectivity and audit required server dependencies
---

```js
if (context.config.abort) return

const { host } = context.config

// ─── SSH ──────────────────────────────────────────────────────────────────────
log.info(`Checking SSH → ${host}`)
try {
  context.exec({ command: `ssh -o ConnectTimeout=5 -o BatchMode=yes ${host} "echo ok" > /dev/null` })
  log.success('SSH connected')
} catch {
  log.error(`Cannot reach ${host}`)
  log.info('Check that your SSH key is authorised on the server:')
  log.info(`  ssh-copy-id ${host}`)
  context.config.abort = true
  return
}

// ─── Dependency checks ────────────────────────────────────────────────────────
const deps = [
  { name: 'docker',  check: 'docker --version',   install: 'curl -fsSL https://get.docker.com | sh' },
  { name: 'nginx',   check: 'nginx -v',            install: 'apt-get install -y nginx' },
  { name: 'git',     check: 'git --version',       install: 'apt-get install -y git' },
  { name: 'bun',     check: 'bun --version',       install: 'curl -fsSL https://bun.sh/install | bash' },
  { name: 'rsync',   check: 'rsync --version',     install: 'apt-get install -y rsync' },
]

const missing = []

for (const dep of deps) {
  try {
    context.exec({ command: `ssh ${host} "${dep.check} > /dev/null 2>&1"` })
    log.success(`  ${dep.name} ✓`)
  } catch {
    log.warn(`  ${dep.name} — not found`)
    missing.push(dep)
  }
}

context.config.missingDeps = missing

if (missing.length === 0) {
  log.success('All dependencies present')
}
```
