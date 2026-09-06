/**
 * tests/static-safety.test.js — a prerendered page cannot publish gated data.
 *
 * ISSUES.md FJS-081. `render: static` emits HTML at build time and every model
 * declares who may read it (`@@gate`), and until now nothing connected the two:
 * a static route reading a model gated at level 4 wrote that data into a public
 * file, which was then served, CDN-cached and indexed. Build succeeded, page
 * looked right, nothing warned.
 *
 * The tests are in two halves, because the two halves fail differently:
 *
 *   1. the decision — checkRoute() against a known read set. Pure, fast, and
 *      where the fail-closed rules are actually pinned.
 *   2. the wiring — prerenderRoutes() with a fake Litestone client, proving the
 *      read set is collected from `load()` at all and that a violation stops
 *      the build rather than warning.
 *
 * Half 2 matters because the ORIGINAL design was going to watch the render.
 * Static-route data arrives from `load()` in the .meta.js companion, before
 * render, as a plain prop — so watching the render would have observed an empty
 * set and passed everything. `reads a gated model through load()` is the test
 * that would have caught that, and it is the reason it exists.
 */

import { describe, test, expect, beforeEach } from 'vitest'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { mkdirSync, writeFileSync } from 'fs'

import {
  installSchemas, gateReadLevel, createReadRecorder,
  declaredPublishLevel, checkRoute, formatReport,
} from '../src/build/static-safety.js'
import { prerenderRoutes } from '../src/build/prerender.js'
import { tmpDir } from './tmp.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

/** A $defs table shaped exactly as litestone's generateJsonSchema emits one. */
const DEFS = {
  Product:  { properties: { id: {} }, 'x-gate': { read: 0, create: 4, update: 4, delete: 5 } },
  // Read 0 and its children are not: the shape `FJS-781` is about — a public
  // parent whose `include:` publishes a gated child.
  Customer: { properties: { id: {} }, 'x-gate': { read: 0, create: 4, update: 4, delete: 5 } },
  Invoice:  { properties: { id: {} }, 'x-gate': { read: 4, create: 4, update: 4, delete: 5 } },
  Secret:   { properties: { id: {} }, 'x-gate': { read: 8, create: 8, update: 8, delete: 8 } },
  Note:     { properties: { id: {} } },                      // no gate at all
  Status:   { enum: ['a', 'b'] },                             // an enum, not a model
  // A MULTI-WORD model. Every other entry here is one word, whose table name
  // is its accessor, so all of them resolved whatever the rule was.
  ProductVariant: { properties: { id: {} }, 'x-gate': { read: 0, create: 4, update: 4, delete: 5 } },
  InvoiceLine:    { properties: { id: {} }, 'x-gate': { read: 4, create: 4, update: 4, delete: 5 } },
}
const MODELS = ['Product', 'Customer', 'Invoice', 'Secret', 'Note', 'ProductVariant', 'InvoiceLine']

beforeEach(() => installSchemas(DEFS, MODELS))

describe('gateReadLevel', () => {

  test('resolves the table name the tap reports, not the $defs key', () => {
    // Established by running it: $tapQuery reports `product`, $defs is keyed
    // `Product`. Lower-casing by hand here would be a second copy of the
    // plural/accessor rules that modelNameFor already owns.
    expect(gateReadLevel('product')).toEqual({ model: 'Product', level: 0 })
    expect(gateReadLevel('invoice')).toEqual({ model: 'Invoice', level: 4 })
  })

  test('accepts the model name too', () => {
    expect(gateReadLevel('Invoice').level).toBe(4)
  })

  test('resolves a MULTI-WORD model from its snake_case table', () => {
    // The case every other fixture here hides. A one-word model's table is its
    // own accessor, so `product` resolved whatever the rule was; `ProductVariant`
    // is stored as `product_variant`, which the registry did not index at all.
    // The read came back unknown, and unknown fails closed — so a static route
    // touching any multi-word model could not be published, and said the schema
    // did not describe a model the schema declares.
    expect(gateReadLevel('product_variant')).toEqual({ model: 'ProductVariant', level: 0 })
    expect(gateReadLevel('invoice_line')).toEqual({ model: 'InvoiceLine', level: 4 })
  })

  test('a gated multi-word model is still caught', () => {
    // The half that matters: resolving the name must not turn the gate off.
    expect(gateReadLevel('invoice_line').level).toBe(4)
  })

  test('an ungated model is level 0, not unknown', () => {
    // No @@gate means genuinely ungated at the Data boundary, so 0 is the
    // accurate answer rather than a permissive guess.
    expect(gateReadLevel('note')).toEqual({ model: 'Note', level: 0 })
  })

  test('a name the schema does not describe is unknown, not 0', () => {
    // The dangerous default. Scoring an unrecognized read as 0 would let a
    // typo'd or dynamic model name through as "public".
    const r = gateReadLevel('whatever')
    expect(r.model).toBeNull()
    expect(Number.isNaN(r.level)).toBe(true)
  })
})

