---
title: basecamp:key
description: Mint a BASECAMP_API_KEY on the running Basecamp over ssh and store it in the global fli env — no browser, no password
effects: issues an API key in Basecamp, filed under the owner it is minted for; writes BASECAMP_API_KEY to ~/.config/fli/.env
examples:
  - fli basecamp:key
  - fli basecamp:key --as jordan@kobami.com
  - fli basecamp:key --scopes servers:write,apps:write --expires 90d
flags:
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

The key `basecamp:app`, `basecamp:deploy`, `outpost:install` and `ws:deps
--push` read, made without signing in. Basecamp refuses to let a key mint a
key, so the browser's way is a password, a second factor and the API keys
screen; this is `fli deploy:repl` instead — ssh to the box, `docker exec` into
the serving API container, and `api-keys.create` called **as** the owner, so
the service's own mint runs: scopes checked, the credential issued by auth, the
row and its trail entry written. Reaching the box over ssh is the proof of
standing a password would have been.

The token comes back on the child's stdout, is written to the global env and
is never printed. A key already in the global env is replaced, not revoked —
one from an old Basecamp is revoked there, on its API keys screen.

Runs from any directory: the target is `packages/basecamp`'s own deploy
config, the box `fli deploy:repl` reaches from there.

<script>
// `deploy:repl -e` in the Basecamp checkout: the answer is the child's stdout
// alone, the boot's chatter its stderr — held, and shown only when it fails.
const replLine = async (code, extra = []) => {
  const { spawnSync } = await import('node:child_process')
  const { resolve }   = await import('node:path')
  const { root } = provisionScript()
  const r = spawnSync(process.execPath, [resolve(global.fliRoot, 'bin/fli.js'), 'deploy:repl', '-e', code, ...extra],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', env: process.env })
  if (r.status !== 0) {
    const said = (r.stderr || '').trim().split('\n').filter(l => !l.startsWith('{"level"')).slice(-4).join('\n')
    throw new Error(`deploy:repl exited ${r.status ?? 'on a signal'}${said ? `:\n${said}` : ''}`)
  }
  try { return JSON.parse(r.stdout) }
  catch { throw new Error(`deploy:repl answered something that is not JSON: ${r.stdout.trim().slice(0, 200)}`) }
}

// Who may hold the key: a person, not a bot, who is an owner or admin of a
// workspace. A `sys` read, so it needs no --force.
const holders = async () =>
  (await replLine(`sys.workspaceMember.findMany({ where: { role: { in: ['owner', 'admin'] } }, select: { role: true, workspaceId: true, workspace: { select: { name: true } }, user: { select: { email: true, kind: true } } } })`))
    .filter(m => m.user?.kind === 'user')
    .map(m => ({ email: m.user.email, role: m.role, workspaceId: m.workspaceId, workspace: m.workspace?.name }))

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

// The service's own create, called as the holder in their workspace, so the
// mint is the one the API keys screen runs. Answers the token, or `{ error }`.
const mint = async (key, holder) => {
  const made = await replLine(`call('api-keys.create', ${JSON.stringify(key)})`, ['--as', holder.email, '--tenant', holder.workspaceId])
  return typeof made?.token === 'string'
    ? made
    : { error: 'Basecamp made the key but answered no token — revoke it on the API keys screen' }
}

const keyName = async () =>
  `fli ${(await import('node:os')).hostname()} ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`

const refuse = (log, message) => { log.error(message); process.exitCode = 1 }
</script>

```js
const { storeGlobal } = await import(new URL('file://' + global.fliRoot + '/core/global-env.js'))

const scopes = flag.scopes.split(',').map(s => s.trim()).filter(Boolean)
if (!scopes.length) return refuse(log, '--scopes names none — admin is every scope')

echo`\n  {bold fli basecamp:key}  {dim reading Basecamp's owners over ssh}`
const holder = await pickHolder(await holders(), { as: flag.as, tty, chalk })
if (holder.error) return refuse(log, holder.error)

const key = { name: flag.name || await keyName(), scopes, expiresIn: flag.expires }
echo`
  {dim name   } ${key.name}
  {dim holder } ${holder.email} {dim · ${holder.role} of ${holder.workspace}}
  {dim scopes } ${scopes.join(', ')} {dim · expires ${flag.expires}}
`
if (flag.dry) { log.dry('Nothing minted'); return }

const made = await mint(key, holder)
if (made.error) return refuse(log, made.error)

const file = storeGlobal('BASECAMP_API_KEY', made.token)
echo`  {green ✓} {bold BASECAMP_API_KEY} {dim ${made.tokenHint}} → ${file}\n`
```
