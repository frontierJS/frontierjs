---
title: 01-check-deps
description: Check SSH connectivity and audit required server dependencies
---

```js
if (context.config.abort) return

const { host } = context.config
const machine  = machineFor(context, host, context.config.serverPath)

// ─── Is the machine reachable ─────────────────────────────────────────────────
log.info(`Checking ${machine.describe()}`)
if (machine.reach()) {
  log.success(machine.local ? 'Local machine' : 'SSH connected')
} else {
  log.error(`Cannot reach ${host}`)
  log.info('Check that your SSH key is authorized on the server:')
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
  // Not required by the pipeline — 05-backup runs `litestone backup` inside the
  // container, where the schema is. Installed because an operator on a box
  // running SQLite will want a shell against it, and finding out at 3am that
  // there isn't one is the wrong time.
  { name: 'sqlite3', check: 'sqlite3 --version',   install: 'apt-get install -y sqlite3' },
]

const missing = []

for (const dep of deps) {
  try {
    machine.run(`${dep.check} > /dev/null 2>&1`)
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
