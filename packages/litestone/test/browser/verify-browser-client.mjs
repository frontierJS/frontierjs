/*
 * verify-browser-client.mjs — Litestone's client, in a real browser, over OPFS.
 *
 *   node packages/litestone/test/browser/verify-browser-client.mjs
 *
 * This is the drive phase 4 exists for (`IDEAS/homestead.md`, `FJS-D305`).
 * Everything under it has a unit test somewhere; none of those can answer the
 * question this does, because all three of the things that could be wrong are
 * facts about a browser:
 *
 *   • whether OPFS's SYNCHRONOUS access handles exist here at all, which is
 *     what the whole engine choice rests on,
 *   • whether the `AsyncLocalStorage` shim in `host/browser.js` keeps a store
 *     across an `await` — it did not, on the first run it existed for,
 *   • whether rows written by one page load are read by the NEXT one, which is
 *     the only difference between a database and a cache,
 *   • and whether a feature whose SQL rests on a COMPILE-TIME option is here at
 *     all — `@point`'s haversine is six `SQLITE_ENABLE_MATH_FUNCTIONS`
 *     functions, and this build's `OMIT_LOAD_EXTENSION` is the same class of
 *     fact in the other direction. A server suite cannot ask either.
 *
 * It has also caught what is broken in a browser and nowhere else: node's
 * `Buffer` in the cursor codec, which took every paginated list on a device and
 * which every unit test in this package passes over, because bun has one.
 *
 * It builds what it serves. Bundling with `--conditions=browser` is not a
 * convenience: it is what resolves `#sql-engine` to nothing and `#host` to the
 * browser's half, so a bundle made any other way would be testing the server.
 *
 * Starts and stops its own static server on 7560 — test tier, tooling, project
 * litestone, straight off `packages/cli/core/ports.js`'s formula. Nothing to
 * launch first. Needs Chrome on PATH or $FJS_CHROME.
 *
 * ── Traps paid for once ───────────────────────────────────────────────────
 *
 *   • An evaluated expression must start with `return`. The CDP harness wraps
 *     it in an async function, so a bare expression answers `undefined` and
 *     every assertion fails for a reason that has nothing to do with the page.
 *   • The worker is a MODULE worker and its wasm arrives through a runtime
 *     `import(url)`. Serve `.wasm` as `application/wasm` or instantiation
 *     fails with a message about the MIME type and nothing about SQLite.
 */

import { spawnSync }                   from 'node:child_process'
import { createServer }                from 'node:http'
import { readFileSync, writeFileSync, existsSync, mkdirSync, cpSync, rmSync } from 'node:fs'
import { join, extname, dirname }      from 'node:path'
import { fileURLToPath }               from 'node:url'
import { openChrome }                  from '../../../mesa/test/browser/drive.mjs'
import { parse, parseFile }            from '../../src/core/parser.js'
import { deviceSchema }                from '../../src/device-schema.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG  = join(HERE, '../..')
const OUT  = join(PKG, 'test/browser/dist')
const PORT = 7560

// The real one. Filtered through `deviceSchema`, which is the only form of it
// a device is ever given.
const APP_SCHEMA = join(PKG, '../../example/db/schema.lite')

// `@sqlite.org/sqlite-wasm` is a devDependency and reached by PATH rather than
// by import: this package ships no dependency on it, because WHERE the wasm
// comes from is the app's decision (`engines/sqlite-wasm.js` takes a `load`).
const WASM_DIR = join(PKG, 'node_modules/@sqlite.org/sqlite-wasm/dist')

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.wasm': 'application/wasm', '.json': 'application/json',
}

const SCHEMA = `
model Shelf {
  id     String @id @default(uuid())
  label  String
  counts Count[]
  @@gate("2")
}
model Count {
  id        String    @id @default(uuid())
  shelfId   String
  shelf     Shelf     @relation(fields: [shelfId], references: [id])
  counted   Int
  deletedAt DateTime?
  @@gate("2")
  @@softDelete
  @@index([shelfId])
}
model Depot {
  id     String @id @default(uuid())
  name   String
  site   Json?  @point(lat, lng)
  @@gate("2")
}`

// ─── build ────────────────────────────────────────────────────────────────

