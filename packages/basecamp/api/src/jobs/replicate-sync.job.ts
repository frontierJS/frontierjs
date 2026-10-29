// src/jobs/replicate-sync.job.ts
// Sends one machine the whole list of apps it replicates, and is the one place
// that asks a machine for one (`POST /replicate`, Invariant 4). Dispatched as
// `replicate:sync` by `syncReplicasOn` from every write that changes a list.
//
// ─── The list is whole, and it is the machine's ──────────────────────────
//
// One Litestream unit per machine reads one config file (`FJS-D1486`), so the
// machine is sent EVERY app it holds that names a `replicaDestinationId`, and
// the Outpost replaces its file with exactly that. An app left off the list
// stops replicating; that is why a list that cannot be built whole is not sent
// at all — a credential nothing can read throws, and the machine keeps the
// file it had, still replicating everybody else.
//
// Each entry carries its own app's key (`FJS-D1505`): the destination is the
// app's alone, and the key is whatever the operator minted for it at the
// vendor — a prefix where the vendor scopes one, a bucket where it does not.
//
// ─── Basecamp's own database ─────────────────────────────────────────────
//
// Basecamp's box replicates Basecamp the same way, through its own Outpost
// (`FJS-D1486`): `HubConfig.replicaDestinationId` rides beside that machine's
// list as `host`. The machine is the `basecamp-host` row IN THE DESTINATION'S
// WORKSPACE: the slug is unique per workspace and reserved nowhere, so a
// tenant naming a server `basecamp-host` would otherwise be sent this key.
// One destination is one replica's, an app's or the hub's (`FJS-D1505`), and
// `replicaHolder` is the one reader of which.
//
// ─── Which writes change a list ──────────────────────────────────────────
//
// An app's pointer set, cleared, deleted or restored; a placement made or
// removed; a release succeeding, because a first release is what creates the
// volume the Outpost skips until it exists; a destination patched, because
// its address or key moved; the hub's pointer set or cleared; and a machine
// coming back `online`, because a re-enrolled machine starts from `dbs: []`.
//
// ─── One in flight per machine ───────────────────────────────────────────
//
// `unique` keeps two sends from crossing, so an older list never lands after
// a newer one. It also drops a dispatch made while one runs, so the handler
// reads the list again after sending and sends again until it holds still.
//
// The work is the machine's, never a person's: the list names every app on it,
// across whoever placed them, so it is read at SYSTEM (`runsAsApp`).

import { defineJob }                         from '@frontierjs/caravan'
import { runsAsApp }                         from './context.ts'
import { executorOn, isExecutor }            from '../providers/executor.ts'
import { createSecretResolver, secretRef }   from '../core/credentials.ts'
import { keyUnder, sendFor }                 from '../providers/storage/index.ts'
import { splitCredential, listObjects }      from '../providers/storage/s3.ts'
import { hostServer, hubApp }                from '../domain/host/host-machine.ts'
import type { App }                          from '@frontierjs/junction'

/** The wire entry `POST /replicate` takes — Outpost's `replicate.js` refuses any other. */
export interface ReplicaEntry {
  app_id:            string
  bucket:            string
  path:              string
  endpoint:          string
  region:            string
  access_key_id:     string
  secret_access_key: string
}

/** The `host` entry: Basecamp's database directory, which the Outpost knows and Basecamp does not. */
export type HostReplica = Omit<ReplicaEntry, 'app_id'>

/** What `POST /replicate` is sent. No `host` is no host replica. */
export type ReplicaList = { replicas: ReplicaEntry[]; host?: HostReplica }

/** A list that will not hold still after this many sends is left to the next write. */
const MAX_SENDS = 3

/**
 * Every app on `serverId` that replicates, each with its key. Throws on an
 * app whose destination is in another workspace or whose key cannot be read,
 * naming the app, so the machine is never sent a list short of one.
 */
export async function replicasFor(app: App, serverId: string): Promise<ReplicaEntry[]> {
  const sys    = (app.db as any).asSystem()
  const placed = await sys.appServer.findMany({ where: { serverId }, select: { appId: true } }) as { appId: string }[]
  const appIds = [...new Set(placed.map(p => p.appId))]
  if (!appIds.length) return []

  const apps = await sys.app.findMany({
    where:  { id: { in: appIds }, replicaDestinationId: { not: null } },
    select: { id: true, slug: true, workspaceId: true, replicaDestinationId: true },
    orderBy: { id: 'asc' },
  }) as { id: string; slug: string; workspaceId: string; replicaDestinationId: string }[]

  const out: ReplicaEntry[] = []
  for (const a of apps) {
    const entry = await replicaOf(app, a)
    if (entry) out.push(entry.entry)
  }
  return out
}

