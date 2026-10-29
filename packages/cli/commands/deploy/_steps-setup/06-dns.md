---
title: 06-dns
description: Point each domain's A record at this server, through the cf login
---

Points `deploy.web.domain` and `deploy.api.domain` at the box, through the
same `cf` login `fli cf:dns` runs on. A domain with no record gets an A
record, DNS-only — Caddy's certificate challenge has to reach the box itself.
A domain already pointed here is left alone. A record pointing somewhere else
is moved only on a `y` at the keyboard: under `--auto-install` it is left as
it is and the one command that moves it is printed, because repointing a live
domain loses its traffic.

A domain this step cannot point — no `cf`, no zone that login reaches, a
CNAME at the name — stays on the report's checklist. Nothing here stops the
setup.

```js
const { host, serverPath, edge } = $.config
const { spawnSync } = await import('node:child_process')

// basecamp:create and :install run setup this way and then write Basecamp's
// own record, marked as the fleet's; an unmarked record written here first is
// one their write refuses as foreign.
if (!$.flag['next-steps']) return
if (machineFor($, host, serverPath).local) return

const domains = [edge.web.domain, edge.api.domain].filter(Boolean)
if (!domains.length) return

// Only a literal address or the one ssh's config names. The resolver would
// answer with the domain's CURRENT target when the ssh host is the domain.
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/
const dest = host.split('@').pop()
const ip = IPV4.test(dest) ? dest
  : (spawnSync('ssh', ['-G', host], { encoding: 'utf8' }).stdout || '').match(/^hostname (\S+)$/m)?.[1]
if (!ip || !IPV4.test(ip)) {
  log.info(`DNS: ${host} names no IPv4 address in ~/.ssh/config, so its domains are left to point by hand`)
  return
}

const { CloudflareError, profileFor, findZone, records, createRecord, updateRecord } =
  await import(new URL('file://' + global.fliRoot + '/core/cloudflare.js'))

// ─── What each domain needs ───────────────────────────────────────────────────
const profile = profileFor()
const plan = []
try {
  for (const name of domains) {
    const zone = await findZone(profile, name)
    if (!zone) { plan.push({ name, skip: 'no Cloudflare zone this login reaches' }); continue }
    const here = (await records(profile, zone.id)).filter(r => r.name === name)
    const a     = here.filter(r => r.type === 'A')
    const cname = here.find(r => r.type === 'CNAME')
    const aaaa  = here.filter(r => r.type === 'AAAA')
    // An AAAA left pointing elsewhere sends every IPv6 visitor to the old box.
    const warn  = aaaa.length ? `has an AAAA record (${aaaa.map(r => r.content).join(', ')}) this leaves alone` : null
    if (cname) plan.push({ name, zone, skip: `is a CNAME to ${cname.content}` })
    else if (a.some(r => r.content === ip)) plan.push({ name, zone, done: true, warn })
    else if (a.length > 1) plan.push({ name, zone, skip: `has ${a.length} A records (${a.map(r => r.content).join(', ')})` })
    else if (a.length) plan.push({ name, zone, move: a[0], warn })
    else plan.push({ name, zone, create: true, warn })
  }
} catch (err) {
  if (!(err instanceof CloudflareError)) throw err
  log.info(`DNS: ${err.message}. Point the domains by hand, or log in with cf and run setup again`)
  return
}

echo('')
for (const p of plan) {
  const what = p.done ? chalk.dim(`already → ${ip}`)
    : p.create ? `A → ${ip} ${chalk.dim('(new, DNS-only)')}`
    : p.move ? `A ${p.move.content} → ${ip}`
    : chalk.yellow(`left alone: ${p.skip}`)
  echo(`  ${p.name}  ${what}`)
  if (p.warn) echo(`  ${' '.repeat(p.name.length)}  ${chalk.yellow(p.warn)}`)
}
echo('')

const pointed = plan.filter(p => p.done).map(p => p.name)
$.config.dnsPointed = pointed
const writes = plan.filter(p => p.create || p.move)
if (!writes.length) return

const auto = $.flag['auto-install']
const answer = auto ? 'y' : await tty.line(`Write ${writes.length === 1 ? 'this record' : 'these records'} at Cloudflare? (y/N) `)
if (answer.trim().toLowerCase() !== 'y') {
  log.info('Skipped — Caddy cannot fetch a certificate until each name resolves here')
  return
}

for (const p of writes) {
  if (p.move && auto) {
    log.warn(`${p.name} points at ${p.move.content}, left as it is. To move it: fli cf:dns --zone ${p.zone.name} --update ${p.move.id} --content ${ip}`)
    continue
  }
  try {
    if (p.create) await createRecord(profile, p.zone.id, { type: 'A', name: p.name, content: ip, ttl: 1, proxied: false })
    else await updateRecord(profile, p.zone.id, p.move.id, { content: ip })
    pointed.push(p.name)
    log.success(`${p.name} → ${ip}`)
  } catch (err) {
    if (!(err instanceof CloudflareError)) throw err
    log.warn(`${p.name}: ${err.message}`)
  }
}
```
