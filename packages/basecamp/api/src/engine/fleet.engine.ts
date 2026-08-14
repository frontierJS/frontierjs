// src/engine/fleet.engine.ts
// The two things this app asks a MACHINE to do — run a recipe, sweep its disk.
//
// One file for both, because they are one shape: resolve the outpost, send one
// request through Conduit, record what came back on the run row, tell the open
// screens. What differs is the safeguard around each, and that lives in the
// services (`recipes` is admin to author, `cleanup` names declared targets) —
// by the time work reaches here the decision has been made and the row exists.
//
// Both handlers take a run ID and nothing else. The row is the queue's payload:
// re-reading it means a retry acts on the current state rather than on a
// snapshot taken when the click happened, and a run that vanished (its recipe
// deleted, its server destroyed) is a no-op instead of a crash loop.
//
// Caravan owns retry and crash recovery. This is the execution logic for one
// run, and it throws so the queue can apply its own backoff.

import { applyDiskReport } from '../services/cleanup/cleanup.service.ts'
import type { BasecampApp } from '../basecamp.types.ts'

/** Output kept per run, per stream. An outpost that cats a log file can answer
 *  megabytes, and a row nothing can render is a row nobody reads — the tail is
 *  what a person wants anyway, so the head is what gets cut. */
const OUTPUT_LIMIT = 32_000

function tail(text: unknown): string | null {
  const s = typeof text === 'string' ? text : text == null ? '' : String(text)
  if (!s) return null
  if (s.length <= OUTPUT_LIMIT) return s
  return `… ${s.length - OUTPUT_LIMIT} earlier characters dropped …\n` + s.slice(-OUTPUT_LIMIT)
}

