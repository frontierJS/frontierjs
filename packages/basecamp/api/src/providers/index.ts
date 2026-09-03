// src/providers/index.ts
// The parties this app speaks to — the 10 beyond Junction's built-ins. Eight
// are self-hosted appliances; `edge` and `cloudSpend` are somebody else's
// service, which changes nothing here and one thing for an operator: an
// appliance is installed and pointed at, a hosted service is an account with a
// bill behind it. (IQueue is gone — replaced by @frontierjs/caravan via app.jobs)
//
// They live under `providers/` because that is what FJS-D06 rules the word to
// mean: a party outside the app that a capability speaks to. Infisical, Unleash
// and Typesense are parties in exactly the sense Hetzner and GitHub are, and
// `executor.ts` and `outpost.ts` beside this file are the fleet's own.
//
// Each defaults to a Stub when the matching env var is not set. Swap in the
// real one by setting the env var — zero service code changes.

import type {
  BasecampProviders,
  ISecrets, IFlags, ISearch,
  IRegistry, IGit, IObservability, INetworking, IIntegrations,
  IEdge, ICloudSpend, GitRepo, GitPullRequest,
  EdgeZone, EdgeRecord, EdgeAnalytics, SpendPeriod, SpendLine
} from '../basecamp.types.ts'

// ─── Stub helpers ────────────────────────────────────────────────────────

function stubWarn(service: string, method: string): void {
  console.warn(`[Basecamp] ${service}.${method}() called on stub — set ${service.toUpperCase()}_URL to enable`)
}

// ── Secrets ───────────────────────────────────────────────────────────────
class StubSecrets implements ISecrets {
  private store = new Map<string, string>()
  async get(key: string)                { return this.store.get(key) ?? null }
  async set(key: string, value: string) { this.store.set(key, value) }
  async delete(key: string)             { this.store.delete(key) }
  async list(prefix = '')               { return [...this.store.keys()].filter(k => k.startsWith(prefix)) }
}

// ── Feature Flags ─────────────────────────────────────────────────────────
class StubFlags implements IFlags {
  async isEnabled(flag: string) { stubWarn('Flags', `isEnabled(${flag})`); return false }
  async getVariant(flag: string){ stubWarn('Flags', `getVariant(${flag})`); return null }
}

// ── Search ────────────────────────────────────────────────────────────────
class StubSearch implements ISearch {
  private store = new Map<string, Record<string, unknown>[]>()
  async index(collection: string, doc: Record<string, unknown>) {
    const c = this.store.get(collection) ?? []
    c.push(doc)
    this.store.set(collection, c)
  }
  async bulkIndex(collection: string, docs: Record<string, unknown>[]) {
    for (const doc of docs) await this.index(collection, doc)
  }
  async search(collection: string, query: string) {
    const q = query.toLowerCase()
    return (this.store.get(collection) ?? []).filter(doc =>
      JSON.stringify(doc).toLowerCase().includes(q)
    )
  }
  async delete(collection: string, id: string) {
    const c = this.store.get(collection) ?? []
    this.store.set(collection, c.filter(d => d.id !== id))
  }
  async createCollection(name: string) {
    if (!this.store.has(name)) this.store.set(name, [])
  }
}

// ── Registry ──────────────────────────────────────────────────────────────
class StubRegistry implements IRegistry {
  async listRepositories()               { stubWarn('Registry', 'listRepositories'); return [] }
  async listTags(repo: string)           { stubWarn('Registry', `listTags(${repo})`); return [] }
  async imageExists()                    { return false }
  async deleteTag(repo: string, tag: string) { stubWarn('Registry', `deleteTag(${repo}:${tag})`) }
}

// ── Git ───────────────────────────────────────────────────────────────────
class StubGit implements IGit {
  async createRepo(name: string)  { stubWarn('Git', `createRepo(${name})`); return { id: 0, clone_url: '' } }
  async deleteRepo(name: string)  { stubWarn('Git', `deleteRepo(${name})`) }
  async listRepos(): Promise<GitRepo[]> { stubWarn('Git', 'listRepos'); return [] }
  async listPullRequests(repo: string): Promise<GitPullRequest[]> {
    stubWarn('Git', `listPullRequests(${repo})`); return []
  }
  async createWebhook()           { stubWarn('Git', 'createWebhook'); return { id: 0 } }
}

// ── Observability ─────────────────────────────────────────────────────────
class StubObservability implements IObservability {
  async pushMetric() { /* silent — metrics fire frequently */ }
  async queryLogs()    { stubWarn('Observability', 'queryLogs');    return [] }
  async queryMetrics() { stubWarn('Observability', 'queryMetrics'); return [] }
}

