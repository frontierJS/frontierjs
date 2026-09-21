/*
 * host.ts
 *
 * What a host supplies to orion, assembled for the suites and for the child
 * process `test/crash.test.ts` kills: the schema text, a node registry with
 * the built-in nodes and two test nodes, and the flow definitions they run.
 *
 * The test nodes leave their evidence on DISK, because the crash test asks a
 * question no in-memory counter can answer across a process that was killed:
 * did this node run once or twice.
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { PluginRegistry } from "../../src/engine/plugins"
import { createNodeImplementations, type NodeDeps } from "../../src/engine/nodes"
import { CodeWorkerPool } from "../../src/engine/nodes/code-worker-pool"
import type { INodeImplementation, NodeContext } from "../../src/engine/executor"
import type { Expression, NodeDefinition } from "../../src/engine/types"

export const SCHEMA = 'database main { path "./orion.db" }\n'
  + readFileSync(join(import.meta.dir, "..", "..", "db", "orion.lite"), "utf8")

export const KEY = "0".repeat(64)

// ─── nodes ───────────────────────────────────────────────────────────────────

const lit = (value: unknown): Expression => ({ type: "literal", value })

/**
 * `test.count` appends its `name` to `<dir>/<runId>.log` and answers what the
 * run's context holds under `read`. `test.hang` never settles while
 * `<dir>/hang` exists and `<dir>/release` does not, and writes `<dir>/entered`
 * first so a test knows the stage is in flight.
 */
export function registryFor(dir: string, deps: Partial<NodeDeps> = {}): PluginRegistry {
  const registry = new PluginRegistry()
  const builtins = createNodeImplementations({
    kv:          { get: async () => undefined, set: async () => {}, delete: async () => false },
    codePool:    new CodeWorkerPool(0),
    ...deps,
  })
  for (const impl of builtins) registry.registerImpl(impl)

  const count: INodeImplementation = {
    type: "test.count",
    async execute(ctx: NodeContext) {
      appendFileSync(join(dir, `${ctx.executionId}.log`), `${String(ctx.config["name"])}\n`)
      const read = ctx.config["read"]
      return { ok: true, data: { read: typeof read === "string" ? (ctx.nodes as any)[read] ?? null : null } }
    },
  }
  const hang: INodeImplementation = {
    type: "test.hang",
    async execute() {
      if (existsSync(join(dir, "hang")) && !existsSync(join(dir, "release"))) {
        writeFileSync(join(dir, "entered"), String(process.pid))
        await new Promise(() => {})
      }
      return { ok: true, data: { released: true } }
    },
  }

  registry.register({
    id: "suite", name: "suite", version: "0.0.0",
    nodes: [
      { type: "test.count", category: "transform", label: "Count", description: "Leaves a line on disk" },
      { type: "test.hang",  category: "transform", label: "Hang",  description: "Holds its stage open" },
    ],
  }, [count, hang])
  return registry
}

/** How many times each node ran in one run, off the log `test.count` writes. */
export function ranIn(dir: string, runId: string): Record<string, number> {
  const file = join(dir, `${runId}.log`)
  if (!existsSync(file)) return {}
  const counts: Record<string, number> = {}
  for (const id of readFileSync(file, "utf8").split("\n").filter(Boolean)) counts[id] = (counts[id] ?? 0) + 1
  return counts
}

// ─── flows ───────────────────────────────────────────────────────────────────

/** A chain: a manual trigger, then each node in order, one per stage. */
export function chain(steps: Array<Omit<NodeDefinition, "id"> & { id: string }>, trigger = "trigger.manual") {
  const nodes: Record<string, NodeDefinition> = { t: { id: "t", type: trigger, config: {} } }
  const edges = []
  let prev = "t"
  for (const step of steps) {
    nodes[step.id] = step
    edges.push({ id: `${prev}-${step.id}`, from: prev, to: step.id })
    prev = step.id
  }
  return { name: "suite", nodes, edges }
}

export const count = (id: string, read?: string): NodeDefinition =>
  ({ id, type: "test.count", config: { name: lit(id), ...(read ? { read: lit(read) } : {}) } })

export const hang = (id: string): NodeDefinition =>
  ({ id, type: "test.hang", config: {} })

export const wait = (id: string, into: string, timeoutMs?: number): NodeDefinition =>
  ({ id, type: "flow.wait", config: { event: lit("approval"), resumeKey: lit(into), ...(timeoutMs ? { timeoutMs: lit(timeoutMs) } : {}) } })

export const cronTrigger = (expression: string): NodeDefinition =>
  ({ id: "t", type: "trigger.cron", config: { expression: lit(expression) } })

/** An active flow at version 1, owned by `ownerId`. */
export async function activeFlow(system: any, definition: unknown, ownerId = "owner-1") {
  const flow = await system.flow.create({ data: { name: "suite", ownerId, currentVersion: 1 } })
  await system.flowVersion.create({ data: { flowId: flow.id, version: 1, definition } })
  await system.flow.update({ where: { id: flow.id }, data: { status: "active" } })
  return flow.id as string
}
