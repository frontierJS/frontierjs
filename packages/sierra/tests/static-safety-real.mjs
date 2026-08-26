/**
 * tests/static-safety-real.mjs — the static-safety check against a REAL
 * Litestone client. Run with bun:
 *
 *     bun run test:safety
 *
 * ── Why this is not in the vitest suite ───────────────────────────────────
 *
 * Litestone imports `bun:sqlite`, and Sierra's suite runs under Node — which
 * is why every other Litestone touchpoint in this package (schema-plugin) is a
 * guarded dynamic import. So the vitest file next to this one uses a fake
 * client that emits the events a tap would produce.
 *
 * That fake proves the prerenderer ACTS on a read set. It cannot prove the read
 * set is real, and the two places this chain breaks are both outside it:
 *
 *   1. `$tapQuery` reports the TABLE name (`invoice`); `$defs` is keyed by the
 *      MODEL name (`Invoice`). A fake emits whatever string the test author
 *      expected, so it would agree with a wrong implementation.
 *   2. `@@gate("4.4.4.5")` has to survive parse → generateJsonSchema → the
 *      `x-gate.read` this check reads.
 *
 * Both are exactly the kind of "two things that look the same and aren't" that
 * `VERIFYING.md` says to settle by running. So this file runs them.
 *
 * Exits non-zero on the first failure.
 */

import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { mkdirSync, writeFileSync } from 'fs'

const HERE = dirname(fileURLToPath(import.meta.url))

import { prerenderRoutes } from '../src/build/prerender.js'
import { createClient, autoMigrate, parse, generateJsonSchema } from '@frontierjs/litestone'
import { tmpDir } from './tmp.js'

let passed = 0
const failures = []

function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ok    ${name}`) })
    .catch(err => { failures.push({ name, err }); console.log(`  FAIL  ${name}\n        ${err.message}`) })
}

function assert(cond, msg) { if (!cond) throw new Error(msg) }

const SCHEMA = `
model Product {
  id   String @id @default(cuid())
  name String
  @@gate("0.4.4.5")
}

model Invoice {
  id    String @id @default(cuid())
  total Float  @default(0)
  @@gate("4.4.4.5")
}
`

/** A throwaway app whose load() reads through a real client. */
async function realApp(accessor, frontmatter = 'render: static') {
  const root = tmpDir('sierra-real-')
  mkdirSync(resolve(root, 'db'), { recursive: true })
  const schemaPath = resolve(root, 'db/schema.lite')
  writeFileSync(schemaPath, SCHEMA)

  const db = await createClient({ schema: schemaPath, db: ':memory:' })
  autoMigrate(db)

  // The build's own path to the gate table — the same two calls schema-plugin
  // makes, so a change in either shows up here rather than in production.
  const parsed = parse(SCHEMA)
  const json   = generateJsonSchema(parsed.schema ?? parsed)

  globalThis.__REALDB__ = db
  mkdirSync(resolve(root, 'src/routes/report'), { recursive: true })
  writeFileSync(resolve(root, 'src/routes/report/index.mesa'),
    `---\n${frontmatter}\n---\n<script>export let data = null</script>\n<h1>{data?.n ?? 0}</h1>\n`)
  writeFileSync(resolve(root, 'src/routes/report/index.meta.js'),
    `export async function load() {\n` +
    `  const rows = await globalThis.__REALDB__.asSystem().${accessor}.findMany({ limit: 1 })\n` +
    `  return { n: rows.length }\n` +
    `}\n`)

  return { root, db, json }
}

async function run({ root, db, json }) {
  const { renderComponent } = await import('@frontierjs/mesa/render-component.js')
  const { scan } = await import('../src/scanner/index.js')
  const tree = await scan('src/routes', { cwd: root })
  return prerenderRoutes({
    tree, root,
    outDir: tmpDir('sierra-real-out-'),
    renderComponent,
    schemaDefs:   json.$defs,
    schemaModels: Object.keys(json.$defs).filter(k => json.$defs[k].properties),
    db,
    // Mesa SSR_SPEC W1: renderComponent writes a temp module and resolves that
    // module's bare imports from wherever it sits. The scaffolded app is a bare
    // mkdtemp with no node_modules, so point at this package's — the real build
    // uses `resolve(root, 'node_modules/.sierra/render')` for the same reason.
    tmpDir: resolve(HERE, '../node_modules/.sierra/render'),
  })
}

console.log('\n  static safety — against a real Litestone client\n')

await check('the gate survives .lite → x-gate', async () => {
  const { json } = await realApp('product')
  assert(json.$defs.Invoice['x-gate'].read === 4, `Invoice read gate is ${json.$defs.Invoice['x-gate']?.read}, expected 4`)
  assert(json.$defs.Product['x-gate'].read === 0, `Product read gate is ${json.$defs.Product['x-gate']?.read}, expected 0`)
})

await check('a real tap reports the table name, and it resolves to the model', async () => {
  const res = await run(await realApp('product'))
  const got = JSON.stringify(res.safety.rows[0].published)
  assert(got === '[{"model":"Product","level":0}]', `published was ${got}`)
})

await check('an ungated read builds', async () => {
  const res = await run(await realApp('product'))
  assert(res.written.includes('report/index.html'),
    `written was ${JSON.stringify(res.written)}; skipped: ${JSON.stringify(res.skipped)}`)
})

await check('a GATED read fails the build, end to end, nothing faked', async () => {
  let threw = null
  try { await run(await realApp('invoice')) } catch (e) { threw = e }
  assert(threw, 'the build succeeded — a level-4 model was published as public HTML')
  assert(/Invoice/.test(threw.message), `message did not name the model: ${threw.message}`)
  assert(/@@gate read 4/.test(threw.message), `message did not name the level: ${threw.message}`)
})

await check('an acknowledged route publishes it deliberately', async () => {
  const res = await run(await realApp('invoice', 'render: static\npublishes: 4'))
  assert(res.written.includes('report/index.html'), 'an acknowledged route was still refused')
  const got = JSON.stringify(res.safety.rows[0].published)
  assert(got === '[{"model":"Invoice","level":4}]', `published was ${got}`)
})

console.log(`\n  ${passed}/${passed + failures.length} passed\n`)
if (failures.length) process.exit(1)
