---
title: basecamp:key
description: Mint an API key on the running Basecamp over ssh and file it in the index of Basecamps (basecamps.json) — no browser, no password
effects: issues an API key in Basecamp, filed under the owner it is minted for; writes the key to the Basecamp's entry in ~/.config/fli/basecamps.json
examples:
  - fli basecamp:key
  - fli basecamp:key --as jordan@kobami.com
  - fli basecamp:key --scopes servers:write,apps:write --expires 90d
  - fli basecamp:key --server root@203.0.113.7 --basecamp ops --domain ops.example.com
flags:
  server:
    type: string
    description: The box Basecamp runs on, as ssh reaches it (default deploy.server in packages/basecamp/frontier.config.js)
    defaultValue: ''
  basecamp:
    type: string
    description: The name the key is filed under, the ssh Host the box answers to (default --server, else deploy.server in packages/basecamp/frontier.config.js)
    defaultValue: ''
  domain:
    type: string
    description: Basecamp's hostname, which the API origin is (default the one already filed under the name, else web.domain in packages/basecamp/frontier.config.js)
    defaultValue: ''
  as:
    type: string
    description: Whose key it is, by email — an owner or admin of the workspace (default ME when it is one, else the only one)
    defaultValue: ''
  name:
    type: string
    description: The key's name in the API keys list (default fli, this machine and the minute)
    defaultValue: ''
  scopes:
    type: string
    description: Comma-separated scopes, or admin for every scope
    defaultValue: 'admin'
  expires:
    type: string
    description: never, 30d, 90d or 1y
    defaultValue: 'never'
---

The key every `basecamp:*` command that calls the API reads, made without signing in. Basecamp refuses to let a key mint a
key, so the browser's way is a password, a second factor and the API keys
screen; this is `fli deploy:repl` instead — ssh to the box, `docker exec` into
the serving API container, and `api-keys.create` called **as** the owner, so
the service's own mint runs: scopes checked, the credential issued by auth, the
row and its trail entry written. Reaching the box over ssh is the proof of
standing a password would have been.

The token comes back on the child's stdout, is filed in `basecamps.json` under
the Basecamp's name and is never printed. The entry is the ssh Host name, the
API origin (`https://` and the hostname), the cloud and box id when `create`
filed them, and the key; a key already filed under the name is replaced, not
revoked — one from an old Basecamp is revoked there, on its API keys screen. A
scoped key or `runs` mark already on the entry stays.

Runs from any directory: the target is `packages/basecamp`'s own deploy
config, the box `fli deploy:repl` reaches from there, or `--server` for a box
that config does not name — one `fli basecamp:create` made.

<script>
// `--as`, else ME when ME holds a seat, else the only one, else asked at a
// terminal. Answers the holder, or `{ error }`.
const pickHolder = async (people, { as, tty, chalk }) => {
  if (!people.length) return { error: 'Basecamp has no owner or admin yet — make one at /setup' }
  const me    = people.find(p => p.email === process.env.ME)?.email
  const named = as || me
  const picks = named ? people.filter(p => p.email === named) : people
  if (!picks.length) return { error: `${named} is no owner or admin there. Those who are: ${people.map(p => p.email).join(', ')}` }
  if (picks.length === 1) return picks[0]
  if (!process.stdin.isTTY) return { error: `Several could hold it — pass --as: ${picks.map(p => `${p.email} (${p.workspace})`).join(', ')}` }
  const options = Object.fromEntries(picks.slice(0, 9).map((p, i) => [String(i + 1), `${p.email} · ${p.role} of ${p.workspace}`]))
  return picks[Number(await tty.keys(chalk`{cyan ?} {bold Whose key?}`, options)) - 1]
}

// The hostname already filed under `name`, so a re-mint needs no --domain.
const filedDomain = (name) => {
  const url = readBasecamps()[name]?.url
  try { return url ? new URL(url).host : '' } catch { return '' }
}

const refuse = (log, message) => { log.error(message); process.exitCode = 1 }
</script>

```js
const server = flag.server || await deployServer()
const name   = flag.basecamp || server
if (!name) return refuse(log, 'Pass --basecamp <name> or --server: the key is filed under the box\'s ssh Host name')
const domain = flag.domain || filedDomain(name) || await webDomain()
if (!domain) return refuse(log, 'Pass --domain: the key is filed with Basecamp\'s hostname, and none is filed or configured')

const box    = flag.server ? ['--server', flag.server] : []
const scopes = flag.scopes.split(',').map(s => s.trim()).filter(Boolean)
if (!scopes.length) return refuse(log, '--scopes names none — admin is every scope')

echo`\n  {bold fli basecamp:key}  {dim reading Basecamp's owners over ssh}`
const holder = await pickHolder(await holders(box), { as: flag.as, tty, chalk })
if (holder.error) return refuse(log, holder.error)

const key = { name: flag.name || await keyName(), scopes, expiresIn: flag.expires }
echo`
  {dim name   } ${key.name}
  {dim holder } ${holder.email} {dim · ${holder.role} of ${holder.workspace}}
  {dim scopes } ${scopes.join(', ')} {dim · expires ${flag.expires}}
`
if (flag.dry) { log.dry('Nothing minted'); return }

const made = await mint(key, holder, box)
if (made.error) return refuse(log, made.error)

const file = fileBasecamp(name, { url: `https://${domain}`, host: name.includes('@') ? undefined : name, apiKey: made.token })
echo`  {green ✓} {bold api key} {dim ${made.tokenHint} for ${name}} → ${file}\n`
```
