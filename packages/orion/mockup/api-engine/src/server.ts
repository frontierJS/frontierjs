/**
 * Orion — Workflow Automation Engine
 * Entry point. Boots the full stack and starts the HTTP server.
 *
 * Usage:
 *   ORION_SECRET=your-secret-key bun run src/server.ts
 *
 * Environment:
 *   ORION_SECRET      — required, used for credential encryption (min 32 chars)
 *   DB_PATH           — SQLite file path          (default: ./orion.db)
 *   PORT              — HTTP port                 (default: 3000)
 *   WORKSPACE_ID      — default workspace         (default: "default")
 *   CONCURRENCY       — scheduler concurrency     (default: 10)
 *   QUEUE_CAPACITY    — max queued jobs            (default: 500)
 *   CHECKPOINT        — checkpoint context (true/false, default: true)
 *   CODE_WORKERS      — data.code worker pool size (default: 3)
 */

import { BunSqliteAdapter, runMigrations }           from "./store/db"
import { SQLiteFlowStore }                            from "./store/flows"
import { SQLiteExecutionStore }                       from "./store/executions"
import { SQLiteCredentialStore, MissingSecretError }  from "./store/credentials"
import { KVStore }                                    from "./store/kv"
import { WaitRegistry }                               from "./store/wait"
import { InMemoryQueue }                              from "./runtime/queue"
import { InMemoryPlanCache }                          from "./runtime/store"
import { Scheduler }                                  from "./runtime/scheduler"
import { EventBus }                                   from "./events"
import { TriggerRegistry }                            from "./triggers/registry"
import { CronScheduler }                              from "./triggers/cron"
import { TriggerRouter }                              from "./triggers/router"
import { WorkflowActivator }                          from "./triggers/activator"
import { Compiler }                                   from "./compiler"
import { PluginRegistry }                             from "./plugins"
import { createNodeImplementations }                  from "./nodes"
import { AIProviderRegistry }                         from "./nodes/providers"
import { CodeWorkerPool }                             from "./nodes/code-worker-pool"
import type { NodeContext }                           from "./executor"
import { ApiRouter }                                  from "./api"

// ─────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────

const PORT         = Number(process.env["PORT"]          ?? 3000)
const DB_PATH      = process.env["DB_PATH"]               ?? "./orion.db"
const WORKSPACE    = process.env["WORKSPACE_ID"]          ?? "default"
const CONCURRENCY  = Number(process.env["CONCURRENCY"]    ?? 10)
const CAPACITY     = Number(process.env["QUEUE_CAPACITY"] ?? 500)
const CHECKPOINT   = process.env["CHECKPOINT"] !== "false"
const CODE_WORKERS = Number(process.env["CODE_WORKERS"]   ?? 3)

// ─────────────────────────────────────────────
// BOOT
// ─────────────────────────────────────────────

