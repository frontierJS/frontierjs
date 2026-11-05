// @frontierjs/conduit-n8n — n8n over conduit.
//
// n8n is TWO listeners on one origin. The public API (`/api/v1`, header
// `X-N8N-API-KEY`) reads and writes workflows and executions; the webhook
// listener (`/webhook/<path>`, `/webhook-test/<path>`) starts an ACTIVE
// workflow and carries no API key, only what that workflow's Webhook node
// asks for (nothing, or a header the app chose). So the builder returns two
// descriptors — `api` and `hook` — and every call picks its own (CONTRACT
// C1, the bundle). There is no vendor address: n8n is self-hosted or a
// per-tenant cloud subdomain, and the builder refuses to guess one.
//
// Where an app only needs to tell n8n something happened, junction's
// `plugins/webhooks` is the tool — signed, retried, a subscription row n8n
// owns. This connector is for the other direction: an app that READS n8n
// (which workflows exist, did the run land) or starts one and wants the
// reply. `FJS-D1489`.

import type { ConduitRequest, ConduitResult, TargetDescriptor } from '@frontierjs/conduit'
import { translate, type N8nFailure } from './errors.ts'
import { MAX_LIMIT, MAX_TAG_NAME, N8N_TARGET, UNSETTLED, type ExecutionFilter, type N8nExecution, type N8nPage, type N8nStoppedExecution, type N8nTag, type N8nWorkflow, type N8nWorkflowDefinition, type TriggerResult, type WorkflowFilter } from './types.ts'

export * from './types.ts'
export * from './errors.ts'

export type Send = <T>(req: Omit<ConduitRequest, 'target'>) => Promise<ConduitResult<T>>
/** One Send per listener. Every call below takes the bundle and picks. */
export interface N8nSend { api: Send; hook: Send }
export interface N8nTargets { api: TargetDescriptor; hook: TargetDescriptor }

export interface N8nTargetOptions {
  /** The instance: `https://n8n.example.com` or `https://<sub>.app.n8n.cloud`. Required; there is no default. */
  address: string
  /** Credential ref for the API key. Default `N8N_API_KEY`, the spelling junction's `attachments` names. */
  ref?:    string
  id?:     string
  /**
   * What the Webhook nodes this app triggers were set to ask for. Absent is
   * *None*; `{ header, ref }` is n8n's *Header Auth*, the header name the
   * credential was given in the editor and the ref holding its value;
   * `{ basic: ref }` is *Basic Auth*, the ref holding `user:password`. JWT
   * Auth is not built: no caller yet.
   */
  hook?:   { header: string; ref: string } | { basic: string }
}

const hookAuth = (hook: N8nTargetOptions['hook']): TargetDescriptor['auth'] =>
  !hook ? { type: 'none' }
  : 'basic' in hook ? { type: 'signed', signer: 'basic', ref: hook.basic }
  : { type: 'api_key', ref: hook.ref, header: hook.header }

/**
 * One set per INSTANCE: an n8n API key reaches every workflow on its
 * instance, so the credential is the deployment's (`provider:n8n`), and a
 * second instance is a second set under its own `id`.
 */
export function n8nTargets(opts: N8nTargetOptions): N8nTargets {
  if (!opts?.address) throw new Error('conduit-n8n: `address` is required — n8n has no vendor address, every instance is its own')
  const id = opts.id ?? N8N_TARGET
  const address = opts.address.replace(/\/+$/, '')
  const base = { kind: 'provider', protocol: 'http', address, registered_at: Date.now(), last_seen_at: null } as const
  return {
    api:  { ...base, id, auth: { type: 'api_key', ref: opts.ref ?? 'N8N_API_KEY', header: 'X-N8N-API-KEY' } },
    hook: { ...base, id: `${id}:hook`, auth: hookAuth(opts.hook) },
  }
}

export function bindN8n(conduit: { send<T>(req: ConduitRequest): Promise<ConduitResult<T>> }, targets: N8nTargets): N8nSend {
  return {
    api:  req => conduit.send({ target: targets.api.id, ...req }),
    hook: req => conduit.send({ target: targets.hook.id, ...req }),
  }
}

type Outcome<T> = { result?: T; error?: N8nFailure }
const refuse = (message: string): { error: N8nFailure } => ({ error: { kind: 'refused', message, retryable: false } })
const out = <T>(r: ConduitResult<T>): Outcome<T> => r.error ? { error: translate(r.error, r.meta.status) } : { result: r.data }
const API = '/api/v1'

