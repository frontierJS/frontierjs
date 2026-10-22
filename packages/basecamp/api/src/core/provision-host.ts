// api/src/core/provision-host.ts — the machine Basecamp itself will run on, made at DigitalOcean.
//
// `fli provision` runs it from this checkout (`FJS-D1253`), with the token in
// the environment so it never sits in a process listing:
//
//   DIGITALOCEAN_TOKEN=… bun api/src/core/provision-host.ts '{"action":"create","size":"4gb",…}'
//   DIGITALOCEAN_TOKEN=… bun api/src/core/provision-host.ts '{"action":"destroy","id":"123"}'
//   DIGITALOCEAN_TOKEN=… bun api/src/core/provision-host.ts '{"action":"list"}'
//
// The vendor's dialect is providers/compute/digitalocean.ts and nothing here
// restates it. The box boots with no user_data: install.sh is served by a
// running Basecamp, so this box cannot boot from it, and `fli deploy:setup`
// installs it over SSH instead.
//
// It carries the fleet tag and no server id. Reconcile reports it as an orphan
// until a Server row names it, which is the truth: a droplet billing at this
// account that no row describes.
//
// The last line of stdout is one JSON object, which is fli's whole contract:
//   { id, name, ip, region, size, image, monthly }   created and up
//   { id, name, pending: true, … }                    created, not up before the deadline
//   { destroyed: '<id>' }
//   { machines: [{ id, status, ip, region, serverId }] }   every fleet-tagged droplet
//   { error: '<what>' }                               and the exit is non-zero

import { connectorFor, fleetMark, priceIn, sizeRegions } from '../providers/compute/index.ts'
import type { ComputeSize }   from '../providers/compute/index.ts'
import { bearerSend }         from './bearer-send.ts'

const answer = (o: Record<string, unknown>) => console.log(JSON.stringify(o))
const fail   = (error: string): never => { answer({ error }); process.exit(1) }

/** How long a droplet gets to come up. DO's own figure is under a minute; past
 *  this the id is answered as pending so the caller can still destroy it. */
const READY_DEADLINE_MS = 180_000
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
  const { name, region, image, size, publicKey, keyName } = input
  if (!name || !region || !image || !size || !publicKey)
    fail('create needs name, region, image, size and publicKey')

  const catalog = await connector.catalog(send)
  if (!catalog.regions.some(r => r.slug === region && r.available))
    fail(`no region '${region}'; available: ${catalog.regions.filter(r => r.available).map(r => r.slug).join(', ')}`)
  if (!catalog.images.some(i => i.slug === image))
    fail(`no image '${image}'; Ubuntu ones: ${catalog.images.filter(i => i.slug.startsWith('ubuntu')).map(i => i.slug).join(', ')}`)
  const picked = pickSize(catalog.sizes, size, region)

  // A second run must not buy a second box. A fleet-tagged droplet with no
  // server id is one this script made and nothing has claimed.
  const prior = (await connector.marked(send, fleetMark())).filter(m => !m.serverId)
  if (prior.length)
    fail(`a machine provisioned earlier is still at this account: `
      + prior.map(m => `${m.providerServerId} (${m.ipAddress ?? 'no address yet'})`).join(', ')
      + ` — destroy it with fli provision:destroy <id>, or deploy to it`)

  const sshKey = await connector.sshKey(send, { name: keyName || `fli ${name}`, publicKey })
  const { providerServerId } = await connector.create(send, {
    name, region, image, size: picked.slug, sshKeys: [sshKey], mark: fleetMark(),
  })

  const made = { id: providerServerId, name, region, size: picked.slug, image,
                 monthly: priceIn(picked, region), currency: picked.currency }

  const deadline = Date.now() + READY_DEADLINE_MS
  while (Date.now() < deadline) {
    const machine = await connector.machine(send, providerServerId)
    if (machine?.status === 'running' && machine.ipAddress) return answer({ ...made, ip: machine.ipAddress })
    await Bun.sleep(POLL_MS)
  }
  answer({ ...made, pending: true })
}

async function destroy() {
  const id = input.id
  if (!id) fail('destroy needs id')

  // Only a box this script made. The token reaches every droplet at the
  // account, and a destroy by a typed id is one digit from somebody else's.
  const ours = (await connector.marked(send, fleetMark())).find(m => m.providerServerId === id)
  if (!ours) fail(`${id} is not a droplet fli provision made (no fleet tag at this account)`)
  if (ours!.serverId) fail(`${id} is a fleet machine Basecamp made (server ${ours!.serverId}): destroy it in Basecamp`)
  // Powering it off first is the second hand on the destroy: a box still
  // serving cannot be removed by one mistyped id or one wrong pick.
  if (ours!.status !== 'off') fail(`${id} is ${ours!.status}: power it off at DigitalOcean first, then destroy it`)

  await connector.destroy(send, id)
  answer({ destroyed: id })
}

// A droplet carrying a serverId is Basecamp's, and destroy refuses it — so the
// list says which, or the id it prints is one destroy will not take.
async function list() {
  const machines = (await connector.marked(send, fleetMark())).map(m => ({
    id: m.providerServerId, status: m.status, ip: m.ipAddress, region: m.region, serverId: m.serverId,
  }))
  answer({ machines })
}

try {
  if (input.action === 'create')       await create()
  else if (input.action === 'destroy') await destroy()
  else if (input.action === 'list')    await list()
  else fail(`unknown action '${input.action}'`)
  process.exit(0)
} catch (e) {
  fail((e as Error).message)
}
