---
title: outpost:install
description: Make a box that answers ssh a machine of a Basecamp's fleet, from any directory
effects: makes a Server row in the Basecamp, installs docker, caddy, bun and the Outpost on the box over ssh
examples:
  - fli outpost:install box1
  - fli outpost:install root@203.0.113.7 --basecamp ops --name eu-1
args:
  -
    name: server
    description: "The box: an alias from ~/.ssh/config, or user@host"
flags:
  basecamp:
    type: string
    description: The Basecamp whose fleet the box joins, by its name in basecamps.json (default the only one; with several and none named, refused with the names)
    defaultValue: ''
  name:
    type: string
    description: The Server's name in Basecamp (default the ssh alias, else the address)
    defaultValue: ''
  wait:
    type: boolean
    description: Wait for the box's first heartbeat, up to ten minutes; --no-wait ends once the install ran
    defaultValue: true
---

The paste, done for you. Basecamp holds a Server row per machine, and a row
for a machine it did not buy is enrolled by one command it issues for that
row, single-use (`issueEnrollment`, the Servers page's button). This finds the
row by the box's address, makes one when there is none, asks Basecamp for the
command and runs it on the box over ssh, with the token on bash's stdin rather
than in any argv. The box then installs docker, caddy, bun and the Outpost,
and checks in; the run waits for that first heartbeat and reports the row
`online`, since a machine in the list with no Outpost answering is the failure
that reads as a green deploy that ran nothing.

The Basecamp and its key come from its entry in `basecamps.json` (`--basecamp`
names it; `fli basecamp:key` files the key). The key needs `servers:write`;
issuing an enrollment is an administrator's act, so the key's owner is one.
The local dev Basecamp is the reserved entry `dev`, written into the file by
hand. Enrollment
travels over https only — the command carries a secret — so a plain `http`
Basecamp is refused by Basecamp itself.

A row already `online` at that address is answered as such and nothing is
run. A box a stored cloud token reaches is then marked with its server id at
the cloud, so `fli server` names it a fleet machine and `fli server:destroy`
refuses it; one made by hand is at no such cloud and is left unmarked.

```js
const dest = String(arg.server ?? '').trim()
if (!dest) { log.error('Pass the box: fli outpost:install <ssh alias or user@host> [--basecamp <name>]'); process.exitCode = 1; return }

const target = reachBasecamp(flag.basecamp, log)
if (!target) return
const { url: origin, key } = target

const ip = await boxAddress(dest)
if (!ip) { log.error(`${dest} resolves to no IPv4 address: pass user@<ip>, or a Host in ~/.ssh/config with a HostName`); process.exitCode = 1; return }

const machine = createMachine({ host: dest, path: null, exec: $.exec, transport: null })
if (!machine.reach()) { log.error(`Cannot reach ${dest} over ssh`); process.exitCode = 1; return }

// The row is the machine's identity in Basecamp, so a second run on the same
// box must find the first run's row rather than make a twin.
const servers = await basecamp(origin, key, '/servers?$limit=100')
let server = servers.find(s => s.ipAddress === ip)
if (server?.status === 'online') {
  log.info(`${dest} is in the fleet already, as ${server.name} (${server.id}), online`)
  await markServer({ ip, serverId: server.id, log })
  return
}
if (!server) {
  const alias = dest.split('@').pop()
  const name  = flag.name || (/^\d{1,3}(\.\d{1,3}){3}$/.test(alias) ? `box-${alias.replace(/\./g, '-')}` : alias)
  server = await basecamp(origin, key, '/servers', { method: 'POST', body: { name, region: 'custom', ipAddress: ip } })
  log.info(`Made server ${server.name} (${server.id}) in Basecamp, at ${ip}`)
} else log.info(`Server ${server.name} (${server.id}) is at ${ip} in Basecamp, ${server.status}`)

const issued = await basecamp(origin, key, `/servers/${encodeURIComponent(server.id)}`, { method: 'POST', headers: { 'x-service-method': 'issueEnrollment' } })
const { outcome } = installOutpost(machine, issued.command, { host: dest, log })
if (outcome === 'failed') { process.exitCode = 1; return }

if (!flag.wait) { log.info(`  fli outpost:install ${dest} --basecamp ${target.name} again reports when it is online`); return }

// The heartbeat is the proof: a row that stays pending has an Outpost that
// never reached Basecamp, which a green install cannot tell from one that did.
log.info('Waiting for the first heartbeat — up to ten minutes')
const until = Date.now() + 10 * 60_000
let row = server
while (Date.now() < until) {
  await new Promise(r => setTimeout(r, 10_000))
  row = await basecamp(origin, key, `/servers/${encodeURIComponent(server.id)}`)
  if (row.status === 'online') break
}
if (row.status !== 'online') {
  log.error(`${server.name} is ${row.status} after ten minutes: the Outpost has not checked in. On the box: journalctl -u outpost.service`)
  process.exitCode = 1
  return
}
log.success(`${server.name} is online${row.outpostUrl ? ` at ${row.outpostUrl}` : ''}`)
await markServer({ ip, serverId: server.id, log })
```
