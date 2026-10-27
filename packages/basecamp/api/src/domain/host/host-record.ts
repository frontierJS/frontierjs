// api/src/domain/host/host-record.ts — Basecamp's own hostname, pointed at its box at Cloudflare.
//
// `fli basecamp:dns` runs it from this checkout, with the token in the
// environment so it never sits in a process listing:
//
//   CLOUDFLARE_TOKEN=… bun api/src/domain/host/host-record.ts '{"host":"ops.example.com","ip":"203.0.113.7"}'
//
// `{"host":…,"check":true}` finds the zone and writes nothing: `fli basecamp:create`
// asks it before buying a box, so a token that cannot reach the name is found
// while nothing has been spent, and answers the address Basecamp's record there
// holds now, which create reuses when it is a reserved IP. `{"find":"<ip>"}` writes nothing either: every
// A record in every zone the token opens that still holds the address, which
// `fli basecamp:destroy` names once the box it pointed at is gone.
//
// The record is written by providers/edge/cloudflare.ts and carries the fleet's
// mark, so Basecamp's own edge reads it as its own: a run that finds one moves
// it, and a record somebody made by hand at that name is refused, never
// overwritten (FJS-D560). DNS-only, which is the schema's default for a
// Domain (FJS-D1380); `"proxied":true` is the flip that ruling offers, and makes
// the edge verify Caddy's certificate for this host alone BEFORE the record turns
// proxied, so no request is ever proxied to an origin the edge does not check.
// Interim for step 3.4 of IDEAS/zero-to-live.md, whose
// ruled writer is a script in the container (FJS-D1254; Q2 there).
//
// The last line of stdout is one JSON object, which is fli's whole contract:
//   { host, ip, zone, record, proxied }
//   { host, zone, points }              under check; points is null with no record
//   { records: [{ zone, name, id, proxied, marked }] }  under find
//   { error: '<what>' }                 and the exit is non-zero

import { cloudflare }  from '../../providers/edge/cloudflare.ts'
import { FLEET }       from '../../providers/compute/index.ts'
import { bearerSend }  from './bearer-send.ts'

const answer = (o: Record<string, unknown>) => console.log(JSON.stringify(o))
const fail   = (error: string): never => { answer({ error }); process.exit(1) }

const input = (() => {
  try { return JSON.parse(process.argv[2] ?? '{}') as Record<string, unknown> }
  catch { return fail('the argument is not JSON') }
})()

const token = process.env.CLOUDFLARE_TOKEN
if (!token) fail('CLOUDFLARE_TOKEN is not set')

if (typeof input.find === 'string') {
  try {
    const send  = bearerSend(cloudflare.address, token!)
    const found = []
    for (const zone of await cloudflare.zones(send))
      for (const r of await cloudflare.records(send, zone.id))
        if (r.type === 'A' && r.content === input.find)
          found.push({ zone: zone.name, name: r.name, id: r.id, proxied: !!r.proxied, marked: !!r.mark })
    answer({ records: found })
    process.exit(0)
  } catch (e) {
    fail((e as Error).message)
  }
}

const host = String(input.host ?? '').trim().toLowerCase().replace(/\.$/, '')
const ip   = String(input.ip ?? '').trim()
if (!host.includes('.')) fail(`'${host}' is not a hostname`)
if (!input.check && !/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) fail(`'${ip}' is not an IPv4 address`)

try {
  const send = bearerSend(cloudflare.address, token!)

  // The longest zone the name ends with, as the edge service picks one, so
  // `a.shop.example.com` lands in `shop.example.com` where both are open.
  const zone = (await cloudflare.zones(send))
    .filter(z => host === z.name || host.endsWith(`.${z.name}`))
    .sort((a, b) => b.name.length - a.name.length)[0]
  if (!zone) fail(`no zone this token opens holds ${host}: give it Zone Read and DNS Edit on that zone`)
  if (input.check) {
    const ours = (await cloudflare.records(send, zone.id)).find(r => r.type === 'A' && r.name === host && r.mark)
    answer({ host, zone: zone.name, points: ours?.content ?? null })
    process.exit(0)
  }

  // Unstated keeps what the record holds, so a reinstall does not take a host
  // back off the proxy somebody put it behind.
  const proxied = typeof input.proxied === 'boolean'
    ? input.proxied
    : (await cloudflare.records(send, zone.id)).some(r => r.type === 'A' && r.name === host && r.mark && r.proxied)
  if (input.proxied === true) await cloudflare.strictOrigin(send, zone.id, host, { fleet: FLEET })
  const [record] = await cloudflare.setRecords(send, zone.id, { fleet: FLEET }, [{ type: 'A', name: host, content: ip, proxied }])
  answer({ host, ip, zone: zone.name, record: record?.id ?? null, proxied })
  process.exit(0)
} catch (e) {
  fail((e as Error).message)
}
