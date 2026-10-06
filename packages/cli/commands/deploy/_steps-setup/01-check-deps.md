---
title: 01-check-deps
description: Check SSH connectivity and audit required server dependencies
---

```js
if ($.config.abort) return

const { host } = $.config
const machine  = machineFor($, host, $.config.serverPath)

// ─── Is the machine reachable ─────────────────────────────────────────────────
log.info(`Checking ${machine.describe()}`)
if (machine.reach()) {
  log.success(machine.local ? 'Local machine' : 'SSH connected')
} else {
  log.error(`Cannot reach ${host}`)
  log.info('Check that your SSH key is authorized on the server:')
  log.info(`  ssh-copy-id ${host}`)
  $.config.abort = true
  return
}

// ─── Dependency checks ────────────────────────────────────────────────────────
// No single quote anywhere in an install line: 02-install-deps runs it as
// sudo sh -c '<line>'.
const CADDY_INSTALL = [
  'apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gnupg',
  'curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg',
  'curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list',
  'apt-get update',
  'apt-get install -y caddy',
  'systemctl disable --now caddy.service',
  'systemctl enable --now caddy-api.service',
].join(' && ')

const deps = [
  { name: 'docker',  check: 'docker --version',   install: 'curl -fsSL https://get.docker.com | sh' },
  // The caddy-api unit and not caddy.service: the routes are written through the
  // admin API, and only --resume brings them back after Caddy restarts. The same
  // install a fleet machine gets (basecamp's providers/compute/enrollment.ts).
  { name: 'caddy',   check: 'caddy version && systemctl is-active --quiet caddy-api', install: CADDY_INSTALL },
  { name: 'git',     check: 'git --version',       install: 'apt-get install -y git' },
  { name: 'bun',     check: 'bun --version',       install: 'curl -fsSL https://bun.sh/install | bash' },
  { name: 'rsync',   check: 'rsync --version',     install: 'apt-get install -y rsync' },
  // Not required by the pipeline — 05-backup runs `litestone backup` inside the
  // container, where the schema is. Installed because an operator on a box
  // running SQLite will want a shell against it, and finding out at 3am that
  // there isn't one is the wrong time.
  { name: 'sqlite3', check: 'sqlite3 --version',   install: 'apt-get install -y sqlite3' },
  // Pinned and checksum-verified, never apt — see LITESTREAM_PIN.
  { name: 'litestream', check: 'litestream version', install: litestreamInstall() },
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

$.config.missingDeps = missing

// Caddy binds 80 and 443 and fails to start beside anything holding them. Not
// stopped from here: whatever else that server serves goes down with it.
const active = (unit) => {
  try { machine.run(`systemctl is-active --quiet ${unit}`); return true } catch { return false }
}
if (active('nginx'))
  log.warn('  nginx is running and holds 80/443 — Caddy cannot bind until it stops: sudo systemctl disable --now nginx')
if (active('caddy'))
  log.warn('  caddy.service is running from a Caddyfile — switching to caddy-api drops whatever that Caddyfile serves')

if (missing.length === 0) {
  log.success('All dependencies present')
}
```
