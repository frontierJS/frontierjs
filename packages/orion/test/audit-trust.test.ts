/*
 * audit-trust.test.ts
 *
 * Fable audit run 1.5 — what the engine believes about a flow's own text.
 *
 * A flow is data a person typed. The compiler is the author-time refusal and
 * the resolver is the run-time one; each test here hands one of them a name an
 * author should not be able to reach and asks which refusal fires.
 *
 * A `test.failing` asserts the behavior the package should have and therefore
 * fails today; drop `.failing` when the fix lands.
 */

import { describe, test, expect } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Compiler } from "../src/engine/compiler/index"
import { ExpressionResolver, ResolutionError } from "../src/engine/expression/index"
import type { Flow, NodeDefinition } from "../src/engine/types"
import { registryFor } from "./fixtures/host"

const registry = registryFor(mkdtempSync(join(tmpdir(), "orion-audit-")))
const lit      = (value: unknown) => ({ type: "literal" as const, value })

const flowWith = (id: string, type: string, config: NodeDefinition["config"]): Flow => ({
  id: "flow_audit", version: "1.0.0", name: "Audit", accountId: "acc", workspaceId: "ws",
  createdBy: "user", createdAt: 0, updatedAt: 0,
  nodes: {
    start: { id: "start", type: "trigger.manual", config: {} },
    [id]:  { id, type, config },
  },
  edges: [{ id: "e1", from: "start", to: id }],
})

const codes = (result: ReturnType<Compiler["compile"]>) => result.ok ? [] : result.errors.map(e => e.code)

// ─── the function table ───────────────────────────────────────────────────────

describe("audit 1.5 — a fn name is looked up on an object with a prototype", () => {
  const r   = new ExpressionResolver()
  const ctx = { nodes: {}, trigger: {}, flowId: "f", executionId: "x" } as never

  // FJS-2339: asserts the fixed behavior, so it fails until the fix lands; drop .failing then.
  //
  // `this.fns` is `{ ...BUILTINS, ...extraFns }`, so `fns["constructor"]` is
  // Object and `fns["toString"]` is Object.prototype.toString — both truthy,
  // both callable, neither a function the table names. The compiler refuses
  // these names against `getFunctionNames()`, so the only way to reach them is
  // a definition the compiler never saw, which is what `test/store.test.ts`
  // says `asSystem()` writes allow. The resolver is the run-time owner of the
  // refusal and does not refuse.
  test.failing("a prototype name is refused as an unknown function", () => {
    expect(() => r.resolve({ type: "fn", name: "constructor", args: [lit(1)] }, ctx)).toThrow(ResolutionError)
    expect(() => r.resolve({ type: "fn", name: "toString",    args: [lit(1)] }, ctx)).toThrow(ResolutionError)
  })

  test("the observed shape: constructor resolves to Object and answers a boxed number", () => {
    const out = r.resolve({ type: "fn", name: "constructor", args: [lit(1)] }, ctx)
    expect(typeof out).toBe("object")
    expect(Number(out)).toBe(1)
  })

  // A ref that walked with bracket access answered `$.trigger.constructor` with
  // the Object constructor, where has() reads own properties only.
  test("a ref path reads own properties only", () => {
    const got = r.resolve({ type: "ref", path: "$.trigger.constructor" }, { ...(ctx as object), trigger: { a: 1 } } as never)
    expect(got).toBeUndefined()
  })

  test("a ref root reads own nodes only", () => {
    expect(() => r.resolve({ type: "ref", path: "$.constructor" }, ctx as never)).toThrow(ResolutionError)
  })
})

// ─── the host catalog ─────────────────────────────────────────────────────────

describe("audit 1.5 — service.call names what the host has", () => {
  const typed = new Compiler(registry, {
    jobs:          { names: () => ["leads.touch"] },
    notifications: { names: () => ["LeadAssigned"] },
    // The shape a services catalog would take; HostCatalog has no slot for it.
    ...({ services: { names: () => ["leads"] } } as object),
  })

  test("a job and a notification are refused by name at author time", () => {
    expect(codes(typed.compile(flowWith("j", "job.dispatch", { job: lit("leads.tuoch") })))).toEqual(["UNKNOWN_JOB"])
    expect(codes(typed.compile(flowWith("n", "notify", { notification: lit("Nope"), to: lit({ id: 1 }) })))).toEqual(["UNKNOWN_NOTIFICATION"])
  })

  // FJS-2337: asserts the fixed behavior, so it fails until the fix lands; drop .failing then.
  //
  // `service.call` is the third app action and the one with no catalog: a
  // service or a method that does not exist compiles, activates, and is found
  // by the first run as a NotFound the node records as failed.
  test.failing("a service the app does not have is refused at author time", () => {
    const result = typed.compile(flowWith("s", "service.call", { service: lit("laeds"), method: lit("find") }))
    expect(codes(result) as string[]).toEqual(["UNKNOWN_SERVICE"])
  })

  test("the observed shape: an unknown service compiles", () => {
    expect(typed.compile(flowWith("s", "service.call", { service: lit("laeds"), method: lit("find") })).ok).toBe(true)
  })

  // FJS-2338: asserts the fixed behavior, so it fails until the fix lands; drop .failing then.
  //
  // `job.dispatch` refuses orion's own jobs by prefix so a flow cannot run a run
  // beside its own job. `service.call` has no such list: a flow may call
  // `flows.activate`, `flows.save` and `runs.cancel` as its owner — including
  // on itself, where `save` on an active flow is refused and `activate` on an
  // active one is a Conflict, but `pause` ends the run that is making the call.
  test.failing("orion's own services are refused to a flow, as orion's own jobs are", () => {
    const result = typed.compile(flowWith("s", "service.call", { service: lit("flows"), method: lit("pause"), id: lit("flow_audit") }))
    expect(result.ok).toBe(false)
  })
})