describe('declaredPublishLevel', () => {

  test('absent means 0 — public only', () => {
    expect(declaredPublishLevel({})).toEqual({ level: 0, declared: false, error: null })
  })

  test('reads the number', () => {
    expect(declaredPublishLevel({ publishes: 4 })).toEqual({ level: 4, declared: true, error: null })
  })

  test('reads it out of frontmatter too', () => {
    expect(declaredPublishLevel({ frontmatter: { publishes: 5 } }).level).toBe(5)
  })

  test('refuses `publishes: true`', () => {
    // A bare true says "turn the check off", not "I decided what this page may
    // contain". The whole point is that the decision is legible in a diff.
    const r = declaredPublishLevel({ publishes: true })
    expect(r.declared).toBe(false)
    expect(r.error).toMatch(/whole number/)
  })

  test('refuses a level off the 0–9 scale', () => {
    expect(declaredPublishLevel({ publishes: 12 }).error).toBeTruthy()
    expect(declaredPublishLevel({ publishes: -1 }).error).toBeTruthy()
  })
})

describe('checkRoute — the decision', () => {

  const route = (o) => checkRoute({
    routeId: 'src/routes/x/index.mesa', meta: {}, models: new Set(),
    taps: 1, readsData: true, ...o,
  })

  test('passes a route that reads only ungated models', () => {
    expect(route({ models: new Set(['product', 'note']) }).ok).toBe(true)
  })

  test('fails a route that reads a gated model', () => {
    const r = route({ models: new Set(['invoice']) })
    expect(r.ok).toBe(false)
    expect(r.message).toContain('Invoice')
    expect(r.message).toContain('@@gate read 4')
  })

  test('the message names the fix, not just the problem', () => {
    const r = route({ models: new Set(['invoice']) })
    expect(r.message).toContain('render: spa')
    expect(r.message).toContain('client:*')
    expect(r.message).toContain('publishes: 4')
  })

  test('an explicit declaration permits exactly that level', () => {
    expect(route({ models: new Set(['invoice']), meta: { publishes: 4 } }).ok).toBe(true)
  })

  test('a declaration does not license a HIGHER gate', () => {
    // publishes: 4 is a decision about level-4 data. It must not silently
    // cover the level-8 model somebody added to the same load() later.
    const r = route({ models: new Set(['invoice', 'secret']), meta: { publishes: 4 } })
    expect(r.ok).toBe(false)
    expect(r.message).toContain('Secret')
    expect(r.message).not.toContain('reads `Invoice`')
  })

  test('reports every violating model, not only the first', () => {
    const r = route({ models: new Set(['invoice', 'secret']) })
    expect(r.message).toContain('Invoice')
    expect(r.message).toContain('Secret')
  })

  test('suggests the level that would actually cover it', () => {
    const r = route({ models: new Set(['invoice', 'secret']) })
    expect(r.message).toContain('publishes: 8')   // the worst, not the first
  })
})

