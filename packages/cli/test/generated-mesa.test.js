/**
 * generated-mesa.test.js — what the generators WRITE must compile.
 *
 * A generator emits component source as a string inside a `.js` file, which
 * makes it the only Mesa in this repo that nothing ever compiles: the `*.mesa`
 * globs cannot see it, `fli check` grades files on disk that do not exist until
 * somebody runs the command, and the compiler is never handed it. So a change
 * to the language lands everywhere except here, and the first person to find out
 * is whoever scaffolds the next app.
 *
 * That is not hypothetical. `FJS-D132` moved every component in the repo onto
 * the `$` door and retired the bare spelling; these templates were still
 * emitting `import { $onDestroy } from '@frontierjs/mesa/runtime'` and
 * `$onDestroy(unsubscribe)` afterwards, and every suite was green.
 *
 * The compiler is imported by relative path because `@frontierjs/cli` does not
 * depend on mesa and must not — it scaffolds apps, and mesa is the app's peer,
 * not the CLI's. Repo tests import workspace source by path anyway, since bun
 * resolves a workspace dep to a copy rather than a symlink.
 */
import { test, expect, describe } from 'bun:test'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const { compileSource } = await import(resolve(HERE, '../../mesa/src/compiler.js'))
// acorn is mesa's dependency, not this package's — reached the same way the
// compiler itself is, by path, so the CLI gains no dependency for a test.
const { parse: parseJs } = await import(resolve(HERE, '../../mesa/node_modules/acorn/dist/acorn.mjs'))
const { listPage, createPage, editPage, resourceRoutePage } = await import(resolve(HERE, '../core/crud-templates.js'))
const { resourceFile } = await import(resolve(HERE, '../core/resource-template.js'))

// The shape `fli make:scaffold` actually passes — see commands/make/scaffold.md.
// Two imports off one file: the default export is the model's default form,
// the named one is the accessor. Both, because the pages use both.
const imports  = [
  `import Order from '../../resources/Order.mesa'`,
  `import { orders } from '../../resources/Order.mesa'`,
]
const basePath = '/orders/'
const GENERATED = {
  // Two shapes of one page, because the column set is emitted differently for
  // each and only one of them is what a scaffold writes: the ranked default
  // asks the resource at runtime, and `only` bakes the names in.
  'make:scaffold — list page': listPage({
    title: 'Orders', heading: 'Orders', newLabel: 'New Order',
    basePath, imports, res: 'orders',
  }),
  'make:scaffold — list page with a pinned column set': listPage({
    title: 'Orders', heading: 'Orders', newLabel: 'New Order',
    basePath, imports, res: 'orders', only: ['reference', 'total'],
  }),
  // What `fli admin:generate` writes: the same page plus the gate notice, the
  // per-row delete and the session import, none of which the scaffold emits.
  'admin:generate — list page': listPage({
    title: 'Orders', heading: 'Orders', newLabel: 'New Order',
    basePath, imports, res: 'orders', gate: true, rowDelete: true,
    sessionImport: "import { session } from '../../session.js'",
  }),
  'make:scaffold — create page': createPage({
    title: 'New Order', heading: 'New Order', submitLabel: 'Create Order',
    backLabel: 'Back to list', basePath, imports, res: 'orders', form: 'Order',
  }),
  'make:scaffold — edit page': editPage({
    title: 'Order', heading: 'Order', submitLabel: 'Save',
    backLabel: 'All orders', deleteLabel: 'Delete', basePath, imports, res: 'orders', form: 'Order',
  }),
  // The admin's detail page: its own session module, the gate notice and the
  // child links, none of which the scaffold's edit page carries.
  'admin:generate — detail page': editPage({
    title: 'Order', heading: 'Order', submitLabel: 'Save',
    backLabel: 'All orders', deleteLabel: 'Delete', basePath, imports, res: 'orders', form: 'Order',
    gate: true, sessionImport: "import { session } from '../../session.js'",
    childRoutesImport: "import { childRoutes } from '../_routes.js'",
  }),
  'make:resource — resource file': resourceFile('Order', 'orders'),
  // `fli make:route <path> --resource Order`, one per shape the path can name.
  'make:route — list':   resourceRoutePage({ path: 'orders', model: 'Order', service: 'orders' }).content,
  'make:route — create': resourceRoutePage({ path: 'orders/create', model: 'Order', service: 'orders' }).content,
  'make:route — detail': resourceRoutePage({ path: 'orders/[id]', model: 'Order', service: 'orders' }).content,
}

