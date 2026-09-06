/**
 * tests/resource-schema-modes.test.js
 *
 * The browser is handed the schema for the write it is making.
 *
 * Litestone generates a CREATE schema and an UPDATE schema and they are
 * different documents. Three facts exist only in the update one and all three
 * are about a write:
 *
 *   `@immutable`            → `readOnly` + `x-litestone-kind: 'immutable'`
 *   `@immutable` + `@seals` → `x-litestone-seal`
 *   `@version`              → the property at all, `readOnly`
 *
 * Sierra's build asked for one mode and got the default. So `stripReadOnly`
 * left an `@immutable` column in a patch payload and the Data boundary refused
 * the KEY — the person told to leave a field out of a payload they never
 * assembled, which is `FJS-526` reappearing one attribute along — and
 * `sealedFields()` answered `[]` for every row of every model, which made
 * `FJS-628`'s seal mechanism dead code in every real app (`FJS-807`).
 *
 * ── Why this file writes a `.lite` to disk ──────────────────────────────────
 *
 * Because the thing under test is what a BUILD produces. `FJS-628` shipped
 * eleven browser assertions against the only file in the repo carrying
 * `x-litestone-seal` — hand-written — so it graded the consumer against a
 * schema no generator emits, and passed for as long as the generator was
 * wrong. Every schema here goes through `generateSchemas()`, the function
 * `schema-plugin.js` itself calls, against the real Litestone in node_modules.
 *
 * The fake here is the NETWORK and nothing else.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

import { parseFile } from '@frontierjs/litestone/parser'
import { generateJsonSchema } from '@frontierjs/litestone/jsonschema'

const HERE        = dirname(fileURLToPath(import.meta.url))
const SIERRA_ROOT = dirname(HERE)
const REPO_ROOT   = resolve(SIERRA_ROOT, '..', '..')

const _calls = []
let _proxy

vi.mock('@frontierjs/sierra/junction', () => ({
  getClient: () => ({
    service: () => _proxy,
    resource: () => ({
      service: _proxy,
      store: { get: () => [], subscribe: (fn) => { fn([]); return () => {} }, set: () => {} },
      stale: { get: () => 0, subscribe: (fn) => { fn(0); return () => {} }, reset: () => {} },
      load: () => Promise.resolve([]),
    }),
  }),
}))

const { generateSchemas, stripProse } = await import('../src/build/schema-plugin.js')
const { registerSchemas, applySchemaModePatch } = await import('../src/junction/schema-registry.js')
const { createResource } = await import('../src/junction/resource.js')

beforeEach(() => {
  _calls.length = 0
  _proxy = {
    find:    (q, p)  => { _calls.push(['find', q, p]);   return Promise.resolve({ data: [], total: 0 }) },
    get:     (id)    => { _calls.push(['get', id]);      return Promise.resolve({}) },
    create:  (data)  => { _calls.push(['create', data]); return Promise.resolve(data) },
    patch:   (id, d) => { _calls.push(['patch', id, d]); return Promise.resolve(d) },
    remove:  (id)    => { _calls.push(['remove', id]);   return Promise.resolve({}) },
    restore: (id)    => { _calls.push(['restore', id]);  return Promise.resolve({}) },
    invoke:  ()      => Promise.resolve({}),
    on: () => {}, call: () => Promise.resolve(),
  }
})

/** Run the build's own schema step over a `.lite` source, and register it. */
async function build(source) {
  const dir  = mkdtempSync(join(tmpdir(), 'sierra-modes-'))
  const path = join(dir, 'schema.lite')
  writeFileSync(path, source)
  const generated = await generateSchemas(path, () => {}, SIERRA_ROOT)
  registerSchemas(generated.defs, generated.models, generated.updatePatch)
  return { ...generated, path }
}

