// ─────────────────────────────────────────────
// ENGINE PORTS
// What the node implementations need from outside the engine, as interfaces.
// The engine imports no framework package; the host supplies these — a model-
// backed key-value store and the app's AI adapters.
// ─────────────────────────────────────────────

// ─── store node ────────────────────────────────

// `scope` is `global`, `flow:<flowId>` or `run:<runId>` (`FJS-D281`). Tenancy
// is the host's, and it reaches the rows through the actor: `global` is global
// to a tenant, never across them.
export interface IKeyValueStore {
  get    (actor: unknown, scope: string, key: string): Promise<unknown | undefined>
  set    (actor: unknown, scope: string, key: string, value: unknown, ttlMs?: number): Promise<void>
  delete (actor: unknown, scope: string, key: string): Promise<boolean>
}

// ─── model and service nodes ──────────────────
// The actor is whatever the host put on the run — the engine never looks inside
// it. A host that grades access at its Data boundary hands in a principal-scoped
// client, so a node is refused by the same gate a request would be.

export type ModelWrite = Record<string, unknown>

export interface IModelActions {
  create (actor: unknown, model: string, data: ModelWrite): Promise<unknown>
  patch  (actor: unknown, model: string, id: unknown, data: ModelWrite): Promise<unknown>
  remove (actor: unknown, model: string, id: unknown): Promise<unknown>
}

export interface IServiceCaller {
  call(actor: unknown, service: string, method: string, input: { id?: unknown; data?: unknown; query?: unknown }): Promise<unknown>
}

// What the compiler checks a model node against at author time: the fields a
// write may name, per mode. Undefined for a model the host does not have.
export interface IModelCatalog {
  fields(model: string, mode: "create" | "update"): ReadonlySet<string> | undefined
}

// ─── job.dispatch and notify ──────────────────
// A flow reaches any job the app registers and any notification it declares
// (`FJS-D290`, `FJS-D291`); what grades the work is the handler, running as the
// actor.

// Orion's own jobs — a run, the sweep, a cron fire. Dispatching one from a flow
// would run a run beside its own job, so no flow may name one.
export const RESERVED_JOB_PREFIX = "orion."

export interface IJobDispatcher {
  /** `id` makes the dispatch idempotent: a stage run again queues nothing new. */
  dispatch(actor: unknown, job: string, data: unknown, opts: { id: string }): Promise<string>
}

export interface Recipient {
  id?:    string | number
  email?: string
  [key: string]: unknown
}

export interface INotifier {
  notify(actor: unknown, notification: string, recipient: Recipient, payload: unknown): Promise<void>
}

// The names a host declares, asked when a flow compiles.
export interface INameCatalog {
  names(): readonly string[]
}

// Everything the compiler types a flow against. Each part absent means the host
// has nothing to check that node against, and the run is the only check.
export interface HostCatalog {
  models?:        IModelCatalog
  jobs?:          INameCatalog
  notifications?: INameCatalog
}

// ─── http.request ──────────────────────────────
// Every outbound call goes through a target a credential registers, and a
// public URL is a credential with no auth (`FJS-D273`), so a request names a
// credential and a path — never a URL of its own.

export interface OutboundRequest {
  credential:     string
  method:         string
  path:           string
  query?:         Record<string, unknown>
  headers?:       Record<string, string>
  body?:          unknown
  // Stable across a crash's re-run of the stage, so the target can collapse
  // the second send: run id, node id, attempt.
  idempotencyKey: string
}

export interface OutboundResponse {
  status:  number
  headers: Record<string, string>
  body:    unknown
}

export interface IOutbound {
  send(actor: unknown, req: OutboundRequest): Promise<OutboundResponse>
}

// ─── ai node ───────────────────────────────────
// The app's own models, by name — `IAIModel` in junction's shape. Vendor code is
// the app's (`FJS-D153`), so orion knows a message list and nothing about who
// answers it.

export interface AIMessage {
  role:    "user" | "assistant" | "system"
  content: string
}

export interface AIRequest {
  messages:     AIMessage[]
  system?:      string
  maxTokens?:   number
  temperature?: number
}

export interface AIResponse {
  content:       string
  model:         string
  inputTokens?:  number
  outputTokens?: number
}

export interface IAIModels {
  complete(actor: unknown, model: string, req: AIRequest): Promise<AIResponse>
}
