/*
 * checkpoint.ts
 *
 * What one per-stage checkpoint costs as a flow grows — `IDEAS/orion-port.md`
 * phase 2's open measurement. The context is rewritten whole at every stage, so
 * its size is the flow's size, and `@encrypted` re-encrypts all of it.
 *
 * Three write paths over the same context, at 10, 100 and 1,000 nodes:
 *
 *   raw        bun:sqlite, one prepared UPDATE of the JSON text
 *   litestone  LitestoneExecutionStore.saveContext, `context Json` plain
 *   encrypted  the same, over `db/orion.lite` as shipped
 *
 * `bun run bench`. Numbers go into the paper dated, never into a README.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { Database } from "bun:sqlite"

import { createTestEnv } from "../../litestone/src/testing.js"
import { LitestoneExecutionStore } from "../src/store"
import type { ExecutionContext, NodeExecutionState } from "../src/engine/runtime"

const SHIPPED = readFileSync(join(import.meta.dir, "..", "db", "orion.lite"), "utf8")
const PLAIN   = SHIPPED.replace("context        Json?      @encrypted", "context        Json?")
if (PLAIN === SHIPPED) throw new Error("bench: the context column moved; the plain variant is not plain")

const header = 'database main { path "./orion.db" }\n'

// A node output the size a real step returns: a record and a little metadata.
function output(i: number) {
  return {
    id:      `lead_${i}`,
    email:   `person${i}@example.com`,
    amount:  1234 + i,
    tags:    ["inbound", "priority"],
    address: { city: "Portland", region: "OR", postal: "97201" },
    at:      "2026-09-14T12:00:00.000Z",
  }
}

function contextOf(nodes: number, executionId: string): ExecutionContext {
  const outputs: Record<string, unknown> = {}
  const states:  Record<string, NodeExecutionState> = {}
  for (let i = 0; i < nodes; i++) {
    outputs[`n${i}`] = output(i)
    states[`n${i}`]  = { status: "completed", attempts: 1, fromCache: false, startedAt: 1, endedAt: 2, output: output(i), logs: [] }
  }
  return {
    executionId, flowId: "flow", version: "1", trigger: { body: {} },
    nodes: outputs, nodeStates: states, status: "running", startedAt: Date.now(), currentStage: 0,
  }
}

async function envFor(schema: string) {
  const env: any = await createTestEnv({ schema: header + schema, encryptionKey: "0".repeat(64), claims: [] })
  const flow    = await env.system.flow.create({ data: { name: "bench", ownerId: "u" } })
  const version = await env.system.flowVersion.create({ data: { flowId: flow.id, version: 1, definition: {} } })
  const run     = await env.system.run.create({ data: { flowVersionId: version.id } })
  return { env, runId: run.id as string }
}

function time(iterations: number, fn: (i: number) => void | Promise<void>) {
  return async () => {
    for (let i = 0; i < Math.min(50, iterations); i++) await fn(i)       // warm the statement cache
    const t0 = Bun.nanoseconds()
    for (let i = 0; i < iterations; i++) await fn(i)
    return (Bun.nanoseconds() - t0) / iterations / 1000                 // µs per checkpoint
  }
}

const SIZES = [[10, 2000], [100, 500], [1000, 100]] as const
const rows: string[] = []

for (const [nodes, iterations] of SIZES) {
  const plain     = await envFor(PLAIN)
  const encrypted = await envFor(SHIPPED)
  const ctxPlain  = contextOf(nodes, plain.runId)
  const ctxEnc    = contextOf(nodes, encrypted.runId)
  const bytes     = JSON.stringify({ nodes: ctxPlain.nodes, nodeStates: ctxPlain.nodeStates }).length

  // The pragmas litestone's writer runs with; the defaults fsync every commit
  // and measure the disk instead of the write path.
  const raw  = new Database(plain.env.path)
  raw.run("PRAGMA journal_mode = WAL")
  raw.run("PRAGMA synchronous = NORMAL")
  const stmt = raw.prepare("UPDATE run SET context = ?, currentStage = ? WHERE id = ?")
  const rawUs = await time(iterations, (i) => {
    stmt.run(JSON.stringify({ nodes: ctxPlain.nodes, nodeStates: ctxPlain.nodeStates }), i, plain.runId)
  })()
  raw.close()

  const plainStore = new LitestoneExecutionStore(plain.env.system)
  const plainUs = await time(iterations, (i) => { ctxPlain.currentStage = i; return plainStore.saveContext(ctxPlain) })()

  const encStore = new LitestoneExecutionStore(encrypted.env.system)
  const encUs = await time(iterations, (i) => { ctxEnc.currentStage = i; return encStore.saveContext(ctxEnc) })()

  rows.push(`| ${nodes} | ${(bytes / 1024).toFixed(1)} KB | ${rawUs.toFixed(0)} | ${plainUs.toFixed(0)} | ${encUs.toFixed(0)} |`)
}

console.log(`bun ${Bun.version}\n`)
console.log("| Nodes | Context | raw µs | litestone µs | encrypted µs |")
console.log("| --- | --- | --- | --- | --- |")
for (const row of rows) console.log(row)
