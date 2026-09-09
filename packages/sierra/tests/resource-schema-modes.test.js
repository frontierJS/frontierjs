/**
 * tests/resource-schema-modes.test.js
 *
 * The browser is handed the schema for the thing it is DOING.
 *
 * Three modes, and the split is write-versus-read rather than one-per-screen.
 * Create and update are both write schemas — which is why the second ships as a
 * delta off the first — and READ is the third, carrying the family of columns
 * no caller ever sends: `@computed`, `@generated`, `@derived`, `@from`. Without
 * it a table and a detail view can rank and render only what may be WRITTEN, so
 * a computed total reaches no screen and the screen still looks finished.
 *
 * Read is NOT a superset of create, which is why it is a third table rather
 * than a replacement: a `@transient` column is present in both write modes and
 * absent here, being written and never read back.
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
  registerSchemas(generated.defs, generated.models, generated.updatePatch, generated.readPatch)
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
  lines   Int           @computed
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

describe('the read mode, which is what a display surface reads', () => {
  test('a @computed column is in NEITHER write mode and in the read one', async () => {
    // The premise, asserted against the real generator rather than assumed.
    // A create schema and an update schema are both write schemas, so neither
    // holds a column nobody writes.
    const { defs, readPatch, updatePatch } = await build(SOURCE)
    expect(defs.Invoice.properties).not.toHaveProperty('lines')
    expect(applySchemaModePatch(defs.Invoice, updatePatch?.Invoice).properties)
      .not.toHaveProperty('lines')
    expect(applySchemaModePatch(defs.Invoice, readPatch?.Invoice).properties)
      .toHaveProperty('lines')
  })

  test('applying the read delta reproduces the read schema exactly — both real apps', async () => {
    // The round trip is what stops the patch format drifting between the build
    // half and the browser half, and it is asked of the schemas people actually
    // ship rather than of this file's fixture.
    for (const app of ['example', 'packages/basecamp']) {
      const schema = parseFile(resolve(REPO_ROOT, app, 'db', 'schema.lite')).schema
      const create = stripProse(generateJsonSchema(schema)?.$defs ?? {})
      const read   = stripProse(generateJsonSchema(schema, { mode: 'full' })?.$defs ?? {})
      const patch  = (await import('../src/junction/schema-registry.js')).diffSchemaModes(create, read)
      for (const name of Object.keys(read))
        expect(applySchemaModePatch(create[name], patch[name])).toEqual(read[name])
    }
  })

  test('the resource shows a computed column in columns() and never in formFields()', async () => {
    // The pair that is the whole point. One resource, two lists, and the column
    // has to be in exactly one of them: a form that offered `lines` would ask
    // for a value the Data boundary refuses, and a table that omitted it is the
    // screen this work exists to fix.
    await build(SOURCE)
    const invoices = createResource('invoices', { model: 'Invoice' })

    expect(invoices.formFields().map(f => f.name)).not.toContain('lines')
    expect(invoices.columns({ limit: 99 }).columns.map(c => c.name)).toContain('lines')
  })

  test('a @transient column goes the other way, which is why read is a third table', async () => {
    // Read is not a superset of create. A column written and never read back is
    // in both write modes and in neither display list, so `columns()` cannot
    // simply be `formFields()` with more.
    const src = `
      model Signup {
        id      Int    @id @default(autoincrement())
        email   String
        confirm String @transient
        @@gate("0.0.0.0")
      }
    `
    const { defs, readPatch } = await build(src)
    expect(defs.Signup.properties).toHaveProperty('confirm')
    expect(applySchemaModePatch(defs.Signup, readPatch?.Signup).properties)
      .not.toHaveProperty('confirm')

    const signups = createResource('signups', { model: 'Signup' })
    expect(signups.formFields().map(f => f.name)).toContain('confirm')
    expect(signups.columns({ limit: 99 }).columns.map(c => c.name)).not.toContain('confirm')
  })
})

describe('a detail view is a model plus its relations', () => {
  test('summary() is exactly what the form cannot offer a control for', async () => {
    await build(SOURCE)
    // Defined against the form rather than restated, so the two cannot drift.
    // Asserted as a PARTITION: every column is in one list or the other and
    // never both, which is the property a screen rendering both depends on.
    const invoices = createResource('invoices', { model: 'Invoice' })
    const onForm   = invoices.formFields().filter(f => f.control).map(f => f.name)
    const inFacts  = invoices.summary().columns.map(c => c.name)

    expect(inFacts).toContain('lines')                     // @computed — absent from a write schema entirely
    expect(onForm).toContain('note')                       // ordinary, writable

    // The discriminator, and the reason this is `f.control` and not `f.name`:
    // `audit` is `@system`, so it IS in the form's field list — carrying
    // `{ control: null, reason: 'readOnly' }`, because the list reports a field
    // it cannot place rather than dropping it. Excluding by NAME would take it
    // out of both lists and lose the column from every screen.
    expect(invoices.formFields().map(f => f.name)).toContain('audit')
    expect(inFacts).toContain('audit')

    expect(inFacts.filter(n => onForm.includes(n))).toEqual([])
  })

  test('a summary column carries its display, so a cell renders it', async () => {
    await build(SOURCE)
    // The payoff of the read mode: a total nobody writes is still a number
    // rendered from its declaration rather than stringified.
    const invoices = createResource('invoices', { model: 'Invoice' })
    const lines    = invoices.summary().columns.find(c => c.name === 'lines')
    expect(lines.display).toBe('number')
    expect(lines.label).toBe('Lines')
  })

  let LINKED

  test('children() resolves the foreign key from the CHILD, which is where it lives', async () => {
    // A hasMany carries the child model and no key — the key is a column on the
    // child — so the child's own belongsTo is what answers, matched by MODEL
    // rather than by name, since a child may call the relation anything.
    LINKED = await build(`
      model Shop {
        id     Int    @id @default(autoincrement())
        name   String
        orders Order[]
        @@gate("0.0.0.0")
      }
      model Order {
        id       Int      @id @default(autoincrement())
        shopId   Int
        shop     Shop     @relation(fields: [shopId], references: [id])
        courier  Courier? @relation(fields: [courierId], references: [id])
        courierId Int?
        ref      String
        @@gate("0.0.0.0")
      }
      model Courier {
        id     Int     @id @default(autoincrement())
        name   String
        orders Order[]
        @@gate("0.0.0.0")
      }
    `)
    // `Order` carries TWO belongsTo — a Shop and a Courier — so taking the
    // first one found answers `courierId` for half the models it is asked
    // about. The match is by MODEL, and a child may call the relation anything.
    const shops = createResource('shops', { model: 'Shop' })
    expect(shops.children()).toEqual([
      { field: 'orders', model: 'Order', service: 'orders', foreignKey: 'shopId' },
    ])

    const couriers = createResource('couriers', { model: 'Courier' })
    expect(couriers.children()).toEqual([
      { field: 'orders', model: 'Order', service: 'orders', foreignKey: 'courierId' },
    ])
  })

  test('a child whose schema is not registered is reported rather than skipped', () => {
    // The case a generated admin meets first: a child model with no service is
    // not registered, so there is nothing to link at. Silence would be a
    // collection missing from a screen with nothing said, which is the failure
    // this whole surface exists to end.
    //
    // The schema is the SAME one as the row above, registered without the
    // child — a pair, because the reported answer has to be the one that
    // changed rather than the only one this model can give.
    registerSchemas({ Shop: LINKED.defs.Shop }, ['Shop'])
    const shops = createResource('shops', { model: 'Shop' })

    expect(shops.children()).toEqual([
      { field: 'orders', model: 'Order', service: null, foreignKey: null,
        reason: 'no schema registered for Order' },
    ])
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

describe('a search box is offered only where the boundary will answer', () => {
  // `$search` reaches `table.search()`, which a Litestone client serves only
  // under `@@fts` and refuses by name below it. Nothing in the generated schema
  // said which models those were, so a generated bar could offer a box on every
  // model — where nearly all of them answer 400 — or on none (`FJS-1040`).
  //
  // Every assertion here is a PAIR over ONE schema. An emit that fires always
  // and an emit that never fires each satisfy a one-sided test, and those are
  // exactly the two ways this goes wrong.
  const SEARCH_SOURCE = `
    model Article {
      id      Int    @id @default(autoincrement())
      title   String
      body    String
      slug    String
      @@fts([body, title])
      @@gate("0.0.0.0")
    }

    model Tag {
      id   Int    @id @default(autoincrement())
      name String
      @@gate("0.0.0.0")
    }
  `

  test('the indexed columns reach the browser, and the model beside it says no', async () => {
    await build(SEARCH_SOURCE)
    const articles = createResource('articles', { model: 'Article' })
    const tags     = createResource('tags',     { model: 'Tag' })

    expect(articles.filters().search.fields).toEqual(['body', 'title'])
    expect(tags.filters().search.fields).toBe(null)
    expect(tags.filters().search.reason).toMatch(/@@fts/)
  })

  test('a refusal carries its reason rather than answering null', async () => {
    // The rule `filters()` already follows for a column with no operator, and
    // `controlFor` before it: an unofferable thing comes back saying why. A bar
    // that dropped it would reproduce, inside the generator, the silence the
    // generator exists to end.
    await build(SEARCH_SOURCE)
    const search = createResource('tags', { model: 'Tag' }).filters().search
    expect(search).not.toBe(null)
    expect(search.reason).toBeTruthy()
  })

  test('the labels are resolved for columns the TABLE does not show', async () => {
    // `@@fts` may index a column no `columns()` tier ranks or that the limit
    // cuts, so labels resolved off the ranked list would come back undefined
    // for exactly those. Asked with a limit of one, which leaves at most one
    // column standing while both indexed columns still need a label.
    await build(SEARCH_SOURCE)
    const articles = createResource('articles', { model: 'Article' })
    const shown    = articles.columns({ limit: 1 }).columns.map(c => c.name)
    const search   = articles.filters({ limit: 1 }).search

    expect(shown.length).toBe(1)
    expect(search.labels).toEqual(['Body', 'Title'])
    expect(search.labels.every(Boolean)).toBe(true)
  })

  test('search and the column filters are separate answers about one model', async () => {
    // The two live at different levels and neither may be read as the other's.
    // `Tag.name` is an ordinary filterable string on a model that answers no
    // `$search` at all — a bar reading one key for both would either offer a
    // box here or drop the `name` filter on Article.
    await build(SEARCH_SOURCE)
    const tags     = createResource('tags',     { model: 'Tag' }).filters()
    const articles = createResource('articles', { model: 'Article' }).filters()

    expect(tags.search.fields).toBe(null)
    expect(tags.filters.find(f => f.name === 'name').op).toBe('contains')
    expect(articles.search.fields).toEqual(['body', 'title'])
    expect(articles.filters.find(f => f.name === 'slug').op).toBe('contains')
  })
})
