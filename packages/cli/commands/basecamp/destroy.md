---
title: basecamp:destroy
description: Destroy a droplet fli basecamp:create made
requires:
  - DIGITALOCEAN_TOKEN: https://cloud.digitalocean.com/account/api/tokens/new  Pick Full Access
effects: destroys a droplet at DigitalOcean and everything on its disk
confirm: human
examples:
  - fli basecamp:destroy 512345678
  - fli basecamp:destroy
args:
  -
    name: id
    description: The droplet id fli basecamp:create printed; with none, pick from the list
---

Refuses any droplet `fli basecamp:create` did not make: the token reaches every
droplet at the account, and a fleet machine Basecamp made is destroyed in
Basecamp, which also retires its row. Refuses one that is not powered off,
too — `fli basecamp:stop` first, so a box still serving is never one mistyped
id away from gone.

With no id it lists the Basecamp hosts that are off and asks which. The pick
still goes through the same refusal, so a list read a moment ago cannot widen
it.

Then it names what `fli basecamp:create` left beside the droplet, none of it
DigitalOcean's to remove: the `Host` block in `~/.ssh/config` and the
`known_hosts` line for its address, and Basecamp's A record at Cloudflare.
DigitalOcean hands a released address to its next customer, so a record still
pointing at it serves a stranger's box under Basecamp's name, and the next box
given that address fails ssh on a changed host key.

A reserved IP in front of the box outlives it. At a terminal the run asks
whether to keep it — Enter keeps it, for the next `fli basecamp:create`, which
reuses the address the hostname's record holds — or release it; with no
terminal it is kept. A kept one is still Basecamp's, so the `Host` block and
the record naming it are left as they are and not listed, and it bills $5/mo
until a box holds it or it is released.

```js
let id = String(arg.id ?? '').trim()
let machines = null

if (!id) {
  const found = await runProvision({ action: 'list' })
  if (found.error) { log.error(found.error); process.exitCode = 1; return }
  machines = found.machines
  const hosts = found.machines.filter(m => !m.serverId)
  const ours  = hosts.filter(m => m.status === 'off')
  if (!hosts.length) { echo('No Basecamp host fli basecamp:create made is at this account'); return }
  if (!ours.length) {
    echo('None is powered off. fli basecamp:stop <id> first:')
    echo.lines(hosts.map(m => machineLine(m, chalk)), { indent: 2 })
    return
  }
  if (!process.stdin.isTTY) {
    log.error('Which droplet? fli basecamp:destroy <id>')
    echo.lines(ours.map(m => machineLine(m, chalk)), { indent: 2 })
    process.exitCode = 1; return
  }

  echo.lines(ours.map((m, i) => `${i + 1}) ${machineLine(m, chalk)}`), { indent: 2 })
  const answer = (await tty.line(`Destroy which? [1-${ours.length}, Enter to cancel] › `)).trim()
  if (!answer) { echo('Nothing destroyed'); return }
  const picked = ours[Number(answer) - 1]
  if (!/^\d+$/.test(answer) || !picked) { log.error(`No row ${answer}`); process.exitCode = 1; return }
  id = picked.id
}

// The address is read before the destroy: after it, DigitalOcean has no row to ask.
machines ??= (await runProvision({ action: 'list' })).machines ?? []
const target = machines.find(m => String(m.id) === id)
const dropletIp = target?.ip ?? null

const done = await runProvision({ action: 'destroy', id })
if (done.error) { log.error(done.error); process.exitCode = 1; return }
log.success(`Destroyed droplet ${done.destroyed}`)

// Released, the address goes back to DigitalOcean's pool and is anybody's, so
// it joins the leftovers; kept, nothing naming it is stale.
const reserved = done.reservedIp ?? target?.reservedIp ?? null
let kept = !!reserved
if (reserved && process.stdin.isTTY) {
  const pick = await tty.keys(chalk`{cyan ?} {bold Keep the reserved IP ${reserved} for the next box?}{dim   $5/mo while no box holds it}`, { k: 'keep', r: 'release' })
  if (pick === 'r') {
    const gone = await runProvision({ action: 'release', ip: reserved })
    if (gone.error) log.error(`${gone.error}. Release it in the DigitalOcean console: https://cloud.digitalocean.com/networking/reserved_ips`)
    else { kept = false; log.success(`Released ${reserved}`) }
  }
}
if (kept) log.info(`  Kept ${reserved} — the next fli basecamp:create reuses it. Releasing it later: https://cloud.digitalocean.com/networking/reserved_ips`)
const addresses = [dropletIp, kept ? null : reserved].filter(Boolean)

const { existsSync, readFileSync } = await import('node:fs')
const { spawnSync } = await import('node:child_process')
const home = process.env.HOME
const left = []

// The Host patterns whose HostName is an address — create names the block
// after the droplet, but a person may have renamed it or written their own.
const sshConfig = `${home}/.ssh/config`
const lines = existsSync(sshConfig) ? readFileSync(sshConfig, 'utf8').split('\n') : []
for (const ip of addresses) {
  const aliases = []
  let current = []
  for (const line of lines) {
    const [word, ...rest] = line.trim().split(/\s+/)
    const key = word?.toLowerCase()
    if (key === 'host') current = rest
    else if (key === 'match') current = []
    else if (key === 'hostname' && rest[0] === ip) aliases.push(...current)
  }
  if (aliases.length) left.push(['~/.ssh/config', `Host ${aliases.join(', ')} → ${ip}`, 'delete the block'])
  if (spawnSync('ssh-keygen', ['-F', ip], { stdio: 'ignore' }).status === 0)
    left.push(['known_hosts', ip, `ssh-keygen -R ${ip}`])
}
if (!dropletIp) {
  left.push(['~/.ssh/config', 'the Host block basecamp:create added', 'delete it; the address was not readable'])
  left.push(['known_hosts', 'the box\'s address', 'ssh-keygen -R <ip>'])
}

// The records are found by the address rather than the hostname: Basecamp's
// config names no domain, and the one create was handed is kept nowhere. A
// proxied record resolves to Cloudflare's addresses, so DNS cannot answer this.
for (const ip of addresses.length ? addresses : [null]) {
  const found = ip && process.env.CLOUDFLARE_TOKEN ? await hostRecord({ find: ip }) : null
  if (found?.records) {
    for (const r of found.records)
      left.push(['Cloudflare', chalk`A ${r.name} → ${ip}{dim ${r.proxied ? ', proxied: its Full (strict) Config Rule too' : ''}${r.marked ? '' : ', not marked basecamp'}}`,
        `fli cf:dns --zone ${r.zone} --delete ${r.id}`])
  } else {
    const why = found?.error ?? (ip ? 'no CLOUDFLARE_TOKEN to look with' : 'the address was not readable')
    left.push(['Cloudflare', `any A record pointing at ${ip ?? 'the box'} — ${why}`, 'fli cf:dns --zone <zone>'])
  }
}

echo('')
echo('Left beside it — check each:')
echo.lines(left.flatMap(([where, what, how]) => [chalk`{bold ${where.padEnd(14)}} ${what}`, chalk`${' '.repeat(15)}{cyan ${how}}`]), { indent: 2 })
```
