/*
 * crash.test.ts
 *
 * Phase 3's done-when, run as written: a process is killed mid-stage and the
 * run completes on restart.
 *
 * Two real processes over one database file and one jobs file. The first runs
 * the flow until its third stage is in flight and is SIGKILLed there, holding a
 * claimed job and an open stage — no shutdown hook, no drain. The second is a
 * new Caravan instance: it reclaims the job once the first stops heartbeating,
 * the job reads the checkpoint, and the run finishes.
 *
 * What proves it is on disk: the node before the crash ran ONCE, because its
 * stage was checkpointed before the kill; the node after ran once; and the job
 * took two attempts. The stage in flight runs again, which is the at-least-once
 * the paper states.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Subprocess } from "bun"

import { createTestEnv } from "../../litestone/src/testing.js"
import { createCaravan } from "../../caravan/src/index"
import { litestoneHost } from "../src/tenancy"
import { createRunner } from "../src/runner"
import { SCHEMA, KEY, registryFor, ranIn, chain, count, hang, activeFlow } from "./fixtures/host"

let env:  any
let dir:  string
let jobsPath: string
const children: Subprocess[] = []

beforeAll(async () => {
  dir      = mkdtempSync(join(tmpdir(), "orion-crash-"))
  jobsPath = join(dir, "jobs.db")
  env      = await createTestEnv({ schema: SCHEMA, encryptionKey: KEY, claims: [] })
})

afterAll(() => {
  for (const child of children) child.kill("SIGKILL")
  rmSync(dir, { recursive: true, force: true })
})

function worker(extra: Record<string, string> = {}): Subprocess {
  const child = Bun.spawn(["bun", join(import.meta.dir, "fixtures", "worker.ts")], {
    env:    { ...process.env, ORION_DB: env.path, ORION_JOBS: jobsPath, ORION_DIR: dir, ...extra },
    stdout: "pipe",
    stderr: "pipe",
  })
  children.push(child)
  return child
}

async function until<T>(what: string, fn: () => Promise<T | undefined> | T | undefined, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const got = await fn()
    if (got) return got
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(25)
  }
}

describe("a process killed mid-stage", () => {
  test("the run completes on restart, and no finished stage runs again", async () => {
    const flowId = await activeFlow(env.system, chain([count("before"), hang("inflight"), count("after")]))
    writeFileSync(join(dir, "hang"), "")

    // The trigger's side: a queue that is never started, only dispatched into.
    const intake = createCaravan({ db: jobsPath })
    const runId  = await createRunner({ host: litestoneHost({ db: env.db }), jobs: intake, registry: registryFor(dir) }).start(flowId, {})

    const first = worker()
    await until("the stage to be in flight", () => existsSync(join(dir, "entered")))

    const checkpointed = await env.system.run.findFirst({ where: { id: runId } })
    expect(checkpointed.status).toBe("running")
    expect(checkpointed.currentStage).toBe(1)
    expect(ranIn(dir, runId)).toEqual({ before: 1 })

    first.kill("SIGKILL")
    await first.exited
    writeFileSync(join(dir, "release"), "")

    const second = worker()
    const run = await until("the run to finish", async () => {
      if (second.exitCode !== null) throw new Error(`the restarted worker exited (${second.exitCode})`)
      const row = await env.system.run.findFirst({ where: { id: runId }, include: { steps: true } })
      return row && ["completed", "failed"].includes(row.status) ? row : undefined
    })

    expect(run.status).toBe("completed")
    expect(ranIn(dir, runId)).toEqual({ before: 1, after: 1 })
    expect(Object.fromEntries(run.steps.map((s: any) => [s.nodeId, s.status])))
      .toEqual({ t: "completed", before: "completed", inflight: "completed", after: "completed" })
    expect(intake.find(`run:${runId}`)?.attempts).toBe(2)
  }, 30_000)
})

describe("a sync webhook run whose process is killed", () => {
  test("the sweep leaves it while its process beats, and hands it to a job once it stops", async () => {
    for (const marker of ["entered", "release"]) rmSync(join(dir, marker), { force: true })
    writeFileSync(join(dir, "hang"), "")
    const lostAfter = 300
    const flowId    = await activeFlow(env.system, chain([count("before"), hang("inflight"), count("after")]))

    const first = worker({ ORION_INLINE: flowId, ORION_LOST_AFTER: String(lostAfter) })
    await until("the stage to be in flight", () => existsSync(join(dir, "entered")))
    const [version] = await env.system.flowVersion.findMany({ where: { flowId }, include: { runs: true } })
    const runId     = version.runs[0].id as string

    // Here and not in a worker: this sweep's instance runs what it dispatches.
    const jobs  = createCaravan({ db: jobsPath, pollInterval: 20, heartbeat: 100, lease: 1_000, cleanupAfter: 0 })
    const local = createRunner({ host: litestoneHost({ db: env.db }), jobs, registry: registryFor(dir), lostAfter })
    local.register()

    // The stage has hung for longer than lostAfter by the time this asks, and a
    // live heartbeat is what keeps the run its process's.
    await Bun.sleep(lostAfter * 2)
    expect((await local.sweep()).redispatched).toBe(0)
    expect(jobs.find(`run:${runId}`)).toBeNull()

    first.kill("SIGKILL")
    await first.exited
    writeFileSync(join(dir, "release"), "")

    await Bun.sleep(lostAfter * 2)
    expect((await local.sweep()).redispatched).toBe(1)
    await jobs.start()
    try {
      const run = await until("the run to finish", async () => {
        const row = await env.system.run.findFirst({ where: { id: runId }, include: { steps: true } })
        return row && ["completed", "failed"].includes(row.status) ? row : undefined
      })
      expect(run.status).toBe("completed")
      expect(run.heartbeatAt).toBeNull()
      expect(ranIn(dir, runId)).toEqual({ before: 1, after: 1 })
      expect((await local.sweep()).redispatched).toBe(0)
    } finally {
      await jobs.stop()
    }
  }, 30_000)
})