type ReplicatingApp = { id: string; slug: string; workspaceId: string; replicaDestinationId: string | null }

/**
 * One app's entry and its destination row, or null when it names none or a
 * removed one — a soft delete that keeps the pointer reads as none, and the
 * app stops replicating with it. Throws as `replicasFor` does.
 */
export async function replicaOf(app: App, a: ReplicatingApp): Promise<{ entry: ReplicaEntry; dest: any } | null> {
  if (!a.replicaDestinationId) return null
  const dest = await (app.db as any).asSystem().backupDestination.findFirst({ where: { id: a.replicaDestinationId } })
  if (!dest) return null
  if (dest.workspaceId !== a.workspaceId)
    throw new Error(`app '${a.slug}' points its replica at a destination outside its workspace`)
  const credential = dest.secretId ? await createSecretResolver(app.db as any).get(secretRef(dest.secretId)) : null
  if (typeof credential !== 'string' || !credential)
    throw new Error(`app '${a.slug}': destination '${dest.name}' has no credential that can be read`)
  const { accessKeyId, secretAccessKey } = splitCredential(credential)
  return { dest, entry: {
    app_id: a.id, bucket: dest.bucket, path: keyUnder(dest, a.id),
    endpoint: dest.endpoint, region: dest.region,
    access_key_id: accessKeyId, secret_access_key: secretAccessKey,
  } }
}

/**
 * The databases a replica holds, read off the bucket: a directory target
 * writes each file under `<path>/<file>/`, and Litestream itself cannot list
 * them. Throws in the bucket's words.
 */
export async function replicaDatabases(app: App, dest: { id: string; name: string; bucket: string }, path: string): Promise<string[]> {
  const send = sendFor(app, dest.id)
  const under = `${path.replace(/\/+$/, '')}/`
  const names: string[] = []
  let token: string | undefined
  do {
    const page = await listObjects(send, dest.bucket, { prefix: under, delimiter: '/', continuationToken: token })
    if (page.error) throw new Error(`'${dest.name}' refused the listing (${page.error.kind}${page.error.code ? `, ${page.error.code}` : ''}): ${page.error.message}`)
    for (const p of page.prefixes!) {
      const name = p.slice(under.length).replace(/\/$/, '')
      if (/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.db$/.test(name)) names.push(name)
    }
    token = page.nextToken ?? undefined
  } while (token)
  return names
}

/**
 * The destination Basecamp's own database replicates to, when `server` is the
 * box that holds it — the hub's host row, in that destination's workspace.
 */
export async function hostReplicaDestination(sys: any, server: { id: string; workspaceId: string }): Promise<any | null> {
  if ((await hostServer(sys))?.id !== server.id) return null
  const hub = await hubApp(sys)
  if (!hub?.replicaDestinationId) return null
  const dest = await sys.backupDestination.findFirst({ where: { id: hub.replicaDestinationId } })
  return dest && dest.workspaceId === server.workspaceId ? dest : null
}

/** The `host` entry for `serverId`, or null. Throws on a key that cannot be read, as `replicasFor` does. */
export async function hostReplicaFor(app: App, serverId: string): Promise<HostReplica | null> {
  const sys    = (app.db as any).asSystem()
  const server = await sys.server.findFirst({ where: { id: serverId }, select: { id: true, workspaceId: true } })
  const dest   = server ? await hostReplicaDestination(sys, server) : null
  if (!dest) return null
  const credential = dest.secretId ? await createSecretResolver(app.db as any).get(secretRef(dest.secretId)) : null
  if (typeof credential !== 'string' || !credential)
    throw new Error(`Basecamp's replica: destination '${dest.name}' has no credential that can be read`)
  const { accessKeyId, secretAccessKey } = splitCredential(credential)
  // Beside the hub's snapshots, which are `<prefix>/basecamp-<stamp>.tar.gz`.
  return {
    bucket: dest.bucket, path: keyUnder(dest, 'basecamp'), endpoint: dest.endpoint, region: dest.region,
    access_key_id: accessKeyId, secret_access_key: secretAccessKey,
  }
}