const SOURCE = `
enum InvoiceStatus { draft  issued }

model Invoice {
  id      Int           @id @default(autoincrement())
  ref     String        @immutable
  note    String?
  total   Float         @immutable @default(0)
  status  InvoiceStatus @default(draft)
  audit   String?       @system
  @@transitions(status,
    issue: draft -> issued @seals
  )
  @@gate("0.0.0.0")
}

model Plan {
  id      Int    @id @default(autoincrement())
  code    String @immutable
  name    String
  rev     Int    @version
  @@gate("0.0.0.0")
}
`

describe('the build emits both write modes', () => {
  test('the update-mode delta carries what create mode cannot say', async () => {
    const { defs, updatePatch } = await build(SOURCE)

    // Create mode: an @immutable column is an ordinary writable string, which
    // is correct — a create form must have a box to type it into.
    expect(defs.Invoice.properties.ref.readOnly).toBeUndefined()
    expect(defs.Invoice.properties.ref['x-litestone-seal']).toBeUndefined()
    expect(defs.Plan.properties.rev).toBeUndefined()

    // Update mode, reached through the delta the build ships.
    const invoice = applySchemaModePatch(defs.Invoice, updatePatch.Invoice)
    expect(invoice.properties.ref['x-litestone-kind']).toBe('immutable-until-seal')
    expect(invoice.properties.ref['x-litestone-seal']).toEqual({ field: 'status', states: ['issued'] })

    const plan = applySchemaModePatch(defs.Plan, updatePatch.Plan)
    expect(plan.properties.code.readOnly).toBe(true)
    expect(plan.properties.code['x-litestone-kind']).toBe('immutable')
    expect(plan.properties.rev.readOnly).toBe(true)
  })

  test('applying the delta reproduces the update schema exactly — both real apps', async () => {
    // The fixed point, over the two real `.lite` files rather than a fixture:
    // a delta that dropped a keyword would still look like a schema, and every
    // behavioral assertion above would pass against the half of it that landed.
    for (const app of ['example', 'packages/basecamp']) {
      const path      = resolve(REPO_ROOT, app, 'db', 'schema.lite')
      const generated = await generateSchemas(path, () => {}, SIERRA_ROOT)
      // Through `stripProse` as well, because the build strips doc comments
      // before it diffs (`FJS-785`) and this assertion is about the DELTA, not
      // about the prose. Leaving them in the oracle alone would report every
      // commented model as a delta that lost a keyword.
      const oracle    = stripProse(
        generateJsonSchema(parseFile(path).schema, { mode: 'update' }).$defs)

      expect(Object.keys(generated.defs).length).toBeGreaterThan(0)
      for (const name of Object.keys(oracle)) {
        expect(applySchemaModePatch(generated.defs[name], generated.updatePatch[name]),
          `${app} — ${name}`).toEqual(oracle[name])
      }
    }
  })

  test('an app with @immutable columns has some, and one without has none', async () => {
    // The scale claim, measured rather than asserted as a number: `example`
    // declares `@immutable` and `basecamp` does not, so the delta is empty for
    // one of them — which is what makes the non-empty one evidence.
    const marked = async (app) => {
      const g = await generateSchemas(resolve(REPO_ROOT, app, 'db', 'schema.lite'), () => {}, SIERRA_ROOT)
      let n = 0
      for (const [model, patch] of Object.entries(g.updatePatch)) {
        for (const [name, p] of Object.entries(patch.properties ?? {})) {
          // Only a column a CREATE form offers and a PATCH refuses. The
          // `@version` column is readOnly in the update schema too and is not
          // this: it is absent from create mode entirely, so no form ever
          // rendered it and nothing about it can be silently wrong.
          const inCreate = g.defs[model]?.properties?.[name]
          if (!inCreate || inCreate.readOnly) continue
          if (p.readOnly || p['x-litestone-seal']) n++
        }
      }
      return n
    }
    expect(await marked('example')).toBeGreaterThan(0)
    expect(await marked('packages/basecamp')).toBe(0)
  })
})

