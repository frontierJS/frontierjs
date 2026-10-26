// src/providers/storage/index.ts
// A `BackupDestination` row is a bucket, and this file is what turns one into
// a Conduit target — compute/accounts.ts for buckets.
//
// ─── Registration is not declaration ─────────────────────────────────────
//
// A destination is a row somebody typed into a form, so it is registered when
// it is written (backup-destinations.service) and re-registered at boot for
// every row that already exists. Both paths are here, so *what does a
// registered destination look like* has one answer.
//
// Keyed on the ROW and not the secret: a destination's address changes under
// a patch to `endpoint` or `region`, which a secret-keyed target would never
// see, and conduit's register is an upsert, so the patch re-registers. The
// credential is a ref, `secret:<id>`, resolved at send time, so a rotation
// in the same Secret row is picked up by the next call with nothing
// re-registered.

import { secretRef }           from '../../core/credentials.ts'
import { s3Target, bindSend }  from './s3.ts'
import type { Send }           from './s3.ts'
import type { App }            from '@frontierjs/junction'

export type DestinationRow = {
  id: string; endpoint: string; region: string; bucket: string; prefix: string; secretId?: string | null
}

/**
 * The Conduit target for one destination, `storage:s3:<destinationId>`. The
 * only place the string is built.
 */
export function targetFor(destinationId: string): string {
  return `storage:s3:${destinationId}`
}

/** Where a key lands under this destination — the prefix joined without a
 *  doubled or missing slash, since a key scoped at the vendor is matched
 *  byte for byte. */
export function keyUnder(row: Pick<DestinationRow, 'prefix'>, name: string): string {
  const prefix = (row.prefix ?? '').replace(/^\/+|\/+$/g, '')
  return prefix ? `${prefix}/${name}` : name
}

/**
 * Register one destination. A row with no credential is not registered — a
 * target whose ref resolves to nothing fails closed at send as `auth_failed`,
 * and a row that was never given a key is better absent than failing.
 */
export async function registerDestination(app: App, row: DestinationRow): Promise<string | null> {
  if (!('conduit' in app)) return null
  if (!row.secretId) return null
  const target = targetFor(row.id)
  await app.conduit.register(s3Target({
    id: target, address: row.endpoint, region: row.region, ref: secretRef(row.secretId),
  }))
  return target
}

/** Drop a destination's target, so a removed bucket stops being a registered
 *  address rather than an address that fails. */
export async function unregisterDestination(app: App, destinationId: string): Promise<void> {
  if (!('conduit' in app)) return
  await app.conduit.deregister(targetFor(destinationId))
}

/**
 * Every live destination, at boot. `asSystem()`: this runs before any request,
 * so there is no principal and no workspace, and it must see every workspace's
 * rows. Nothing here returns a row to a caller; it reads addresses and
 * registers them.
 */
export async function registerAllDestinations(app: App, db: any): Promise<number> {
  if (!('conduit' in app)) return 0
  const rows = await db.asSystem().backupDestination.findMany({
    select: { id: true, endpoint: true, region: true, bucket: true, prefix: true, secretId: true },
  })
  let n = 0
  for (const row of rows as DestinationRow[]) {
    try {
      if (await registerDestination(app, row)) n++
    } catch (err) {
      // One unregistrable destination must not stop the others, and must not
      // be silent either — a schedule whose target is missing answers
      // `target_not_found` at 02:00 with no explanation otherwise.
      app.logger.warn('storage: destination not registered', { destination_id: row.id, error: String(err) })
    }
  }
  return n
}

/** A sender bound to one destination's target. */
export function sendFor(app: App, destinationId: string): Send {
  return bindSend(app.conduit as never, targetFor(destinationId))
}
