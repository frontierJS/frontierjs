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
const { listPage, createPage, editPage } = await import(resolve(HERE, '../core/crud-templates.js'))
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
  'make:resource — resource file': resourceFile('Order', 'orders'),
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
      expect(source, `${what} takes a sort and never marks it`).toContain('orderBy={ordering}')
      // And it parses nothing: reading the three legal shapes is <Table>'s, off
      // one owner, because three pages did it by hand and disagreed (FJS-1077).
      expect(source, `${what} parses the orderBy itself`).not.toContain('.replace(/^-/')
      // Read off page.directives and never held locally: the URL is the state,
      // so a pair kept in the page disagrees with the load on the first Back.
      expect(source, `${what} does not read the sort off the URL`).toContain('page.directives?.orderBy')
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
      expect(tag, `${what} hands the bar no filters`).toContain('value={page.query}')
      expect(tag, `${what} hands the bar no directives, so a filter drops the sort`)
        .toContain('directives={page.directives}')
    }
    expect(handed, 'no generated page renders a filter bar at all').toBeGreaterThan(0)
  })
})
