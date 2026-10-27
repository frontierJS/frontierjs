// api/src/domain/host/provision-host.ts — the machine Basecamp itself will run on, made at a cloud.
//
// `fli basecamp:create` runs it from this checkout (`FJS-D1253`), with the
// cloud's token in the environment so it never sits in a process listing. The
// key is the cloud's kind upper-cased, then _TOKEN:
//
//   <KIND>_TOKEN=… bun api/src/domain/host/provision-host.ts '{"cloud":"<kind>","action":"create","size":"4gb",…}'
//   <KIND>_TOKEN=… bun api/src/domain/host/provision-host.ts '{"cloud":"<kind>","action":"off","id":"123"}'
//   <KIND>_TOKEN=… bun api/src/domain/host/provision-host.ts '{"cloud":"<kind>","action":"destroy","id":"123"}'
//   <KIND>_TOKEN=… bun api/src/domain/host/provision-host.ts '{"cloud":"<kind>","action":"list"}'
//   <KIND>_TOKEN=… bun api/src/domain/host/provision-host.ts '{"cloud":"<kind>","action":"host","id":"123"}'
//   <KIND>_TOKEN=… bun api/src/domain/host/provision-host.ts '{"cloud":"<kind>","action":"release","ip":"203.0.113.9"}'
//
// Each vendor's dialect is its connector under providers/compute/ and nothing
// here restates one. The box boots with no install in its user_data: install.sh
// is served by a running Basecamp, so this box cannot boot from it, and `fli
// deploy:setup` installs it over SSH instead.
//
// `"reservedIp":true` on a create holds an address beside the box and answers
// it as `ip`, so the hostname and the ssh Host name an address that outlives
// the box. `"reuse":"<ip>"` is the address the hostname points at now: taken
// again when it is a reserved IP at this account, in the region, that no box
// holds — which is a replaced box keeping its DNS. The address is held BEFORE
// the box is bought: a cloud that assigns only at create needs it then, and a
// refusal there leaves nothing billing.
//
// It carries the fleet mark and no server id. Reconcile reports it as an orphan
// until a Server row names it, which is the truth: a box billing at this
// account that no row describes. `host` adds the host mark once `fli
// basecamp:install` has Basecamp running on it, which is what tells a working
// Basecamp from a box an earlier create left behind.
//
// The last line of stdout is one JSON object, which is fli's whole contract:
//   { id, name, ip, region, size, image, monthly }   created and up
//     + boxIp, reserved: { ip, reused } | { error }  under reservedIp
//   { id, name, pending: true, … }                    created, not up before the deadline
//   { off: '<id>' }  { off: '<id>', pending: true }   powered off, or asked and not off yet
//   { destroyed: '<id>', reservedIp }                 the address it held, unassigned now
//   { machines: [{ id, name, status, ip, region, serverId, basecampHost, reservedIp }] }   every fleet-marked box
//   { host: '<id>' }                                  carries the host mark now
//   { released: '<ip>' }
//   { error: '<what>' }                               and the exit is non-zero
//
// stderr is what the minute is spent on, for the person watching: fli lets it
// through to the terminal untouched.

import { connectorFor, fleetMark, hostMark, priceIn, sizeRegions } from '../../providers/compute/index.ts'
import type { ComputeSize, ReservedIp } from '../../providers/compute/index.ts'
import type { ProviderKind }  from '../../../../db/schema.d.ts'
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

/** How long a box gets to come up. Both clouds' own figure is under a minute;
 *  past this the id is answered as pending so the caller can still destroy it. */
const READY_DEADLINE_MS = 180_000
const OFF_DEADLINE_MS   = 60_000
const ASSIGN_DEADLINE_MS = 60_000
const POLL_MS           = 5_000

const input = (() => {
  try { return JSON.parse(process.argv[2] ?? '{}') as Record<string, string> }
  catch { return fail('the argument is not JSON') }
})()

const connector = connectorFor(input.cloud as ProviderKind)
  ?? fail(`no cloud '${input.cloud ?? ''}': the input names one by kind`)
const tokenKey  = `${connector.kind.toUpperCase()}_TOKEN`
const token     = process.env[tokenKey] ?? fail(`${tokenKey} is not set`)
const send      = bearerSend(connector.address, token)
const vendor    = connector.label

const booting = (status?: string) =>
  status === 'starting' ? `${vendor} is laying down the disk and booting the image`
  : status === 'running' ? 'Booted, waiting for its public address'
  : `${vendor} says ${status ?? 'nothing yet'}`

// ─── Sizes ───────────────────────────────────────────────────────────────

/** `4gb` is the cheapest x86 size with that much memory sold in the region; a
 *  vendor slug is taken as itself. The catalog is read, never a table here
 *  (`docs/PROVISIONING.md` § D3). One cloud still sells legacy sizes whose
 *  slug IS `4gb` at twice the price, so a memory size is never matched as a
 *  slug. An Arm size is refused: the app image is built amd64 on the laptop
 *  that releases it, and the cheapest 4 GB at Hetzner is Arm. */