async function listFor(app: App, serverId: string): Promise<ReplicaList> {
  const replicas = await replicasFor(app, serverId)
  const host     = await hostReplicaFor(app, serverId)
  return host ? { replicas, host } : { replicas }
}

/** Send `serverId` its list until it holds still. Answers what the machine said. */
export async function syncReplicas(app: App, serverId: string): Promise<{ replicating: string[]; skipped: unknown[]; host?: string; stub?: true }> {
  const executor = await executorOn(app, serverId)
  if (!isExecutor(executor)) throw new Error(executor.reason)

  let list = await listFor(app, serverId)
  for (let sent = 1; ; sent++) {
    const reply = await executor.call('/replicate', list)
    if (reply.error) throw new Error(reply.error.message)
    const after = await listFor(app, serverId)
    if (JSON.stringify(after) === JSON.stringify(list) || sent === MAX_SENDS) {
      if (executor.kind === 'stub') return { replicating: [], skipped: [], stub: true }
      const host = reply.data?.host as string | undefined
      return {
        replicating: (reply.data?.replicating as string[] | undefined) ?? [],
        skipped:     (reply.data?.skipped as unknown[] | undefined) ?? [],
        ...(host ? { host } : {}),
      }
    }
    list = after
  }
}

/** Who replicates with this destination's key: an app, the hub, or nobody. */
export async function replicaHolder(app: App, destinationId: string): Promise<{ app: { id: string; slug: string } } | { hub: true } | null> {
  const sys = (app.db as any).asSystem()
  const held = await sys.app.findFirst({ where: { replicaDestinationId: destinationId }, select: { id: true, slug: true } })
  if (!held) return null
  return held.id === (await hubApp(sys))?.id ? { hub: true } : { app: held }
}

/** Queue a send to every machine holding this destination's key. */
export async function syncReplicasHeldBy(app: App, destinationId: string): Promise<void> {
  const holder = await replicaHolder(app, destinationId)
  if (holder && 'app' in holder) await syncReplicasOf(app, [holder.app.id])
  else if (holder)               await syncHostReplica(app)
}

/** Queue a send to Basecamp's box. */
export async function syncHostReplica(app: App): Promise<void> {
  const host = await hostServer((app.db as any).asSystem())
  if (host) await syncReplicasOn(app, [host.id])
}

/**
 * Queue a send to each named machine. Never throws: every caller is a write
 * that already happened, and a queue hiccup must not undo it.
 */
export async function syncReplicasOn(app: App, serverIds: Iterable<string>): Promise<void> {
  for (const serverId of new Set(serverIds)) {
    try {
      await app.jobs.dispatch(replicateSync, { serverId }, { unique: `replicate:${serverId}`, actor: null, tenant: null })
    } catch (err) {
      app.logger.child('replicate-sync').warn('replica list not queued', { serverId, error: (err as Error).message })
    }
  }
}

/** Queue a send to every machine holding any of these apps. */
export async function syncReplicasOf(app: App, appIds: string[]): Promise<void> {
  if (!appIds.length) return
  const placed = await (app.db as any).asSystem().appServer.findMany({ where: { appId: { in: appIds } }, select: { serverId: true } }) as { serverId: string }[]
  await syncReplicasOn(app, placed.map(p => p.serverId))
}

// ─── The job ──────────────────────────────────────────────────────────────
// Retried: a machine not yet registered since the API restarted heartbeats
// within the delays below, and until it does it replicates the old list.

const replicateSync = defineJob<{ serverId: string }>({
  name:        'replicate:sync',
  queue:       'fleet',
  maxAttempts: 5,
  retryDelay:  [10_000, 60_000],
  // A restart is bounded at 60s on the machine; this outlasts three sends.
  timeout:     4 * 60_000,
  handler: async (ctx) => {
    const { app } = runsAsApp(ctx, 'replicate:sync')
    const out = await syncReplicas(app, ctx.data.serverId)
    const log = app.logger.child('replicate-sync')
    if (out.skipped.length) log.info('replicating, some volumes not made yet', { serverId: ctx.data.serverId, ...out })
    else                    log.info('replicating', { serverId: ctx.data.serverId, ...out })
  },
})

export default replicateSync
