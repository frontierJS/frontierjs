// src/engine/job.engine.ts
// Job Engine — executes one-shot and triggered jobs via Conduit.
// Caravan handles scheduling, retry backoff, and crash recovery.
// This engine is purely the execution logic for a single job run.

import type { BasecampApp } from '../basecamp.types.ts'

interface JobRow {
  id:              string
  workspace_id:    string
  service_id:      string | null
  name:            string
  kind:            string
  status:          string
  command:         string | null
  timeout_seconds: number
  retry_limit:     number
  retry_count:     number
}

interface ServiceServerRow {
  server_id: string
}

export function createJobEngine(app: BasecampApp) {

  // asSystem(): the engine runs on Caravan's thread, not a request's. There is
  // no caller to scope to, and it legitimately writes to any workspace's rows.
  const db  = app.data.asSystem()
  const log = app.logger.child('job-engine')

  /** An online server this app is placed on, or null. */
  async function resolveServer(appId: string): Promise<string | null> {
    const placements = await db.appServer.findMany({
      where:   { appId },
      include: { server: true },
    })
    const live = placements.find((p: any) => p.server?.status === 'online')
    return live?.serverId ?? null
  }

  async function executeJob(job: JobRow): Promise<string> {
    if (!job.command) throw new Error('Job has no command configured')

    const serverId    = job.appId ? await resolveServer(job.appId) : null
    const outpostTarget = serverId ? `outpost:${serverId}` : null

    // No outpost — try local:basecamp sidecar target
    if (!outpostTarget) {
      const local = await app.conduit.resolve('local:basecamp')
      if (!local) throw new Error('No server assigned and no local target registered')

      const result = await app.conduit.send<{ exit_code: number; stdout: string; stderr: string }>({
        target: 'local:basecamp',
        method: 'POST',
        path:   '/exec',
        body:   { command: job.command, timeout_s: job.timeoutSeconds },
      })

      if (result.error) throw new Error(result.error.message)
      if (result.data?.exit_code !== 0) throw new Error(result.data?.stderr ?? 'non-zero exit')
      return result.data?.stdout ?? ''
    }

    const result = await app.conduit.send<{ exit_code: number; stdout: string; stderr: string }>({
      target:     outpostTarget,
      method:     'POST',
      path:       '/exec',
      body:       { command: job.command, timeout_s: job.timeoutSeconds, job_id: job.id },
      timeout_ms: (job.timeoutSeconds + 5) * 1_000,
    })

    if (result.error) throw new Error(result.error.message)
    if (result.data?.exit_code !== 0) throw new Error(result.data?.stderr ?? 'non-zero exit')
    return result.data?.stdout ?? ''
  }

  // Tell anyone watching. The deployment engine pushes on every step; this one
  // pushed nothing, so a job that ran wrote its JobRun to the database and left
  // every open screen showing the previous history until it was reloaded.
  //
  // A Channel's method is `send(event, data)` — `publish()` is on the MANAGER,
  // and calling it on a channel is a silent no-op (the deployment engine did
  // exactly that for its whole life).
  //
  // The event name is what the client's service proxy dispatches on, so
  // 'jobs patched' reaches `service.on('patched')` and any '*' listener.
  async function pushJob(jobId: string, workspaceId: string): Promise<void> {
    const manager = (app as unknown as Record<string, unknown>).channels as
      { channel: (n: string) => { send?: (e: string, d: unknown) => void } | undefined } | undefined

    const ch = manager?.channel?.(`workspace:${workspaceId}`)
    if (!ch?.send) return

    // The whole row: a client that assigns the payload over the record it is
    // rendering keeps every field this way.
    const row = await db.job.findUnique({ where: { id: jobId } })
    if (row) ch.send('jobs patched', row)
  }

  async function runJob(jobId: string, trigger = 'manual'): Promise<void> {
    const job = await db.job.findUnique({ where: { id: jobId } })
    if (!job) { log.warn('job not found', { id: jobId }); return }

    const startedAt = Date.now()
    const startedIso = new Date(startedAt).toISOString()

    const run = await db.jobRun.create({
      data: { jobId, status: 'running', trigger, startedAt: startedIso },
    })
    const runId = run.id

    await db.job.update({ where: { id: jobId }, data: { status: 'running', lastRunAt: startedIso } })

    log.info('job started', { job_id: jobId, run_id: runId, name: job.name })
    await pushJob(jobId, job.workspaceId)

    try {
      const output     = await executeJob(job)
      const finishedAt = Date.now()

      await db.jobRun.update({
        where: { id: runId },
        data: {
          status:     'success',
          finishedAt: new Date(finishedAt).toISOString(),
          durationMs: finishedAt - startedAt,
          exitCode:   0,
          output:     { stdout: output },   // Json column — object, not a string
        },
      })

      await db.job.update({
        where: { id: jobId },
        data:  { status: 'pending', lastRunStatus: 'success', retryCount: 0 },
      })
      app.events.emit('job:success', { job_id: jobId, run_id: runId })
      await pushJob(jobId, job.workspaceId)
      log.info('job succeeded', { job_id: jobId, run_id: runId })

    } catch (err: unknown) {
      const msg        = (err as Error).message ?? 'unknown error'
      const finishedAt = Date.now()

      await db.jobRun.update({
        where: { id: runId },
        data: {
          status:     'failed',
          finishedAt: new Date(finishedAt).toISOString(),
          durationMs: finishedAt - startedAt,
          exitCode:   1,
          error:      msg,
        },
      })

      await db.job.update({ where: { id: jobId }, data: { status: 'failed', lastRunStatus: 'failed' } })
      app.events.emit('job:failed', { job_id: jobId, run_id: runId, error: msg })
      await pushJob(jobId, job.workspaceId)
      log.error('job failed', { job_id: jobId, error: msg })

      // Re-throw so Caravan can apply its retry backoff
      throw err
    }
  }

  // ── Register Caravan handler ──────────────────────────────────────
  function register(): void {
    app.jobs.handle<{ id: string; trigger?: string }>('job:run', async (job) => {
      await runJob(job.data.id, job.data.trigger ?? 'manual')
    }, {
      queue:       'jobs',
      maxAttempts: 3,
      retryDelay:  [5_000, 30_000, 120_000],  // 5s, 30s, 2m
    })

    log.info('job engine registered')
  }

  return { register, runJob }
}
