// src/domain/servers/servers.ts -- the Servers screen: the machines this
// laptop's provider accounts list, beside the hosts its ssh config names.
//
// Fetched live on every call and kept nowhere (`FJS-D2008`): the provider's
// account is the one origin, so a stored copy could only disagree with it.
// The page holds the answer for the tab's lifetime and shows `fetchedAt`.
//
// Read-only toward every provider: only each conduit's `list` and `verify`
// are called here. A connector's `create` and `destroy` are never imported.
//
// The token leaves the database only through `asSystem()`, into a conduit
// credential resolver built for that one call; it is never in an answer.

import { createConduit, createStaticResolver } from '@frontierjs/conduit'
import * as hz from '@frontierjs/conduit-hetzner'
import * as dO from '@frontierjs/conduit-digitalocean'
import { listSshHosts, type SshHost } from '../local/local-ssh.ts'

export type ComputeProvider = 'hetzner' | 'digitalocean'

type Machine = hz.Machine | dO.Machine
/** What a connector's `list` and `verify` take; the two conduits' shapes agree. */
export type Send = hz.Send

export interface ServerMachine {
  id:       string
  name:     string | null
  ip:       string | null
  status:   string
  size:     string | null
  location: string | null
  /** The machine's page in the provider's console; null where its URL needs more than the token reveals. */
  consoleUrl: string | null
}

export interface ServerAccount {
  id:       number
  label:    string
  provider: ComputeProvider
  machines: ServerMachine[]
  error:    string | null
}

export interface ServersList {
  fetchedAt: string
  accounts:  ServerAccount[]
  sshHosts:  SshHost[]
}

// Hetzner's console URL carries the project id, which no API call made with a
// project's own token returns, so a Hetzner machine has no link.
const CONNECTORS = {
  hetzner:      { label: 'Hetzner',      target: hz.hetznerTarget,      list: hz.list,  verify: hz.verify, consoleUrl: (_id: string) => null },
  digitalocean: { label: 'DigitalOcean', target: dO.digitaloceanTarget, list: dO.list,  verify: dO.verify, consoleUrl: (id: string) => `https://cloud.digitalocean.com/droplets/${encodeURIComponent(id)}` },
} as const

export const PROVIDERS = Object.keys(CONNECTORS) as ComputeProvider[]
export const isProvider = (p: unknown): p is ComputeProvider => typeof p === 'string' && Object.hasOwn(CONNECTORS, p)

/** A `send` bound to one account's token. A test hands a stub in its place. */
export type SendFor = (provider: ComputeProvider, token: string, accountId: string) => Promise<Send>

// One conduit per call, its resolver holding this one token: a shared conduit
// would keep every account's token in memory for the process's life.
export const conduitSend: SendFor = async (provider, token, accountId) => {
  const ref     = `workbench-servers:${provider}:${accountId}`
  const conduit = createConduit({ credentials: createStaticResolver({ [ref]: token }) })
  const target  = CONNECTORS[provider].target({ accountId, ref })
  await conduit.register(target)
  return hz.bindSend(conduit, target.id)
}

const toRow = (provider: ComputeProvider, m: Machine): ServerMachine => ({
  id: m.providerServerId, name: m.name, ip: m.ipAddress, status: m.status, size: m.size, location: m.region,
  consoleUrl: m.providerServerId ? CONNECTORS[provider].consoleUrl(m.providerServerId) : null,
})

// A connector's thrown failure names its kind and the vendor's sentence; a
// failure with no message still needs a line on the screen.
const sentence = (err: unknown) => (err instanceof Error && err.message) || String(err) || 'the provider did not answer'

type Db = { asSystem: () => any }

export interface ServersOptions {
  sendFor?:  SendFor
  sshHosts?: () => Promise<SshHost[]>
  now?:      () => Date
}

/** Every account's machines and the ssh hosts. One account failing is its own `error`; the rest still list. */
export async function listServers (db: Db, opts: ServersOptions = {}): Promise<ServersList> {
  const sendFor = opts.sendFor ?? conduitSend
  const rows = await db.asSystem().providerAccount.findMany({ orderBy: { id: 'asc' } }) as Array<{ id: number, label: string, provider: ComputeProvider, token: string }>
  const [accounts, sshHosts] = await Promise.all([
    Promise.all(rows.map(async (row): Promise<ServerAccount> => {
      const base = { id: row.id, label: row.label, provider: row.provider }
      try {
        const send     = await sendFor(row.provider, row.token, String(row.id))
        const machines = await CONNECTORS[row.provider].list(send)
        return { ...base, machines: machines.map(m => toRow(row.provider, m)), error: null }
      } catch (err) {
        return { ...base, machines: [], error: sentence(err) }
      }
    })),
    (opts.sshHosts ?? (() => listSshHosts()))().catch(() => [] as SshHost[]),
  ])
  return { fetchedAt: (opts.now?.() ?? new Date()).toISOString(), accounts, sshHosts }
}

export type AddRefusal = { refused: string }

/** Verify the token with the provider before a row exists, so a typo is never stored. */
export async function addAccount (
  db: Db,
  input: { label: unknown, provider: unknown, token: unknown },
  opts: Pick<ServersOptions, 'sendFor'> = {},
): Promise<{ id: number, label: string, provider: ComputeProvider, createdAt: string } | AddRefusal> {
  const label = typeof input.label === 'string' ? input.label.trim() : ''
  const token = typeof input.token === 'string' ? input.token.trim() : ''
  if (!isProvider(input.provider)) return { refused: `provider must be one of ${PROVIDERS.join(', ')}` }
  if (!label) return { refused: 'an account needs a label' }
  if (!token) return { refused: 'an account needs a token' }
  const provider = input.provider
  const name     = CONNECTORS[provider].label

  let ok = false
  try {
    const send = await (opts.sendFor ?? conduitSend)(provider, token, 'verify')
    ok = await CONNECTORS[provider].verify(send)
  } catch (err) {
    return { refused: `${name} could not be reached to check the token: ${sentence(err)}` }
  }
  if (!ok) return { refused: `${name} refused the token: it opens no account. Check it is a ${name} API token with read access.` }

  const row = await db.asSystem().providerAccount.create({ data: { label, provider, token } })
  return { id: row.id, label: row.label, provider: row.provider, createdAt: row.createdAt }
}

export async function removeAccount (db: Db, id: number): Promise<{ id: number } | AddRefusal> {
  const sys = db.asSystem().providerAccount
  const row = await sys.findFirst({ where: { id }, select: { id: true } })
  if (!row) return { refused: `no account ${id}` }
  await sys.delete({ where: { id } })
  return { id }
}