async function boot() {

  // ── 1. Guard — require secret before touching DB ─────────────────
  if (!process.env["ORION_SECRET"]) {
    throw new MissingSecretError()
  }

  // ── 2. Database ───────────────────────────────────────────────────
  const db = new BunSqliteAdapter(DB_PATH)
  runMigrations(db)

  // ── 3. Store layer ────────────────────────────────────────────────
  const flowStore = new SQLiteFlowStore(db)
  const execStore = new SQLiteExecutionStore(db)
  const credStore = new SQLiteCredentialStore(db)
  const kv        = new KVStore(db)
  const waitReg   = new WaitRegistry(db)

  // ── 4. Plugin registry ─────────────────────────────────────────────
  const pluginRegistry = new PluginRegistry()
  const aiProviders    = new AIProviderRegistry()
  const codePool       = new CodeWorkerPool(CODE_WORKERS)

  const impls = createNodeImplementations({
    kv, waitReg, aiProviders, workspaceId: WORKSPACE, codePool,
  })

  for (const impl of impls) {
    pluginRegistry.registerImpl(impl)
  }

  // ── 5. Credential-aware registry wrapper ──────────────────────────
  //
  // Nodes declare config.credential = "<id>".
  // Before execute() is called, we look up the credential, decrypt it,
  // and inject the data into config:
  //   - ai node          → config.__provider = { provider, ...data }
  //   - http credential  → config.headers merged with data fields
  //
  // This wrapper sits between the Scheduler and the real PluginRegistry.
  // No other layer knows credentials exist.

  const credentialAwareRegistry = {
    get(type: string) {
      const impl = pluginRegistry.get(type)
      if (!impl) return undefined
      return {
        type: impl.type,
        async execute(ctx: NodeContext) {
          const credId = ctx.config.credential
          if (typeof credId === "string" && credId) {
            const cred = credStore.get(credId)
            if (!cred) {
              return { ok: false as const, error: `Credential "${credId}" not found` }
            }
            if (type === "ai" || cred.provider !== "http") {
              ctx = {
                ...ctx,
                config: {
                  ...ctx.config,
                  __provider: { provider: cred.provider, ...cred.data },
                },
              }
            } else {
              const existing = (ctx.config.headers as Record<string, string> | undefined) ?? {}
              ctx = {
                ...ctx,
                config: {
                  ...ctx.config,
                  headers: { ...cred.data, ...existing },
                },
              }
            }
          }
          return impl.execute(ctx)
        },
      }
    },
  }

  const status = pluginRegistry.status()
  if (!status.ready) {
    console.warn(`⚠  Missing implementations: ${status.missingImplementations.join(", ")}`)
  }

  // ── 6. Runtime ────────────────────────────────────────────────────
  const queue    = new InMemoryQueue(CAPACITY)
  const plans    = new InMemoryPlanCache()
  const eventBus = new EventBus(queue)
  const registry = new TriggerRegistry()
  const cron     = new CronScheduler(queue)
  const compiler = new Compiler(pluginRegistry)

  // ── 7. HTTP router ────────────────────────────────────────────────
  const router = new TriggerRouter(queue, plans, registry, eventBus, execStore, waitReg)

  // ── 8. Scheduler ──────────────────────────────────────────────────
  const scheduler = new Scheduler(
    queue, plans, execStore, credentialAwareRegistry, undefined,
    { concurrency: CONCURRENCY, checkpoint: CHECKPOINT },
  )

  // ── 9. Activate persisted flows ───────────────────────────────────
  const flows     = flowStore.listActive()
  const activator = new WorkflowActivator(compiler, plans, router, cron, eventBus, registry)

  // ── API router (needs activator for hot-reload) ───────────────────
  const apiRouter = new ApiRouter({ flowStore, credStore, execStore, activator, workspaceId: WORKSPACE })

  // Combined fetch handler — API routes take priority, then trigger routes
  const fetch = async (req: Request): Promise<Response> => {
    const apiRes = await apiRouter.handle(req)
    if (apiRes) return apiRes
    return router.handle(req)
  }
  const results   = await activator.activate(flows)

  let activated = 0
  for (const r of results) {
    if (r.ok) {
      console.log(`  ✓ flow:${r.flowId}  (${r.triggers} trigger${r.triggers !== 1 ? "s" : ""})`)
      activated++
    } else {
      console.error(`  ✗ flow:${r.flowId}  ${r.error}`)
    }
  }

  if (flows.length === 0) {
    console.log("  No flows registered yet. POST a flow definition to get started.")
  } else {
    console.log(`  ${activated}/${flows.length} flows activated`)
  }

  // ── 10. Background sweep — hourly ─────────────────────────────────
  const runSweep = async () => {
    const kvCount  = kv.purgeExpired()
    const expired  = waitReg.getExpired()
    waitReg.deleteExpired()

    // Mark timed-out waiting executions as failed
    for (const entry of expired) {
      try {
        const ctx = await execStore.getContext(entry.executionId)
        if (!ctx) continue
        const now = Date.now()
        await execStore.saveRecord({
          executionId:  ctx.executionId,
          flowId:       ctx.flowId,
          version:      ctx.version,
          status:       "failed",
          trigger:      ctx.trigger,
          startedAt:    ctx.startedAt,
          endedAt:      now,
          durationMs:   now - ctx.startedAt,
          nodeStates:   ctx.nodeStates,
          nodeTimings:  {},
          slowNodes:    [],
          error:        `flow.wait timed out waiting for event "${entry.nodeId}"`,
          finalContext: ctx.nodes,
        })
      } catch { /* best-effort — log and continue */ }
    }

    if (kvCount > 0 || expired.length > 0) {
      console.log(`[sweep] purged ${kvCount} KV entries, ${expired.length} wait timeouts`)
    }
  }

  setInterval(runSweep, 60 * 60 * 1_000)

  // ── 11. Start execution loop ──────────────────────────────────────
  scheduler.run()

  // ── 12. Start HTTP server ─────────────────────────────────────────
  const server = Bun.serve({ port: PORT, fetch })

  console.log(`\nOrion  db=${DB_PATH}  workspace=${WORKSPACE}`)
  console.log(`Listening → http://localhost:${server.port}\n`)
  console.log(`  ── Flows ─────────────────────────────────────────────`)
  console.log(`  POST   /api/flows                    create + activate`)
  console.log(`  GET    /api/flows                    list active flows`)
  console.log(`  GET    /api/flows/:id                get flow`)
  console.log(`  PUT    /api/flows/:id                update + hot-reload`)
  console.log(`  DELETE /api/flows/:id                archive + deactivate`)
  console.log(`  GET    /api/flows/:id/versions       version history`)
  console.log(`  POST   /api/flows/:id/activate       activate flow`)
  console.log(`  POST   /api/flows/:id/deactivate     deactivate flow`)
  console.log(`  GET    /api/flows/:id/layout         visual layout`)
  console.log(`  PUT    /api/flows/:id/layout         save layout`)
  console.log(`  GET    /api/flows/:id/executions     execution history`)
  console.log(`  GET    /api/flows/:id/metrics        performance metrics`)
  console.log(`  ── Credentials ───────────────────────────────────────`)
  console.log(`  POST   /api/credentials              create credential`)
  console.log(`  GET    /api/credentials              list credentials`)
  console.log(`  GET    /api/credentials/:id          get credential`)
  console.log(`  PUT    /api/credentials/:id          update credential`)
  console.log(`  DELETE /api/credentials/:id          delete credential`)
  console.log(`  ── Executions ────────────────────────────────────────`)
  console.log(`  GET    /api/executions               list executions`)
  console.log(`  GET    /api/executions/:id           get execution`)
  console.log(`  GET    /api/metrics                  global metrics`)
  console.log(`  ── Triggers ──────────────────────────────────────────`)
  console.log(`  POST   /hooks/:path                  webhook trigger`)
  console.log(`  POST   /wait/:resumeKey              resume flow.wait`)
  console.log(`  POST   /events/:name                 emit event`)
  console.log(`  POST   /flows/:id/trigger            manual trigger`)
  console.log(`  GET    /admin/health                 health`)
  console.log(`  GET    /admin/triggers               active triggers`)

  // ── 13. Graceful shutdown ─────────────────────────────────────────
  const shutdown = async () => {
    console.log("\nShutting down...")
    server.stop()
    await codePool.drain()
    db.close()
    process.exit(0)
  }

  process.on("SIGINT",  shutdown)
  process.on("SIGTERM", shutdown)
}

boot().catch(err => {
  console.error("\nBoot failed:", err instanceof Error ? err.message : err)
  process.exit(1)
})
