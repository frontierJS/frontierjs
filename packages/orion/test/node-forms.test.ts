/*
 * node-forms.test.ts
 *
 * Every built-in node type's `configSchema` renders as a form.
 *
 * `configSchema` was declared on all 25 descriptors and read by NOTHING — not
 * the compiler, not the executor, not a screen — so a property that named a
 * shape no control could render was invisible, and so was one whose schema had
 * drifted from what the node's implementation reads. The inspector is its
 * first reader; this is what makes it a build failure rather than an empty box
 * somebody finds on a screen.
 *
 * The pipeline asserted here is the one the inspector runs, and it is entirely
 * the framework's: `buildFieldRules` flattens the document into a rule per
 * property, `formFieldList` asks `controlFor` which control each rule gets.
 * Nothing in orion decides any of it, which is the point — a plugin's node
 * type gets a form with nothing written.
 *
 * `() => null` is the ref resolver: a config schema is one self-contained
 * document with no `$defs` table under it, so a `$ref` in one resolves to
 * nothing and is RECORDED as unresolved rather than read as a document.
 */

import { describe, test, expect } from "bun:test"

import { BUILTIN_DESCRIPTORS } from "../src/engine/plugins/builtins"
import { buildFieldRules, formFieldList } from "../../sierra/src/resource/field-rules.js"

const WITH_CONFIG = BUILTIN_DESCRIPTORS.filter(d => d.configSchema)

const fieldsFor = (schema: unknown) =>
  formFieldList(buildFieldRules(schema as any, () => null) as any) as Array<{
    name: string; rule: any; control: string | null; reason?: string
  }>

describe("every built-in node type describes its own form", () => {
  test("the set is not empty, so a broken import cannot pass this file", () => {
    expect(WITH_CONFIG.length).toBeGreaterThan(20)
  })

  for (const d of WITH_CONFIG) {
    describe(d.type, () => {
      const declared = Object.keys((d.configSchema as any).properties ?? {})
      const fields   = fieldsFor(d.configSchema)

      test("every declared property reaches the form", () => {
        expect(fields.map(f => f.name).sort()).toEqual([...declared].sort())
      })

      test("and every one of them gets a control", () => {
        const missing = fields.filter(f => !f.control).map(f => `${f.name}: ${f.reason}`)
        expect(missing).toEqual([])
      })

      test("what the schema requires, the form requires", () => {
        const required = new Set((d.configSchema as any).required ?? [])
        for (const f of fields) expect(f.rule.required).toBe(required.has(f.name))
      })
    })
  }
})

describe("the two shapes a config property takes", () => {
  // A config value is stored as an Expression node, so the schema describes
  // what the value must RESOLVE to. Where the value is always computed the
  // schema declares no type at all, and that absence is what the inspector
  // reads: it opens such a field on the expression rather than on a control
  // over a value the node will never hold.
  const typeless = (d: any) =>
    Object.entries((d.configSchema?.properties ?? {}) as Record<string, any>)
      .filter(([, s]) => s && s.type === undefined)
      .map(([k]) => k)

  test("the typeless properties are the computed ones, and there are some", () => {
    const found = WITH_CONFIG.flatMap(d => typeless(d).map(k => `${d.type}.${k}`))
    expect(found).toContain("flow.delay.ms")
    expect(found).toContain("http.request.body")
    expect(found).toContain("ai.prompt")
    expect(found.length).toBeGreaterThan(10)
  })

  test("a declared type still picks a real control", () => {
    const webhook = fieldsFor(BUILTIN_DESCRIPTORS.find(d => d.type === "trigger.webhook")!.configSchema)
    expect(webhook.find(f => f.name === "path")?.control).toBe("input")
    // `method` declares an enum, so the form offers the members rather than a
    // box to type an HTTP verb into.
    expect(webhook.find(f => f.name === "method")?.control).toBe("select")
  })
})
