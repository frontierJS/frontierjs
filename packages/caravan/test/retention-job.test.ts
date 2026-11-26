// retentionJob: the sweep every app's retention.job.ts used to spell out.

import { describe, it, expect, spyOn } from 'bun:test'
import { retentionJob } from '../src/index.ts'
import type { JobContext } from '../src/types.ts'

const run = (job: ReturnType<typeof retentionJob>) => job.handler({} as JobContext<unknown>)

function quiet() {
  return {
    log:   spyOn(console, 'log').mockImplementation(() => {}),
    error: spyOn(console, 'error').mockImplementation(() => {}),
  }
}

describe('retentionJob', () => {
  it('states cron on the definition and takes no name of its own', () => {
    const job = retentionJob({ cron: '0 4 * * *', client: () => ({ $retain: async () => [] }) })
    expect(job.cron).toBe('0 4 * * *')
    expect(job.__caravanJob).toBe(true)
    expect(() => job.name).toThrow(/no name/)
  })

  it('does not call the client thunk until the job runs', async () => {
    let opened = 0
    const job = retentionJob({ cron: '0 4 * * *', client: () => { opened++; return { $retain: async () => [] } } })
    expect(opened).toBe(0)
    const spies = quiet()
    await run(job)
    spies.log.mockRestore(); spies.error.mockRestore()
    expect(opened).toBe(1)
  })

  it('awaits an async thunk and logs one summary line when it removed rows', async () => {
    const spies = quiet()
    const job = retentionJob({
      cron: '0 4 * * *',
      client: async () => ({ $retain: async () => [
        { model: 'AuditLog', removed: 3 },
        { model: 'Session',  removed: 2 },
        { model: 'Note',     removed: 0 },
      ] }),
    })
    await run(job)
    expect(spies.log.mock.calls).toEqual([['[retention] removed 5 row(s) across 2 table(s)']])
    expect(spies.error).not.toHaveBeenCalled()
    spies.log.mockRestore(); spies.error.mockRestore()
  })

  it('says nothing when nothing was removed', async () => {
    const spies = quiet()
    await run(retentionJob({ cron: '0 4 * * *', client: () => ({ $retain: async () => [{ model: 'Note', removed: 0 }] }) }))
    expect(spies.log).not.toHaveBeenCalled()
    expect(spies.error).not.toHaveBeenCalled()
    spies.log.mockRestore(); spies.error.mockRestore()
  })

  it('logs a table it could not sweep to stderr and still summarizes the rest', async () => {
    const spies = quiet()
    await run(retentionJob({
      cron: '0 4 * * *',
      client: () => ({ $retain: async () => [
        { model: 'AuditLog', removed: 0, error: 'database is locked' },
        { model: 'Session',  removed: 4 },
      ] }),
    }))
    expect(spies.error.mock.calls).toEqual([['[retention] AuditLog: database is locked']])
    expect(spies.log.mock.calls).toEqual([['[retention] removed 4 row(s) across 1 table(s)']])
    spies.log.mockRestore(); spies.error.mockRestore()
  })

  it('lets a failing $retain fail the job so the queue retries it', async () => {
    const job = retentionJob({ cron: '0 4 * * *', client: () => ({ $retain: async () => { throw new Error('boom') } }) })
    await expect(run(job)).rejects.toThrow('boom')
  })
})
