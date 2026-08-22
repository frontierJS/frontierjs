// ============================================================
// autoloadJobs() — against a real, non-empty directory.
//
// This feature had never once run to completion: `dir` was declared inside
// the try block and read in the loop outside it, so the first entry threw
// `ReferenceError: dir is not defined`. Nothing caught it because no test
// ever pointed autoload at a directory containing a job file — an empty
// glob result skips the loop entirely and reports success.
//
// Every test here therefore uses a directory that actually has files in it.
// ============================================================

import { describe, it, expect, beforeEach } from 'bun:test'
import { resolve } from 'node:path'
import { autoloadJobs } from '../src/autoload.ts'
import { createCaravan } from '../src/index.ts'
import type { HandlerOptions, JobHandler, JobRegistrar } from '../src/types.ts'

const FIXTURES = resolve(import.meta.dir, 'fixtures/jobs')
const COLON    = resolve(import.meta.dir, 'fixtures/colon-jobs')
const DUPES    = resolve(import.meta.dir, 'fixtures/dup-jobs')

// Collects what autoload registers, so the assertions are about the call
// autoload makes rather than about queue internals.
function collector() {
  const registered: Array<{ name: string; opts: HandlerOptions }> = []
  // JobRegistrar rather than Pick<CaravanInstance, 'handle'>: handle() is
  // overloaded (a name, or a whole definition), and an overloaded member forces
  // a stub to implement both signatures to be assignable at all.
  //
  // The DEFINITION arrives whole now. autoload used to re-list a definition's
  // keys into the name-and-options form, which is what silently dropped a
  // `timeout` written in a job file — so what this collector records is the
  // definition itself, and a key added to one cannot go missing on the way.
  const stub: JobRegistrar = {
    handle(job) {
      registered.push({ name: job.name, opts: job as HandlerOptions })
    },
  }
  return { stub, registered }
}

describe('autoloadJobs against a directory with job files', () => {
  let c: ReturnType<typeof collector>
  beforeEach(() => { c = collector() })

  it('loads every *.job.ts file and returns their names', async () => {
    const loaded = await autoloadJobs(FIXTURES, c.stub)

    // This line is the regression: before the fix it threw ReferenceError.
    expect(loaded.sort()).toEqual(['cleanup', 'send-email'])
  })

  it('registers each handler with the options from defineJob()', async () => {
    await autoloadJobs(FIXTURES, c.stub)

    const email = c.registered.find(r => r.name === 'send-email')
    expect(email).toBeDefined()
    expect(email!.opts.queue).toBe('email')
    expect(email!.opts.maxAttempts).toBe(5)
    expect(email!.opts.retryDelay).toEqual([10, 20])
  })

  it('recurses into subdirectories', async () => {
    const loaded = await autoloadJobs(FIXTURES, c.stub)
    expect(loaded).toContain('cleanup')
  })

  it('skips a file whose default export is not a defineJob() result', async () => {
    const loaded = await autoloadJobs(FIXTURES, c.stub)

    expect(loaded).not.toContain('not-a-real-job')
    expect(c.registered.map(r => r.name)).not.toContain('not-a-real-job')
  })

  it('accepts a path relative to cwd, not just an absolute one', async () => {
    const rel = resolve(import.meta.dir, '..')
    const loaded = await autoloadJobs(
      `${rel.slice(process.cwd().length + 1) || '.'}/tests/fixtures/jobs`,
      c.stub,
    )
    expect(loaded.sort()).toEqual(['cleanup', 'send-email'])
  })

  it('returns an empty list for a directory that does not exist', async () => {
    expect(await autoloadJobs(resolve(FIXTURES, 'nope'), c.stub)).toEqual([])
    expect(c.registered).toHaveLength(0)
  })
})

// A job name is commonly namespaced with a colon, and a colon is not a legal
// filename character on Windows — so the file convention used to exclude the
// most common way of naming a job, by refusing the only file name it could have.

describe('a namespaced job name', () => {
  it('accepts the dash spelling of a colon as the file name', async () => {
    const c = collector()
    const loaded = await autoloadJobs(COLON, c.stub)

    // The NAME keeps its colon — the translation is one-way, for the file only.
    expect(loaded).toEqual(['deployment:run'])
    expect(c.registered[0]!.name).toBe('deployment:run')
    expect(c.registered[0]!.opts.queue).toBe('deployments')
  })
})

// The scan recurses and the name is the basename, so two directories can claim
// one name. `handlers` is a Map: without this the loser stops existing and
// every dispatch to it runs the winner's handler instead.

describe('two files claiming one job name', () => {
  it('refuses, naming both files', async () => {
    const c = collector()
    await expect(autoloadJobs(DUPES, c.stub)).rejects.toThrow(/already registered by/)
  })
})

describe('jobsDir wired through createCaravan().start()', () => {
  it('start() autoloads handlers and they can process a dispatch', async () => {
    const caravan = createCaravan({
      db:           ':memory:',
      pollInterval: 10,
      jobsDir:      FIXTURES,
      queues:       { default: { concurrency: 2 }, email: { concurrency: 1 } },
    })

    await caravan.start()

    // The autoloaded 'send-email' handler declares queue 'email'; dispatch
    // must route there off the registration, not the default queue.
    const id = await caravan.dispatch('send-email', { to: 'alice@example.com' })
    expect(caravan.find(id)!.queue).toBe('email')

    const deadline = Date.now() + 2_000
    while (Date.now() < deadline && caravan.find(id)!.status !== 'done') {
      await new Promise(r => setTimeout(r, 10))
    }
    expect(caravan.find(id)!.status).toBe('done')

    await caravan.stop()
  })
})
