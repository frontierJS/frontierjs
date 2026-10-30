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

const NAME_MAX = 40
const namePad = Math.min(NAME_MAX, Math.max(4, ...all.map(z => z.name.length)))

echo('')
echo(`  ${chalk.bold('Zones')}  ${chalk.dim(`·  ${all.length} zone(s)  ·  ${chalk.green('✓')} active  ${chalk.yellow('~')} nameservers not moved`)}\n`)
for (const z of all) {
  const active = z.status === 'active'
  const mark = active ? chalk.green('✓') : chalk.yellow('~')
  const name = z.name.length > namePad ? z.name.slice(0, namePad - 1) + '…' : z.name
  echo(`  ${mark}  ${active ? name.padEnd(namePad) : chalk.yellow(name.padEnd(namePad))}  ${chalk.dim(z.id)}`)
  echo(chalk.dim(`     ${z.plan?.name || 'free'}  ·  ${z.account?.name || ''}  ·  ${z.name_servers?.join(', ') || ''}`))
}
echo('')
```
