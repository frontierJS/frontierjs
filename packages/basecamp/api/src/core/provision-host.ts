// api/src/core/provision-host.ts — the machine Basecamp itself will run on, made at DigitalOcean.
//
// `fli basecamp:create` runs it from this checkout (`FJS-D1253`), with the token in
// the environment so it never sits in a process listing:
//
//   DIGITALOCEAN_TOKEN=… bun api/src/core/provision-host.ts '{"action":"create","size":"4gb",…}'
//   DIGITALOCEAN_TOKEN=… bun api/src/core/provision-host.ts '{"action":"off","id":"123"}'
//   DIGITALOCEAN_TOKEN=… bun api/src/core/provision-host.ts '{"action":"destroy","id":"123"}'
//   DIGITALOCEAN_TOKEN=… bun api/src/core/provision-host.ts '{"action":"list"}'
//   DIGITALOCEAN_TOKEN=… bun api/src/core/provision-host.ts '{"action":"release","ip":"203.0.113.9"}'
//
// The vendor's dialect is providers/compute/digitalocean.ts and nothing here
// restates it. The box boots with no install in its user_data: install.sh is
// served by a running Basecamp, so this box cannot boot from it, and `fli
// deploy:setup` installs it over SSH instead.
//
// `"reservedIp":true` on a create holds an address beside the droplet and
// answers it as `ip`, so the hostname and the ssh Host name an address that
// outlives the box. `"reuse":"<ip>"` is the address the hostname points at now:
// taken again when it is a reserved IP at this account, in the region, that no
// droplet holds — which is a replaced box keeping its DNS.
//
// It carries the fleet tag and no server id. Reconcile reports it as an orphan
// until a Server row names it, which is the truth: a droplet billing at this
// account that no row describes.
//
// The last line of stdout is one JSON object, which is fli's whole contract:
//   { id, name, ip, region, size, image, monthly }   created and up
//     + dropletIp, reserved: { ip, reused } | { error }  under reservedIp
//   { id, name, pending: true, … }                    created, not up before the deadline
//   { off: '<id>' }  { off: '<id>', pending: true }   powered off, or asked and not off yet
//   { destroyed: '<id>', reservedIp }                 the address it held, unassigned now
//   { machines: [{ id, status, ip, region, serverId, reservedIp }] }   every fleet-tagged droplet
//   { released: '<ip>' }
//   { error: '<what>' }                               and the exit is non-zero
//
// stderr is what the minute is spent on, for the person watching: fli lets it
// through to the terminal untouched.

import { connectorFor, fleetMark, priceIn, sizeRegions } from '../providers/compute/index.ts'
import type { ComputeSize }   from '../providers/compute/index.ts'
import { reservedIps, RESERVED_EGRESS } from '../providers/compute/digitalocean.ts'
import { bearerSend }         from './bearer-send.ts'

const answer = (o: Record<string, unknown>) => console.log(JSON.stringify(o))
const fail   = (error: string): never => { answer({ error }); process.exit(1) }
const step   = (t: string) => process.stderr.write(`  · ${t}\n`)

/** The boot wait as one line that counts: rewritten in place at a terminal,
 *  one line per change of state anywhere else, so a log is not a wall of seconds. */
function waitLine() {
  const tty   = !!process.stderr.isTTY
  const start = Date.now()
  const secs  = () => Math.round((Date.now() - start) / 1000)
  let label = ''
  const draw  = () => process.stderr.write(`\r\x1b[K  · ${label} ${secs()}s`)
  const timer = tty ? setInterval(draw, 1000) : undefined
  return {
    say(next: string) { if (next === label) return; label = next; tty ? draw() : step(next) },
    end(last: string) { clearInterval(timer); if (tty) process.stderr.write('\r\x1b[K'); step(`${last} (${secs()}s)`) },
  }
}

const BOOTING: Record<string, string> = {
  starting: 'DigitalOcean is laying down the disk and booting Ubuntu',
  running:  'Booted, waiting for its public address',
}

/** How long a droplet gets to come up. DO's own figure is under a minute; past
 *  this the id is answered as pending so the caller can still destroy it. */
const READY_DEADLINE_MS = 180_000
const OFF_DEADLINE_MS   = 60_000
const ASSIGN_DEADLINE_MS = 60_000
const POLL_MS           = 5_000

const input = (() => {
  try { return JSON.parse(process.argv[2] ?? '{}') as Record<string, string> }
  catch { return fail('the argument is not JSON') }
})()

const token = process.env.DIGITALOCEAN_TOKEN
if (!token) fail('DIGITALOCEAN_TOKEN is not set')

const connector = connectorFor('digitalocean')!
const send      = bearerSend(connector.address, token!)

// ─── Sizes ───────────────────────────────────────────────────────────────

