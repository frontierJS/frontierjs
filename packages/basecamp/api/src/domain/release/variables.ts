// src/domain/release/variables.ts
// What a container's environment is, and the one place a secret value is read.
//
// A release records its variables when it is CREATED and the machine gets them
// when it is SENT. Plain values are copied into the snapshot, so a rollback
// puts back what shipped. A secret is recorded as its `Variable` and the
// revision it had, because the snapshot is on every release read and must
// never hold the value, and a rollback must put back the credential that
// shipped or refuse by name once it is revoked (FJS-D2182).

import type { BasecampDb } from '../../core/db.ts'

interface VariableRow { id: string; key: string; appId: string | null; isSecret: boolean; value: string | null; revision: number }

/** A secret as a release pinned it. A bare string is a Variable id from a
 *  release made before secrets were pinned, and resolves to today's value. */
export type SecretPin = { variableId: string; revision: number } | string

/** What `Deployment.configSnapshot` carries beside `source` and `runtime`. */
export interface ReleaseVariables {
  env:       Record<string, string>
  secretEnv: Record<string, SecretPin>
}

/** `KEY@revision` per secret, the spelling `fli` uses too, so the two hash a
 *  release's configuration alike (FJS-D2216). An unpinned release's secret
 *  has no revision to name and is spelled by its key alone. */
export function secretRefsOf(snapshot: Partial<ReleaseVariables>): Record<string, string> {
  const refs: Record<string, string> = {}
  for (const [key, pin] of Object.entries(snapshot.secretEnv ?? {}))
    refs[key] = typeof pin === 'string' ? key : `${key}@${pin.revision}`
  return refs
}

/** A release that would start with a credential a rotation revoked. */
export class RevokedSecret extends Error {
  constructor(readonly refs: string[]) {
    super(`${refs.join(', ')} ${refs.length === 1 ? 'was' : 'were'} rotated out since this release shipped, and putting back a revoked credential is refused — roll back with today's value instead (hasTodaysSecrets: true)`)
    this.name = 'RevokedSecret'
  }
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
  const env: Record<string, string> = {}, secretEnv: Record<string, SecretPin> = {}
  // Environment-wide first, so the app's own row is the one left standing.
  for (const row of [...rows.filter(r => !r.appId), ...rows.filter(r => r.appId)]) {
    delete env[row.key]; delete secretEnv[row.key]
    if (row.isSecret) secretEnv[row.key] = { variableId: row.id, revision: row.revision }
    else            env[row.key] = row.value ?? ''
  }
  return { env, secretEnv }
}

interface Resolved { key: string; ref: string; current: string | null; kept?: { secretValue: string; revokedAt: string | null } | null; revision: number | null; currentRevision: number | null }

/** Each pinned secret beside its variable's current value and, where the pin
 *  is older, the version a rotation kept. Read through `asSystem()`, the one
 *  place a secret value is read. */
async function resolvePins(db: BasecampDb, snapshot: Partial<ReleaseVariables>): Promise<Resolved[]> {
  const pins = Object.entries(snapshot.secretEnv ?? {})
  if (!pins.length) return []
  const sys  = (db as any).asSystem()
  const idOf = (pin: SecretPin) => typeof pin === 'string' ? pin : pin.variableId
  const rows: Array<{ id: string; secretValue: string | null; revision: number }> = await sys.variable.findMany({
    where:  { id: { in: pins.map(([, pin]) => idOf(pin)) } },
    select: { id: true, secretValue: true, revision: true },
  })
  const byId = new Map(rows.map(r => [r.id, r]))
  const out: Resolved[] = []
  for (const [key, pin] of pins) {
    const row = byId.get(idOf(pin))
    const revision = typeof pin === 'string' ? null : pin.revision
    const kept = row && revision != null && revision !== row.revision
      ? await sys.variableVersion.findFirst({ where: { variableId: row.id, revision }, select: { secretValue: true, revokedAt: true } })
      : undefined
    out.push({ key, ref: revision == null ? key : `${key}@${revision}`, current: row?.secretValue ?? null,
      kept, revision, currentRevision: row?.revision ?? null })
  }
  return out
}

/** The refs in a release a rotation has revoked since — what a rollback to it
 *  is refused over unless the caller takes today's values. */
export async function revokedSecretsOf(db: BasecampDb, snapshot: Partial<ReleaseVariables>): Promise<string[]> {
  return (await resolvePins(db, snapshot)).filter(p => p.kept?.revokedAt).map(p => p.ref)
}

/** The snapshot with every secret pinned to its revision today: what a
 *  rollback *with today's values* ships, recorded as what it applied. */
export async function pinnedToToday(db: BasecampDb, snapshot: Partial<ReleaseVariables>): Promise<Partial<ReleaseVariables>> {
  const secretEnv: Record<string, SecretPin> = { ...(snapshot.secretEnv ?? {}) }
  for (const p of await resolvePins(db, snapshot)) {
    const pin = secretEnv[p.key]
    if (p.currentRevision != null) secretEnv[p.key] = { variableId: typeof pin === 'string' ? pin : pin.variableId, revision: p.currentRevision }
  }
  return { ...snapshot, secretEnv }
}

/**
 * A release's variables as the machine needs them — one flat `env`, each
 * secret at the revision the release pinned.
 *
 * A secret that is gone THROWS, naming the variable: a container started
 * without its database password comes up and fails somewhere far less legible
 * than the release that sent it. A revoked one throws `RevokedSecret` unless
 * `todaysSecrets` — a copy or a drill of the live app wants the credential
 * the app would get now, not one a rotation withdrew.
 */
export async function releaseEnv(
  db:       BasecampDb,
  snapshot: Partial<ReleaseVariables>,
  { todaysSecrets = false }: { todaysSecrets?: boolean } = {},
): Promise<Record<string, string>> {
  const env      = { ...(snapshot.env ?? {}) }
  const resolved = await resolvePins(db, snapshot)
  const revoked  = resolved.filter(p => p.kept?.revokedAt).map(p => p.ref)
  if (revoked.length && !todaysSecrets) throw new RevokedSecret(revoked)
  for (const p of resolved) {
    const value = p.kept && !todaysSecrets ? p.kept.secretValue
      : p.kept === null && !todaysSecrets ? null
      : p.current
    if (value == null)
      throw new Error(`${p.ref} names a secret variable that is gone, and the container would start without it`)
    env[p.key] = value
  }
  return env
}