describe('checkRoute — fail closed', () => {

  test('a route that reads data with no tap is refused', () => {
    // The load-bearing rule. Fail-open here would let exactly the clever route
    // we are worried about through, which is the failure mode being fixed.
    const r = checkRoute({
      routeId: 'r', meta: {}, models: new Set(), taps: 0, readsData: true,
    })
    expect(r.ok).toBe(false)
    expect(r.message).toContain('could not observe')
  })

  test('…and the refusal names the one way out, which is wiring the client', () => {
    const r = checkRoute({
      routeId: 'r', meta: {}, models: new Set(), taps: 0, readsData: true,
    })
    expect(r.message).toContain('sierra config `db`')
  })

  test('`publishes: 0` does NOT waive it — the most conservative-looking value was the strongest escape (FJS-782)', () => {
    // `publishes: 0` reads as *this page publishes public data only* and its
    // effect was *stop asking whether you could observe me*. The two questions
    // are separate: a number about what a page contains cannot stand in for
    // being able to see what it contains.
    for (const publishes of [0, 4, '0']) {
      const r = checkRoute({
        routeId: 'r', meta: { publishes }, models: new Set(), taps: 0, readsData: true,
      })
      expect(r.ok).toBe(false)
      expect(r.message).toContain('could not observe')
    }
  })

  test('…and the route that reads nothing is still never asked, whatever it declares', () => {
    // The negative control. A branch that refused every undeclared route would
    // satisfy the assertion above and fail every page with a companion.
    expect(checkRoute({
      routeId: 'r', meta: { publishes: 0 }, models: new Set(), taps: 0, readsData: false,
    }).ok).toBe(true)
    expect(checkRoute({
      routeId: 'r', meta: {}, models: new Set(['product']), taps: 1, readsData: true,
    }).ok).toBe(true)
  })

  test('a route that reads NO data is never asked to declare anything', () => {
    // A page with no companion cannot read a model at build time, so it has
    // nothing to prove. Demanding a declaration there would be noise that
    // teaches people to add `publishes:` reflexively.
    const r = checkRoute({
      routeId: 'r', meta: {}, models: new Set(), taps: 0, readsData: false,
    })
    expect(r.ok).toBe(true)
  })

  test('an unrecognized model is refused rather than scored public', () => {
    const r = checkRoute({
      routeId: 'r', meta: {}, models: new Set(['mystery']), taps: 1, readsData: true,
    })
    expect(r.ok).toBe(false)
    expect(r.message).toContain('could not\n   resolve')
  })

  test('…and `publishes:` does not waive that either (FJS-782)', () => {
    const r = checkRoute({
      routeId: 'r', meta: { publishes: 9 }, models: new Set(['mystery']), taps: 1, readsData: true,
    })
    expect(r.ok).toBe(false)
  })

  test('a relation the recorder could not expand is refused, not scored', () => {
    const r = checkRoute({
      routeId: 'r', meta: { publishes: 9 }, models: new Set(['product']),
      unresolved: new Set(['Product.mystery']), taps: 1, readsData: true,
    })
    expect(r.ok).toBe(false)
    expect(r.message).toContain('Product.mystery')
  })

  test('reads data, a tap installed, and nothing seen is REPORTED rather than refused', () => {
    // A load() that fetches an absolute URL and touches no database is
    // legitimate and common; a load() that built its own Litestone client is
    // not, and the two are the same silence. Refusing would refuse the
    // majority case to catch the minority one.
    const r = checkRoute({
      routeId: 'r', meta: {}, models: new Set(), taps: 1, readsData: true,
    })
    expect(r.ok).toBe(true)
    expect(r.observedNothing).toBe(true)
    // The control: a route that read something is not reported.
    expect(checkRoute({
      routeId: 'r', meta: {}, models: new Set(['product']), taps: 1, readsData: true,
    }).observedNothing).toBe(false)
  })

  test('a bad publishes value fails the route rather than being ignored', () => {
    const r = checkRoute({
      routeId: 'r', meta: { publishes: 'yes' }, models: new Set(), taps: 1, readsData: true,
    })
    expect(r.ok).toBe(false)
  })
})