/** `4gb` is the cheapest size with that much memory sold in the region; a
 *  vendor slug is taken as itself. The catalog is read, never a table here
 *  (`docs/PROVISIONING.md` § D3). DigitalOcean still sells legacy sizes whose
 *  slug IS `4gb` at twice the price, so a memory size is never matched as a slug. */
function pickSize(sizes: ComputeSize[], wanted: string, region: string): ComputeSize {
  const gb = /^(\d+)\s*gb$/i.exec(wanted)?.[1]
  const exact = gb ? undefined : sizes.find(s => s.slug === wanted)
  if (exact) {
    if (priceIn(exact, region) === null)
      fail(`${exact.slug} is not sold in ${region}: ${sizeRegions(exact).join(', ')}`)
    return exact
  }

  if (!gb) fail(`--size takes a memory size like 4gb or a DigitalOcean slug like s-2vcpu-4gb, not '${wanted}'`)

  const memoryMb = Number(gb) * 1024
  const sold = sizes
    .filter(s => s.memoryMb === memoryMb && priceIn(s, region) !== null)
    .sort((a, b) => priceIn(a, region)! - priceIn(b, region)!)
  if (sold.length) return sold[0]

  const offered = [...new Set(sizes.filter(s => priceIn(s, region) !== null).map(s => s.memoryMb / 1024))]
    .sort((a, b) => a - b).map(n => `${n}gb`)
  return fail(`no ${wanted} size in ${region}; it sells ${offered.join(', ')}`)
}

// ─── Actions ─────────────────────────────────────────────────────────────

async function create() {
  const { name, region, image, size, publicKey, keyName, reuse } = input
  const holdIp = (input as Record<string, unknown>).reservedIp === true
  if (!name || !region || !image || !size || !publicKey)
    fail('create needs name, region, image, size and publicKey')

  step(`Reading DigitalOcean's catalog: regions, sizes, images`)
  const catalog = await connector.catalog(send)
  if (!catalog.regions.some(r => r.slug === region && r.available))
    fail(`no region '${region}'; available: ${catalog.regions.filter(r => r.available).map(r => r.slug).join(', ')}`)
  if (!catalog.images.some(i => i.slug === image))
    fail(`no image '${image}'; Ubuntu ones: ${catalog.images.filter(i => i.slug.startsWith('ubuntu')).map(i => i.slug).join(', ')}`)
  const picked = pickSize(catalog.sizes, size, region)
  const price  = priceIn(picked, region)

  // A second run must not buy a second box. A fleet-tagged droplet with no
  // server id is one this script made and nothing has claimed.
  step('Checking the account for a box an earlier run left behind')
  const prior = (await connector.marked(send, fleetMark())).filter(m => !m.serverId)
  if (prior.length)
    fail(`a machine provisioned earlier is still at this account: `
      + prior.map(m => `${m.providerServerId} (${m.ipAddress ?? 'no address yet'})`).join(', ')
      + ` — fli basecamp:stop <id> then fli basecamp:destroy <id> removes it, or fli basecamp:install installs on it`)

  step('Putting your SSH public key on the account')
  const sshKey = await connector.sshKey(send, { name: keyName || `fli ${name}`, publicKey })
  step(`Ordering ${picked.slug} in ${region}, ${image}`
    + (price == null ? '' : ` at ${(price / 100).toFixed(2)} ${picked.currency}/mo`))
  const { providerServerId } = await connector.create(send, {
    name, region, image, size: picked.slug, sshKeys: [sshKey], mark: fleetMark(),
    userData: holdIp ? RESERVED_EGRESS : undefined,
  })
  step(`Droplet ${providerServerId} ordered, tagged for the fleet`)

  const made = { id: providerServerId, name, region, size: picked.slug, image,
                 monthly: price, currency: picked.currency }

  const wait = waitLine()
  const deadline = Date.now() + READY_DEADLINE_MS
  while (Date.now() < deadline) {
    const machine = await connector.machine(send, providerServerId)
    if (machine?.status === 'running' && machine.ipAddress) {
      wait.end(`Up at ${machine.ipAddress}`)
      if (!holdIp) return answer({ ...made, ip: machine.ipAddress })
      const reserved = await holdAddress(providerServerId, region, reuse)
      return answer({ ...made, ip: reserved.ip ?? machine.ipAddress, dropletIp: machine.ipAddress, reserved })
    }
    wait.say(BOOTING[machine?.status ?? ''] ?? `DigitalOcean says ${machine?.status ?? 'nothing yet'}`)
    await Bun.sleep(POLL_MS)
  }
  wait.end(`No address after ${READY_DEADLINE_MS / 60_000} minutes`)
  answer({ ...made, pending: true })
}

