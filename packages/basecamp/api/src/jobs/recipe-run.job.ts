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
import { outbound, outpostFor } from '../providers/outpost.ts'
import { tail, recordServerEvent } from './outpost-run.ts'
import { runsAsCaller } from './context.ts'
import type { BasecampApp } from '../basecamp.types.ts'

async function runRecipe(app: BasecampApp, runId: string): Promise<void> {
  const log = app.logger.child('recipe-run')

  // No client here, and that is the change (`FJS-384`). Caravan records the
  // actor and the tenant at dispatch and junction re-binds both around this
  // handler, so a service call resolves the membership for that actor in that
  // workspace — and a run belonging to another one answers nothing rather than
  // being written by id. The row writes themselves are still system, because
  // `RecipeRun` is update-at-SYSTEM: the schema's statement that an outcome
  // belongs to the machine. `recipes.startRun` is where the two meet.
  const recipes = app.service('recipes')

  let run: Awaited<ReturnType<typeof startRun>>
  try {
    run = await startRun()
  } catch (err) {
    // A run whose recipe or server has gone, or that this actor can no longer
    // reach, is a no-op rather than a crash loop — the same answer the old
    // `if (!run) return` gave, now including *you may not touch this one*.
    log.warn('recipe run not startable', { id: runId, error: (err as Error).message })
    return
  }

  async function startRun() {
    return await recipes.call('startRun', runId) as {
      runId: string; recipeId: string; serverId: string; script: string
      startedAt: string; requestedBy: string | null
      timeoutSeconds: number; recipeName: string
    }
  }

  const script  = run.script
  const timeout = run.timeoutSeconds
  const recipe  = { name: run.recipeName }

  async function finish(data: Record<string, unknown>) {
    await recipes.call('finishRun', runId, data)
  }

  const target = await outpostFor(app, run.serverId)
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
    await recordServerEvent(app, run.serverId, 'recipe_failed',
      `Recipe '${recipe.name}' did not complete (${res.error.kind})`, { run_id: runId })
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

  await recordServerEvent(app, run.serverId, exitCode === 0 ? 'recipe_ran' : 'recipe_failed',
    `Recipe '${recipe.name}' exited ${exitCode}`,
    { run_id: runId, requested_by: run.requestedBy })

  log.info('recipe run finished', { run_id: runId, exit_code: exitCode })
}

// ── The job ───────────────────────────────────────────────────────
// Two attempts, not three. A recipe is somebody's shell script and nothing here can
// know whether it is safe to run twice — the retry that exists covers a
// transport failure, and a non-zero exit is recorded rather than thrown so it
// is never retried at all.

export default defineJob<{ runId: string; workspaceId: string }>('recipe:run', async (ctx) => {
  // Somebody clicked Run. The queue recorded them and the workspace; this
  // refuses if either is missing rather than helping itself to system.
  const { app } = runsAsCaller(ctx, 'recipe:run')
  // `workspaceId` stays on the payload and is no longer read here: the tenant
  // this work is for is the one caravan recorded and junction re-bound, not a
  // value the payload could disagree with.
  await runRecipe(app, ctx.data.runId)
}, {
  queue:       'fleet',
  maxAttempts: 2,
  retryDelay:  [10_000],
})
