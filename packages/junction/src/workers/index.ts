// workers/index.ts
// Worker system — Bun native threads and pools.
// createThread   → Bun.Worker (shared memory, fast)
// createPool     → pool of N workers, queue-based dispatch
//
// A worker receives two different things and they arrive by two different
// routes: SETUP data, once, at construction — read with `workerData()` — and
// WORK, repeatedly, over postMessage — handled with `workerHandler()`. Keeping
// them apart is why neither needs an envelope to tell them apart.

import { workerData as threadData } from 'node:worker_threads'

// ─── Types ────────────────────────────────────────────────────────────────

export interface WorkerHandle {
  postMessage: (data: unknown) => void
  on:          (event: 'message' | 'error' | 'exit', handler: (...args: unknown[]) => void) => void
  terminate:   () => void
}

export interface WorkerPoolHandle {
  exec:  <T = unknown>(data: unknown) => Promise<T>
  size:  () => number
  stats: () => PoolStats
  destroy: () => void
}

export interface PoolStats {
  total:   number
  idle:    number
  busy:    number
  queued:  number
  completed: number
  errors:  number
}

// ─── Spawning ─────────────────────────────────────────────────────────────

/**
 * The one place a Worker is constructed, so setup data cannot reach one kind of
 * worker and not another — a pool RESPAWNS after an error, and a respawned
 * worker that lost its configuration is a pool that answers differently after
 * the first failure.
 *
 * `workerData` is not part of the web `WorkerOptions`, which is what the cast
 * is for. It IS delivered on Bun 1.3.11 — measured — but only to
 * `node:worker_threads`: inside the worker `globalThis.workerData`,
 * `self.workerData` and `Bun.workerData` are all undefined, which is what made
 * this look like a dropped parameter (`FJS-271`). `workerData()` below is the
 * read half, and the two live together so a future runtime change is one edit.
 */
function spawn(path: string, data?: unknown): Worker {
  return new Worker(path, {
    type:       'module',
    workerData: data,
  } as WorkerOptions & { workerData?: unknown })
}

/**
 * The setup data this worker was constructed with, inside the worker.
 *
 * `undefined` on the main thread and in a worker given none — Node answers
 * `null` for both, and a caller cannot act on the difference between *nobody
 * passed anything* and *somebody passed nothing*.
 */
export function workerData<T = unknown>(): T | undefined {
  return (threadData ?? undefined) as T | undefined
}

// ─── Single thread ────────────────────────────────────────────────────────

export function createThread(
  nameOrPath: string,
  data?:      unknown
): WorkerHandle {

  const worker = spawn(resolveWorkerPath(nameOrPath), data)

  return {
    postMessage: (msg) => worker.postMessage(msg),
    on:          (event, handler) => {
      if (event === 'message') worker.onmessage  = (e) => handler(e.data)
      if (event === 'error')   worker.onerror    = handler as (e: ErrorEvent) => void
    },
    terminate:   () => worker.terminate()
  }
}

// ─── Worker pool ──────────────────────────────────────────────────────────
// A fixed-size pool that queues work when all workers are busy.
// Each pool worker runs an infinite loop, receiving tasks via postMessage.

