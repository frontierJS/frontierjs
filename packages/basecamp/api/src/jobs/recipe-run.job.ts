import { $ } from '@frontierjs/junction'
// src/jobs/recipe-run.job.ts
// Runs one Recipe on one machine. Dispatched as `recipe:run`.
//
// The handler takes a run ID and nothing else. The row is the queue's payload:
// re-reading it means a retry acts on the current state rather than on a
// snapshot taken when the click happened, and a run that vanished (its recipe
// deleted, its server destroyed) is a no-op instead of a crash loop.
//
// Caravan owns retry and crash recovery. This is the execution logic for one
// run, and it throws so the queue can apply its own backoff.

import { defineJob } from '@frontierjs/caravan'
import { announce }   from '../channels.ts'
import { outbound, outpostFor } from '../providers/outpost.ts'
import { tail, recordServerEvent } from './outpost-run.ts'
import { appFrom }    from './context.ts'
import type { BasecampApp } from '../basecamp.types.ts'

async function runRecipe(app: BasecampApp, runId: string, workspaceId: string): Promise<void> {
  // asSystem(): a job runs on the queue's thread, not a request's. There is
  // no caller to scope to, and it legitimately writes any workspace's rows.
  const db  = app.data.asSystem() as any
  const log = app.logger.child('recipe-run')

  const run = await db.recipeRun.findUnique({ where: { id: runId } })
  if (!run) { log.warn('recipe run not found', { id: runId }); return }

  const startedAt  = Date.now()
  const startedIso = new Date(startedAt).toISOString()

  await db.recipeRun.update({ where: { id: runId }, data: { status: 'running', startedAt: startedIso } })
  announce(app, workspaceId, 'recipes patched', { id: run.recipeId })

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
    announce(app, workspaceId, 'recipes patched', { id: run.recipeId })
  }

  const target = await outpostFor(app, run.serverId as string)
  if (!target) {
    // Not thrown: there is nothing to retry. The machine has no outpost, and
    // the row saying so is the answer.
    await finish({ status: 'failed', error: 'No outpost is registered for this server' })
    return
  }

  const res = await outbound(app).send<{ exit_code?: number; stdout?: string; stderr?: string }>({
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
    await recordServerEvent(app, run.serverId as string, 'recipe_failed',
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

  await recordServerEvent(app, run.serverId as string, exitCode === 0 ? 'recipe_ran' : 'recipe_failed',
    `Recipe '${recipe?.name ?? 'unknown'}' exited ${exitCode}`,
    { run_id: runId, requested_by: run.requestedBy })

  log.info('recipe run finished', { run_id: runId, exit_code: exitCode })
}

// ── The job ───────────────────────────────────────────────────────
// Two attempts, not three. A recipe is somebody's shell script and nothing here can
// know whether it is safe to run twice — the retry that exists covers a
// transport failure, and a non-zero exit is recorded rather than thrown so it
// is never retried at all.

export default defineJob<{ runId: string; workspaceId: string }>('recipe:run', async (ctx) => {
  const app = appFrom(ctx, 'recipe:run')
  await runRecipe(app, ctx.data.runId, ctx.data.workspaceId)
}, {
  queue:       'fleet',
  maxAttempts: 2,
  retryDelay:  [10_000],
})
