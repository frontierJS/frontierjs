// src/basecamp.types.ts
// The provider interfaces, and the slots this app adds to junction's App.

import type { BasecampDb } from './core/db.ts'
import type { Workbench }  from './core/workbench.ts'

// ─── Provider interfaces ──────────────────────────────────────────────────────
// Junction covers: cache, events, scheduler, workers, mail, ai
// Basecamp speaks to 10 more, each a party outside the app in the sense
// FJS-D06 rules the word. Eight are self-hosted appliances; two are somebody
// else's service, and the split matters for one reason — an appliance is
// something an operator installs and can be pointed at, a hosted service is an
// account with a bill, so *unconfigured* means different work.
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

/**
 * The git host.
 *
 * `listRepos` answers more than a name and a clone URL, and that is the
 * difference between an interface a screen can render and one it cannot: open
 * pull requests, the branch's CI verdict and open issues are three separate
 * calls at every host that has them, so a repository record that does not carry
 * them makes /git-activity/ a table of names. `ci` is a VERDICT and not a
 * status string — `unknown` is what a host with no CI answers, and it is not
 * the same as `pending`.
 */
export interface IGit {
  createRepo(name: string, opts?: { description?: string; private?: boolean }): Promise<{ id: number; clone_url: string }>
  deleteRepo(name: string):                             Promise<void>
  listRepos():                                          Promise<GitRepo[]>
  listPullRequests(repo: string):                       Promise<GitPullRequest[]>
  createWebhook(repo: string, url: string, events: string[]): Promise<{ id: number }>
}

export type CiVerdict = 'passing' | 'failing' | 'pending' | 'unknown'

export interface GitRepo {
  name:            string
  clone_url:       string
  description?:    string
  defaultBranch?:  string
  ci:              CiVerdict
  openPullRequests: number
  openIssues:      number
  lastPushedAt?:   string
}

export interface GitPullRequest {
  number:     number
  title:      string
  author:     string
  branch:     string
  ci:         CiVerdict
  mergeable:  boolean
  openedAt:   string
}

export interface IObservability {
  pushMetric(name: string, value: number, labels?: Record<string, string>): Promise<void>
  queryLogs(query: string, from: Date, to: Date):     Promise<unknown[]>
  queryMetrics(query: string, from: Date, to: Date):  Promise<unknown[]>
}

// A zone and a record are the connector's shapes, declared once at its
// boundary. The edge is not in `BasecampProviders`: it is a workspace ACCOUNT
// (`FJS-D558`), read by `services/edge/`.
import type { EdgeZone, EdgeRecord } from './providers/edge/index.ts'
export type { EdgeZone, EdgeRecord }

/**
 * What the cloud is charging.
 *
 * **Money is minor units plus a currency**, never a float and never a symbol —
 * the same rule `@money` holds at the Data boundary, for the same reason: a
 * divisor of 100 is right for the dollar, wrong for the yen and wrong for the
 * dinar (`@frontierjs/toolbelt/units`). `forServer` takes the
 * `providerServerId` this app already records, which is the only key the two
 * sides share — there is no row of ours in the vendor's ledger.
 */
export interface ICloudSpend {
  monthToDate():                          Promise<SpendPeriod>
  lineItems():                            Promise<SpendLine[]>
  forServer(providerServerId: string):    Promise<SpendLine | null>
}

export interface SpendPeriod {
  currency:        string
  amountMinor:     number
  projectedMinor?: number
  from:            string
  to:              string
}

export interface SpendLine {
  kind:        string      // droplets · backups · volumes · addresses · snapshots
  label:       string
  currency:    string
  amountMinor: number
  detail?:     string
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

// ─── Provider container ───────────────────────────────────────────────────

export interface BasecampProviders {
  secrets:       ISecrets
  flags:         IFlags
  search:        ISearch
  registry:      IRegistry
  git:           IGit
  observability: IObservability
  networking:    INetworking
  integrations:  IIntegrations
  cloudSpend:    ICloudSpend
}

// ─── The app ──────────────────────────────────────────────────────────────────
// Every slot is typed by augmenting junction's exported interfaces, never by a
// second interface that redeclares a field (Invariant 5 — declaration merging
// requires identical types, so a redeclaration silently loses). A service holds
// no app of its own and reads `ctx.app` / `$.app`, which is junction's `App`,
// so a slot typed anywhere else is a slot those reads cannot see.
//
// `app.conduit` and `app.jobs` are typed by @frontierjs/conduit's and
// @frontierjs/caravan's own augmentations. `app.db` is the Litestone client
// createApp was given; services use the caller-scoped copy (`$.db`), and
// `app.db` is the unscoped root, for jobs and the outpost paths that have no
// session to scope to. Junction types `db` optional because it runs without
// one; this app never does, so a reader asserts it with `!`.
declare module '@frontierjs/junction' {
  interface AppDb extends BasecampDb {}
  interface App {
    // The raw bun:sqlite handle, for the two callers that want a Database and
    // not an ORM.
    sqlite:    import('bun:sqlite').Database
    providers: BasecampProviders
    workbench: Workbench
  }
}