describe('a resource judges a payload by the mode it is writing in', () => {
  test('a patch drops @immutable and keeps @version; a create keeps @immutable', async () => {
    await build(SOURCE)
    const plans = createResource('plans', { model: 'Plan' })

    // The edit-form round trip: a row the server sent, one box changed, the
    // whole record written back.
    await plans.save({ id: 1, code: 'P-1', name: 'changed', rev: 3 })
    const [verb, id, sent] = _calls.at(-1)
    expect(verb).toBe('patch')
    expect(id).toBe(1)
    expect(sent).not.toHaveProperty('code')      // @immutable — the boundary refuses the KEY
    expect(sent.rev).toBe(3)                     // @version — readOnly and must still travel
    expect(sent.name).toBe('changed')

    // The same column on a create, which is the negative control: a fix that
    // dropped `@immutable` everywhere would make the model uncreatable through
    // a generated form and would satisfy the assertion above on its own.
    _calls.length = 0
    await plans.save({ code: 'P-2', name: 'new' })
    const [verb2, sent2] = _calls.at(-1)     // create is (data) — no id argument
    expect(verb2).toBe('create')
    expect(sent2.code).toBe('P-2')
  })

  test('formFields still offers the @immutable column, and make() seeds it', async () => {
    await build(SOURCE)
    const plans = createResource('plans', { model: 'Plan' })
    expect(plans.formFields().map(f => f.name)).toContain('code')
    expect(plans.make()).toHaveProperty('code')
    // …and never the version column, which no person types.
    expect(plans.formFields().map(f => f.name)).not.toContain('rev')
  })
})

describe('sealedFields — which columns are frozen for THIS row', () => {
  test('@immutable freezes as soon as the row exists', async () => {
    await build(SOURCE)
    const plans = createResource('plans', { model: 'Plan' })
    expect(plans.sealedFields({ id: 1, code: 'P-1', name: 'x', rev: 1 })).toEqual(['code'])
    // No record is a draft being made, so nothing is frozen — the create form.
    expect(plans.sealedFields(null)).toEqual([])
    // The version column is readOnly and is the one that MUST travel: a caller
    // deleting it turns every optimistic write into one the server refuses.
    expect(plans.sealedFields({ id: 1, rev: 1 })).not.toContain('rev')
  })

  test('a sealing @immutable freezes at the seal and not before', async () => {
    await build(SOURCE)
    const invoices = createResource('invoices', { model: 'Invoice' })
    const draft  = { id: 1, ref: 'INV-1', status: 'draft',  total: 10 }
    const issued = { id: 1, ref: 'INV-1', status: 'issued', total: 10 }

    // The negative control the seal turns on: a guard that froze everything
    // would satisfy the `issued` assertion by itself.
    expect(invoices.sealedFields(draft)).toEqual([])
    expect(invoices.sealedFields(issued).sort()).toEqual(['ref', 'total'])
  })

  test('a column that was never writable is not reported as frozen', async () => {
    // `@system` is the server's on every row rather than frozen on this one,
    // and no form ever offered a box for it. Reporting it here would have
    // `<Form>` announce a lock over a field nobody can see.
    await build(SOURCE)
    const invoices = createResource('invoices', { model: 'Invoice' })
    expect(invoices.sealedFields({ id: 1, status: 'issued', audit: 'x' })).not.toContain('audit')
  })
})

describe('degrading', () => {
  test('no delta means the two modes agree — the behavior before FJS-807', async () => {
    const { defs, models } = await build(SOURCE)
    registerSchemas(defs, models)              // an older build, or a hand-passed schema
    const plans = createResource('plans', { model: 'Plan' })
    expect(plans.sealedFields({ id: 1, code: 'P-1' })).toEqual([])
    await plans.save({ id: 1, code: 'P-1', name: 'x' })
    expect(_calls.at(-1)[2]).toHaveProperty('code')
  })
})
