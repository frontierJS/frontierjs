// tests/workers.test.ts
//
// Real workers, real threads. Nothing here can be faked usefully: the whole
// question is what a second thread receives, and a stand-in for a Worker
// answers whatever the stand-in was written to answer — which is how
// `createThread(path, data)` shipped with its second parameter documented,
// exported, and going nowhere (`FJS-271`).
//
// The measurement behind the fix: on Bun 1.3.11 `workerData` IS delivered, and
// only to `node:worker_threads`. `globalThis.workerData`, `self.workerData` and
// `Bun.workerData` are all undefined inside the worker, which is what made a
// delivered value look like a dropped one.

import { describe, test, expect } from 'bun:test'
import { join } from 'node:path'

import { createThread, createPool, workerData } from '../src/workers/index.ts'

const WORKER = join(import.meta.dir, 'fixtures/workers/echo-setup.worker.ts')

/** One task in, one message out. */
function ask(thread: ReturnType<typeof createThread>, msg: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('worker never answered')), 10_000)
    thread.on('message', (data) => { clearTimeout(timer); resolve(data) })
    thread.on('error',   (e)    => { clearTimeout(timer); reject(e) })
    thread.postMessage(msg)
  })
}

describe('createThread', () => {
  test('the setup data reaches the worker', async () => {
    const thread = createThread(WORKER, { factor: 3, tag: 'alpha' })
    try {
      const answer = await ask(thread, 7)
      expect(answer.setup).toEqual({ factor: 3, tag: 'alpha' })
      expect(answer.product).toBe(21)
    } finally {
      thread.terminate()
    }
  }, 20_000)

  test('setup outlives the first message', async () => {
    // It is read at module scope, not off a message, so the second task sees
    // it too — which is the difference between setup and an initial task.
    const thread = createThread(WORKER, { factor: 10 })
    try {
      expect((await ask(thread, 1)).product).toBe(10)
      expect((await ask(thread, 2)).product).toBe(20)
    } finally {
      thread.terminate()
    }
  }, 20_000)

  test('a thread given none reads undefined, not null', async () => {
    const thread = createThread(WORKER)
    try {
      const answer = await ask(thread, 5)
      expect(answer.setup).toBeUndefined()
      expect(answer.product).toBe(5)
    } finally {
      thread.terminate()
    }
  }, 20_000)
})

describe('workerData()', () => {
  test('is undefined on the main thread', () => {
    // Node answers null there; a caller cannot act on the difference between
    // "nobody passed anything" and "somebody passed nothing", so both are one
    // value and `?? fallback` works in either place.
    expect(workerData()).toBeUndefined()
  })
})

describe('createPool', () => {
  test('every worker in the pool gets the setup data', async () => {
    const pool = createPool(WORKER, 3, { factor: 4 })
    try {
      const answers = await Promise.all([1, 2, 3, 4, 5].map(n => pool.exec<any>(n)))
      for (const a of answers) expect(a.setup).toEqual({ factor: 4 })
      expect(answers.map(a => a.product)).toEqual([4, 8, 12, 16, 20])
    } finally {
      pool.destroy()
    }
  }, 20_000)

  test('a handler that throws REJECTS the caller and counts as an error', async () => {
    // `workerHandler` reports a throw as a message — a worker cannot reject its
    // caller's promise from inside itself — and the pool used to resolve with
    // that envelope: the caller's await succeeded, the failure arrived as a
    // property nobody reads, and `stats.completed` counted it as work done.
    const pool = createPool(WORKER, 1, { factor: 2 })
    try {
      await expect(pool.exec(-1)).rejects.toThrow('asked to fail')

      const stats = pool.stats()
      expect(stats.errors).toBe(1)
      expect(stats.completed).toBe(0)

      // …and the pool still works afterwards.
      expect((await pool.exec<any>(6)).product).toBe(12)
      expect(pool.stats().completed).toBe(1)
    } finally {
      pool.destroy()
    }
  }, 20_000)

  test('a pool with no setup data still runs', async () => {
    const pool = createPool(WORKER, 2)
    try {
      const answer = await pool.exec<any>(9)
      expect(answer.setup).toBeUndefined()
      expect(answer.product).toBe(9)
    } finally {
      pool.destroy()
    }
  }, 20_000)
})