function pickSize(all: ComputeSize[], wanted: string, region: string): ComputeSize {
  const gb = /^(\d+)\s*gb$/i.exec(wanted)?.[1]
  const exact = gb ? undefined : all.find(s => s.slug === wanted)
  if (exact) {
    if (exact.arch !== 'x86') fail(`${exact.slug} is an Arm size; the fleet runs x86 only`)
    if (priceIn(exact, region) === null)
      fail(`${exact.slug} is not sold in ${region}: ${sizeRegions(exact).join(', ')}`)
    return exact
  }

  const sizes = all.filter(s => s.arch === 'x86')
  if (!gb) fail(`--size takes a memory size like 4gb or a ${vendor} size like ${sizes[0]?.slug ?? 'its slug'}, not '${wanted}'`)

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
  const { name, size, publicKey, keyName, reuse } = input
  const region = input.region || connector.defaults.region
  const image  = input.image  || connector.defaults.image
  const holdIp = (input as Record<string, unknown>).reservedIp === true
  if (!name || !size || !publicKey) fail('create needs name, size and publicKey')
  if (holdIp && !connector.reservedIps) fail(`${vendor} holds no address apart from a box here`)

  step(`Reading ${vendor}'s catalog: regions, sizes, images`)
  const catalog = await connector.catalog(send)
  if (!catalog.regions.some(r => r.slug === region && r.available))
    fail(`no region '${region}'; available: ${catalog.regions.filter(r => r.available).map(r => r.slug).join(', ')}`)
  if (!catalog.images.some(i => i.slug === image))
    fail(`no image '${image}'; Ubuntu ones: ${catalog.images.filter(i => i.slug.startsWith('ubuntu')).map(i => i.slug).join(', ')}`)
  const picked = pickSize(catalog.sizes, size, region)
  const price  = priceIn(picked, region)

  // A second run must not buy a second box. A fleet-marked box with no
  // server id and no host mark is one this script made that nothing installed
  // on or claimed.
  step('Checking the account for a box an earlier run left behind')
  const prior = (await connector.marked(send, fleetMark())).filter(m => !m.serverId && !m.basecampHost)
  if (prior.length)
    fail(`a machine provisioned earlier is still at this account: `
      + prior.map(m => `${m.providerServerId} (${m.ipAddress ?? 'no address yet'})`).join(', ')
      + ` — fli basecamp:stop <id> then fli basecamp:destroy <id> removes it, or fli basecamp:install installs on it`)

  const held = holdIp ? await holdAddress(region, reuse) : null

  step('Putting your SSH public key on the account')
  let providerServerId = ''
  try {
    const sshKey = await connector.sshKey(send, { name: keyName || `fli ${name}`, publicKey })
    step(`Ordering ${picked.slug} in ${region}, ${image}`
      + (price == null ? '' : ` at ${(price / 100).toFixed(2)} ${picked.currency}/mo`))
    providerServerId = (await connector.create(send, {
      name, region, image, size: picked.slug, sshKeys: [sshKey], mark: fleetMark(),
      userData:   held ? connector.reservedIps!.egress : undefined,
      reservedIp: held && !connector.reservedIps!.assign ? held.address : undefined,
    })).providerServerId
  } catch (e) {
    fail((e as Error).message + (held && !held.reused ? ` — ${held.address.ip} is reserved and bills while it holds nothing` : ''))
  }
  step(`Box ${providerServerId} ordered, marked for the fleet`)

  const made = { id: providerServerId, name, region, size: picked.slug, image,
                 monthly: price, currency: picked.currency }

  const wait = waitLine()
  const deadline = Date.now() + READY_DEADLINE_MS
  while (Date.now() < deadline) {
    const machine = await connector.machine(send, providerServerId)
    if (machine?.status === 'running' && machine.ipAddress) {
      wait.end(`Up at ${machine.ipAddress}`)
      if (!held) return answer({ ...made, ip: machine.ipAddress })
      const reserved = await routeAddress(held.address, providerServerId)
      return answer({ ...made, ip: 'ip' in reserved ? reserved.ip : machine.ipAddress,
                      boxIp: machine.ipAddress, reserved: 'ip' in reserved ? { ...reserved, reused: held.reused } : reserved })
    }
    wait.say(booting(machine?.status))
    await Bun.sleep(POLL_MS)
  }
  wait.end(`No address after ${READY_DEADLINE_MS / 60_000} minutes`)
  answer({ ...made, pending: true })
}

/** The spare the hostname points at when it can be taken again, else a new
 *  address in the region. A refusal fails the run before anything is bought. */
async function holdAddress(region: string, reuse?: string): Promise<{ address: ReservedIp; reused: boolean }> {
  const ips   = connector.reservedIps!
  const spare = reuse ? await ips.get(send, reuse) : null
  if (spare && spare.region === region && !spare.machineId) {
    step(`Reusing reserved IP ${spare.ip}, which the hostname already points at`)
    return { address: spare, reused: true }
  }
  if (reuse) step(`${reuse} is not a reserved IP in ${region} that no box holds`)
  step(`Reserving an IP in ${region}`)
  return { address: await ips.reserve(send, region), reused: false }
}

