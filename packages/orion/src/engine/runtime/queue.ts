import type { ExecutionContext } from './context'

// ─────────────────────────────────────────────
// EXECUTION QUEUE
// Jobs flow in via trigger handlers, out to the Scheduler.
// Bounded — back-pressure via QueueFullError (→ HTTP 503).
// Default: in-memory. Scale-out: swap for BullMQ.
//
// Surface API:
//   new InMemoryQueue(capacity?)
//   queue.enqueue(job)   → throws QueueFullError if at capacity
//   queue.dequeue()      → ExecutionJob | undefined
//   queue.size()         → number
// ─────────────────────────────────────────────

export interface ExecutionJob {
  executionId: string
  flowId: string
  version: string
  trigger: unknown
  // If set, Scheduler resumes from this state instead of starting fresh
  resumeFrom?: ExecutionContext
  // Present for sync webhook flows — resolved by http.respond node
  responseHandle?: import('./context').SyncResponseHandle
}

export interface IExecutionQueue {
  enqueue(job: ExecutionJob): Promise<void>
  dequeue(): Promise<ExecutionJob | undefined>
  size(): number
}

// ─────────────────────────────────────────────
// QUEUE FULL ERROR
// Callers convert this to HTTP 503 / 429 at the trigger boundary
// ─────────────────────────────────────────────

export class QueueFullError extends Error {
  constructor(public readonly capacity: number) {
    super(`Execution queue is full (capacity: ${capacity})`)
    this.name = 'QueueFullError'
  }
}

// ─────────────────────────────────────────────
// IN-MEMORY QUEUE
// ─────────────────────────────────────────────

export class InMemoryQueue implements IExecutionQueue {
  private readonly jobs: ExecutionJob[] = []

  constructor(private readonly capacity = 500) {}

  async enqueue(job: ExecutionJob): Promise<void> {
    if (this.jobs.length >= this.capacity) throw new QueueFullError(this.capacity)
    this.jobs.push(job)
  }

  async dequeue(): Promise<ExecutionJob | undefined> {
    return this.jobs.shift()
  }

  size(): number {
    return this.jobs.length
  }

  clear(): void {
    this.jobs.length = 0
  }
}
