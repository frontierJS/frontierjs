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
const columns  = [{ key: 'reference', label: 'Reference' }, { key: 'total', label: 'Total' }]

const GENERATED = {
  'make:scaffold — list page': listPage({
    title: 'Orders', heading: 'Orders', newLabel: 'New Order',
    basePath, imports, res: 'orders', columns,
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
})
