---
title: cloudflare:zones
description: List all zones (domains) in your Cloudflare account
alias: cf:zones
examples:
  - fli cf:zones
  - fli cf:zones --json
flags:
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

Lists all zones in your account with their status, plan, and nameservers.

```js
const zones = await cfApi(context, 'GET', '/zones?per_page=50&status=active')

if (flag.json) { echo(JSON.stringify(zones, null, 2)); return }

echo('')
echo(`  ${zones.length} zone(s)\n`)
for (const z of zones) {
  const status = z.status === 'active' ? '✓' : '~'
  echo(`  ${status}  ${z.name.padEnd(40)} ${z.id}`)
  echo(`       plan: ${z.plan?.name || 'free'}  ·  ${z.name_servers?.join(', ') || ''}`)
}
echo('')
```
