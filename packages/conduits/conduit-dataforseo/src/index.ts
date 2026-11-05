// @frontierjs/conduit-dataforseo — DataForSEO over conduit.
//
// Written from two callers: serpgrid's `providers/dataforseo/` (the standard
// queue — task_post, tasks_ready, task_get — paced per agency) and kos's
// `domain/links/dataforseo.ts` (live endpoints, one task, the answer in the
// same response). What this vendor presses that the others did not:
//
//   - EVERY ACCEPTED TASK BILLS and there is no idempotency key. A resent post
//     is a second task and a second charge, so a post is never replayed and a
//     lost answer is `indeterminate`; the caller's own `tag` on each task is
//     what `tasksReady` finds it by.
//   - ONE REQUEST, UP TO 100 TASKS, EACH ANSWERED ON ITS OWN. A 200 whose
//     envelope says 20000 can carry a task that failed, so `validate` refuses
//     only the envelope (C4) and each task keeps its own status.
//   - HTTP Basic, and the login is the ACCOUNT's: `login:password` under one
//     ref through conduit's built-in `basic` signer. Where the account is a
//     tenant's, the target is per account and the resolver answers `getFor`.

import type { ConduitError, ConduitRequest, ConduitResult, ResponseValidator, TargetDescriptor } from '@frontierjs/conduit'
import type { DataforseoEnvelope, DataforseoTask, TaskAnswer } from './types.ts'

export * from './types.ts'

export const DATAFORSEO_TARGET  = 'provider:dataforseo'
export const DATAFORSEO_ADDRESS = 'https://api.dataforseo.com'

/** The vendor's own limit on tasks in one post (40006 past it). */
export const BATCH_SIZE = 100

export const OK        = 20000
export const CREATED   = 20100
/** In the queue or handed to a worker: ask again later. */
export const NOT_READY = new Set([40601, 40602])
/** The account's balance is too low. */
export const NO_FUNDS  = new Set([40200, 40210])
export const RATE_LIMITED = 40202
export const BAD_LOGIN    = 40100

export type Send = <T>(req: Omit<ConduitRequest, 'target'>) => Promise<ConduitResult<T>>
export function bindSend(conduit: { send<T>(req: ConduitRequest): Promise<ConduitResult<T>> }, target = DATAFORSEO_TARGET): Send {
  return req => conduit.send({ target, ...req })
}

/**
 * The credential under `ref` is `login:password`, the spelling the `basic`
 * signer reads (C13). One target per process where the login is the
 * process's; `accountId` makes it one per account (`provider:dataforseo:<id>`)
 * and `perCaller` asks the resolver `getFor(ref, who)` so one agency's login
 * is never sent for the next (`FJS-2232`). `accountId` is optional here where
 * the cloud connectors require it, because a DataForSEO login is the process's
 * by default and an agency's only in a multi-agency app; the spelling is
 * cloudflare's and gmail's.
 */
export function dataforseoTarget(opts: { ref?: string; address?: string; id?: string; accountId?: string; perCaller?: boolean } = {}): TargetDescriptor {
  return {
    id:            opts.id ?? (opts.accountId ? `${DATAFORSEO_TARGET}:${opts.accountId}` : DATAFORSEO_TARGET),
    kind:          'provider',
    protocol:      'http',
    address:       (opts.address ?? DATAFORSEO_ADDRESS).replace(/\/$/, ''),
    auth:          { type: 'signed', signer: 'basic', ref: opts.ref ?? 'DATAFORSEO_LOGIN', ...(opts.perCaller ? { per_caller: true as const } : {}) },
    // A 100-task post answers in about a second; a lost answer is a batch
    // failed unread, so waiting beats cutting it short.
    resilience:    { timeout_ms: 30_000 },
    registered_at: Date.now(),
    last_seen_at:  null,
  }
}

// ─── Money ───────────────────────────────────────────────────────────────
// The vendor's `cost` is a float of dollars (0.0006). It is kept as MICROS —
// the unit of a `@scale(6)` column — because a task's price is under a cent and
// minor units would round every one to 0.

/** `0.0006` → 600 micros. Not a number is `null`, never 0: an unknown cost is not a free task. */
export const toMicros = (usd: unknown): number | null =>
  typeof usd === 'number' && Number.isFinite(usd) ? Math.round(usd * 1_000_000) : null

// ─── Errors ──────────────────────────────────────────────────────────────
// Every refusal is the envelope itself: `status_code` and `status_message` at
// the top, HTTP 200 for most of them, 401 for a bad login, 429 beside 40202.

export type DataforseoFailureKind = 'no_funds' | 'not_ready' | 'refused' | ConduitError['kind']
export interface DataforseoFailure { kind: DataforseoFailureKind; message: string; code?: number; retryable: boolean; retryAfterMs?: number }

/** The vendor's quota window: 2,000 calls a minute per login, and no `Retry-After`. */
export const RATE_WINDOW_MS = 60_000

export function translate(error: ConduitError, status?: number): DataforseoFailure {
  let body: Partial<DataforseoEnvelope> | null = null
  try { body = typeof error.raw === 'string' ? JSON.parse(error.raw) : (error.raw as Partial<DataforseoEnvelope>) } catch { /* not JSON */ }
  const code = typeof body?.status_code === 'number' ? body.status_code : undefined
  const base: DataforseoFailure = {
    kind: error.kind, message: body?.status_message ?? error.message, retryable: error.retryable,
    ...(code !== undefined ? { code } : {}),
    ...(error.retry_after_ms !== undefined ? { retryAfterMs: error.retry_after_ms } : {}),
  }
  if (code === RATE_LIMITED || status === 429) return { ...base, kind: 'rate_limited', retryable: true, retryAfterMs: error.retry_after_ms ?? RATE_WINDOW_MS }
  if (code === BAD_LOGIN || status === 401)   return { ...base, kind: 'auth_failed', retryable: false }
  if (code !== undefined && NO_FUNDS.has(code)) return { ...base, kind: 'no_funds', retryable: false }
  if (error.kind === 'invalid_response' && code !== undefined) return { ...base, kind: 'refused', retryable: false }
  return base
}