// ── Edge (DNS, TLS termination) ───────────────────────────────────────────
// Empty answers, never invented ones. A stub that returned a plausible zone
// would put a hostname on /dns/ that this app cannot reach and nobody owns.
class StubEdge implements IEdge {
  async listZones(): Promise<EdgeZone[]>   { stubWarn('Edge', 'listZones');   return [] }
  async listRecords(zoneId: string): Promise<EdgeRecord[]> {
    stubWarn('Edge', `listRecords(${zoneId})`); return []
  }
  async analytics(zoneId: string): Promise<EdgeAnalytics> {
    stubWarn('Edge', `analytics(${zoneId})`)
    // Zeroes are a lie of a different kind — "no requests" reads as an outage.
    // The screen asks whether the adapter is configured BEFORE it asks this,
    // so nothing renders these; they exist because the signature must return.
    return { requests: 0, cached: 0, bandwidthBytes: 0, threats: 0 }
  }
}

// ── Cloud spend ───────────────────────────────────────────────────────────
class StubCloudSpend implements ICloudSpend {
  async monthToDate(): Promise<SpendPeriod> {
    stubWarn('CloudSpend', 'monthToDate')
    return { currency: 'USD', amountMinor: 0, from: '', to: '' }
  }
  async lineItems(): Promise<SpendLine[]> { stubWarn('CloudSpend', 'lineItems'); return [] }
  async forServer(id: string): Promise<SpendLine | null> {
    stubWarn('CloudSpend', `forServer(${id})`); return null
  }
}

// ── Networking ────────────────────────────────────────────────────────────
class StubNetworking implements INetworking {
  async createPeer(name: string) { stubWarn('Networking', `createPeer(${name})`); return { id: '', ip: '' } }
  async deletePeer(id: string)   { stubWarn('Networking', `deletePeer(${id})`) }
  async listPeers()              { stubWarn('Networking', 'listPeers'); return [] }
  async createPolicy(name: string) { stubWarn('Networking', `createPolicy(${name})`); return { id: '' } }
}

// ── Integrations ──────────────────────────────────────────────────────────
class StubIntegrations implements IIntegrations {
  async getToken(provider: string)       { stubWarn('Integrations', `getToken(${provider})`);  return '' }
  async listConnections()                { stubWarn('Integrations', 'listConnections'); return [] }
  async deleteConnection(id: string)     { stubWarn('Integrations', `deleteConnection(${id})`) }
  async request(provider: string)        { stubWarn('Integrations', `request(${provider})`);   return null }
}

// ─── Factory ─────────────────────────────────────────────────────────────

export async function buildProviders(
  cfg: Record<string, Record<string, unknown>>
): Promise<BasecampProviders> {

  // TODO: if (cfg.secrets?.url) → import('./adapters/infisical').then(...)
  const secrets: ISecrets = new StubSecrets()

  // TODO: if (cfg.flags?.url) → UnleashFlags(cfg.flags)
  const flags: IFlags = new StubFlags()

  // TODO: if (cfg.search?.url) → TypesenseSearch(cfg.search)
  const search: ISearch = new StubSearch()

  // TODO: if (cfg.registry?.url) → ZotRegistry(cfg.registry)
  const registry: IRegistry = new StubRegistry()

  // TODO: if (cfg.git?.url) → ForgejoGit(cfg.git)
  const git: IGit = new StubGit()

  // TODO: if (cfg.observability?.grafana_url) → GrafanaObservability(...)
  const observability: IObservability = new StubObservability()

  // TODO: if (cfg.networking?.url) → NetBirdNetworking(cfg.networking)
  const networking: INetworking = new StubNetworking()

  // TODO: if (cfg.integrations?.nango_url) → NangoIntegrations(...)
  const integrations: IIntegrations = new StubIntegrations()

  // The two that are somebody else's service rather than an appliance. Both
  // are a `@frontierjs/conduit` target when they land — a declared target with
  // its token held as a `Secret`, never a `fetch()` in a service.
  // TODO: if (cfg.edge?.api_token) → CloudflareEdge(cfg.edge)
  const edge: IEdge = new StubEdge()

  // TODO: if (cfg.cloud_spend?.api_token) → DigitalOceanSpend(cfg.cloud_spend)
  const cloudSpend: ICloudSpend = new StubCloudSpend()

  return {
    secrets, flags, search, registry, git, observability, networking, integrations,
    edge, cloudSpend,
  }
}
