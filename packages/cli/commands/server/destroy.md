---
title: server:destroy
description: Destroy a box fli server:create made
effects: destroys a box at its cloud and everything on its disk
confirm: human
examples:
  - fli server:destroy 512345678
  - fli server:destroy
args:
  -
    name: id
    description: The box id fli server:create printed; with none, pick from the list
flags:
  cloud:
    type: string
    description: The cloud the box is at, by kind; found by its id otherwise
    defaultValue: ''
  release-ip:
    type: boolean
    description: Release the box's reserved IP too, without asking; kept otherwise (asked at a terminal)
    defaultValue: false
---

Refuses any box `fli server:create` did not make: the token reaches every
box at the account, and a fleet machine is destroyed in Basecamp, which also
retires its row. Refuses one that is not powered off, too — `fli server:stop`
first, so a box still serving is never one mistyped id away from gone.

With no id it lists the boxes that are off, at every cloud whose token is
stored, and asks which. The pick still goes through the same refusal, so a
list read a moment ago cannot widen it. A typed id is looked up the same way,
and one at two clouds needs `--cloud`.

Then it names what `fli server:create` left beside the box, none of it the
cloud's to remove: the `Host` block in `~/.ssh/config` and the `known_hosts`
line for its address, and any A record at Cloudflare. A cloud hands a released
address to its next customer, so a record still pointing at it serves a
stranger's box under the old name, and the next box given that address fails
ssh on a changed host key.

A reserved IP in front of the box outlives it. At a terminal the run asks
whether to keep it — Enter keeps it, for a next box, which `fli
basecamp:create` reuses when the hostname's record holds it — or release it;
with no terminal it is kept, and `--release-ip` releases it without asking. A
kept one is still yours, so the `Host` block and the record naming it are left
as they are and not listed, and it bills at the cloud's rate until it is
released — Setup names each. With nothing left, it says so, rather than ending
on the destroy.

At a terminal the list ends in an offer to clean it up, which Enter declines.
Taken, it walks the rows one at a time: Enter runs the row's command, `s`
skips it and `q` stops. A `Host` block is cut from `~/.ssh/config` in place,
the comment above the next block left with that block. A row with nothing to
run — the address unreadable, no `CLOUDFLARE_TOKEN` — is not offered.

<script>
const { existsSync, readFileSync, writeFileSync } = await import('node:fs')
const { spawnSync } = await import('node:child_process')

// The Host blocks whose HostName is `ip`, as line ranges — create names the
// block after the box, but a person may have renamed it or written their own.
// A comment closing a range sits above the next block and is that block's.
const hostBlocks = (lines, ip) => {
  const words = (line) => line.trim().split(/\s+/)
  const starts = lines.flatMap((line, i) => ['host', 'match'].includes(words(line)[0].toLowerCase()) ? [i] : [])
  return starts.flatMap((from, n) => {
    const [word, ...aliases] = words(lines[from])
    let to = starts[n + 1] ?? lines.length
    const holds = lines.slice(from + 1, to).some(l => { const [k, v] = words(l); return k.toLowerCase() === 'hostname' && v === ip })
    if (word.toLowerCase() !== 'host' || !holds) return []
    while (to > from + 1 && lines[to - 1].trim().startsWith('#')) to--
    return [{ aliases, from, to }]
  })
}

// Read again at the cut: the list was read before the person was asked.
const dropHostBlock = (path, ip, aliases) => {
  const lines = readFileSync(path, 'utf8').split('\n')
  const block = hostBlocks(lines, ip).find(b => b.aliases.join(' ') === aliases.join(' '))
  if (!block) return { error: `~/.ssh/config no longer holds Host ${aliases.join(' ')} → ${ip}` }
  lines.splice(block.from, block.to - block.from)
  writeFileSync(path, lines.join('\n'))
  return { done: `Deleted Host ${aliases.join(' ')} from ~/.ssh/config` }
}

// `fli` is this checkout's, never the global install on the PATH.
const runArgv = ([cmd, ...args]) => {
  const argv = cmd === 'fli' ? [process.execPath, `${global.fliRoot}/bin/fli.js`, ...args] : [cmd, ...args]
  const { status } = spawnSync(argv[0], argv.slice(1), { stdio: 'inherit' })
  return status === 0 ? { done: [cmd, ...args].join(' ') } : { error: `${[cmd, ...args].join(' ')} exited ${status}` }
}
</script>

