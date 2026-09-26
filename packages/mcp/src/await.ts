/*
 * src/await.ts — hold a tool call open until the jobs it started are finished.
 *
 * The jobs are FOUND, not declared (`FJS-D406`): Caravan stamps every dispatched
 * job with the correlation id of the request that dispatched it, and one MCP
 * `tools/call` is one HTTP request, so *the jobs this call started* is a lookup
 * by that id. A method that dispatches cannot forget to say so, because it says
 * nothing.
 *
 * A caller asks for it with `_meta: { 'frontierjs/await': true }` on the call —
 * a vendor key in the protocol's own extension slot, so no tool's input schema
 * changes and a client that never asks is answered exactly as before.
 *
 * What it cannot see is the correlation id's own gap, and is stated rather than
 * hidden: a job queued through the transactional outbox (`ctx.enqueue`) is
 * dispatched after commit by the relay and may carry no correlation id, and a
 * job dispatched from inside another job carries a fresh one. Neither is waited
 * on; the answer lists what WAS found, so an empty list reads as empty.
 */

export const AWAIT_META = 'frontierjs/await'
export const JOBS_META  = 'frontierjs/jobs'

const TERMINAL = new Set(['done', 'failed', 'cancelled'])

export interface JobState {
  id:       string
  name:     string
  status:   string
  attempts: number
  error:    string | null
}

interface JobRow { id: string; name: string; status: string; attempts: number; error: string | null; created_at: number }

export interface JobsReader {
  findByCorrelation(correlationId: string): JobRow[]
}

export interface AwaitOptions {
  /** Give up after this long and answer what is known. */
  timeoutMs:  number
  pollMs:     number
  signal?:    AbortSignal
  /** Called whenever a job's status moves, for a progress notification. */
  onProgress?: (done: number, total: number, jobs: JobState[]) => void
  now?:       () => number
  sleep?:     (ms: number) => Promise<void>
}

export interface AwaitOutcome {
  jobs:     JobState[]
  /** True when every job reached a terminal status before the deadline. */
  settled:  boolean
}

const state = (r: JobRow): JobState =>
  ({ id: r.id, name: r.name, status: r.status, attempts: r.attempts, error: r.error ?? null })

/**
 * Wait on every job the correlation id names that was created at or after
 * `since` — a client may reuse an `x-request-id`, and the jobs an earlier call
 * under the same id started are not this call's.
 */
export async function awaitJobs(reader: JobsReader, correlationId: string, since: number, opts: AwaitOptions): Promise<AwaitOutcome> {
  const now   = opts.now ?? Date.now
  const sleep = opts.sleep ?? ((ms: number) => new Promise(r => setTimeout(r, ms)))
  const deadline = now() + opts.timeoutMs
  let last = ''

  for (;;) {
    const jobs = reader.findByCorrelation(correlationId).filter(r => r.created_at >= since).map(state)
    const done = jobs.filter(j => TERMINAL.has(j.status)).length
    const sig  = jobs.map(j => `${j.id}:${j.status}`).join()
    if (sig !== last) { opts.onProgress?.(done, jobs.length, jobs); last = sig }

    if (done === jobs.length) return { jobs, settled: true }
    if (opts.signal?.aborted || now() >= deadline) return { jobs, settled: false }
    await sleep(opts.pollMs)
  }
}

/** One line per job, for a reader that reads only the text — an agent. */
export function describeOutcome(o: AwaitOutcome): string {
  if (!o.jobs.length) return 'This call started no job this surface can see.'
  const lines = o.jobs.map(j => `${j.name} (${j.id}): ${j.status}${j.error ? ` — ${j.error}` : ''}`)
  return [o.settled ? 'Every job this call started has finished:' : 'Stopped waiting before every job finished:', ...lines].join('\n')
}