const pageQuery = (f: { limit?: number; cursor?: string }) => ({ ...(f.limit !== undefined ? { limit: f.limit } : {}), ...(f.cursor ? { cursor: f.cursor } : {}) })
const checkLimit = (limit?: number) => limit !== undefined && (limit < 1 || limit > MAX_LIMIT || !Number.isInteger(limit))
  ? refuse(`limit is 1..${MAX_LIMIT}; n8n answers 400 above it`) : null

// ── workflows ────────────────────────────────────────────────────────────────

export async function workflows(send: N8nSend, filter: WorkflowFilter = {}): Promise<Outcome<N8nPage<N8nWorkflow>>> {
  const bad = checkLimit(filter.limit); if (bad) return bad
  const query = { ...pageQuery(filter), ...(filter.active !== undefined ? { active: String(filter.active) } : {}), ...(filter.name ? { name: filter.name } : {}), ...(filter.tags?.length ? { tags: filter.tags.join(',') } : {}) }
  return out(await send.api<N8nPage<N8nWorkflow>>({ method: 'GET', path: `${API}/workflows`, query }))
}

/** Every page by cursor until none; `cap` bounds the walk. */
export async function allWorkflows(send: N8nSend, filter: Omit<WorkflowFilter, 'cursor'> = {}, opts: { cap?: number } = {}): Promise<Outcome<N8nWorkflow[]>> {
  const cap = opts.cap ?? 100
  const rows: N8nWorkflow[] = []
  let cursor: string | undefined
  for (let page = 0; page < cap; page++) {
    const r = await workflows(send, { ...filter, cursor })
    if (r.error) return { error: r.error }
    rows.push(...r.result!.data)
    if (!r.result!.nextCursor) return { result: rows }
    cursor = r.result!.nextCursor
  }
  return refuse(`still paging after ${cap} pages`)
}

export async function workflow(send: N8nSend, id: string): Promise<Outcome<N8nWorkflow>> {
  if (!id) return refuse('a workflow id is required')
  return out(await send.api<N8nWorkflow>({ method: 'GET', path: `${API}/workflows/${encodeURIComponent(id)}` }))
}

const checkDefinition = (def: N8nWorkflowDefinition) =>
  !def?.name?.trim() ? refuse('a workflow needs a name')
  : !Array.isArray(def.nodes) ? refuse('`nodes` is an array, empty is allowed')
  : !def.connections || typeof def.connections !== 'object' ? refuse('`connections` is an object, `{}` is allowed')
  : null

const definitionBody = (def: N8nWorkflowDefinition) => ({ name: def.name, nodes: def.nodes, connections: def.connections, settings: def.settings ?? {}, ...(def.staticData !== undefined ? { staticData: def.staticData } : {}) })

/**
 * Unkeyed and unreplayable (C5): n8n collapses nothing, and two creates are
 * two workflows with one name. A lost response is resolved by
 * `workflows(send, { name })` (C6).
 */
export async function createWorkflow(send: N8nSend, def: N8nWorkflowDefinition): Promise<Outcome<N8nWorkflow>> {
  const bad = checkDefinition(def); if (bad) return bad
  return out(await send.api<N8nWorkflow>({ method: 'POST', path: `${API}/workflows`, body: definitionBody(def) }))
}

/** PUT replaces the whole definition; `active` and tags are not part of it and stay. */
export async function updateWorkflow(send: N8nSend, id: string, def: N8nWorkflowDefinition): Promise<Outcome<N8nWorkflow>> {
  if (!id) return refuse('a workflow id is required')
  const bad = checkDefinition(def); if (bad) return bad
  return out(await send.api<N8nWorkflow>({ method: 'PUT', path: `${API}/workflows/${encodeURIComponent(id)}`, body: definitionBody(def) }))
}

export async function deleteWorkflow(send: N8nSend, id: string): Promise<Outcome<N8nWorkflow>> {
  if (!id) return refuse('a workflow id is required')
  return out(await send.api<N8nWorkflow>({ method: 'DELETE', path: `${API}/workflows/${encodeURIComponent(id)}` }))
}

/**
 * A POST that moves a flag to a state: activating an active workflow answers
 * the workflow unchanged, so it is `replayable: true` and conduit retries a
 * lost response itself. The refusal that matters is `no_trigger`.
 */
