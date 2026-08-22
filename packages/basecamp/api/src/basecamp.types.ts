// src/basecamp.types.ts
// Extends Junction's App interface with Basecamp-specific subsystems.
// app.conduit is typed via @frontierjs/conduit's module augmentation.
// app.jobs   is typed via @frontierjs/caravan's duck-typed CaravanInstance.

import type { App, DatabaseClient, ILogger } from '@frontierjs/junction'
import type { BasecampDb } from './core/db.ts'
import type { CaravanInstance } from '@frontierjs/caravan'

// ─── Basecamp infra interfaces ─────────────────────────────────────────────────
// Junction covers: cache, events, scheduler, workers, filestorage, mail, ai
// Basecamp adds 8 more infrastructure-control-plane-specific services.
// (IQueue is gone — replaced by app.jobs via Caravan)

export interface ISecrets {
  get(key: string):                Promise<string | null>
  set(key: string, value: string): Promise<void>
  delete(key: string):             Promise<void>
  list(prefix?: string):           Promise<string[]>
}

export interface IFlags {
  isEnabled(flag: string, context?: Record<string, unknown>): Promise<boolean>
  getVariant(flag: string): Promise<unknown>
}

export interface ISearch {
  index(collection: string, doc: Record<string, unknown>):                    Promise<void>
  bulkIndex(collection: string, docs: Record<string, unknown>[]):             Promise<void>
  search(collection: string, query: string, opts?: Record<string, unknown>):  Promise<unknown[]>
  delete(collection: string, id: string):                                     Promise<void>
  createCollection(name: string, schema: Record<string, unknown>):            Promise<void>
}

export interface IRegistry {
  listRepositories():                                  Promise<{ name: string; description?: string }[]>
  listTags(repo: string):                              Promise<string[]>
  imageExists(repo: string, tag: string):              Promise<boolean>
  deleteTag(repo: string, tag: string):                Promise<void>
}

export interface IGit {
  createRepo(name: string, opts?: { description?: string; private?: boolean }): Promise<{ id: number; clone_url: string }>
  deleteRepo(name: string):                             Promise<void>
  listRepos():                                          Promise<{ name: string; clone_url: string }[]>
  createWebhook(repo: string, url: string, events: string[]): Promise<{ id: number }>
}

export interface IObservability {
  pushMetric(name: string, value: number, labels?: Record<string, string>): Promise<void>
  queryLogs(query: string, from: Date, to: Date):     Promise<unknown[]>
  queryMetrics(query: string, from: Date, to: Date):  Promise<unknown[]>
}

export interface INetworking {
  createPeer(name: string, setupKey: string):          Promise<{ id: string; ip: string }>
  deletePeer(peerId: string):                          Promise<void>
  listPeers():                                         Promise<{ id: string; name: string; ip: string; connected: boolean }[]>
  createPolicy(name: string, sources: string[], destinations: string[]): Promise<{ id: string }>
}

export interface IIntegrations {
  getToken(provider: string, connectionId: string):   Promise<string>
  listConnections(provider?: string):                 Promise<{ id: string; provider: string }[]>
  deleteConnection(connectionId: string):             Promise<void>
  request(provider: string, connectionId: string, opts: {
    method: string; endpoint: string; body?: unknown
  }): Promise<unknown>
}

// ─── Infra container ──────────────────────────────────────────────────────

export interface BasecampInfra {
  secrets:       ISecrets
  flags:         IFlags
  search:        ISearch
  registry:      IRegistry
  git:           IGit
  observability: IObservability
  networking:    INetworking
  integrations:  IIntegrations
}

// ─── BasecampApp ───────────────────────────────────────────────────────────────
// Junction App + Basecamp extensions.
// app.conduit is added by @frontierjs/conduit's module augmentation.
// app.jobs    is added explicitly here (Caravan uses duck-typing).

export interface BasecampApp extends App {
  db:     DatabaseClient       // Junction's database client (db.db = raw bun:sqlite)
  // THE Data boundary — the Litestone client. Services normally use the
  // caller-scoped copy on ctx.locals.db; `app.data` is the unscoped root, for
  // jobs and for the outpost paths that have no session to scope to.
  data:   BasecampDb
  infra:  BasecampInfra
  logger: ILogger
  jobs:   CaravanInstance      // durable job queue — replaces IQueue stub
}
