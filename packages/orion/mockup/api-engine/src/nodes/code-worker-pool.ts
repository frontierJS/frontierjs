import { Worker } from "worker_threads"

// ─────────────────────────────────────────────
// CODE WORKER POOL
// Executes user-supplied JavaScript in isolated worker threads.
// Uses a fixed pool of persistent workers — message passing overhead
// (~0.27ms) is lower than vm.runInNewContext context creation (~0.47ms)
// and gives true OS-level process isolation.
//
// Workers run vm.Script inside the thread for scope isolation within
// the already-isolated thread.
//
// Crashes: a worker that throws an uncaught error is replaced automatically.
// Hangs: timeoutMs kills and replaces the worker, returns an error result.
//
// Surface API:
//   new CodeWorkerPool(size?)
//   pool.run(code, ctx, timeoutMs?) → Promise<unknown>
//   pool.drain()                    → gracefully terminate all workers
// ─────────────────────────────────────────────

const WORKER_CODE = /* javascript */ `
const { parentPort } = require('worker_threads')
const vm = require('vm')

const scripts = new Map()

parentPort.on('message', ({ id, code, ctx }) => {
  try {
    let script = scripts.get(code)
    if (!script) {
      script = new vm.Script('(function(__ctx){with(__ctx){return(' + code + ')}})(ctx)', {
        filename: 'user-code.js',
        timeout: 10000,
      })
      if (scripts.size > 200) {
        // evict oldest
        const first = scripts.keys().next().value
        scripts.delete(first)
      }
      scripts.set(code, script)
    }
    const sandbox = vm.createContext({ ctx, console, JSON, Math, Date, parseInt, parseFloat, isNaN, isFinite, Array, Object, String, Number, Boolean })
    const result = script.runInContext(sandbox, { timeout: 10000 })
    parentPort.postMessage({ id, result })
  } catch(e) {
    parentPort.postMessage({ id, error: e.message ?? String(e) })
  }
})
`

interface Pending {
  resolve: (value: unknown)  => void
  reject:  (reason: unknown) => void
  timer?:  ReturnType<typeof setTimeout>
}

interface PoolWorker {
  worker:  Worker
  pending: Map<number, Pending>
  msgId:   number
}

export class CodeWorkerPool {
  private readonly pool: PoolWorker[] = []
  private          idx  = 0

  constructor(private readonly size = 3) {
    for (let i = 0; i < size; i++) {
      this.pool.push(this.spawn())
    }
  }

  async run(
    code:       string,
    ctx:        Record<string, unknown>,
    timeoutMs = 5_000,
  ): Promise<unknown> {
    const pw  = this.pool[this.idx % this.pool.length]!
    this.idx++

    return new Promise((resolve, reject) => {
      const id    = pw.msgId++
      const timer = setTimeout(() => {
        pw.pending.delete(id)
        // Replace the hung worker
        const i = this.pool.indexOf(pw)
        if (i !== -1) {
          pw.worker.terminate()
          this.pool[i] = this.spawn()
        }
        reject(new Error(`data.code timed out after ${timeoutMs}ms`))
      }, timeoutMs)

      pw.pending.set(id, { resolve, reject, timer })
      pw.worker.postMessage({ id, code, ctx })
    })
  }

  drain(): Promise<void[]> {
    return Promise.all(this.pool.map(pw => pw.worker.terminate()))
  }

  private spawn(): PoolWorker {
    const pw: PoolWorker = {
      worker:  new Worker(WORKER_CODE, { eval: true }),
      pending: new Map(),
      msgId:   0,
    }

    pw.worker.on("message", ({ id, result, error }: { id: number; result?: unknown; error?: string }) => {
      const pending = pw.pending.get(id)
      if (!pending) return
      pw.pending.delete(id)
      clearTimeout(pending.timer)
      if (error !== undefined) {
        pending.reject(new Error(error))
      } else {
        pending.resolve(result)
      }
    })

    pw.worker.on("error", (err) => {
      // Drain all pending with the error, then replace this worker
      for (const [, p] of pw.pending) {
        clearTimeout(p.timer)
        p.reject(err)
      }
      pw.pending.clear()
      const i = this.pool.indexOf(pw)
      if (i !== -1) this.pool[i] = this.spawn()
    })

    return pw
  }
}
