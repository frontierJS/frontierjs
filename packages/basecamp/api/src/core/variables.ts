// src/core/variables.ts
// What a container's environment is, and the one place a secret value is read.
//
// A release records its variables when it is CREATED and the machine gets them
// when it is SENT. Plain values are copied into the snapshot, so a rollback
// puts back what shipped. A secret is recorded as the id of its `Variable`,
// because the snapshot is on every release read and must never hold the value.

import type { BasecampDb } from './db.ts'

interface VariableRow { id: string; key: string; appId: string | null; secret: boolean; value: string | null }

/** What `Deployment.configSnapshot` carries beside `source` and `runtime`. */
export interface ReleaseVariables {
  env:       Record<string, string>
  secretEnv: Record<string, string>   // key → Variable id
}

/**
 * The variables an app's container starts with: its environment's, then its
 * own on top. An app's `LOG_LEVEL` wins over the environment's `LOG_LEVEL`,
 * and a plain one of either kind replaces a secret of the same key.
 *
 * `db` is the caller's client. Reading ids and plain values needs no more
 * than reading the environment, and `secretValue` is absent from the answer.
 */
export async function snapshotVariables(
  db:  BasecampDb,
  app: { id: string; environmentId: string },
): Promise<ReleaseVariables> {
  const rows: VariableRow[] = await (db as any).variable.findMany({
    where: { environmentId: app.environmentId, OR: [{ appId: null }, { appId: app.id }] },
  })
  const env: Record<string, string> = {}, secretEnv: Record<string, string> = {}
  // Environment-wide first, so the app's own row is the one left standing.
  for (const row of [...rows.filter(r => !r.appId), ...rows.filter(r => r.appId)]) {
    delete env[row.key]; delete secretEnv[row.key]
    if (row.secret) secretEnv[row.key] = row.id
    else            env[row.key] = row.value ?? ''
  }
  return { env, secretEnv }
}

/**
 * A release's variables as the machine needs them — one flat `env`, every
 * secret read at this moment through `asSystem()`.
 *
 * A secret that is gone THROWS, naming the variable: a container started
 * without its database password comes up and fails somewhere far less legible
 * than the release that sent it.
 */
export async function releaseEnv(
  db:       BasecampDb,
  snapshot: Partial<ReleaseVariables>,
): Promise<Record<string, string>> {
  const env  = { ...(snapshot.env ?? {}) }
  const refs = Object.entries(snapshot.secretEnv ?? {})
  if (!refs.length) return env

  const rows: Array<{ id: string; secretValue: string | null }> = await (db as any).asSystem().variable.findMany({
    where:  { id: { in: refs.map(([, id]) => id) } },
    select: { id: true, secretValue: true },
  })
  const byId = new Map(rows.map(r => [r.id, r.secretValue]))
  for (const [key, id] of refs) {
    const value = byId.get(id)
    if (value == null)
      throw new Error(`${key} names a secret variable that is gone, and the container would start without it`)
    env[key] = value
  }
  return env
}
