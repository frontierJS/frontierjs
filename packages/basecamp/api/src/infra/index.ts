// src/infra/index.ts
// Basecamp infrastructure adapters — the 8 services beyond Junction's built-ins.
// (IQueue is gone — replaced by @frontierjs/caravan via app.jobs)
//
// Each adapter defaults to a Stub when the matching env var is not set.
// Swap in the real adapter by setting the env var — zero service code changes.

import type {
  BasecampInfra,
  ISecrets, IFlags, ISearch,
  IRegistry, IGit, IObservability, INetworking, IIntegrations
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
  async listRepos()               { stubWarn('Git', 'listRepos'); return [] }
  async createWebhook()           { stubWarn('Git', 'createWebhook'); return { id: 0 } }
}

// ── Observability ─────────────────────────────────────────────────────────
class StubObservability implements IObservability {
  async pushMetric() { /* silent — metrics fire frequently */ }
  async queryLogs()    { stubWarn('Observability', 'queryLogs');    return [] }
  async queryMetrics() { stubWarn('Observability', 'queryMetrics'); return [] }
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

export async function buildInfra(
  cfg: Record<string, Record<string, unknown>>
): Promise<BasecampInfra> {

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

  return { secrets, flags, search, registry, git, observability, networking, integrations }
}
