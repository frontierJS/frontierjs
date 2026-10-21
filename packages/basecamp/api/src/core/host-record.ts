// api/src/core/host-record.ts — Basecamp's own hostname, pointed at its box at Cloudflare.
//
// `fli provision:dns` runs it from this checkout, with the token in the
// environment so it never sits in a process listing:
//
//   CLOUDFLARE_TOKEN=… bun api/src/core/host-record.ts '{"host":"ops.example.com","ip":"203.0.113.7"}'
//
// `{"host":…,"check":true}` finds the zone and writes nothing: `fli provision`
// asks it before buying a box, so a token that cannot reach the name is found
// while nothing has been spent.
//
// The record is written by providers/edge/cloudflare.ts and carries the fleet's
// mark, so Basecamp's own edge reads it as its own: a run that finds one moves
// it, and a record somebody made by hand at that name is refused, never
// overwritten (FJS-D560). DNS-only, which is the schema's default for a
// Domain (FJS-D1380). Interim for step 3.4 of IDEAS/zero-to-live.md, whose
// ruled writer is a script in the container (FJS-D1254; Q2 there).
//
// The last line of stdout is one JSON object, which is fli's whole contract:
//   { host, ip, zone, record }
//   { host, zone }                      under check
//   { error: '<what>' }                 and the exit is non-zero

import { cloudflare }  from '../providers/edge/cloudflare.ts'
import { FLEET }       from '../providers/compute/index.ts'
import { bearerSend }  from './bearer-send.ts'

const answer = (o: Record<string, unknown>) => console.log(JSON.stringify(o))
const fail   = (error: string): never => { answer({ error }); process.exit(1) }

const input = (() => {
  try { return JSON.parse(process.argv[2] ?? '{}') as Record<string, unknown> }
  catch { return fail('the argument is not JSON') }
})()

const token = process.env.CLOUDFLARE_TOKEN
if (!token) fail('CLOUDFLARE_TOKEN is not set')

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
  if (input.check) { answer({ host, zone: zone.name }); process.exit(0) }

  const [record] = await cloudflare.setRecords(send, zone.id, { fleet: FLEET }, [{ type: 'A', name: host, content: ip }])
  answer({ host, ip, zone: zone.name, record: record?.id ?? null })
  process.exit(0)
} catch (e) {
  fail((e as Error).message)
}
