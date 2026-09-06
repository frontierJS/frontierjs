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

model Customer {
  id       String    @id @default(cuid())
  name     String
  invoices Invoice[]
  @@gate("0.4.4.5")
}

model Invoice {
  id         String   @id @default(cuid())
  total      Float    @default(0)
  customerId String?
  customer   Customer? @relation(fields: [customerId], references: [id])
  @@gate("4.4.4.5")
}
`

/**
 * A throwaway app whose load() reads through a real client.
 *
 * `read` is the BODY of the read, so a test can write the query it means —
 * `include:` included, which is the whole of `FJS-781`.
 */
async function realApp(read, frontmatter = 'render: static') {
  const body = read.includes('.') ? read : `${read}.findMany({ limit: 1 })`
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
    `  const rows = await globalThis.__REALDB__.asSystem().${body}\n` +
    `  return { n: rows.length }\n` +
    `}\n`)

  return { root, db, json }
}

async function run({ root, db, json }, { wireDb = true, warnings = null } = {}) {
  const { renderComponent } = await import('@frontierjs/mesa/render-component.js')
  const { scan } = await import('../src/scanner/index.js')
  const tree = await scan('src/routes', { cwd: root })
  return prerenderRoutes({
    tree, root,
    outDir: tmpDir('sierra-real-out-'),
    renderComponent,
    schemaDefs:   json.$defs,
    schemaModels: Object.keys(json.$defs).filter(k => json.$defs[k].properties),
    // Not wiring it is what makes a route UNPROVABLE — the state `publishes: 0`
    // used to wave through (`FJS-782`).
    db: wireDb ? db : null,
    ...(warnings ? { warn: m => warnings.push(m) } : {}),
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

// ── FJS-781 — the relation the tap never fires for ────────────────────────
//
// `$tapQuery` fires per TABLE. A child resolved by `include:` is read inside
// the parent's own statement, so `Customer` was the whole read set, the report
// printed `Customer(0)`, and a level-4 `Invoice` was in the published file.

await check('an included GATED child fails the build, and the message names IT', async () => {
  let threw = null
  try {
    await run(await realApp('customer.findMany({ limit: 1, include: { invoices: true } })'))
  } catch (e) { threw = e }
  assert(threw, 'the build succeeded — a level-4 Invoice reached a public file through include:')
  assert(/Invoice/.test(threw.message), `message did not name the child: ${threw.message}`)
  assert(/@@gate read 4/.test(threw.message), `message did not name the level: ${threw.message}`)
})

await check('the included child is in the REPORT, not only in the refusal', async () => {
  // A refusal that does not also correct the table leaves the build printing
  // `Customer(0)` beside it, which is the sentence that made the page look
  // proven.
  const res = await run(await realApp(
    'customer.findMany({ limit: 1, include: { invoices: true } })',
    'render: static\npublishes: 4'))
  const got = JSON.stringify(res.safety.rows[0].published)
  assert(/"model":"Invoice"/.test(got), `the report did not carry the child: ${got}`)
  assert(/"model":"Customer"/.test(got), `the report lost the parent: ${got}`)
})

await check('a plain read of the same parent still builds', async () => {
  // The negative control. A fix that refused every `include` outright — or
  // every read of a model that HAS a gated child — satisfies the two rows
  // above and blocks the ordinary page (`FJS-351`).
  const res = await run(await realApp('customer.findMany({ limit: 1 })'))
  assert(res.written.includes('report/index.html'),
    `written was ${JSON.stringify(res.written)}; skipped: ${JSON.stringify(res.skipped)}`)
  const got = JSON.stringify(res.safety.rows[0].published)
  assert(got === '[{"model":"Customer","level":0}]', `published was ${got}`)
})

await check('a select naming only scalar columns is not an unresolved read', async () => {
  // The other direction of the same control: every ordinary `select` would be
  // refused if a scalar key counted as a relation the map does not carry.
  const res = await run(await realApp('customer.findMany({ limit: 1, select: { id: true, name: true } })'))
  assert(res.written.includes('report/index.html'),
    `a plain select was refused; skipped: ${JSON.stringify(res.skipped)}`)
})

// ── FJS-782 — `publishes:` is not an answer about OBSERVABILITY ────────────

await check('an unobservable route is refused', async () => {
  let threw = null
  try { await run(await realApp('product'), { wireDb: false }) } catch (e) { threw = e }
  assert(threw, 'a route whose reads nothing could observe was published')
  assert(/could not observe/.test(threw.message), `wrong refusal: ${threw.message}`)
})

await check('…and `publishes: 0` does not waive it — the escape that looked most conservative', async () => {
  // The measured escape: the same app, the same unobservable loader, refused
  // without the key and published with `publishes: 0`.
  for (const declared of ['publishes: 0', 'publishes: 4']) {
    let threw = null
    try {
      await run(await realApp('product', `render: static\n${declared}`), { wireDb: false })
    } catch (e) { threw = e }
    assert(threw, `${declared} still turned the observability check off`)
    assert(/could not observe/.test(threw.message), `wrong refusal for ${declared}: ${threw.message}`)
  }
})

await check('…and a route that reads NOTHING still builds with no client wired', async () => {
  // The negative control for the branch above: a page with no companion has
  // nothing to prove, and refusing it would fail every static page in an app
  // that has a schema and a site that never touches it.
  const app = await realApp('product')
  writeFileSync(resolve(app.root, 'src/routes/report/index.meta.js'), 'export const x = 1\n')
  const res = await run(app, { wireDb: false })
  assert(res.written.includes('report/index.html'),
    `written was ${JSON.stringify(res.written)}; skipped: ${JSON.stringify(res.skipped)}`)
})

await check('a load() that reads no model is REPORTED, not refused and not silent', async () => {
  // The second half of `FJS-782`. The tap is installed on the ONE client the
  // config named, so a load() that constructs its own reads with `tapped` still
  // true and contributes nothing — a pass that proves nothing. It cannot be
  // refused (a load() that fetches an absolute URL is legitimate and common),
  // so it is a state the build reports.
  const app = await realApp('product')
  writeFileSync(resolve(app.root, 'src/routes/report/index.meta.js'),
    'export async function load() { return { n: 0 } }\n')
  const warnings = []
  const res = await run(app, { warnings })
  assert(res.written.includes('report/index.html'), 'a load() reading nothing was refused')
  assert(warnings.some(w => /observed no model read/.test(w)),
    `nothing was reported; warnings were ${JSON.stringify(warnings)}`)
})

await check('…and a load() that DID read is not reported', async () => {
  // The negative control: a report that fires on every page is one nobody
  // reads, which is the same silence one step along (`FJS-351`).
  const warnings = []
  await run(await realApp('product'), { warnings })
  assert(!warnings.some(w => /observed no model read/.test(w)),
    `an ordinary read was reported: ${JSON.stringify(warnings)}`)
})

console.log(`\n  ${passed}/${passed + failures.length} passed\n`)
if (failures.length) process.exit(1)