function build() {
  if (!existsSync(WASM_DIR)) {
    console.error(`[skip] @sqlite.org/sqlite-wasm is not installed — run \`bun install\` in ${PKG}`)
    process.exit(0)
  }
  rmSync(OUT, { recursive: true, force: true })
  mkdirSync(OUT, { recursive: true })

  for (const [entry, name] of [['src/browser/worker.js', 'worker.js'], ['src/browser/client.js', 'client.js']]) {
    const r = spawnSync('bun', [
      'build', '--target=browser', '--conditions=browser',
      join(PKG, entry), '--outfile=' + join(OUT, name),
    ], { encoding: 'utf8' })
    if (r.status !== 0) { console.error(r.stderr ?? r.error?.message); process.exit(1) }
  }

  // Two files, and `sqlite3-opfs-async-proxy.js` is deliberately not one of
  // them: that proxy belongs to the OTHER OPFS VFS, the one that needs
  // SharedArrayBuffer and COOP/COEP headers. The SAH pool does not use it —
  // asserted by this drive passing without it rather than assumed.
  for (const f of ['index.mjs', 'sqlite3.wasm'])
    cpSync(join(WASM_DIR, f), join(OUT, f))

  writePage()
}

function writePage() {
  // The PARSED variant, which is what a real app will send. A projection of the
  // parsed tree is how a device gets the models it needs without the prose
  // `FJS-D204` strips or the policies `FJS-D303` makes opt-in — shipping the
  // app's `.lite` text would hand over both. Written through JSON, which is
  // strictly weaker than the structuredClone the worker boundary actually uses,
  // so a tree that survives this survives the real crossing.
  const parsed = JSON.parse(JSON.stringify(parse(SCHEMA)))
  writeFileSync(join(OUT, 'parsed.json'), JSON.stringify(parsed))
  writeFileSync(join(OUT, 'parsed.html'), `<!doctype html><meta charset=utf8><title>parsed</title>
<script type=module>
import { createBrowserClient } from './client.js'
window.boot = (async () => {
  const guest = await createBrowserClient({
    worker:  new URL('./worker.js', location.href),
    wasmUrl: new URL('./index.mjs', location.href).href,
    schema:  await (await fetch('./parsed.json')).json(),
    db:      '/parsed.db',
  })
  window.guest = guest
  window.db = guest.asSystem()
  return { engine: guest.$engine, models: guest.$models }
})()
</script>`)
  writeDevicePage()
}

// ── the app's own schema, filtered ────────────────────────────────────────
//
// The fixture above is two models written to exercise the worker. This is
// `example`'s 53, run through `deviceSchema` and served as the three a device
// actually gets — which is the only thing that can catch a construct a real
// schema has and a fixture does not.
function writeDevicePage() {
  const { parsed, models, notes } = deviceSchema(parseFile(APP_SCHEMA))
  writeFileSync(join(OUT, 'device.json'), JSON.stringify(parsed))

  console.log(`  device schema: ${models.join(', ')} — ${JSON.stringify(parsed).length} bytes, ` +
    `${notes.length} note${notes.length === 1 ? '' : 's'}`)

  writeFileSync(join(OUT, 'device.html'), `<!doctype html><meta charset=utf8><title>device</title>
<script type=module>
import { createBrowserClient } from './client.js'
window.boot = (async () => {
  const guest = await createBrowserClient({
    worker:  new URL('./worker.js', location.href),
    wasmUrl: new URL('./index.mjs', location.href).href,
    schema:  await (await fetch('./device.json')).json(),
    db:      '/device.db',
  })
  window.guest = guest
  window.db = guest.asSystem()
  return { engine: guest.$engine, models: guest.$models }
})()
</script>`)

  writePlainPage()
}

function writePlainPage() {
  const page = `<!doctype html><meta charset=utf8><title>litestone</title>
<script type=module>
import { createBrowserClient } from './client.js'
window.boot = (async () => {
  const guest = await createBrowserClient({
    worker:  new URL('./worker.js', location.href),
    wasmUrl: new URL('./index.mjs', location.href).href,
    schema:  ${JSON.stringify(SCHEMA)},
    db:      '/drive.db',
  })
  window.guest = guest
  window.db = guest.asSystem()
  return { engine: guest.$engine, models: guest.$models }
})()
</script>`
  writeFileSync(join(OUT, 'index.html'), page)
}

// ─── serve ────────────────────────────────────────────────────────────────

function serve() {
  const server = createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0])
    const p   = join(OUT, rel === '/' ? 'index.html' : rel)
    if (!p.startsWith(OUT) || !existsSync(p)) { res.writeHead(404); return res.end('not here') }
    res.writeHead(200, { 'content-type': TYPES[extname(p)] ?? 'application/octet-stream' })
    res.end(readFileSync(p))
  })
  return new Promise((r) => server.listen(PORT, () => r(server)))
}

// ─── drive ────────────────────────────────────────────────────────────────

