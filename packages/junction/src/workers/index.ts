// workers/index.ts
// Worker system — Bun native threads and pools.
// createThread   → Bun.Worker (shared memory, fast)
// createPool     → pool of N workers, queue-based dispatch
// Worker scripts receive data and post results back.

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

// ─── Single thread ────────────────────────────────────────────────────────

export function createThread(
  nameOrPath: string,
  data?:      unknown
): WorkerHandle {

  const path = resolveWorkerPath(nameOrPath)

  // `workerData` is not part of the web WorkerOptions, and measured on Bun
  // 1.3.11 it is NOT DELIVERED either: inside the worker, `globalThis.workerData`,
  // `self.workerData` and `Bun.workerData` are all undefined. So `data` goes
  // nowhere and this file's own header — "Worker scripts receive data" — is
  // wrong. `FJS-271` holds the fix, which is a protocol decision rather than a
  // type one: an initial `postMessage` would arrive as a task on the pool's
  // message loop.
  //
  // Passed anyway rather than deleted, so the day Bun delivers it this starts
  // working; the cast is what the web type does not admit.
  const worker = new Worker(path, {
    type:       'module',
    workerData: data,
  } as WorkerOptions & { workerData?: unknown })

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
  count:      number = 2
): WorkerPoolHandle {

  const path    = resolveWorkerPath(nameOrPath)
  const workers: PoolWorker[] = []
  const queue:   QueuedTask[] = []
  const stats: PoolStats = {
    total: count, idle: count, busy: 0, queued: 0, completed: 0, errors: 0
  }

  // Spawn workers
  for (let i = 0; i < count; i++) {
    const w = new Worker(path, { type: 'module' })
    const pw: PoolWorker = { worker: w, busy: false, id: i }
    workers.push(pw)

    w.onmessage = (e: MessageEvent) => {
      const task = pw.currentTask
      pw.busy   = false
      pw.currentTask = undefined
      stats.busy--
      stats.idle++
      stats.completed++

      if (task) task.resolve(e.data)

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

      // Respawn this worker
      const newWorker    = new Worker(path, { type: 'module' })
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
//   import { workerHandler } from 'framework/workers'
//   workerHandler(async (data) => {
//     return { result: data.x * 2 }
//   })

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