describe('what the generators write', () => {
  for (const [what, source] of Object.entries(GENERATED)) {
    test(`${what} compiles`, async () => {
      const ctx = await compileSource(source, { filename: 'Generated.mesa', css: false, debug: false })
      expect(ctx.analysis.errors, what).toEqual([])
    })

    // Invariant 15: a clean compile is not proof of valid JS.
    test(`${what} emits JavaScript that parses`, async () => {
      const ctx = await compileSource(source, { filename: 'Generated.mesa', css: false, debug: false })
      expect(() => parseJs(ctx.result, { ecmaVersion: 'latest', sourceType: 'module' }), what).not.toThrow()
    })
  }

  // The specific regression, named so it cannot come back quietly.
  //
  // Which spellings are retired is READ OFF THE COMPILER, never restated here:
  // `FJS-D135` gave the five data bags a bare spelling back, and a hand-kept
  // copy of the list would have failed this suite for four of them while the
  // compiler happily accepted all four. The list that matters is DOOR_MEMBERS
  // minus SUGAR_MEMBERS, which is what the compiler itself computes.
  test('no generator emits a bare spelling the compiler refuses', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(resolve(HERE, '../../mesa/src/compiler.js'), 'utf8')
    const names = (decl) =>
      src.match(new RegExp(`const ${decl} = \\[([\\s\\S]*?)\\]`))[1]
        .match(/'(\w+)'/g).map((x) => x.slice(1, -1))
    const refused = names('DOOR_MEMBERS').filter((m) => !names('SUGAR_MEMBERS').includes(m))
    expect(refused.length, 'read no names off the compiler').toBeGreaterThan(0)

    const BARE = new RegExp(String.raw`(?<![\w$])\$(${refused.join('|')})\b`)
    for (const [what, source] of Object.entries(GENERATED)) {
      const hit = source.match(BARE)
      expect(hit?.[0] ?? null, `${what} still writes ${hit?.[0]}`).toBeNull()
    }
  })

  // A sort a page can SET and cannot SHOW is the shape that passes every test
  // asking what the table renders. <Table> derives the next direction from the
  // ordering it was handed, so a page that reports a sort without stating the
  // current one has a header that never reverses and an aria-sort stuck at
  // none — and the rows are correct the whole time, because the boundary got
  // the directive.
  test('a generated table that offers a sort states the current one', () => {
    let offered = 0
    for (const [what, source] of Object.entries(GENERATED)) {
      if (!source.includes('onsort=')) continue
      offered++
      // The SAME directives the load sends, read off the list and never held
      // locally: a pair kept in the page disagrees with the load on the first Back.
      expect(source, `${what} takes a sort and never marks it`).toContain('orderBy={list.directives.orderBy}')
      // And it parses nothing: reading the three legal shapes is <Table>'s, off
      // one owner, because three pages did it by hand and disagreed (FJS-1077).
      expect(source, `${what} parses the orderBy itself`).not.toContain('.replace(/^-/')
    }
    expect(offered, 'no generated page offers a sort at all').toBeGreaterThan(0)
  })

  // `columns()` answers in two halves and the second one is a promise the
  // generated comment makes in words: every column the table left out, named
  // with its reason, so a column added to the schema that does not appear is
  // answerable without reading the page. A page that destructures it and never
  // renders it makes that promise and does not keep it.
  test('a generated page renders every list it asks columns() for', () => {
    let asked = 0
    for (const [what, source] of Object.entries(GENERATED)) {
      if (!/columns:\s*cols,\s*omitted/.test(source)) continue
      asked++
      expect(source, `${what} asks for omitted and never renders it`).toContain('omitted.length')
    }
    expect(asked, 'no generated page asks for the omitted half').toBeGreaterThan(0)
  })

  // A filter bar is handed BOTH halves of the URL's query, because the router
  // splits them (Invariant 10) and the bar is what puts them back together. A
  // page that passes the filters alone hands the bar a query with no sort and no
  // page size in it -- and gets one back the same way, so the first keystroke in
  // a filter box drops the sort a header just set. Nothing refuses it: the bar
  // renders, the rows are correct, and only the sort quietly disappears.
  //
  // This replaces a tripwire asserting that `const urlQuery` compiled to a
  // derivation (`FJS-1065`). The const is gone -- the bar reads `page.query` and
  // `page.directives` as props, which are pushed from an effect -- so the hazard
  // is removed rather than guarded, and what is left to protect is the pairing.
  test('a generated page hands a filter bar both halves of the query', () => {
    let handed = 0
    for (const [what, source] of Object.entries(GENERATED)) {
      if (!source.includes('<FilterBar')) continue
      handed++
      const at  = source.indexOf('<FilterBar')
      const tag = source.slice(at, source.indexOf('/>', at))
      expect(tag, `${what} hands the bar no filters`).toContain('value={list.query}')
      expect(tag, `${what} hands the bar no directives, so a filter drops the sort`)
        .toContain('directives={list.directives}')
    }
    expect(handed, 'no generated page renders a filter bar at all').toBeGreaterThan(0)
  })

  // Nothing between <main class="screen"> and a page's components carries a
  // vertical gap, so flat siblings put the filter bar flush on the table.
  test('a generated page wraps its markup in one .stack', () => {
    for (const [what, source] of Object.entries(GENERATED)) {
      if (!source.includes('<SectionHeader')) continue
      const markup = source.slice(source.lastIndexOf('</script>') + 9).trim()
      expect(markup.startsWith('<div class="stack">'), `${what} has no .stack around its body`).toBe(true)
      expect(markup.endsWith('</div>'), `${what} closes its .stack early`).toBe(true)
    }
  })

  // A list page is a consumer of resource.list() and wires none of it itself.
  // The hand-wired shape failed in silence twice: without the bare $: watch the
  // load ran once and every filter and sort was a control that did nothing, and
  // with it a generated page restated the store, the load and the URL round-trip
  // per model. And the window: more() was built, keyset and correct, and no page
  // called it, so every list stopped at the server's page size with nothing
  // saying there were more rows.
  test('a generated list page reads its state through list() and offers the window', () => {
    let lists = 0
    for (const [what, source] of Object.entries(GENERATED)) {
      if (!source.includes('<Table')) continue
      lists++
      expect(source, `${what} does not use list()`).toMatch(/const list = \w+\.list\(/)
      expect(source, `${what} still wires a load by hand`).not.toMatch(/\$:\s*page\.query/)
      expect(source, `${what} still subscribes to the store by hand`).not.toContain('useStore(')
      expect(source, `${what} never offers more rows`).toContain('{#if list.hasMore}')
    }
    expect(lists, 'no generated page renders a table at all').toBeGreaterThan(0)
  })
})

