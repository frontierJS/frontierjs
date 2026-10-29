// src/domain/backup/found-replicas.ts
// After a hub restore, which replicas the bucket still holds
// (`IDEAS/backups.md` 4.5). Run once by `restore:reconcile`, at the first boot
// whose `restoreStaged` answered `done`.
//
// ─── Found is not lost ────────────────────────────────────────────────────
//
// The restored rows are as old as the archive, and the fleet kept running. So
// a replica found is recorded, not acted on: `App.replicaFoundAt` makes the
// app screen offer `restoreReplica`, and the screen hides the offer while a
// placement's heartbeat shows the app replicating inside the lag window — that
// app is alive, and Outpost refuses a volume its container holds anyway.
//
// ─── The hub's own ────────────────────────────────────────────────────────
//
// Basecamp's replica can be newer than the archive just restored, which is the
// one case where the runbook beats the archive. It is recorded on the hub
// App's row the same way, under `<prefix>/basecamp` rather than its id, and
// nobody is told: `/hub/backups/` names the runbook, because the hub cannot
// replace itself while serving.
//
// A credential that will not decrypt, or a bucket that refuses the listing,
// is that app's line in the answer and the log; the others still run.

import { replicaOf, replicaDatabases } from '../../jobs/replicate-sync.job.ts'
import { keyUnder, sendFor }           from '../../providers/storage/index.ts'
import { listObjects }                 from '../../providers/storage/s3.ts'
import { notifyPeople, workspaceMembers } from '../notification/notify.ts'
import { hubApp }                      from '../host/host-machine.ts'
import type { App }                    from '@frontierjs/junction'

export type Finding =
  | { appId: string | null; databases: string[]; syncedAt: string | null }
  | { appId: string | null; error: string }

/** The newest object under `prefix`, Litestream's last write to the bucket. */
export async function newestUnder(app: App, dest: { id: string; name: string; bucket: string }, prefix: string): Promise<string | null> {
  const send = sendFor(app, dest.id)
  let token: string | undefined, newest: string | null = null
  do {
    const page = await listObjects(send, dest.bucket, { prefix: `${prefix.replace(/\/+$/, '')}/`, continuationToken: token })
    if (page.error) throw new Error(`'${dest.name}' refused the listing (${page.error.kind}${page.error.code ? `, ${page.error.code}` : ''}): ${page.error.message}`)
    for (const o of page.objects!) {
      const at = o.lastModified ? new Date(o.lastModified).toISOString() : null
      if (at && (!newest || at > newest)) newest = at
    }
    token = page.nextToken ?? undefined
  } while (token)
  return newest
}

async function probe(app: App, appId: string | null, dest: any, path: string): Promise<Finding> {
  try {
    const databases = await replicaDatabases(app, dest, path)
    return { appId, databases, syncedAt: databases.length ? await newestUnder(app, dest, path) : null }
  } catch (err) {
    return { appId, error: (err as Error).message }
  }
}

/**
 * List every replica the restored rows name, record each one found, and tell
 * each workspace which of its apps have one. Answers one finding per replica.
 */
export async function reconcileFound(app: App): Promise<Finding[]> {
  const sys = (app.db as any).asSystem()
  const now = new Date().toISOString()
  const out: Finding[] = []

  const hub = await hubApp(sys)
  const apps = await sys.app.findMany({
    where:  { replicaDestinationId: { not: null }, ...(hub ? { NOT: { id: hub.id } } : {}) },
    select: { id: true, slug: true, name: true, workspaceId: true, replicaDestinationId: true, replicaFoundAt: true },
    orderBy: { id: 'asc' },
  }) as { id: string; slug: string; name: string; workspaceId: string; replicaDestinationId: string; replicaFoundAt: string | null }[]

  const told = new Map<string, { id: string; name: string; syncedAt: string | null }[]>()
  for (const a of apps) {
    let replica
    try { replica = await replicaOf(app, a) }
    catch (err) { out.push({ appId: a.id, error: (err as Error).message }); continue }
    if (!replica) continue
    const f = await probe(app, a.id, replica.dest, replica.entry.path)
    out.push(f)
    if ('error' in f || !f.databases.length) continue
    await sys.app.update({
      where:  { id: a.id },
      data:   { replicaFoundAt: now, replicaSyncedAt: f.syncedAt },
      system: ['replicaFoundAt', 'replicaSyncedAt'],
    })
    // A retried job has already told whoever it found the first time.
    if (!a.replicaFoundAt) told.set(a.workspaceId, [...(told.get(a.workspaceId) ?? []), { id: a.id, name: a.name, syncedAt: f.syncedAt }])
  }

  const dest = hub?.replicaDestinationId
    ? await sys.backupDestination.findFirst({ where: { id: hub.replicaDestinationId } })
    : null
  if (dest) {
    const f = dest.secretId
      ? await probe(app, null, dest, keyUnder(dest, 'basecamp'))
      : { appId: null, error: `destination '${dest.name}' holds no credential` }
    out.push(f)
    if (!('error' in f) && f.databases.length)
      await sys.app.update({
        where:  { id: hub.id },
        data:   { replicaFoundAt: now, replicaSyncedAt: f.syncedAt },
        system: ['replicaFoundAt', 'replicaSyncedAt'],
      })
  }

  for (const [workspaceId, found] of told)
    await notifyPeople(app, 'ReplicaFound', await workspaceMembers(app, workspaceId), { workspaceId, apps: found })
  return out
}