// A failure here leaves the box bought and answered on its own address, so the
// run goes on; the error names the address, since it bills while it holds nothing.
async function routeAddress(address: ReservedIp, machineId: string): Promise<{ ip: string } | { error: string }> {
  const ips = connector.reservedIps!
  try {
    if (ips.assign) await ips.assign(send, address, machineId)
    const deadline = Date.now() + ASSIGN_DEADLINE_MS
    while (Date.now() < deadline) {
      if ((await ips.get(send, address.ip))?.machineId === machineId) {
        step(`${address.ip} routes to the box`)
        return { ip: address.ip }
      }
      await Bun.sleep(POLL_MS)
    }
    return { error: `${address.ip} is reserved and did not reach the box in ${ASSIGN_DEADLINE_MS / 1000}s` }
  } catch (e) {
    return { error: `${(e as Error).message} — ${address.ip} is reserved and bills while it holds nothing` }
  }
}

// Only a box this script made. The token reaches every box at the
// account, and an action by a typed id is one digit from somebody else's.
async function ownBox(doIt: string) {
  const id = input.id
  if (!id) fail(`${input.action} needs id`)
  const ours = (await connector.marked(send, fleetMark())).find(m => m.providerServerId === id)
  if (!ours) fail(`${id} is not a box fli basecamp:create made (no fleet mark at this ${vendor} account)`)
  if (ours!.serverId) fail(`${id} is a fleet machine Basecamp made (server ${ours!.serverId}): ${doIt} in Basecamp`)
  return ours!
}

async function destroy() {
  const ours = await ownBox('destroy it')
  // Powering it off first is the second hand on the destroy: a box still
  // serving cannot be removed by one mistyped id or one wrong pick.
  if (ours.status !== 'off') fail(`${ours.providerServerId} is ${ours.status}: fli basecamp:stop ${ours.providerServerId} first, then destroy it`)

  // Read before the destroy: the cloud unassigns the address with it.
  const reservedIp = (await heldBy()).get(ours.providerServerId) ?? null
  await connector.destroy(send, ours.providerServerId)
  answer({ destroyed: ours.providerServerId, reservedIp })
}

async function powerOff() {
  const ours = await ownBox('power it off')
  const id   = ours.providerServerId
  if (ours.status === 'off') return answer({ off: id })
  if (!await connector.powerOff(send, id)) fail(`${id} is no longer at ${vendor}`)

  const wait     = waitLine()
  const deadline = Date.now() + OFF_DEADLINE_MS
  while (Date.now() < deadline) {
    const machine = await connector.machine(send, id)
    if (machine?.status === 'off') { wait.end('Powered off'); return answer({ off: id }) }
    wait.say(`${vendor} says ${machine?.status ?? 'nothing yet'}`)
    await Bun.sleep(POLL_MS)
  }
  wait.end(`Still not off after ${OFF_DEADLINE_MS / 1000}s`)
  answer({ off: id, pending: true })
}

// A box carrying a serverId is Basecamp's, and destroy refuses it — so the
// list says which, or the id it prints is one destroy will not take.
async function list() {
  const held = await heldBy()
  const machines = (await connector.marked(send, fleetMark())).map(m => ({
    id: m.providerServerId, name: m.name, status: m.status, ip: m.ipAddress, region: m.region, serverId: m.serverId,
    basecampHost: m.basecampHost, createdAt: m.createdAt,
    reservedIp: held.get(m.providerServerId) ?? null,
  }))
  answer({ machines })
}

async function host() {
  const ours = await ownBox('it runs apps, not Basecamp; manage it')
  if (!ours.basecampHost) await connector.addMark(send, ours.providerServerId, hostMark())
  answer({ host: ours.providerServerId })
}

/** Box id → the reserved IP it holds. */
async function heldBy() {
  if (!connector.reservedIps) return new Map<string, string>()
  return new Map((await connector.reservedIps.list(send)).filter(r => r.machineId).map(r => [r.machineId!, r.ip]))
}

// Only an address no box holds: the token reaches every reserved IP at the
// account, and one that is assigned is serving somebody's box right now.
async function release() {
  const ip = input.ip
  if (!ip) fail('release needs ip')
  const ips  = connector.reservedIps ?? fail(`${vendor} holds no address apart from a box here`)
  const held = await ips.get(send, ip) ?? fail(`${ip} is not a reserved IP at this ${vendor} account`)
  if (held.machineId) fail(`${ip} is assigned to box ${held.machineId}: destroy that first`)
  await ips.release(send, held)
  answer({ released: ip })
}

try {
  if (input.action === 'create')       await create()
  else if (input.action === 'destroy') await destroy()
  else if (input.action === 'off')     await powerOff()
  else if (input.action === 'list')    await list()
  else if (input.action === 'host')    await host()
  else if (input.action === 'release') await release()
  else fail(`unknown action '${input.action}'`)
  process.exit(0)
} catch (e) {
  fail((e as Error).message)
}
