/**
 * tests/auto-import-build.test.js — auto-import through a REAL Vite build
 *
 * The unit tests hold what injectAutoImports() returns as a string. This one
 * holds the thing that actually matters: that the injected source COMPILES.
 * A prepended import can be syntactically fine and still land in the wrong
 * block, shadow a Mesa-generated name, or resolve to nothing — none of which a
 * string assertion can see.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { mkdir, writeFile, rm } from 'fs/promises'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { build } from 'vite'

import { createSierraViteConfig } from '../src/build/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TMP = join(__dirname, 'tmp-autoimport-build')

beforeAll(async () => {
  // A component two directories deep — only a recursive scan finds it.
  await mkdir(join(TMP, 'src/components/UI/forms'), { recursive: true })
  await mkdir(join(TMP, 'src/lib'), { recursive: true })

  await writeFile(
    join(TMP, 'src/components/UI/Card.mesa'),
    '<div class="card">{title}</div>\n<script>\n  let { title } = $.props\n</script>',
    'utf8'
  )
  await writeFile(
    join(TMP, 'src/components/UI/forms/TextField.mesa'),
    '<input value={value} />\n<script>\n  let { value } = $.props\n</script>',
    'utf8'
  )

  // The package a module binding is auto-imported from.
  await writeFile(
    join(TMP, 'src/lib/format.js'),
    'export const money = (n) => `$${n}`\nexport const shout = (s) => s.toUpperCase()\n',
    'utf8'
  )

  // The entry uses all three without importing any of them:
  // two components as tags, one binding in the script, one in an expression.
  await writeFile(
    join(TMP, 'src/entry.mesa'),
    [
      '<script>',
      '  let total = shout("total")',
      '</script>',
      '<Card title={total} />',
      '<TextField value={money(12)} />',
    ].join('\n'),
    'utf8'
  )

  // A markup-only page — no <script> of any kind. The exact thing
  // auto-imported components exist for, and the shape that had nowhere to put
  // an import: the statement was prepended as TEMPLATE text (`FJS-796`).
  await writeFile(
    join(TMP, 'src/plain.mesa'),
    '<h1>Hello</h1>\n<Card title="x" />\n',
    'utf8'
  )
})

afterAll(async () => {
  await rm(TMP, { recursive: true, force: true })
})

describe('auto-import through a real Vite build', () => {
  test('a nested component and two module bindings compile with no import written', async () => {
    const config = createSierraViteConfig({
      target: 'widget',
      autoImport: {
        components: ['src/components/UI'],
        modules: { '/src/lib/format.js': ['money', ['shout', 'shout']] },
      },
      vite: {
        root: TMP,
        logLevel: 'silent',
        build: {
          outDir: join(TMP, 'dist'),
          emptyOutDir: true,
          // Unminified, because every assertion below names an identifier and
          // esbuild renames them. Sierra no longer overrides Vite's minify
          // default (`FJS-799`), so a build is minified unless a caller says
          // otherwise — and this test is about what reached the graph.
          minify: false,
          lib: { entry: join(TMP, 'src/entry.mesa'), formats: ['es'], fileName: 'entry' },
        },
      },
    })

    const result = await build(config)
    const output = Array.isArray(result) ? result[0].output : result.output
    const code = output.filter(c => c.type === 'chunk').map(c => c.code).join('\n')

    // Each assertion names a body that can only be in the bundle if its own
    // import was injected AND resolved. A missing injection does NOT fail the
    // build — Mesa compiles a reference to an undefined name happily — so the
    // bundle content is the only thing that can tell the two apart.
    expect(code).toContain('card')        // Card.mesa reached the graph
    expect(code).toContain('input')       // TextField.mesa, two directories deep
    expect(code).toContain('toUpperCase') // shout(), used in the <script>
    expect(code).toContain('money')       // money(), used in a {…} expression
  }, 60_000)

  test('a script-less page gets a script block, not an import rendered as text', async () => {
    const config = createSierraViteConfig({
      target: 'widget',
      autoImport: { components: ['src/components/UI'] },
      vite: {
        root: TMP,
        logLevel: 'silent',
        build: {
          outDir: join(TMP, 'dist-plain'),
          emptyOutDir: true,
          minify: false,
          lib: { entry: join(TMP, 'src/plain.mesa'), formats: ['es'], fileName: 'plain' },
        },
      },
    })

    const result = await build(config)
    const output = Array.isArray(result) ? result[0].output : result.output
    const code = output.filter(c => c.type === 'chunk').map(c => c.code).join('\n')

    // The component reached the graph…
    expect(code).toContain('card')
    // …and the import statement is nowhere in a template literal. Mesa emits
    // the page's markup as `template(\`…\`)`, so the import appearing there is
    // exactly the failure: the words rendered onto the page.
    for (const tpl of code.matchAll(/template\(`([^`]*)`/g)) {
      expect(tpl[1]).not.toContain('import Card')
    }
  }, 60_000)
})