// A failure here leaves the droplet bought and answered on its own address, so
// the run goes on; the error names any address already reserved, since that one
// bills while it holds nothing.
async function holdAddress(dropletId: string, region: string, reuse?: string) {
  let ip = ''
  try {
    const spare = reuse ? await reservedIps.get(send, reuse) : null
    if (spare && spare.region === region && !spare.dropletId) {
      ip = spare.ip
      step(`Reusing reserved IP ${ip}, which the hostname already points at`)
    } else {
      if (reuse) step(`${reuse} is not a reserved IP in ${region} that no droplet holds`)
      step(`Reserving an IP in ${region}, free while a droplet holds it`)
      ip = (await reservedIps.reserve(send, region)).ip
    }
    await reservedIps.assign(send, ip, dropletId)
    const deadline = Date.now() + ASSIGN_DEADLINE_MS
    while (Date.now() < deadline) {
      if ((await reservedIps.get(send, ip))?.dropletId === dropletId) {
        step(`${ip} routes to the droplet`)
        return { ip, reused: ip === spare?.ip }
      }
      await Bun.sleep(POLL_MS)
    }
    return { error: `${ip} is reserved and did not reach the droplet in ${ASSIGN_DEADLINE_MS / 1000}s` }
  } catch (e) {
    return { error: (e as Error).message + (ip ? ` — ${ip} is reserved and bills while it holds nothing` : '') }
  }
}

// Only a box this script made. The token reaches every droplet at the
// account, and an action by a typed id is one digit from somebody else's.
async function ownDroplet(doIt: string) {
  const id = input.id
  if (!id) fail(`${input.action} needs id`)
  const ours = (await connector.marked(send, fleetMark())).find(m => m.providerServerId === id)
  if (!ours) fail(`${id} is not a droplet fli basecamp:create made (no fleet tag at this account)`)
  if (ours!.serverId) fail(`${id} is a fleet machine Basecamp made (server ${ours!.serverId}): ${doIt} in Basecamp`)
  return ours!
}

async function destroy() {
  const ours = await ownDroplet('destroy it')
  // Powering it off first is the second hand on the destroy: a box still
  // serving cannot be removed by one mistyped id or one wrong pick.
  if (ours.status !== 'off') fail(`${ours.providerServerId} is ${ours.status}: fli basecamp:stop ${ours.providerServerId} first, then destroy it`)

  // Read before the destroy: DO unassigns the address with it.
  const reservedIp = (await heldBy()).get(ours.providerServerId) ?? null
  await connector.destroy(send, ours.providerServerId)
  answer({ destroyed: ours.providerServerId, reservedIp })
}

async function powerOff() {
  const ours = await ownDroplet('power it off')
  const id   = ours.providerServerId
  if (ours.status === 'off') return answer({ off: id })
  if (!await connector.powerOff(send, id)) fail(`${id} is no longer at DigitalOcean`)

  const wait     = waitLine()
  const deadline = Date.now() + OFF_DEADLINE_MS
  while (Date.now() < deadline) {
    const machine = await connector.machine(send, id)
    if (machine?.status === 'off') { wait.end('Powered off'); return answer({ off: id }) }
    wait.say(`DigitalOcean says ${machine?.status ?? 'nothing yet'}`)
    await Bun.sleep(POLL_MS)
  }
  wait.end(`Still not off after ${OFF_DEADLINE_MS / 1000}s`)
  answer({ off: id, pending: true })
}

// A droplet carrying a serverId is Basecamp's, and destroy refuses it — so the
// list says which, or the id it prints is one destroy will not take.
async function list() {
  const held = await heldBy()
  const machines = (await connector.marked(send, fleetMark())).map(m => ({
    id: m.providerServerId, status: m.status, ip: m.ipAddress, region: m.region, serverId: m.serverId,
    reservedIp: held.get(m.providerServerId) ?? null,
  }))
  answer({ machines })
}

/** Droplet id → the reserved IP it holds. */
async function heldBy() {
  return new Map((await reservedIps.list(send)).filter(r => r.dropletId).map(r => [r.dropletId!, r.ip]))
}

// Only an address no droplet holds: the token reaches every reserved IP at the
// account, and one that is assigned is serving somebody's box right now.
async function release() {
  const ip = input.ip
  if (!ip) fail('release needs ip')
  const held = await reservedIps.get(send, ip)
  if (!held) fail(`${ip} is not a reserved IP at this account`)
  if (held!.dropletId) fail(`${ip} is assigned to droplet ${held!.dropletId}: destroy that first`)
  await reservedIps.release(send, ip)
  answer({ released: ip })
}

try {
  if (input.action === 'create')       await create()
  else if (input.action === 'destroy') await destroy()
  else if (input.action === 'off')     await powerOff()
  else if (input.action === 'list')    await list()
  else if (input.action === 'release') await release()
  else fail(`unknown action '${input.action}'`)
  process.exit(0)
} catch (e) {
  fail((e as Error).message)
}