export function createPool(
  nameOrPath: string,
  count:      number = 2,
  data?:      unknown
): WorkerPoolHandle {

  const path    = resolveWorkerPath(nameOrPath)
  const workers: PoolWorker[] = []
  const queue:   QueuedTask[] = []
  const stats: PoolStats = {
    total: count, idle: count, busy: 0, queued: 0, completed: 0, errors: 0
  }

  // Spawn workers
  for (let i = 0; i < count; i++) {
    const w = spawn(path, data)
    const pw: PoolWorker = { worker: w, busy: false, id: i }
    workers.push(pw)

    w.onmessage = (e: MessageEvent) => {
      const task = pw.currentTask
      pw.busy   = false
      pw.currentTask = undefined
      stats.busy--
      stats.idle++

      // `workerHandler` reports a throw as a message, because a worker cannot
      // reject the caller's promise from inside itself. Resolving with that
      // envelope hands the caller an object shaped like a result and counts a
      // failure as `completed` — the one thing a pool must not do, since the
      // caller's `await` succeeds and the error is a property nobody reads.
      if (isWorkerError(e.data)) {
        stats.errors++
        if (task) task.reject(new Error(e.data.message))
      } else {
        stats.completed++
        if (task) task.resolve(e.data)
      }

      // Drain queue
      drain()
    }

    w.onerror = (e: ErrorEvent) => {
      const task = pw.currentTask
      pw.busy   = false
      pw.currentTask = undefined
      stats.busy--
      stats.idle++
      stats.errors++

      if (task) task.reject(new Error(e.message))

      // Respawn this worker — with the same setup data, or the pool serves
      // one configuration before its first error and another after it.
      const newWorker    = spawn(path, data)
      pw.worker          = newWorker
      newWorker.onmessage = w.onmessage
      newWorker.onerror   = w.onerror

      drain()
    }
  }

  function drain(): void {
    if (!queue.length) return

    const idle = workers.find(w => !w.busy)
    if (!idle) return

    const task = queue.shift()!
    stats.queued--
    idle.busy        = true
    idle.currentTask = task
    stats.busy++
    stats.idle--

    idle.worker.postMessage(task.data)
  }

  return {

    exec<T = unknown>(data: unknown): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const task: QueuedTask = { data, resolve: resolve as (value: unknown) => void, reject }
        queue.push(task)
        stats.queued++
        drain()
      })
    },

    size(): number {
      return workers.length
    },

    stats(): PoolStats {
      return { ...stats }
    },

    destroy(): void {
      for (const pw of workers) pw.worker.terminate()
      workers.length = 0
      // Reject all queued tasks
      for (const task of queue) task.reject(new Error('Pool destroyed'))
      queue.length = 0
    }
  }
}

// ─── Worker script helper ─────────────────────────────────────────────────
// Use this inside a worker file to declare a handler cleanly.
//
// worker.ts:
//   import { workerHandler, workerData } from '@frontierjs/junction/workers'
//
//   const { factor } = workerData<{ factor: number }>() ?? { factor: 2 }
//
//   workerHandler(async (data) => {
//     return { result: data.x * factor }
//   })
//
// Setup is read once, at module scope; work arrives per message. A throw is
// posted back as an envelope and the pool turns it into a rejection — a worker
// cannot reject its caller's promise from inside itself.

export function workerHandler<TIn = unknown, TOut = unknown>(
  fn: (data: TIn) => Promise<TOut> | TOut
): void {
  // @ts-ignore — Bun worker global
  self.onmessage = async (e: MessageEvent<TIn>) => {
    try {
      const result = await fn(e.data)
      // @ts-ignore
      self.postMessage(result)
    } catch (err) {
      // @ts-ignore
      self.postMessage({ __error: true, message: (err as Error).message })
    }
  }
}

/** The envelope `workerHandler` posts when the handler threw. */
function isWorkerError(v: unknown): v is { __error: true; message: string } {
  return typeof v === 'object' && v !== null && (v as { __error?: unknown }).__error === true
}

// ─── Internal types ───────────────────────────────────────────────────────

interface PoolWorker {
  id:          number
  worker:      Worker
  busy:        boolean
  currentTask?: QueuedTask
}

interface QueuedTask {
  data:    unknown
  resolve: (value: unknown) => void
  reject:  (reason: unknown) => void
}

// ─── Path resolver ────────────────────────────────────────────────────────

function resolveWorkerPath(nameOrPath: string): string {
  // Absolute path — use as-is
  if (nameOrPath.startsWith('/') || nameOrPath.startsWith('./') || nameOrPath.startsWith('../'))
    return nameOrPath

  // Name only — resolve from workers/ directory
  return `./workers/${nameOrPath}.ts`
}