describe('createReadRecorder', () => {

  function fakeClient() {
    const listeners = new Set()
    return {
      $tapQuery(fn) { listeners.add(fn); return () => listeners.delete(fn) },
      emit(model, operation = 'findMany') { for (const fn of listeners) fn({ model, operation }) },
      get listenerCount() { return listeners.size },
    }
  }

  test('collects the models a client reads', () => {
    const c = fakeClient()
    const rec = createReadRecorder(c)
    c.emit('product'); c.emit('invoice'); c.emit('product')
    expect([...rec.models].sort()).toEqual(['invoice', 'product'])
    expect(rec.taps).toBe(1)
  })

  test('stop() actually unsubscribes', () => {
    // A leaked tap attributes one route's reads to the next and fails the
    // wrong build — which is worse than not checking, because the message
    // points at an innocent file.
    const c = fakeClient()
    const rec = createReadRecorder(c)
    rec.stop()
    expect(c.listenerCount).toBe(0)
    c.emit('invoice')
    expect(rec.models.size).toBe(0)
  })

  test('reports taps:0 when there is no client', () => {
    const rec = createReadRecorder(null)
    expect(rec.taps).toBe(0)
    expect(() => rec.stop()).not.toThrow()
  })

  test('reports taps:0 for something that is not a Litestone client', () => {
    expect(createReadRecorder({}).taps).toBe(0)
  })
})

describe('createReadRecorder — a relation the tap never fires for (FJS-781)', () => {

  // `$tapQuery` fires per TABLE, from inside makeTable's closure, so a child
  // resolved by `include:` is read inside the PARENT's statement and reaches no
  // child table. The recorder holds the client, so it expands the query.
  function client(relations) {
    const listeners = new Set()
    return {
      $relations: relations,
      $tapQuery(fn) { listeners.add(fn); return () => listeners.delete(fn) },
      read(model, args) { for (const fn of listeners) fn({ model, operation: 'findMany', args }) },
    }
  }

  const RELATIONS = {
    Customer: { invoices: { kind: 'hasMany', targetModel: 'Invoice' } },
    Invoice:  { lines:    { kind: 'hasMany', targetModel: 'InvoiceLine' },
                secret:   { kind: 'belongsTo', targetModel: 'Secret' } },
  }

  test('an included child is in the read set', () => {
    const c = client(RELATIONS)
    const rec = createReadRecorder(c)
    c.read('customer', { include: { invoices: true } })
    expect([...rec.models]).toContain('Invoice')
    expect([...rec.unresolved]).toEqual([])
  })

  test('and it is what makes the route fail', () => {
    // The whole point: the parent is level 0 and the child is level 4, so
    // scoring the parent alone published the child and printed a tick.
    const c = client(RELATIONS)
    const rec = createReadRecorder(c)
    c.read('customer', { include: { invoices: true } })
    const r = checkRoute({
      routeId: 'r', meta: {}, models: rec.models, unresolved: rec.unresolved,
      taps: rec.taps, readsData: true,
    })
    expect(r.ok).toBe(false)
    expect(r.message).toContain('Invoice')
  })

  test('a nested include is followed to the bottom', () => {
    const c = client(RELATIONS)
    const rec = createReadRecorder(c)
    c.read('customer', { include: { invoices: { include: { lines: true, secret: true } } } })
    expect([...rec.models].sort()).toEqual(['Invoice', 'InvoiceLine', 'Secret', 'customer'])
  })

  test('a relation named in a nested SELECT is followed too', () => {
    const c = client(RELATIONS)
    const rec = createReadRecorder(c)
    c.read('customer', { select: { name: true, invoices: { select: { total: true } } } })
    expect([...rec.models]).toContain('Invoice')
  })

  test('a plain select of scalar columns is not an unresolved read', () => {
    // The negative control that keeps the expansion honest in the other
    // direction: every ordinary `select` would be refused if a scalar key
    // counted as a relation the map does not carry (`FJS-351`).
    const c = client(RELATIONS)
    const rec = createReadRecorder(c)
    c.read('customer', { select: { name: true, total: true }, where: { id: 1 } })
    expect([...rec.unresolved]).toEqual([])
    expect([...rec.models]).toEqual(['customer'])
  })

  test('an include the map cannot expand is unresolved, not scored', () => {
    const c = client(RELATIONS)
    const rec = createReadRecorder(c)
    c.read('customer', { include: { mystery: true } })
    expect([...rec.unresolved]).toEqual(['Customer.mystery'])
  })

  test('a client with no $relations at all refuses an include and passes a plain read', () => {
    // An older litestone. Fail closed on what cannot be expanded — and only on
    // that, or every app on that client stops building.
    const c = client(undefined)
    const rec = createReadRecorder(c)
    c.read('customer', { where: { id: 1 } })
    expect([...rec.unresolved]).toEqual([])
    c.read('customer', { include: { invoices: true } })
    expect([...rec.unresolved]).toEqual(['Customer.invoices'])
  })

  test('_count over a relation is a read of that relation', () => {
    const c = client(RELATIONS)
    const rec = createReadRecorder(c)
    c.read('customer', { include: { _count: { select: { invoices: true } } } })
    expect([...rec.models]).toContain('Invoice')
  })

  test('an aggregate with no include contributes only its own table', () => {
    // The six REFUSED rows of the audit probe are the negative control for the
    // recorder's PLACEMENT; this is the one of them the expansion could break.
    const c = client(RELATIONS)
    const rec = createReadRecorder(c)
    c.read('invoice', { _sum: { total: true } })
    expect([...rec.models]).toEqual(['invoice'])
    expect([...rec.unresolved]).toEqual([])
  })
})

