/*
 * outbound.ts
 *
 * The http.request node's port over conduit, and conduit's credential resolver
 * over `FlowCredential` (`FJS-D273`).
 *
 * orion runs its OWN conduit instance rather than the app's: a flow's secrets
 * are rows in orion's models, encrypted and gated at 5, and the app's resolver
 * reads the environment. Everything conduit owns per target — the timeout, the
 * retry, the breaker, the auth header, the body encoding, the refusal to follow
 * a redirect with the credential — applies to a flow's call unchanged.
 *
 * A credential is registered as a target the first time a flow calls through
 * it, and again whenever the row's `updatedAt` moves, so an edited address or
 * a rotated secret is what the next call uses.
 *
 * A credential is a row in its TENANT (`FJS-D294`), so two tenants may each have
 * one called `crm`. The target is named for both, and the tenant travels to the
 * resolver inside the ref, which is the only thing conduit hands it.
 */

import type { IOutbound, OutboundResponse } from "./engine/ports"
import { withSystem, type OrionHost } from "./tenancy"

// ─── what this file asks of conduit ──────────────────────────────────────────

interface ConduitLike {
  register(descriptor: object): Promise<void>
  send(req: {
    target: string; method: string; path?: string; query?: Record<string, unknown>
    headers?: Record<string, string>; body?: unknown; idempotency_key?: string
  }): Promise<{
    data:  unknown
    error: { kind: string; message: string; raw?: unknown } | null
    meta:  { status?: number; headers?: Record<string, string> }
  }>
}

interface CredentialTable {
  findFirst(args: object): Promise<CredentialRow | null>
}

interface CredentialRow {
  name:      string
  address:   string
  auth:      "none" | "bearer" | "api_key" | "hmac"
  header:    string | null
  encoding:  string | null
  secret?:   string | null
  updatedAt: string
}

export class UnknownCredentialError extends Error {
  constructor(readonly credential: string) {
    super(`No credential named "${credential}"`)
    this.name = "UnknownCredentialError"
  }
}

// ─── the resolver ────────────────────────────────────────────────────────────

const refFor  = (tenant: string | null, name: string) => JSON.stringify([tenant, name])
const readRef = (ref: string) => JSON.parse(ref) as [string | null, string]

/** Conduit's `credentials` option: a target's `ref` is the tenant and the credential's name. */
export function flowCredentialResolver(host: OrionHost) {
  return {
    async get(ref: string): Promise<string | null> {
      const [tenant, name] = readRef(ref)
      const row = await withSystem(host, tenant, (db) =>
        (db as unknown as { flowCredential: CredentialTable }).flowCredential.findFirst({ where: { name }, select: { secret: true } }))
      return row?.secret ?? null
    },
  }
}

// ─── the port ────────────────────────────────────────────────────────────────

/**
 * `credentialsOf` answers, for a run's actor, the system client its tenant's
 * credentials are read through and the tenant it is.
 */
export function conduitOutbound(opts: {
  conduit:       ConduitLike
  credentialsOf: (actor: unknown) => { db: { flowCredential: CredentialTable }; tenant: string | null }
}): IOutbound {
  const { conduit } = opts
  const registered = new Map<string, string>()   // target id → the updatedAt it was registered at

  async function targetFor(actor: unknown, name: string): Promise<string> {
    const { db, tenant } = opts.credentialsOf(actor)
    const row = await db.flowCredential.findFirst({
      where:  { name },
      select: { name: true, address: true, auth: true, header: true, encoding: true, updatedAt: true },
    })
    if (!row) throw new UnknownCredentialError(name)

    const id = tenant === null ? `orion:${row.name}` : `orion:${Buffer.from(tenant).toString("base64url")}:${row.name}`
    if (registered.get(id) !== row.updatedAt) {
      await conduit.register({
        id,
        kind:     "provider",
        protocol: "http",
        address:  row.address,
        auth:     authFor(row, refFor(tenant, row.name)),
        encoding: row.encoding ?? "json",
      })
      registered.set(id, row.updatedAt)
    }
    return id
  }

  return {
    async send(actor, req): Promise<OutboundResponse> {
      const target = await targetFor(actor, req.credential)
      const res = await conduit.send({
        target,
        method:          req.method,
        path:            req.path,
        query:           req.query,
        headers:         req.headers,
        body:            req.body,
        idempotency_key: req.idempotencyKey,
      })
      // The target answering, even with a refusal, is an answer the flow can
      // branch on. Only a call that got no answer fails the node.
      if (res.meta.status !== undefined) {
        return { status: res.meta.status, headers: res.meta.headers ?? {}, body: res.error ? res.error.raw ?? null : res.data }
      }
      throw new Error(`${res.error?.kind ?? "failed"}: ${res.error?.message ?? "no response"}`)
    },
  }
}

function authFor(row: CredentialRow, ref: string) {
  switch (row.auth) {
    case "bearer":  return { type: "bearer", ref }
    case "api_key": return { type: "api_key", ref, header: row.header ?? "x-api-key" }
    case "hmac":    return { type: "hmac", ref, ...(row.header ? { header_prefix: row.header } : {}) }
    default:        return { type: "none" }
  }
}