```js
let id = String(arg.id ?? '').trim()

// Read before the destroy, for the address too: after it, the cloud has no row to ask.
const read = await cloudsToRead({ cloud: flag.cloud, interactive: !!process.stdin.isTTY, tty, chalk, say: (t) => log.warn(t) })
if (read.error) { log.error(read.error); process.exitCode = 1; return }
const found = await listBoxes(read.clouds)
if (found.error) { log.error(found.error); process.exitCode = 1; return }
let cloud = ''

if (!id) {
  const hosts = found.machines.filter(m => !m.serverId)
  const ours  = hosts.filter(m => m.status === 'off')
  if (!hosts.length) { echo(`No box fli server:create made is at ${read.clouds.map(cloudLabel).join(' or ')}`); return }
  if (!ours.length) {
    echo('None is powered off. fli server:stop <id> first:')
    echo.lines(hosts.map(m => machineLine(m, chalk)), { indent: 2 })
    return
  }
  if (!process.stdin.isTTY) {
    log.error('Which box? fli server:destroy <id>')
    echo.lines(ours.map(m => machineLine(m, chalk)), { indent: 2 })
    process.exitCode = 1; return
  }

  echo.lines(ours.map((m, i) => `${i + 1}) ${machineLine(m, chalk)}`), { indent: 2 })
  const answer = (await tty.line(`Destroy which? [1-${ours.length}, Enter to cancel] › `)).trim()
  if (!answer) { echo('Nothing destroyed'); return }
  const picked = ours[Number(answer) - 1]
  if (!/^\d+$/.test(answer) || !picked) { log.error(`No row ${answer}`); process.exitCode = 1; return }
  id = String(picked.id)
  cloud = picked.cloud
} else {
  const at = cloudOf(id, found.machines, read.clouds)
  if (at.error) { log.error(at.error); process.exitCode = 1; return }
  cloud = at.cloud
}

const target = found.machines.find(m => String(m.id) === id && m.cloud === cloud)
const boxIp  = target?.ip ?? null
const { addresses: page, held } = CLOUDS[cloud]

const done = await runProvision({ cloud, action: 'destroy', id })
if (done.error) { log.error(done.error); process.exitCode = 1; return }
log.done(`Destroyed box ${done.destroyed} at ${cloudLabel(cloud)}`)

// Released, the address goes back to the cloud's pool and is anybody's, so it
// joins the leftovers; kept, nothing naming it is stale.
const reserved = done.reservedIp ?? target?.reservedIp ?? null
let kept = !!reserved
if (reserved && (flag['release-ip'] || process.stdin.isTTY)) {
  const pick = flag['release-ip'] ? 'r' : await tty.keys(chalk`{cyan ?} {bold Keep the reserved IP ${reserved} for the next box?}{dim   ${held}}`, { k: 'keep', r: 'release' })
  if (pick === 'r') {
    const gone = await runProvision({ cloud, action: 'release', ip: reserved })
    if (gone.error) log.error(`${gone.error}. Release it in the ${cloudLabel(cloud)} console: ${page}`)
    else { kept = false; log.done(`Released ${reserved}`) }
  }
}
if (kept) log.info(`  Kept ${reserved} — the next fli basecamp:create reuses it when the hostname's record holds it, so the A record and Host block naming it stay. Releasing it later: ${page}, or --release-ip on the next destroy`)
// At a cloud that puts the held address on the box itself, the box's own
// address IS the reserved one, and a kept one leaves nothing stale.
const addresses = [...new Set([boxIp, reserved])].filter(ip => ip && !(kept && ip === reserved))

const sshConfig = `${process.env.HOME}/.ssh/config`
const lines = existsSync(sshConfig) ? readFileSync(sshConfig, 'utf8').split('\n') : []
const left = []

for (const ip of addresses) {
  for (const { aliases } of hostBlocks(lines, ip))
    left.push({ where: '~/.ssh/config', what: `Host ${aliases.join(', ')} → ${ip}`, how: `delete the Host ${aliases.join(' ')} block`,
      run: () => dropHostBlock(sshConfig, ip, aliases) })
  if (spawnSync('ssh-keygen', ['-F', ip], { stdio: 'ignore' }).status === 0)
    left.push({ where: 'known_hosts', what: ip, how: `ssh-keygen -R ${ip}`, run: () => runArgv(['ssh-keygen', '-R', ip]) })
}
if (!boxIp) {
  left.push({ where: '~/.ssh/config', what: 'the Host block server:create added', how: 'delete it; the address was not readable' })
  left.push({ where: 'known_hosts', what: 'the box\'s address', how: 'ssh-keygen -R <ip>' })
}

// The records are found by the address rather than the hostname: Basecamp's
// config names no domain, and the one create was handed is kept nowhere. A
// proxied record resolves to Cloudflare's addresses, so DNS cannot answer this.
for (const ip of boxIp ? addresses : [null]) {
  const found = ip && process.env.CLOUDFLARE_TOKEN ? await hostRecord({ find: ip }) : null
  if (found?.records) {
    for (const r of found.records) {
      const argv = ['fli', 'cf:dns', '--zone', r.zone, '--delete', r.id]
      left.push({ where: 'Cloudflare', what: chalk`A ${r.name} → ${ip}{dim ${r.proxied ? ', proxied: its Full (strict) Config Rule too' : ''}${r.marked ? '' : ', not marked basecamp'}}`,
        how: argv.join(' '), run: () => runArgv(argv) })
    }
  } else {
    const why = found?.error ?? (ip ? 'no CLOUDFLARE_TOKEN to look with' : 'the address was not readable')
    left.push({ where: 'Cloudflare', what: `any A record pointing at ${ip ?? 'the box'} — ${why}`, how: 'fli cf:dns --zone <zone>' })
  }
}

echo('')
if (!left.length) {
  echo(chalk.dim(addresses.length
    ? `Nothing left beside it — no ~/.ssh/config block, known_hosts line or Cloudflare A record names ${addresses.join(', ')}`
    : 'Nothing left beside it — what names the kept address stays for the next box'))
  return
}
echo('Left beside it — check each:')
echo.lines(left.flatMap(({ where, what, how }) => [chalk`{bold ${where.padEnd(14)}} ${what}`, chalk`${' '.repeat(15)}{cyan ${how}}`]), { indent: 2 })

const runnable = left.filter(l => l.run)
if (!runnable.length || !process.stdin.isTTY) return
echo('')
if (await tty.keys(chalk`{cyan ?} {bold Clean these up one at a time?}`, { n: 'no', y: 'yes' }) !== 'y') return
for (const { where, how, run } of runnable) {
  const pick = await tty.keys(chalk`{bold ${where.padEnd(14)}} {cyan ${how}}`, { enter: 'run', s: 'skip', q: 'quit' })
  if (pick === 'q') break
  if (pick === 's') continue
  const done = await tty.aside(run)
  if (done.error) log.error(done.error)
  else log.done(done.done ?? how)
}
```
