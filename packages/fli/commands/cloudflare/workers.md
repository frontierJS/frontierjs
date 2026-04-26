---
title: cloudflare:workers
description: List Workers scripts in your Cloudflare account
alias: cf:workers
examples:
  - fli cf:workers
  - fli cf:workers --status my-worker
  - fli cf:workers --json
flags:
  account:
    type: string
    description: Account ID (defaults to CLOUDFLARE_ACCOUNT_ID)
    defaultValue: ''
  status:
    type: string
    description: Show details for a specific worker
    defaultValue: ''
  token:
    type: string
    description: Override CLOUDFLARE_TOKEN for this run
    defaultValue: ''
  json:
    char: j
    type: boolean
    description: Output as JSON
    defaultValue: false
---

<script>
const accountId = (context) => context.flag.account || process.env.CLOUDFLARE_ACCOUNT_ID
</script>

Lists all Workers scripts in your account. Use `--status <name>` to see
bindings, cron triggers, and routes for a specific worker.

```js
const acct = accountId(context)
if (!acct) { log.error('No account ID — set CLOUDFLARE_ACCOUNT_ID or use --account'); return }

// ── STATUS ────────────────────────────────────────────────────────────────────
if (flag.status) {
  const [worker, bindings, schedules] = await Promise.all([
    cfApi(context, 'GET', `/accounts/${acct}/workers/scripts/${flag.status}`).catch(() => null),
    cfApi(context, 'GET', `/accounts/${acct}/workers/scripts/${flag.status}/bindings`).catch(() => []),
    cfApi(context, 'GET', `/accounts/${acct}/workers/scripts/${flag.status}/schedules`).catch(() => ({ schedules: [] })),
  ])

  echo('')
  echo(`  ${flag.status}`)
  if (worker) {
    echo(`  modified: ${new Date(worker.modified_on || worker.created_on).toLocaleString()}`)
  }
  if (bindings.length) {
    echo(`\n  bindings:`)
    for (const b of bindings) echo(`    ${b.type.padEnd(12)} ${b.name}`)
  }
  const crons = schedules?.schedules || []
  if (crons.length) {
    echo(`\n  cron triggers:`)
    for (const c of crons) echo(`    ${c.cron}`)
  }
  echo('')
  return
}

// ── LIST ──────────────────────────────────────────────────────────────────────
const workers = await cfApi(context, 'GET', `/accounts/${acct}/workers/scripts`)
if (flag.json) { echo(JSON.stringify(workers, null, 2)); return }

echo('')
echo(`  ${workers.length} worker(s)\n`)
for (const w of workers) {
  const modified = w.modified_on ? new Date(w.modified_on).toLocaleString() : ''
  echo(`  ·  ${w.id.padEnd(40)} ${modified}`)
}
echo('')
```