export async function activate(send: N8nSend, id: string): Promise<Outcome<N8nWorkflow>> {
  if (!id) return refuse('a workflow id is required')
  return out(await send.api<N8nWorkflow>({ method: 'POST', path: `${API}/workflows/${encodeURIComponent(id)}/activate`, replayable: true }))
}

export async function deactivate(send: N8nSend, id: string): Promise<Outcome<N8nWorkflow>> {
  if (!id) return refuse('a workflow id is required')
  return out(await send.api<N8nWorkflow>({ method: 'POST', path: `${API}/workflows/${encodeURIComponent(id)}/deactivate`, replayable: true }))
}

// ── executions ───────────────────────────────────────────────────────────────

export async function executions(send: N8nSend, filter: ExecutionFilter = {}): Promise<Outcome<N8nPage<N8nExecution>>> {
  const bad = checkLimit(filter.limit); if (bad) return bad
  const query = { ...pageQuery(filter), ...(filter.status ? { status: filter.status } : {}), ...(filter.workflowId ? { workflowId: filter.workflowId } : {}), ...(filter.includeData ? { includeData: 'true' } : {}) }
  return out(await send.api<N8nPage<N8nExecution>>({ method: 'GET', path: `${API}/executions`, query }))
}

export async function execution(send: N8nSend, id: string, opts: { includeData?: boolean } = {}): Promise<Outcome<N8nExecution>> {
  if (!id) return refuse('an execution id is required')
  return out(await send.api<N8nExecution>({ method: 'GET', path: `${API}/executions/${encodeURIComponent(id)}`, query: opts.includeData ? { includeData: 'true' } : {} }))
}

export async function deleteExecution(send: N8nSend, id: string): Promise<Outcome<N8nExecution>> {
  if (!id) return refuse('an execution id is required')
  return out(await send.api<N8nExecution>({ method: 'DELETE', path: `${API}/executions/${encodeURIComponent(id)}` }))
}

/**
 * Reads the run until it ends: every status but `new`, `running` and
 * `waiting`. A trigger answers before n8n writes the run, so the id comes from
 * `executions({ workflowId, limit: 1 })`. Past `timeoutMs` it answers
 * `timeout`, retryable, with the status it last read; a Wait node longer than
 * the budget lands there.
 */
export async function waitForExecution(send: N8nSend, id: string, opts: { timeoutMs?: number; intervalMs?: number } = {}): Promise<Outcome<N8nExecution>> {
  if (!id) return refuse('an execution id is required')
  const deadline = Date.now() + (opts.timeoutMs ?? 30_000), every = opts.intervalMs ?? 500
  for (;;) {
    const r = await execution(send, id)
    if (r.error || !UNSETTLED.includes(r.result!.status)) return r
    if (Date.now() + every > deadline) return { error: { kind: 'timeout', retryable: true, message: `execution ${id} is still ${r.result!.status}` } }
    await new Promise(res => setTimeout(res, every))
  }
}

/**
 * Unreplayable, unlike `activate`: a second stop is a 409 `conflict` naming
 * the status, not the run unchanged, so a replay would turn a stop that landed
 * into a failure. A lost response is `indeterminate`; `execution(id)` says.
 * Only a `running` or `waiting` run stops; any other is `conflict`.
 */
export async function stopExecution(send: N8nSend, id: string): Promise<Outcome<N8nStoppedExecution>> {
  if (!id) return refuse('an execution id is required')
  return out(await send.api<N8nStoppedExecution>({ method: 'POST', path: `${API}/executions/${encodeURIComponent(id)}/stop` }))
}

/**
 * Starts a NEW run from the failed one's saved input, `mode: 'retry'`,
 * `retryOf: id`. Unkeyed and unreplayable (C5): retrying one run twice is two
 * runs. A lost response is resolved by `executions({ workflowId })` and a row
 * whose `retryOf` is `id` (C6). A run that succeeded is `conflict`.
 * `loadWorkflow` runs the workflow as saved now, not as it was.
 */
export async function retryExecution(send: N8nSend, id: string, opts: { loadWorkflow?: boolean } = {}): Promise<Outcome<N8nExecution>> {
  if (!id) return refuse('an execution id is required')
  return out(await send.api<N8nExecution>({ method: 'POST', path: `${API}/executions/${encodeURIComponent(id)}/retry`, body: opts.loadWorkflow !== undefined ? { loadWorkflow: opts.loadWorkflow } : {} }))
}