describe('formatReport', () => {
  test('lists each route and what it published', () => {
    const out = formatReport([
      { route: '/shop/', allowed: 0, published: [{ model: 'Product', level: 0 }] },
      { route: '/about/', allowed: 0, published: [] },
    ])
    expect(out).toContain('/shop/')
    expect(out).toContain('Product(0)')
    expect(out).toContain('—')
  })
})

// ── Half 2: the wiring ───────────────────────────────────────────────────

describe('prerenderRoutes — the read set comes from load()', () => {

  const RENDER_TIMEOUT = 30_000

  /**
   * Build a throwaway app whose load() "reads" a model, and a fake client that
   * reports it. The fake is deliberate: this test is about whether the
   * prerenderer collects and acts on the read set, not about Litestone.
   */
  function scaffold(modelRead, frontmatter = 'render: static') {
    const root = tmpDir('sierra-safety-')
    mkdirSync(resolve(root, 'src/routes/report'), { recursive: true })
    writeFileSync(resolve(root, 'src/routes/report/index.mesa'),
      `---\n${frontmatter}\n---\n<script>export let data = null</script>\n<h1>{data?.n ?? 0}</h1>\n`)
    writeFileSync(resolve(root, 'src/routes/report/index.meta.js'),
      `export async function load() { globalThis.__READ__?.('${modelRead}'); return { n: 1 } }\n`)
    return root
  }

  function fakeClient() {
    const listeners = new Set()
    globalThis.__READ__ = (model) => { for (const fn of listeners) fn({ model, operation: 'findMany' }) }
    return { $tapQuery(fn) { listeners.add(fn); return () => listeners.delete(fn) } }
  }

  async function run(root, db) {
    const { renderComponent } = await import('@frontierjs/mesa/render-component.js')
    const { scan } = await import('../src/scanner/index.js')
    const tree = await scan('src/routes', { cwd: root })
    return prerenderRoutes({
      tree, root,
      outDir: tmpDir('sierra-safety-out-'),
      renderComponent,
      schemaDefs: DEFS, schemaModels: MODELS, db,
    })
  }

  test('a load() reading an ungated model builds', async () => {
    const res = await run(scaffold('product'), fakeClient())
    expect(res.written).toContain('report/index.html')
    expect(res.safety.rows[0].published).toEqual([{ model: 'Product', level: 0 }])
  }, RENDER_TIMEOUT)

  test('a load() reading a GATED model fails the build', async () => {
    // The one that would have failed under the original render-watching
    // design, because nothing is read during render.
    await expect(run(scaffold('invoice'), fakeClient()))
      .rejects.toThrow(/Invoice/)
  }, RENDER_TIMEOUT)

  test('…and it throws rather than warning', async () => {
    // A warning scrolls past in CI and the file is written anyway. Once a
    // public artifact exists it has been served and indexed.
    await expect(run(scaffold('invoice'), fakeClient()))
      .rejects.toThrow(/cannot be published as static HTML/)
  }, RENDER_TIMEOUT)

  test('an acknowledged route is published', async () => {
    const res = await run(scaffold('invoice', 'render: static\npublishes: 4'), fakeClient())
    expect(res.written).toContain('report/index.html')
  }, RENDER_TIMEOUT)

  test('no client means a data-reading route is refused', async () => {
    await expect(run(scaffold('product'), null))
      .rejects.toThrow(/could not observe/)
  }, RENDER_TIMEOUT)

  test('no schema stands the whole check down', async () => {
    // A Sierra app with no .lite file has no gates, so there is nothing to
    // prove and nothing to refuse.
    const { renderComponent } = await import('@frontierjs/mesa/render-component.js')
    const { scan } = await import('../src/scanner/index.js')
    const root = scaffold('product')
    const tree = await scan('src/routes', { cwd: root })
    const res = await prerenderRoutes({
      tree, root,
      outDir: tmpDir('sierra-safety-out-'),
      renderComponent,
      schemaDefs: null,
    })
    expect(res.written).toContain('report/index.html')
    expect(res.safety).toBeNull()
  }, RENDER_TIMEOUT)
})