export function createFleetEngine(app: BasecampApp) {

  // asSystem(): the engine runs on Caravan's thread, not a request's. There is
  // no caller to scope to, and it legitimately writes to any workspace's rows.
  const db  = app.data.asSystem() as any
  const log = app.logger.child('fleet-engine')

  /**
   * Tell anyone watching.
   *
   * A Channel's method is `send(event, data)` — `publish()` is on the MANAGER,
   * and calling it on a channel is a silent no-op (the deployment engine did
   * exactly that for its whole life). The event name is what the browser
   * client's service proxy dispatches on, so 'recipes patched' reaches
   * `service.on('patched')` and any '*' listener.
   */
  function push(workspaceId: string, event: string, row: unknown): void {
    const manager = (app as unknown as Record<string, unknown>).channels as
      { channel: (n: string) => { send?: (e: string, d: unknown) => void } | undefined } | undefined

    manager?.channel?.(`workspace:${workspaceId}`)?.send?.(event, row)
  }

  /** The outbound boundary, or a throw. Both handlers below are nothing but a
   *  request to a machine, so an app configured without conduit cannot run
   *  either — and `app.conduit` is optional on the type, which is what makes
   *  this one function rather than three non-null assertions. */
  function outbound() {
    if (!app.conduit) throw new Error('Outbound delivery is not configured — no conduit plugin')
    return app.conduit
  }

  /** The outpost for a server, or null. Registered on heartbeat, so null means
   *  the machine has never checked in with a URL. */
  async function outpostFor(serverId: string): Promise<string | null> {
    const target = `outpost:${serverId}`
    return await outbound().resolve(target).catch(() => null) ? target : null
  }

  async function recordEvent(
    serverId: string, kind: string, message: string, metadata: Record<string, unknown> = {},
  ) {
    await db.serverEvent.create({ data: { serverId, kind, message, metadata } })
  }

  // ─── recipe:run ────────────────────────────────────────────────────────

  async function runRecipe(runId: string, workspaceId: string): Promise<void> {
    const run = await db.recipeRun.findUnique({ where: { id: runId } })
    if (!run) { log.warn('recipe run not found', { id: runId }); return }

    const startedAt  = Date.now()
    const startedIso = new Date(startedAt).toISOString()

    await db.recipeRun.update({ where: { id: runId }, data: { status: 'running', startedAt: startedIso } })
    push(workspaceId, 'recipes patched', { id: run.recipeId })

    // Read from the RUN, not from the recipe. The recipe is editable and this
    // is the script that was queued; running the current text would mean an
    // edit made while a fleet run was in flight reached half the machines.
    const script  = run.script as string
    const recipe  = await db.recipe.findUnique({ where: { id: run.recipeId } })
    const timeout = (recipe?.timeoutSeconds as number | undefined) ?? 300

    async function finish(data: Record<string, unknown>) {
      const finishedAt = Date.now()
      await db.recipeRun.update({
        where: { id: runId },
        data: {
          ...data,
          finishedAt: new Date(finishedAt).toISOString(),
          durationMs: finishedAt - startedAt,
        },
      })
      // Bookkeeping the list reads. Counted per SERVER, because that is what a
      // run is here: a recipe let loose on five machines ran five times.
      await db.recipe.update({
        where: { id: run.recipeId },
        data:  { lastRunAt: new Date(finishedAt).toISOString(), runCount: ((recipe?.runCount as number) ?? 0) + 1 },
      })
      push(workspaceId, 'recipes patched', { id: run.recipeId })
    }

    const target = await outpostFor(run.serverId as string)
    if (!target) {
      // Not thrown: there is nothing to retry. The machine has no outpost, and
      // the row saying so is the answer.
      await finish({ status: 'failed', error: 'No outpost is registered for this server' })
      return
    }

    const res = await outbound().send<{ exit_code?: number; stdout?: string; stderr?: string }>({
      target,
      method:     'POST',
      path:       '/exec',
      body:       { command: script, timeout_s: timeout, recipe_run_id: runId },
      timeout_ms: (timeout + 5) * 1_000,
    })

    if (res.error) {
      // A timeout is its own state, not a failure: the script may well have
      // finished the work and lost the answer, and an operator reading the
      // history needs to be able to tell those apart.
      const status = res.error.kind === 'timeout' ? 'timeout' : 'failed'
      await finish({ status, error: `${res.error.kind}: ${res.error.message}` })
      await recordEvent(run.serverId as string, 'recipe_failed',
        `Recipe '${recipe?.name ?? 'unknown'}' did not complete (${res.error.kind})`, { run_id: runId })
      throw new Error(res.error.message)
    }

    const exitCode = Number(res.data?.exit_code ?? 0)
    await finish({
      status:   exitCode === 0 ? 'success' : 'failed',
      exitCode,
      stdout:   tail(res.data?.stdout),
      stderr:   tail(res.data?.stderr),
      // A non-zero exit is the script's own answer, not a transport failure —
      // so it is recorded and NOT thrown. Retrying `rm -rf` because it exited 1
      // is how a retry policy makes things worse.
      error:    exitCode === 0 ? null : `exited ${exitCode}`,
    })

    await recordEvent(run.serverId as string, exitCode === 0 ? 'recipe_ran' : 'recipe_failed',
      `Recipe '${recipe?.name ?? 'unknown'}' exited ${exitCode}`,
      { run_id: runId, requested_by: run.requestedBy })

    log.info('recipe run finished', { run_id: runId, exit_code: exitCode })
  }

  // ─── cleanup:run ───────────────────────────────────────────────────────

  async function runCleanup(runId: string, workspaceId: string): Promise<void> {
    const run = await db.cleanupRun.findUnique({ where: { id: runId } })
    if (!run) { log.warn('cleanup run not found', { id: runId }); return }

    const startedAt  = Date.now()
    const startedIso = new Date(startedAt).toISOString()

    await db.cleanupRun.update({ where: { id: runId }, data: { status: 'running', startedAt: startedIso } })
    push(workspaceId, 'cleanup patched', run)

    async function finish(data: Record<string, unknown>) {
      const finishedAt = Date.now()
      const updated = await db.cleanupRun.update({
        where: { id: runId },
        data: {
          ...data,
          finishedAt: new Date(finishedAt).toISOString(),
          durationMs: finishedAt - startedAt,
        },
      })
      push(workspaceId, 'cleanup patched', updated)
      return updated
    }

    const target = await outpostFor(run.serverId as string)
    if (!target) {
      await finish({ status: 'failed', error: 'No outpost is registered for this server' })
      return
    }

    const res = await outbound().send<{
      freed_bytes?: number
      removed?:     Record<string, unknown>
      volumes?:     string[]
      usage?:       Parameters<typeof applyDiskReport>[2]
    }>({
      target,
      method:     'POST',
      path:       '/system/prune',
      body:       { targets: run.targets, keep_images: run.keepImages, cleanup_run_id: runId },
      // A sweep of a build-runner's cache is minutes, not seconds. Conduit's
      // default is 10s, which would report every real cleanup as a timeout.
      timeout_ms: 300_000,
    })

    if (res.error) {
      const status = res.error.kind === 'timeout' ? 'timeout' : 'failed'
      await finish({ status, error: `${res.error.kind}: ${res.error.message}` })
      await recordEvent(run.serverId as string, 'cleanup_failed',
        `Disk cleanup did not complete (${res.error.kind})`, { run_id: runId })
      throw new Error(res.error.message)
    }

    const freedBytes = Math.max(0, Math.round(Number(res.data?.freed_bytes ?? 0)))

    // Exactly the volumes the outpost says it removed, never the ones it was
    // asked about. Same rule `volumes.prune` follows: an outpost that could
    // delete three of five leaves the fourth on disk, and forgetting the row
    // is how that disk becomes invisible.
    const gone = Array.isArray(res.data?.volumes) ? res.data!.volumes! : []
    if (gone.length)
      await db.volume.deleteMany({ where: { serverId: run.serverId, name: { in: gone } } })

    // The outpost has just run `docker system df` to work out what it freed, so
    // its answer is a fresher picture than the last report. Written through the
    // same function the report endpoint uses, so the two cannot disagree about
    // which key means what.
    if (res.data?.usage) await applyDiskReport(db, run.serverId as string, res.data.usage)

    await finish({
      status:     'success',
      freedBytes,
      detail:     { removed: res.data?.removed ?? {}, volumes: gone },
    })

    await recordEvent(run.serverId as string, 'cleanup_ran',
      `Disk cleanup freed ${freedBytes} bytes`,
      { run_id: runId, targets: run.targets, requested_by: run.requestedBy })

    log.info('cleanup run finished', { run_id: runId, freed_bytes: freedBytes })
  }

  // ── Register Caravan handlers ──────────────────────────────────────
  function register(): void {
    app.jobs.handle<{ runId: string; workspaceId: string }>('recipe:run', async (job) => {
      await runRecipe(job.data.runId, job.data.workspaceId)
    }, {
      queue:       'fleet',
      // Two attempts, not three. A recipe is somebody's shell script and this
      // engine cannot know whether it is safe to run twice — the retry that
      // exists covers a transport failure, and a non-zero exit is recorded
      // rather than thrown so it is never retried at all.
      maxAttempts: 2,
      retryDelay:  [10_000],
    })

    app.jobs.handle<{ runId: string; workspaceId: string }>('cleanup:run', async (job) => {
      await runCleanup(job.data.runId, job.data.workspaceId)
    }, {
      queue:       'fleet',
      maxAttempts: 2,
      retryDelay:  [10_000],
    })

    log.info('fleet engine registered')
  }

  return { register, runRecipe, runCleanup }
}
