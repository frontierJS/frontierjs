---
title: cloudflare:zones
description: List all zones (domains) in your Cloudflare account
alias: cf:zones
examples:
  - fli cf:zones
  - fli cf:zones --json
  - fli cf:zones --profile client
flags:
  profile:
    type: string
    description: cf profile to run as (default CLOUDFLARE_API_TOKEN, else cf's active login)
  json:
    char: j
    type: boolean
    description: Output as JSON
    defaultValue: false
---

Lists every zone the login reaches, across its accounts, with status, plan,
account and nameservers. `~` is a zone not yet active — nameservers not moved.

```js
const { profileFor, zones } = await import(new URL('file://' + global.fliRoot + '/core/cloudflare.js'))
const all = await zones(profileFor(flag.profile))

if (flag.json) { echo(JSON.stringify(all, null, 2)); return }

echo('')
echo(`  ${all.length} zone(s)\n`)
for (const z of all) {
  const status = z.status === 'active' ? '✓' : '~'
  echo(`  ${status}  ${z.name.padEnd(40)} ${z.id}`)
  echo(`       plan: ${z.plan?.name || 'free'}  ·  ${z.account?.name || ''}  ·  ${z.name_servers?.join(', ') || ''}`)
}
echo('')
```
