// src/domain/release/image-export.ts
// Puts one release's image in its App's replica bucket, so a read-only copy
// can be served on a machine that never held the release (`FJS-D1914`). The
// job `release-image:export` is the only caller.
//
// ─── Where the image lives ────────────────────────────────────────────────
//
// Beside the replica's databases, under `<replica path>/images/`. A copy only
// ever runs the newest successful release, so the export that lands deletes
// every other image there. `replicaDatabases` lists `*.db` prefixes only, so
// `images/` is never read as a database.
//
// A failed export leaves `imageSha256` null and the release as it was: the
// release shipped, and a copy on the App's own machine still serves it from
// the digest it holds.

import { executorOn, isExecutor }                     from '../../providers/executor.ts'
import { sendFor }                                    from '../../providers/storage/index.ts'
import { deleteObject, listObjects }                  from '../../providers/storage/s3.ts'
import { replicaOf }                                  from '../../jobs/replicate-sync.job.ts'
import { mintPut, BACKUP_TIMEOUT_MS }                 from '../../jobs/app-backup-run.job.ts'
import type { App }                                   from '@frontierjs/junction'

/** An export is a `docker save`, a gzip and an upload; it gets a backup's bound. */
export const IMAGE_EXPORT_TIMEOUT_MS = BACKUP_TIMEOUT_MS

const imagesUnder = (replicaPath: string): string => `${replicaPath.replace(/\/+$/, '')}/images/`

/** The object a release's image is stored as. */
export const imageKey = (replicaPath: string, deploymentId: string): string =>
  `${imagesUnder(replicaPath)}${deploymentId}.tar.gz`

export type ImageExport =
  | { uploaded: true;  key: string; sha256: string; pruned: number }
  | { uploaded: false; reason: string | null }

/**
 * Export the release's image from `serverId` and record its sha256. Answers
 * `reason: null` when there was nothing to do, and the reason in words when
 * the export was attempted and failed. Never throws and never touches the
 * release's status.
 */
export async function exportReleaseImage(app: App, deploymentId: string, serverId: string): Promise<ImageExport> {
  const sys     = app.db!.asSystem() as any
  const failed  = (reason: string): ImageExport => ({ uploaded: false, reason })
  try {
    const release = await sys.deployment.findFirst({ where: { id: deploymentId } })
    if (!release?.toImage) return { uploaded: false, reason: null }
    const target = await sys.app.findFirst({ where: { id: release.appId } })
    if (!target || target.deletedAt) return { uploaded: false, reason: null }
    const replica = await replicaOf(app, target)
    if (!replica) return { uploaded: false, reason: null }

    const executor = await executorOn(app, serverId)
    if (!isExecutor(executor)) return failed(executor.reason)
    if (executor.kind === 'stub') return { uploaded: false, reason: null }

    const key   = imageKey(replica.entry.path, deploymentId)
    const reply = await executor.call('/image/export', {
      app_id: target.id, image: release.toImage, ...(release.builtImage ? { digest: release.builtImage } : {}),
      upload_url: await mintPut(app, replica.dest, key),
    }, { timeoutMs: IMAGE_EXPORT_TIMEOUT_MS })
    if (reply.error) return failed(reply.error.message)
    const { uploaded, sha256, upload_error } = (reply.data ?? {}) as { uploaded?: boolean; sha256?: string; upload_error?: string }
    if (!uploaded) return failed(`the bucket refused the image${upload_error ? `: ${upload_error}` : ''}`)
    if (typeof sha256 !== 'string' || !sha256) return failed('the outpost uploaded the image but answered no sha256')

    await sys.deployment.update({ where: { id: deploymentId }, data: { imageSha256: sha256 } })
    return { uploaded: true, key, sha256, pruned: await pruneImages(app, replica.dest, replica.entry.path, key) }
  } catch (err) {
    return failed((err as Error).message)
  }
}

/** Delete every image under the replica but `keep`. Throws in the bucket's words. */
async function pruneImages(app: App, dest: { id: string; name: string; bucket: string }, replicaPath: string, keep: string): Promise<number> {
  const send = sendFor(app, dest.id)
  const stale: string[] = []
  let token: string | undefined
  do {
    const page = await listObjects(send, dest.bucket, { prefix: imagesUnder(replicaPath), continuationToken: token })
    if (page.error) throw new Error(`'${dest.name}' refused the listing of old images (${page.error.kind}): ${page.error.message}`)
    for (const o of page.objects!) if (o.key !== keep) stale.push(o.key)
    token = page.nextToken ?? undefined
  } while (token)
  for (const key of stale) {
    const del = await deleteObject(send, dest.bucket, key)
    if (!del.gone) throw new Error(`'${dest.name}' kept the old image ${key}`)
  }
  return stale.length
}
