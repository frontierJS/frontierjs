/*
 * app.ts
 *
 * An app with orion installed, for the suites that need the app's own models:
 * two models gated differently and a versioned, soft-deleting one beside orion's, the catalog read off
 * litestone's own JSON Schema, a Caravan queue over a real jobs file, and the
 * actor a principal-scoped client graded by litestone's default resolver. So a
 * refusal a suite asserts is the Data boundary's.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createTestEnv } from "../../../litestone/src/testing.js"
import { generateJsonSchema } from "../../../litestone/src/jsonschema.js"
import { createCaravan } from "../../../caravan/src/index"
import { createRunner, type Runner } from "../../src/runner"
import { litestoneHost } from "../../src/tenancy"
import { modelCatalog, litestoneModelActions } from "../../src/models"
import type { Expression, NodeDefinition } from "../../src/engine/types"
import { SCHEMA, KEY, registryFor } from "./host"

// Notifications' own model, as an app appends it, so the notify node writes a
// real in-app row.
const NOTIFICATION = readFileSync(join(import.meta.dir, "..", "..", "..", "notifications", "db", "notification.lite"), "utf8")

export const APP = SCHEMA + NOTIFICATION + `
model Lead {
  id        Int     @id
  name      String
  tier      String?
  internal  String? @guarded
  // Read by an administrator alone, so a row one writes is not the row a USER reads.
  score     Int?    @allow('read', auth().isAdmin == true)
  @@gate("4.4.4.4")
}

// Read at ADMINISTRATOR, so a USER's flow cannot hear one written.
model Memo {
  id    Int    @id
  body  String
  @@gate("5.5.5.5")
}

model Invoice {
  id     Int  @id
  total  Int
  @@gate("4.5.5.5")
}

model Note {
  id        Int       @id
  body      String
  version   Int       @version
  deletedAt DateTime?
  @@gate("4.4.4.4")
  @@softDelete
}
`

// Standing comes off these under litestone's default resolver: a role is
// USER(4), isAdmin is ADMINISTRATOR(5).
export const PRINCIPALS: Record<string, object> = {
  "u-user":  { id: "u-user",  role: "member" },
  "u-admin": { id: "u-admin", role: "admin", isAdmin: true },
}

export interface AppHost {
  env:    any
  dir:    string
  jobs:   ReturnType<typeof createCaravan>
  runner: Runner
  stop(): Promise<void>
  settled(runId: string, statuses?: string[], ms?: number): Promise<any>
}

export async function appHost(opts: { start?: boolean } = {}): Promise<AppHost> {
  const dir  = mkdtempSync(join(tmpdir(), "orion-app-"))
  const env: any = await createTestEnv({ schema: APP, encryptionKey: KEY, claims: [] })
  const jobs = createCaravan({ db: join(dir, "jobs.db"), pollInterval: 20, heartbeat: 100, lease: 2_000, cleanupAfter: 0 })

  const names  = env.schema.models.map((m: any) => m.name)
  const runner = createRunner({
    host:     litestoneHost({ db: env.db }),
    jobs,
    registry: registryFor(dir, { models: litestoneModelActions(names) }),
    catalog:  {
      models: modelCatalog({
        create: generateJsonSchema(env.schema, { mode: "create" }),
        update: generateJsonSchema(env.schema, { mode: "update" }),
        models: names,
      }),
    },
    withActor: (actorId, _tenant, fn) => {
      const principal = actorId ? PRINCIPALS[actorId] : undefined
      if (!principal) return Promise.reject(new Error(`no user "${actorId}"`))
      return fn(env.actingAs(principal))
    },
  })
  runner.register()
  if (opts.start !== false) await jobs.start()

  return {
    env, dir, jobs, runner,
    async stop() {
      await jobs.stop()
      rmSync(dir, { recursive: true, force: true })
    },
    async settled(runId, statuses = ["completed", "failed", "cancelled", "waiting"], ms = 5_000) {
      const until = Date.now() + ms
      for (;;) {
        const run = await env.system.run.findFirst({ where: { id: runId }, include: { steps: true, waits: true } })
        if (run && statuses.includes(run.status)) return run
        if (Date.now() > until) throw new Error(`run ${runId} is ${run?.status} after ${ms}ms`)
        await Bun.sleep(20)
      }
    },
  }
}

// ─── node builders ───────────────────────────────────────────────────────────

export const lit = (value: unknown): Expression => ({ type: "literal", value })

export const obj = (fields: Record<string, unknown>): Expression =>
  ({ type: "object", properties: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, lit(v)])) })

export const create = (id: string, model: string | Expression, data: Expression): NodeDefinition =>
  ({ id, type: "model.create", config: { model: typeof model === "string" ? lit(model) : model, data } })