const rows = []
const t = async (b, name, expr, check) => {
  try {
    const value = await b.evaluate(expr)
    rows.push({ name, ok: check(value), detail: JSON.stringify(value)?.slice(0, 100) })
  } catch (err) {
    rows.push({ name, ok: false, detail: err.message.split('\n')[0].slice(0, 140) })
  }
}


async function main() {
  build()
  const server = await serve()
  const b = await openChrome()
  const url = `http://localhost:${PORT}/`

  await b.navigate(url)

  // The engine, and that it is the wasm one rather than something that fell
  // back to memory — a fallback would pass every read below and persist none.
  await t(b, 'engine is sqlite-wasm over the OPFS pool',
    `return await window.boot`,
    v => v?.engine?.startsWith('sqlite-wasm') && v.models.join() === 'shelf,count,depot')

  await t(b, 'a row is written and read back',
    `const s = await db.shelf.create({ data: { label: 'A1' } }); window.sid = s.id; return s.label`,
    v => v === 'A1')

  await t(b, 'a child names its parent by a client-minted key',
    `return (await db.count.create({ data: { shelfId: sid, counted: 4 } })).counted`, v => v === 4)

  // The four that are not a key-value store. This is the argument against
  // `FJS-D305`'s option B in executable form: a scan cannot answer any of them.
  await t(b, 'include walks the relation',
    `return (await db.shelf.findMany({ include: { counts: true } }))[0].counts.length`, v => v === 1)
  await t(b, 'a where clause filters in SQL',
    `return (await db.count.findMany({ where: { counted: { gt: 2 } } })).length`, v => v === 1)
  await t(b, 'groupBy aggregates',
    `return (await db.count.groupBy({ by: ['shelfId'], _sum: { counted: true } }))[0]._sum.counted`, v => v === 4)
  await t(b, 'orderBy and limit',
    `return (await db.count.findMany({ orderBy: { counted: 'desc' }, limit: 1 }))[0].counted`, v => v === 4)

  // Invariant 6 does not move because the engine did. The gate is enforced at
  // the Data boundary, and here the Data boundary is on the device.
  await t(b, 'the gate refuses a client with no standing',
    `try { await guest.count.findMany(); return 'allowed' } catch (e) { return e.code }`,
    v => v === 'ACCESS_DENIED')

  // The error crossed a structuredClone and kept the field a caller acts on.
  await t(b, 'a refusal arrives with its code, not just a message',
    `try { await guest.count.findMany(); return {} } catch (e) { return { code: e.code, model: e.model, op: e.operation } }`,
    v => v?.code === 'ACCESS_DENIED' && v.model === 'Count')

  await t(b, '$transaction is refused by name',
    `try { db.$transaction(() => {}); return 'allowed' } catch (e) { return e.message.slice(0, 60) }`,
    v => typeof v === 'string' && v.includes('$transaction is not available'))

  await t(b, 'a model that does not exist is refused on the page',
    `try { db.widget.findMany(); return 'allowed' } catch (e) { return e.message.slice(0, 60) }`,
    v => typeof v === 'string' && v.includes("'widget' is not a model"))

  // ── the whole point ──
  // A second page load is a new worker, a new wasm instance and a new client.
  // Anything that answered from memory answers nothing here.
  //
  // **Nothing closes the client first, and that is an assertion.** An OPFS sync
  // access handle is EXCLUSIVE — the SAH pool reserves its whole capacity when
  // it installs — so a departing page whose worker outlives it holds the files
  // the arriving one needs. Chrome does not report that as an error: it kills
  // the RENDERER, taking the page and any service worker with it, which from
  // the outside is a tab that has stopped answering (`FJS-1179`). The client
  // releases its worker on `pagehide` for exactly this, and a navigation with
  // no `$close()` is the only thing that grades it.
  await b.navigate(url)
  await t(b, 'a second page load finds the same database',
    `return await window.boot`, v => v?.engine?.startsWith('sqlite-wasm'))
  await t(b, 'the rows survived it',
    `return await db.count.count()`, v => v === 1)
  await t(b, 'and so did the relation between them',
    `return (await db.shelf.findMany({ include: { counts: true } }))[0].counts[0].counted`, v => v === 4)

  // ── one message, one transaction ──
  //
  // The verb that decides whether hydration is a feature or a hang. Measured in
  // this browser: an autocommit INSERT over OPFS is one filesystem sync, so a
  // row costs 9.23 ms alone and 0.033 ms inside a batch — 0.3 seconds against
  // 46 for 5,000 rows. Batched, the engine matches `bun:sqlite` on a server.
  // The budget below is 45x the measured time, so it fails only if the batching
  // stops rather than if the machine is slow.
  await t(b, 'createMany writes 2000 rows in one call, and quickly',
    `const s = await db.shelf.create({ data: { label: 'bulk' } })
     const rows = Array.from({ length: 2000 }, (_, i) => ({ shelfId: s.id, counted: i }))
     const t0 = performance.now()
     const r = await db.count.createMany({ data: rows })
     return { wrote: r?.count ?? r, ms: performance.now() - t0, back: await db.count.count() }`,
    v => v?.wrote === 2000 && v.back === 2001 && v.ms < 3000)

  // A re-hydration writes rows that may already be there, so the refresh path
  // needs the other bulk verb and needs it to MOVE a value rather than insert
  // a duplicate.
  await t(b, 'upsertMany moves existing rows without adding any',
    `const before = await db.count.count()
     const some = await db.count.findMany({ limit: 100 })
     await db.count.upsertMany({ data: some.map(r => ({ ...r, counted: r.counted + 5000 })) })
     const one = await db.count.findUnique({ where: { id: some[0].id } })
     return { total: await db.count.count(), same: before, moved: one.counted >= 5000 }`,
    v => v?.total === v?.same && v.moved === true)


  // ── where a row IS, in the browser engine ──
  //
  // `@point` compiles to two `REAL GENERATED ALWAYS AS (json_extract(...))
  // VIRTUAL` columns, a composite index, a `CHECK`, and a haversine built from
  // `asin` · `sqrt` · `power` · `sin` · `cos` · `radians`. Every one of those
  // six is `SQLITE_ENABLE_MATH_FUNCTIONS`, a COMPILE-TIME option — which is the
  // shape that just bit `@vector`, where this build's `OMIT_LOAD_EXTENSION`
  // means `sqlite-vec` can never be here. The option IS set in
  // `@sqlite.org/sqlite-wasm` 3.53.4, so the whole feature is expected to work;
  // expected is not measured, and litestone runs in both engines by ruling.
  const LONDON = '{ lat: 51.5074, lng: -0.1278 }'
  await t(b, 'a point column is written and read back whole',
    `await db.depot.createMany({ data: [
       { name: 'Camden',    site: { lat: 51.5390, lng: -0.1426 } },
       { name: 'Greenwich', site: { lat: 51.4826, lng: -0.0077 } },
       { name: 'Croydon',   site: { lat: 51.3762, lng: -0.0982 } },
       { name: 'Edinburgh', site: { lat: 55.9533, lng: -3.1883 } },
       { name: 'Nowhere',   site: null },
     ] })
     const one = await db.depot.findFirst({ where: { name: 'Camden' } })
     return one.site`,
    v => v?.lat === 51.5390 && v.lng === -0.1426)

  // The filter is a bounding box over the generated columns AND an exact
  // haversine. If the math functions were absent this is where it says so.
  await t(b, 'a near filter runs in the wasm engine',
    `const r = await db.depot.findMany({
       where: { site: { near: { ...${LONDON}, within: '10km' } } }, orderBy: { name: 'asc' } })
     return r.map(d => d.name)`,
    v => Array.isArray(v) && v.join() === 'Camden,Greenwich')

  // NULL is not zero distance. The generated column is NULL for a row with no
  // point, and a NULL never satisfies a comparison, so the row is in no circle.
  await t(b, 'a row with no point is in no circle',
    `const r = await db.depot.findMany({ where: { site: { near: { ...${LONDON}, within: '2000km' } } } })
     return r.map(d => d.name).includes('Nowhere')`,
    v => v === false)

  // SQLite sorts NULL FIRST ascending, so without the emitted `NULLS LAST` the
  // nearest place to London is the branch that has never been located.
  await t(b, 'distance orders nearest-first and sorts an unlocated row LAST',
    `const r = await db.depot.findMany({ orderBy: { site: { near: ${LONDON} } } })
     return r.map(d => d.name)`,
    v => Array.isArray(v) && v.join() === 'Camden,Greenwich,Croydon,Edinburgh,Nowhere')

  // The cursor carries the POINT and the center rather than a distance, so the
  // second page compares with the same expression the first ordered by. A JS
  // number and a SQL one differ in the last bits, and one ulp serves the
  // boundary row twice — which here would also mean two different libm builds.
  await t(b, 'a distance-ordered page continues without repeating a row',
    `const near = { site: { near: ${LONDON} } }
     const p1 = await db.depot.findManyCursor({ limit: 2, orderBy: near })
     const p2 = await db.depot.findManyCursor({ limit: 2, orderBy: near, cursor: p1.nextCursor })
     return [...p1.items, ...p2.items].map(d => d.name)`,
    v => Array.isArray(v) && v.join() === 'Camden,Greenwich,Croydon,Edinburgh')

  // The `CHECK` is the database's because four writers never reach the Data
  // boundary. This client IS `asSystem()`, which is the closest a page gets to
  // being one of them.
  await t(b, 'the CHECK refuses half a coordinate, on the device',
    `try { await db.depot.create({ data: { name: 'Half', site: { lat: 51.5 } } }); return 'allowed' }
     catch (err) { return err.message.slice(0, 120) }`,
    v => typeof v === 'string' && v !== 'allowed')

  // ── the schema a real app will actually send ──
  //
  // Not `.lite` text. A projection of the PARSED tree is how a device gets the
  // models it needs without the prose `FJS-D204` strips (measured at 23 kB) or
  // the row policies `FJS-D303` made opt-in — and shipping the source would
  // hand over both, on a build that says nothing. This proves the parsed form
  // crosses and drives the same client, which is what makes the projection
  // buildable at all.
  await b.navigate(`http://localhost:${PORT}/parsed.html`)
  await t(b, 'a client opens from a PARSED schema, not .lite text',
    `return await window.boot`,
    v => v?.engine?.startsWith('sqlite-wasm') && v.models.join() === 'shelf,count,depot')

  await t(b, 'and it is the same client — relations and all',
    `const s = await db.shelf.create({ data: { label: 'A1' } })
     await db.count.createMany({ data: [{ shelfId: s.id, counted: 1 }, { shelfId: s.id, counted: 2 }] })
     const w = await db.shelf.findMany({ include: { counts: true } })
     return { shelves: w.length, counts: w[0].counts.length }`,
    v => v?.shelves === 1 && v.counts === 2)

  // ── the app's own schema, in a browser ──
  //
  // `example`'s 53 models filtered to the three that declare `@@sync`, opened
  // over OPFS. Everything above this runs against a fixture written to exercise
  // the worker; this is the first thing that runs against a schema somebody
  // wrote to run a shop — a `File?` column, a gate ladder, an enum, a relation
  // to a model the device does NOT get, and 23 kB of prose that must not be here.
  await b.navigate(`http://localhost:${PORT}/device.html`)
  await t(b, "example's own schema, filtered, opens over OPFS",
    `return await window.boot`,
    v => v?.models?.sort().join() === 'inventoryMovement,stocktakeCount,stocktakeSheet')

  await t(b, 'a stocktake is counted in the stockroom and reads back',
    `const sheet = await db.stocktakeSheet.create({ data: { note: 'aisle 3' } })
     await db.stocktakeCount.createMany({ data: [
       { sheetId: sheet.id, variantId: 42, counted: 9,  expected: 11 },
       { sheetId: sheet.id, variantId: 43, counted: 4,  expected: 4  },
     ] })
     await db.inventoryMovement.create({ data: {
       variantId: 42, kind: 'adjusted', quantity: -2, stockBefore: 11, stockAfter: 9 } })
     const back = await db.stocktakeSheet.findUnique({
       where: { id: sheet.id }, include: { counts: true } })
     return { counts: back.counts.length, gap: back.counts[0].expected - back.counts[0].counted,
              ledger: await db.inventoryMovement.count() }`,
    v => v?.counts === 2 && v.gap === 2 && v.ledger === 1)

  // The relation that did NOT cross. `variantId` is a column and `variant` is
  // not, and the device has to say so rather than answering an empty join —
  // which is what an `include` of a missing relation would look like on screen.
  await t(b, 'and the relation the filter dropped is refused by name',
    `try { await db.stocktakeCount.findMany({ include: { variant: true } }); return 'no refusal' }
     catch (err) { return err.message }`,
    v => typeof v === 'string' && v !== 'no refusal' && /variant/.test(v))

  await b.close()
  server.close()
  report()
}

function report() {
  const bad = rows.filter(r => !r.ok)
  for (const r of rows) console.log(`  ${r.ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${r.name}${r.ok ? '' : `\n      got ${r.detail}`}`)
  console.log(bad.length ? `\n\x1b[31m${bad.length} of ${rows.length} failed\x1b[0m` : `\n\x1b[32mall ${rows.length} passed\x1b[0m`)
  process.exit(bad.length ? 1 : 0)
}

main().catch((err) => { console.error(err); process.exit(1) })
