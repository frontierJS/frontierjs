---
title: cloudflare:workers
description: List the Workers in your Cloudflare account
alias: cf:workers
examples:
  - fli cf:workers
  - fli cf:workers --status my-worker
  - fli cf:workers --json
flags:
  account:
    type: string
    description: Account ID (defaults to CLOUDFLARE_ACCOUNT_ID; needed when the login reaches more than one)
    defaultValue: ''
  status:
    type: string
    description: Show details for a specific worker
    defaultValue: ''
  profile:
    type: string
    description: cf profile to run as (default CLOUDFLARE_API_TOKEN, else cf's active login)
  json:
    char: j
    type: boolean
    description: Output as JSON
    defaultValue: false
---

Lists the Workers in the account. `--status <name>` shows one Worker's
domains and the bindings of the version serving its traffic. Cron triggers are
not shown — `cf` has no verb that reads them.

```js
const { profileFor, workers, worker, activeVersion } = await import(new URL('file://' + global.fliRoot + '/core/cloudflare.js'))
const profile = profileFor(flag.profile)
const acct = flag.account || undefined

// ── STATUS ────────────────────────────────────────────────────────────────────
if (flag.status) {
  const [w, version] = await Promise.all([
    worker(profile, acct, flag.status),
    activeVersion(profile, acct, flag.status),
  ])

  echo('')
  echo(`  ${chalk.bold(w.name)}  ${chalk.dim(`·  deployed ${w.deployed_on ? new Date(w.deployed_on).toLocaleString() : 'never'}`)}`)
  const domains = w.references?.domains ?? []
  if (domains.length) {
    echo(`\n  ${chalk.dim('DOMAINS')}`)
    for (const d of domains) echo(`    ${chalk.cyan(d.hostname)}`)
  }
  const bindings = version?.bindings ?? []
  if (bindings.length) {
    echo(`\n  ${chalk.dim(`BINDINGS  ·  version ${version.number}`)}`)
    for (const b of bindings) echo(`    ${chalk.dim(b.type.padEnd(16))} ${b.name}`)
  }
  echo('')
  return
}

// ── LIST ──────────────────────────────────────────────────────────────────────
const all = await workers(profile, acct)
if (flag.json) { echo(JSON.stringify(all, null, 2)); return }

echo('')
echo(`  ${chalk.bold('Workers')}  ${chalk.dim(`·  ${all.length} worker(s)`)}\n`)
const namePad = Math.min(40, Math.max(4, ...all.map(w => w.name.length)))
echo(chalk.dim(`  ${'NAME'.padEnd(namePad)}  UPDATED`))
for (const w of all) {
  const updated = w.updated_on ? new Date(w.updated_on).toLocaleString() : ''
  const name = w.name.length > namePad ? w.name.slice(0, namePad - 1) + '…' : w.name
  echo(`  ${name.padEnd(namePad)}  ${chalk.dim(updated)}`)
}
echo('')
```
