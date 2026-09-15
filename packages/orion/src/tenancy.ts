/*
 * tenancy.ts
 *
 * Which database a run's rows are in (`FJS-D294`). Orion's models are the
 * host's, so they are tenanted the way the host's are, and the runner asks this
 * port rather than holding a client:
 *
 *   open(tenant)   orion's system client for one tenant, leased until released
 *   tenants()      every tenant the walks visit — the activation poll, the sweep
 *
 * `litestoneHost` answers it for the three shapes a Litestone host has:
 *
 *   no tenancy          one client; the only tenant is null
 *   strategy database   a tenant is a file: the registry's client, leased from
 *                       its pool for as long as the work runs
 *   strategy row        one file: the system client scoped by the tenant claim,
 *                       which filters every read and stamps every create; the
 *                       tenants are the values on the Flow rows
 *
 * A tenant travels with a run's JOB, which Caravan re-enters; with a resume key,
 * which is the one thing that reaches orion with nothing else attached; and with
 * every activation, so a trigger starts its flow in the flow's own tenant.
 */

import type { OrionSystemClient } from "./store"

export interface OrionHost {
  open(tenant: string | null): Promise<{ db: OrionSystemClient; release(): void }>
  tenants(): Promise<Array<string | null>>
}

/** Runs `fn` with a tenant's system client, releasing it however `fn` ends. */
export async function withSystem<T>(host: OrionHost, tenant: string | null, fn: (db: OrionSystemClient) => Promise<T>): Promise<T> {
  const { db, release } = await host.open(tenant)
  try { return await fn(db) } finally { release() }
}

interface LitestoneLike {
  asSystem(): OrionSystemClient
  $setAuth(principal: object): { asSystem(): OrionSystemClient }
  $tenancy?: { strategy?: string; column?: string; claim?: string } | null
}

interface RegistryLike {
  get(id: string): Promise<LitestoneLike>
  list(): string[] | Promise<string[]>
  retain?(id: string): () => void
}

export class TenantRequiredError extends Error {
  constructor(what: string) {
    super(`This host is tenanted, and ${what} named no tenant`)
    this.name = "TenantRequiredError"
  }
}

export function litestoneHost(source: { db: unknown } | { registry: unknown }): OrionHost {
  if ("registry" in source) {
    const registry = source.registry as RegistryLike
    return {
      async open(tenant) {
        if (tenant === null) throw new TenantRequiredError("the work")
        const client  = await registry.get(tenant)
        const release = registry.retain?.(tenant) ?? (() => {})
        return { db: client.asSystem(), release }
      },
      async tenants() { return [...await registry.list()] },
    }
  }

  const db = source.db as LitestoneLike
  let tenancy: LitestoneLike["$tenancy"] = null
  try { tenancy = db.$tenancy } catch { /* a client with no tenancy declares none */ }

  if (tenancy?.strategy === "row") {
    const { column, claim } = tenancy as { column: string; claim: string }
    return {
      async open(tenant) {
        if (tenant === null) throw new TenantRequiredError("the work")
        return { db: db.$setAuth({ [claim]: tenant }).asSystem(), release: () => {} }
      },
      // A tenant with no flow has nothing for a walk to visit.
      async tenants() {
        const rows = await db.asSystem().flow.findMany({ select: { [column]: true } })
        return [...new Set(rows.map(r => r[column]).filter(v => v != null).map(String))]
      },
    }
  }

  const system = db.asSystem()
  return {
    async open() { return { db: system, release: () => {} } },
    async tenants() { return [null] },
  }
}

// ─── resume keys ─────────────────────────────────────────────────────────────

// A resume arrives as a key and nothing else, so a tenanted key says whose run
// it resumes. The tenant is readable in the key; the 32 random bytes after it
// are what make the key a credential.
const SEPARATOR = "~"

export function tagKey(tenant: string | null, key: string): string {
  if (tenant === null || key.includes(SEPARATOR)) return key
  return `${Buffer.from(tenant, "utf8").toString("base64url")}${SEPARATOR}${key}`
}

export function tenantOfKey(key: string): string | null {
  const at = key.indexOf(SEPARATOR)
  return at === -1 ? null : Buffer.from(key.slice(0, at), "base64url").toString("utf8")
}
