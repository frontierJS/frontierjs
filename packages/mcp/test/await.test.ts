/*
 * test/await.test.ts — `awaitJobs`, the wait an awaited tool call is held by.
 *
 * Over a reader and a clock of this test's own, because what is asked is the
 * loop — when it stops, what it reports, when it says so — and a real queue
 * would make every row a race. Whether the jobs a real call started are the
 * ones found is basecamp's `verify:cli`, against Caravan and a real `/mcp`.
 */

import { describe, test, expect } from 'bun:test'
import { awaitJobs, describeOutcome, type JobsReader } from '../src/await.ts'

type Row = ReturnType<JobsReader['findByCorrelation']>[number]

/** A queue whose rows move one step per poll, on a clock that moves with them. */
function queue(timeline: Array<Array<Partial<Row>>>) {
  let tick = 0, clock = 1_000
  const reader: JobsReader = {
    findByCorrelation: () => (timeline[Math.min(tick, timeline.length - 1)]).map((r, i) => ({
      id: `j${i}`, name: 'job:run', status: 'pending', attempts: 0, error: null, created_at: 1_000, ...r,
    })),
  }
  return {
    reader,
    opts: { timeoutMs: 10_000, pollMs: 500, now: () => clock, sleep: async (ms: number) => { clock += ms; tick++ } },
    polls: () => tick,
  }
}

describe('awaitJobs', () => {

  test('waits until every job is terminal, and says so', async () => {
    const q = queue([[{ status: 'pending' }], [{ status: 'running' }], [{ status: 'done' }]])
    const o = await awaitJobs(q.reader, 'c1', 1_000, q.opts)
    expect(o).toEqual({ settled: true, jobs: [{ id: 'j0', name: 'job:run', status: 'done', attempts: 0, error: null }] })
    expect(q.polls()).toBe(2)
  })

  test('a failed job is terminal and reported with its error, not raised', async () => {
    const q = queue([[{ status: 'running' }], [{ status: 'failed', error: 'no server assigned', attempts: 1 }]])
    const o = await awaitJobs(q.reader, 'c1', 1_000, q.opts)
    expect(o.settled).toBe(true)
    expect(o.jobs[0]).toMatchObject({ status: 'failed', error: 'no server assigned' })
    expect(describeOutcome(o)).toMatch(/job:run \(j0\): failed — no server assigned/)
  })

  test('a job created before the call is not this call\'s, even under the same correlation id', async () => {
    const q = queue([[{ status: 'running', created_at: 500 }, { status: 'done' }]])
    const o = await awaitJobs(q.reader, 'c1', 1_000, q.opts)
    expect(o.jobs.map(j => j.id)).toEqual(['j1'])
    expect(o.settled).toBe(true)
  })

  test('past the deadline it stops and answers where each job had got to', async () => {
    const q = queue([[{ status: 'running' }]])
    const o = await awaitJobs(q.reader, 'c1', 1_000, { ...q.opts, timeoutMs: 1_500 })
    expect(o.settled).toBe(false)
    expect(o.jobs[0].status).toBe('running')
    expect(describeOutcome(o)).toMatch(/^Stopped waiting/)
  })

  test('a client that went away stops the wait', async () => {
    const ac = new AbortController(); ac.abort()
    const q  = queue([[{ status: 'running' }]])
    const o  = await awaitJobs(q.reader, 'c1', 1_000, { ...q.opts, signal: ac.signal })
    expect(o.settled).toBe(false)
    expect(q.polls()).toBe(0)
  })

  test('progress is told when a status MOVES, not on every poll', async () => {
    const seen: string[] = []
    const q = queue([[{ status: 'pending' }], [{ status: 'pending' }], [{ status: 'running' }], [{ status: 'done' }]])
    await awaitJobs(q.reader, 'c1', 1_000, { ...q.opts, onProgress: (d, t, jobs) => seen.push(`${d}/${t} ${jobs[0].status}`) })
    expect(seen).toEqual(['0/1 pending', '0/1 running', '1/1 done'])
  })

  test('a call that started nothing settles at once, and the text says it found nothing', async () => {
    const q = queue([[]])
    const o = await awaitJobs(q.reader, 'c1', 1_000, q.opts)
    expect(o).toEqual({ settled: true, jobs: [] })
    expect(describeOutcome(o)).toMatch(/started no job/)
  })
})