// ── tags ─────────────────────────────────────────────────────────────────────

export async function tags(send: N8nSend, page: { limit?: number; cursor?: string } = {}): Promise<Outcome<N8nPage<N8nTag>>> {
  const bad = checkLimit(page.limit); if (bad) return bad
  return out(await send.api<N8nPage<N8nTag>>({ method: 'GET', path: `${API}/tags`, query: pageQuery(page) }))
}

const checkTagName = (name: string) =>
  !name?.trim() ? refuse('a tag needs a name')
  : name.length > MAX_TAG_NAME ? refuse(`a tag name is at most ${MAX_TAG_NAME} characters; n8n answers a longer one as "Tag already exists"`)
  : null

/** A taken name is `conflict`. Unkeyed; a lost response is resolved by `tags()` and the name. */
export async function createTag(send: N8nSend, name: string): Promise<Outcome<N8nTag>> {
  const bad = checkTagName(name); if (bad) return bad
  return out(await send.api<N8nTag>({ method: 'POST', path: `${API}/tags`, body: { name } }))
}

export async function updateTag(send: N8nSend, id: string, name: string): Promise<Outcome<N8nTag>> {
  if (!id) return refuse('a tag id is required')
  const bad = checkTagName(name); if (bad) return bad
  return out(await send.api<N8nTag>({ method: 'PUT', path: `${API}/tags/${encodeURIComponent(id)}`, body: { name } }))
}

/** Takes the tag off every workflow that had it. */
export async function deleteTag(send: N8nSend, id: string): Promise<Outcome<N8nTag>> {
  if (!id) return refuse('a tag id is required')
  return out(await send.api<N8nTag>({ method: 'DELETE', path: `${API}/tags/${encodeURIComponent(id)}` }))
}

export async function workflowTags(send: N8nSend, id: string): Promise<Outcome<N8nTag[]>> {
  if (!id) return refuse('a workflow id is required')
  return out(await send.api<N8nTag[]>({ method: 'GET', path: `${API}/workflows/${encodeURIComponent(id)}/tags` }))
}

/** Replaces the whole set; `[]` clears it. One unknown id refuses the lot (`not_found`) and nothing changes. */
export async function setWorkflowTags(send: N8nSend, id: string, tagIds: string[]): Promise<Outcome<N8nTag[]>> {
  if (!id) return refuse('a workflow id is required')
  if (!Array.isArray(tagIds)) return refuse('`tagIds` is an array of tag ids, empty clears')
  return out(await send.api<N8nTag[]>({ method: 'PUT', path: `${API}/workflows/${encodeURIComponent(id)}/tags`, body: tagIds.map(t => ({ id: t })) }))
}

// ── the trigger ──────────────────────────────────────────────────────────────

export interface TriggerOptions {
  method?:  'POST' | 'GET' | 'PUT' | 'PATCH' | 'DELETE'
  body?:    unknown
  query?:   Record<string, string>
  headers?: Record<string, string>
  /** `/webhook-test/`: the path the editor listens on while *Listen for test event* is open. */
  test?:    boolean
}

/**
 * Starts the ACTIVE workflow whose Webhook node owns `path`. What comes back
 * is the workflow's choice: `{ message: 'Workflow was started' }` at once
 * under *Immediately*, or whatever a Respond to Webhook node sends.
 *
 * Unkeyed and unreplayable (C5): n8n starts one execution per request and
 * collapses nothing, so a lost response is `indeterminate` and the read that
 * resolves it is `executions(send, { workflowId, limit: 1 })` (C6). An app
 * that must deliver exactly once puts its own id in the body and dedupes in
 * the workflow.
 */
export async function trigger(send: N8nSend, path: string, opts: TriggerOptions = {}): Promise<Outcome<TriggerResult>> {
  const p = (path ?? '').replace(/^\/+/, '')
  if (!p) return refuse('a webhook path is required — the Webhook node\'s `path`, or its id when none was set')
  const r = await send.hook<unknown>({ method: opts.method ?? 'POST', path: `/${opts.test ? 'webhook-test' : 'webhook'}/${p}`, body: opts.body, query: opts.query, headers: opts.headers })
  if (r.error) return { error: translate(r.error, r.meta.status) }
  return { result: { status: r.meta.status, body: r.data } }
}