// A model under `@@transitions` changes state by a MOVE, and the generated pages
// had no way to take one: no button anywhere, while the form offered the state
// column as a select of every member (`FJS-1433`). The buttons are read off the
// schema when the page runs, so a template that named a move, a state or the
// column would be a page frozen at the moment it was written.
describe('the moves a row may make', () => {
  const pages = Object.entries(GENERATED).filter(([what]) => /list|edit|detail/.test(what) && !/resource file/.test(what))

  test('every list and detail page draws one button per move, from transitions() at runtime', () => {
    expect(pages.length).toBeGreaterThan(4)
    for (const [what, source] of pages) {
      expect(source, `${what} does not ask the resource for the moves`).toMatch(/\.transitions\(rec, session\.level\)/)
      expect(source, `${what} offers a @system move a browser can never make`).toContain('.filter(t => !t.system)')
      expect(source, `${what} has no button per move`).toMatch(/\{#each movesOf\(record\) as t \(t\.name\)\}/)
      expect(source, `${what} does not call the move by its name`).toContain('.service.invoke(t.name, key)')
      expect(source, `${what} labels a button with the identifier`).toContain('>{t.label}</Button>')
    }
  })

  test('a move shows at once and is put back on a refusal, and the refusal is said', () => {
    for (const [what, source] of pages) {
      expect(source, `${what} does not move the row's node`).toContain('.mutate(key, { [t.field]: t.to }')
      expect(source, `${what} swallows a refused move`).toMatch(/catch \(e\) \{ (error|failed) = e\.message \}/)
    }
  })

  test('a page with no session of its own grades against sierra\'s, and watches it once', () => {
    for (const [what, source] of pages) {
      const own = source.includes("from '../../session.js'")
      expect(source.includes("import { session } from '@frontierjs/sierra/resource'"), what).toBe(!own)
      expect(source.match(/^\s*\$: session\.level$/gm)?.length, `${what} watches the level ${source.match(/^\s*\$: session\.level$/gm)?.length} times`).toBe(1)
    }
  })

  test('a detail page with no moves draws no empty cluster', () => {
    for (const [what, source] of pages.filter(([w]) => /edit|detail/.test(w))) {
      expect(source, what).toContain('{#if record && movesOf(record).length}')
    }
  })

  test('the template names no move, state or column', () => {
    for (const [what, source] of pages) {
      expect(source, what).not.toMatch(/invoke\('/)
      expect(source, what).not.toMatch(/\bstatus\b/)
    }
  })
})

// `fli make:route --resource` wrote ONE page for every path — a list under a
// detail route's heading, no form on a create route, a runtime import that does
// not exist, and a list file beside the directory its own next example creates
// (`FJS-1261`).
describe('make:route --resource', () => {
  const route = (path) => resourceRoutePage({ path, model: 'Order', service: 'orders' })

  test('the path names which of the three pages it writes', () => {
    expect(route('orders').kind).toBe('list')
    expect(route('orders/create').kind).toBe('create')
    expect(route('orders/[id]').kind).toBe('detail')
    const [list, create, detail] = ['orders', 'orders/create', 'orders/[id]'].map((p) => route(p).content)
    expect(new Set([list, create, detail]).size).toBe(3)
    expect(detail).toContain('page.params.id')
    expect(create).toContain('<Order')
    expect(list).toContain('columns()')
  })

  test('a list lands as index.mesa, so the detail and create routes can sit beside it', () => {
    expect(route('orders').file).toBe('orders/index.mesa')
    expect(route('orders/index').file).toBe('orders/index.mesa')
    expect(route('orders/[id]').file).toBe('orders/[id].mesa')
    expect(route('admin/orders').file).toBe('admin/orders/index.mesa')
  })

  test('each import reaches src/resources from where the file lands', () => {
    expect(route('orders').content).toContain(`from '../../resources/Order.mesa'`)
    expect(route('admin/orders/[id]').content).toContain(`from '../../../resources/Order.mesa'`)
    expect(route('admin/orders/[id]').content).toContain(`href="/admin/orders/"`)
  })

  test('a detail route keyed by anything but [id] is refused, not written with an undefined id', () => {
    expect(route('orders/[slug]').error).toContain('[id]')
  })

  // Sierra's scanner serves `routes/searchIndexes/` at /searchindexes/, so a
  // two-word model's every New, Open and Back link landed on the 404 (`FJS-1821`).
  test('a link names the URL the scanner serves its directory at, not the directory', () => {
    const page = (path) => resourceRoutePage({ path, model: 'SearchIndex', service: 'searchIndexes' })
    expect(page('searchIndexes').file).toBe('searchIndexes/index.mesa')
    expect(page('searchIndexes').content).toContain(`href="/searchindexes/create/"`)
    expect(page('searchIndexes/create').content).toContain(`href="/searchindexes/"`)
    expect(page('Admin/searchIndexes/[id]').content).toContain(`href="/admin/searchindexes/"`)
    for (const p of ['searchIndexes', 'searchIndexes/create', 'searchIndexes/[id]']) {
      expect(page(p).content, p).not.toContain('/searchIndexes/')
    }
  })
})