describe('prerenderRoutes — a companion that will not import', () => {

  const RENDER_TIMEOUT = 30_000

  /**
   * The fail-OPEN hole the first version of this check had, found by running it
   * in `example/` rather than by reading it.
   *
   * `importCompanion` swallowed an import error and returned null. So a .meta.js
   * that throws on import — one importing a db client under a runtime that
   * cannot load it, which is exactly what happened — was indistinguishable from
   * a route with no companion, and sailed through as "reads nothing".
   *
   * It is refused twice over now. The import itself throws, naming the route and
   * carrying the module's own error (`FJS-551`), which is the earlier and more
   * useful of the two; and behind it the safety check still treats a companion
   * it could not read as UNKNOWN, which is the case it exists to refuse.
   */
  test('is refused, and the refusal carries the module\'s own error', async () => {
    const { renderComponent } = await import('@frontierjs/mesa/render-component.js')
    const { scan } = await import('../src/scanner/index.js')

    const root = tmpDir('sierra-broken-')
    mkdirSync(resolve(root, 'src/routes/report'), { recursive: true })
    writeFileSync(resolve(root, 'src/routes/report/index.mesa'),
      `---\nrender: static\n---\n<h1>hi</h1>\n`)
    // Imports something that does not exist — import throws, mod is null.
    writeFileSync(resolve(root, 'src/routes/report/index.meta.js'),
      `import { nope } from './does-not-exist.js'\n` +
      `export async function load() { return { nope } }\n`)

    const tree = await scan('src/routes', { cwd: root })
    await expect(prerenderRoutes({
      tree, root,
      outDir: tmpDir('sierra-broken-out-'),
      renderComponent,
      schemaDefs: DEFS, schemaModels: MODELS,
      db: null,
    })).rejects.toThrow(/companion threw while it was loading/)
  }, RENDER_TIMEOUT)

  test('and the cause is in the message, not only the fact', async () => {
    const { renderComponent } = await import('@frontierjs/mesa/render-component.js')
    const { scan } = await import('../src/scanner/index.js')

    const root = tmpDir('sierra-broken-cause-')
    mkdirSync(resolve(root, 'src/routes/report'), { recursive: true })
    writeFileSync(resolve(root, 'src/routes/report/index.mesa'),
      `---\nrender: static\n---\n<h1>hi</h1>\n`)
    writeFileSync(resolve(root, 'src/routes/report/index.meta.js'),
      `throw new Error('the schema has errors: line 837')\n` +
      `export async function load() { return {} }\n`)

    const tree = await scan('src/routes', { cwd: root })
    let message = ''
    try {
      await prerenderRoutes({
        tree, root,
        outDir: tmpDir('sierra-broken-cause-out-'),
        renderComponent,
        schemaDefs: DEFS, schemaModels: MODELS,
        db: null,
      })
    } catch (err) { message = err.message }

    // The route, so the reader knows where — and the module's own sentence, so
    // they know what. A build that prints only the first sends them to the file
    // rather than to the schema.
    expect(message).toMatch(/\/report/)
    expect(message).toMatch(/the schema has errors: line 837/)
  }, RENDER_TIMEOUT)
})