/** C4: a 200 whose envelope is not 20000 is a failure, and `translate` reads the sentence. */
export const envelope: ResponseValidator<DataforseoEnvelope> = {
  validate(data) {
    const d = data as Partial<DataforseoEnvelope> | null
    if (!d || typeof d !== 'object' || typeof d.status_code !== 'number') return { ok: false, errors: ['no status_code in the envelope'] }
    if (d.status_code !== OK) return { ok: false, errors: [`${d.status_code} ${d.status_message ?? ''}`.trim()] }
    return { ok: true, value: d as DataforseoEnvelope }
  },
}

/** One task of the envelope, its cost in micros and its own status read. */
function answer<R>(task: DataforseoTask<R>): TaskAnswer<R> {
  const code = task.status_code
  const kind = code === OK || code === CREATED ? 'ok' : NOT_READY.has(code) ? 'not_ready' : NO_FUNDS.has(code) ? 'no_funds' : 'refused'
  return { id: task.id, tag: task.data?.tag, kind, code, message: task.status_message, costMicros: toMicros(task.cost), result: task.result ?? null }
}

// ─── The wire ────────────────────────────────────────────────────────────

const clean = (path: string) => path.replace(/^\/+/, '').replace(/^v3\//, '')

/**
 * Post up to 100 tasks to a standard-queue endpoint (`serp/google/organic/task_post`).
 * Unkeyed and unreplayable: every accepted task bills. Answers the vendor's
 * tasks in the vendor's order, each with its own status, or a failure for the
 * request as a whole, in which case NO task can be assumed created or not —
 * `tasksReady` finds the ones that were by the caller's `tag` (C6).
 */
export async function postTasks<R = unknown>(send: Send, path: string, tasks: Record<string, unknown>[]): Promise<{ tasks?: TaskAnswer<R>[]; costMicros?: number | null; error?: DataforseoFailure }> {
  if (!tasks.length) throw new TypeError('dataforseo: nothing to post')
  if (tasks.length > BATCH_SIZE) throw new TypeError(`dataforseo: ${tasks.length} tasks in one post — the vendor takes ${BATCH_SIZE}`)
  if (/\/live\b/.test(path)) throw new TypeError(`dataforseo: '${path}' is a live endpoint — use live(), one task at a time`)
  const r = await send<DataforseoEnvelope<R>>({ method: 'POST', path: `/v3/${clean(path)}`, body: tasks, validate: envelope })
  if (r.error) return { error: translate(r.error, r.meta.status) }
  return { tasks: (r.data.tasks ?? []).map(answer), costMicros: toMicros(r.data.cost) }
}

/**
 * A live endpoint (`serp/google/organic/live/advanced`, `backlinks/…/live`):
 * ONE task, the result in the same answer, billed on acceptance. The vendor
 * refuses an array of more than one here, and the refusal costs a round trip,
 * so it is made before the send (C9).
 */
export async function live<R = unknown>(send: Send, path: string, task: Record<string, unknown>): Promise<{ task?: TaskAnswer<R>; error?: DataforseoFailure }> {
  if (!/\/live\b/.test(path)) throw new TypeError(`dataforseo: '${path}' is not a live endpoint — use postTasks()`)
  const r = await send<DataforseoEnvelope<R>>({ method: 'POST', path: `/v3/${clean(path)}`, body: [task], validate: envelope })
  if (r.error) return { error: translate(r.error, r.meta.status) }
  const first = r.data.tasks?.[0]
  if (!first) return { error: { kind: 'refused', message: 'no task in the answer', retryable: false } }
  return { task: answer(first) }
}

/**
 * Which of the login's tasks are done and not yet collected, oldest first, at
 * most 1,000 — one FREE call however many are ready, so it is replayable. A
 * `task_get` collects a task and it leaves this list.
 */
export async function tasksReady(send: Send, path: string): Promise<{ ready?: { id: string; tag?: string }[]; error?: DataforseoFailure }> {
  const r = await send<DataforseoEnvelope<{ id: string; tag?: string }>>({ method: 'GET', path: `/v3/${clean(path).replace(/\/task_post$/, '')}/tasks_ready`, replayable: true, validate: envelope })
  if (r.error) return { error: translate(r.error, r.meta.status) }
  const first = r.data.tasks?.[0]
  if (!first || first.status_code !== OK) return { error: { kind: 'refused', message: first?.status_message ?? 'no task in the answer', retryable: false, ...(first ? { code: first.status_code } : {}) } }
  return { ready: (first.result ?? []).map(t => ({ id: t.id, ...(t.tag ? { tag: t.tag } : {}) })) }
}

/** One task's result, free and replayable. `not_ready` (40601/40602) is its own kind: the task exists and the caller asks again. */
export async function getTask<R = unknown>(send: Send, path: string, taskId: string, variant = 'advanced'): Promise<{ task?: TaskAnswer<R>; error?: DataforseoFailure }> {
  const r = await send<DataforseoEnvelope<R>>({ method: 'GET', path: `/v3/${clean(path).replace(/\/task_post$/, '')}/task_get/${variant}/${encodeURIComponent(taskId)}`, replayable: true, validate: envelope })
  if (r.error) return { error: translate(r.error, r.meta.status) }
  const first = r.data.tasks?.[0]
  if (!first) return { error: { kind: 'refused', message: 'no task in the answer', retryable: false } }
  return { task: answer(first) }
}
