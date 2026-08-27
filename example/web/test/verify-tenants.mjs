/**
 * web/test/verify-tenants.mjs — MANY SHOPS, one file each.
 *
 * `db/schema.lite` declares `tenancy { strategy database }`, so a shop is a
 * SQLite file and the isolation is the filesystem: there is no query that
 * reaches two shops, because there is no connection that holds two.
 *
 * No browser. A browser cannot set a `Host` header, and the host is the whole
 * mechanism under `resolve subdomain` — so this drive speaks to the API the way
 * a reverse proxy in front of two domains would.
 *
 * ─── The three things this proves and nothing else here can ───────────────
 *
 *   the DATA     a product created at one shop is not at the other, and the
 *                second shop starts with a catalogue of its own — empty
 *   the PEOPLE   `User`, `Credential` and `Session` are in the tenant's file, so
 *                an account at one shop is not an account at another. This is
 *                the assertion the whole arrangement stands on: it is what a
 *                shared identity table would quietly get wrong
 *   the SESSION  a token issued by one shop is not a session at the other, even
 *                though both were signed by the same process a second apart
 *
 * ─── Why it runs under bun ────────────────────────────────────────────────
 *
 * It creates the second shop, which is an operator's act and not a request:
 * there is no HTTP endpoint that mints a tenant and there should not be. So it
 * imports the app's own registry — TypeScript, which node's strip-only loader
 * refuses — exactly as `verify:site` imports the app's Litestone client.
 *
 * The API must be up (`bun run api`).
 */

import { createLitestoneAuth } from '@frontierjs/auth'
import { shops, DEFAULT_SHOP } from '../../api/src/core/db.ts'

const API   = process.env.API_URL ?? 'http://localhost:8110'
/**
 * A shop this run made, named for this run.
 *
 * Not a fixed 'highstreet' reused every time, and the reason is worth stating:
 * the API holds an LRU pool of open tenant connections, so a shop this process
 * deletes is still open in THAT one — SQLite keeps serving an unlinked file to
 * whoever had it open. A drive that recreated a fixed id read the previous
 * run's rows through the API and its own fresh file through the registry, and
 * the two disagreed. A shop the API has never opened cannot be stale.
 */
const RUN_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
const SHOP  = `highstreet${RUN_ID}`
const HOST  = `${SHOP}.shop.test`
/** A shop nobody has created. The registry's answer for it is a 404, not the
 *  default — a host that names a shop is a caller who meant that shop. */
const GHOST = 'nosuchshop.shop.test'

try {
  const r = await fetch(`${API}/api/health`)
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
} catch (e) {
  console.error(`Cannot reach the api (bun run api) at ${API} — ${e.message}`)
  process.exit(1)
}

let pass = 0, fail = 0
function check(name, actual, expected) {
  const ok = typeof expected === 'function' ? expected(actual) : JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) { pass++; console.log(`  ✓ ${name}`) }
  else    { fail++; console.log(`  ✗ ${name}\n      got      ${JSON.stringify(actual)}\n      expected ${typeof expected === 'function' ? '(predicate)' : JSON.stringify(expected)}`) }
}

/** A request AS a shop. The Host is the whole of it — `resolve subdomain` in
 *  the seed, `registry.tenantFor` at the boundary, no app code in between. */
const at = (host, path, opts = {}) => fetch(`${API}/api${path}`, {
  ...opts,
  headers: { ...(host ? { host } : {}), ...(opts.headers ?? {}) },
})

// ─── The second shop ──────────────────────────────────────────────────────
//
// Created here rather than seeded, so this drive is repeatable against a
// database it has already written to: everything below is keyed on a stamp.
const RUN = RUN_ID

console.log('\n  the fleet')

check('the shop does not exist before it is created', shops.list().includes(SHOP), false)
await shops.getOrCreate(SHOP)
check('the shop exists once it has been created', shops.list().includes(SHOP), true)

// Written HERE rather than beside the assertions, and that is not tidiness. The
// API is a separate process holding its own memo, keyed per shop and resolved on
// that shop's first call — so settings written after the checks below have
// already addressed this shop would be correct in the registry and stale in the
// process serving it. `invalidateTenantConfig` is the answer inside one process;
// across two, the answer is to write before the first request.
shops.metaSet(SHOP, { config: { name: 'High Street', mail: { from: `orders@${SHOP}.test` } } })
check('…and so does the one every other drive uses', shops.list().includes(DEFAULT_SHOP), true)

// The staff of THIS shop, created through auth against this shop's own client.
// A shop's people are rows in the shop's file, which is the whole point.
const shopDb   = await shops.get(SHOP)
const shopAuth = createLitestoneAuth(shopDb, { encryptionKey: process.env.ENCRYPTION_KEY ?? 'deadbeef'.repeat(8) })
const LOCAL    = { email: `manager-${RUN}@highstreet.test`, password: 'correct-horse-battery' }
await shopAuth.createUser({ ...LOCAL, name: 'High Street Manager', role: 'admin' })

// ─── The data ─────────────────────────────────────────────────────────────

console.log('\n  the data')

const flagshipList = await (await at(null, '/products?$limit=200')).json()
check('the flagship has its catalogue', flagshipList.total > 10, true)

const theirs = await (await at(HOST, '/products?$limit=200')).json()
check('the new shop starts with a catalogue of its own — empty', theirs.total, 0)

// A product written straight into the second shop's file. Through the registry
// rather than over HTTP, because creating one needs a signed-in seller and what
// is being asserted is the ISOLATION, not the write path.
const mine = await shopDb.asSystem().product.create({ data: {
  slug: `high-street-special-${RUN}`, name: `High Street Special ${RUN}`,
  brand: 'litestone', description: 'Sold at one shop only.',
} })

check('it is in the shop that made it',
      (await (await at(HOST, '/products?$limit=200')).json()).data.some(p => p.id === mine.id), true)
check('…and in no other, by name',
      (await (await at(null, '/products?$limit=200')).json()).data.some(p => p.name === mine.name), false)
check('…nor is the flagship’s catalogue in it — one product, the one it made',
      (await (await at(HOST, '/products?$limit=200')).json()).total, 1)

// The isolation is the filesystem, so it is checkable as one.
check('a shop is a file, and two shops are two files',
      (await shops.get(SHOP)) !== (await shops.get(DEFAULT_SHOP)), true)

// A host naming a shop that does not exist is a 404 rather than the default.
// The fallback in api/src/core/db.ts is for a request that names NO shop.
check('a host naming a shop nobody created is refused', (await at(GHOST, '/products')).status, 404)

// ─── The people ───────────────────────────────────────────────────────────

console.log('\n  the people')

const login = (host, body) => at(host, '/auth/login', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})

const FLAGSHIP_STAFF = { email: 'alex@shop.test', password: 'correct-horse-battery' }

const atHome = await login(null, FLAGSHIP_STAFF)
check('the flagship’s admin signs in at the flagship', atHome.status, 200)
const homeToken = (await atHome.json()).token

// The headline. `User`, `Credential` and `Session` live in the tenant's file, so
// this is not a permission being denied — it is an account that does not exist
// here. A fleet with one shared identity table gets this wrong silently.
const away = await login(HOST, FLAGSHIP_STAFF)
check('…and is nobody at the other shop', away.status, 401)
check('…refused as a credential, not as a permission',
      /invalid credentials/i.test((await away.json()).message ?? ''), true)

const local     = await login(HOST, LOCAL)
const localBody = await local.json()
check('the other shop’s own manager signs in there', local.status, 200)
// Graded by THAT shop's own row: `sessionFields` reads `role` off the User the
// login found, and the User it found is in this shop's file.
check('…as themselves, at their own standing',
      { email: localBody.user?.email, isAdmin: localBody.user?.isAdmin },
      { email: LOCAL.email, isAdmin: true })
const localToken = localBody.token

// ─── The session ──────────────────────────────────────────────────────────

console.log('\n  the session')

// Both tokens were minted by the same process seconds apart. A session is a ROW
// and the row is in one shop's file, so verifying it against the other finds
// nothing — which is what the transport is handed the request's origin for: it
// resolves the session before any hook has run, and therefore before a tenant
// would otherwise be known.
// Read through a GATE, not through a public list. `Customer` reads at STRANGER(0)
// here, so an anonymous caller sees the same rows a signed-in one does and the
// assertion would pass with the session doing nothing. `InventoryMovement` is
// @@gate("5.5.9.9") — a refusal, and a refusal is unambiguous.
check('a token from one shop is not a session at the other',
      (await at(HOST, '/inventory', { headers: { authorization: `Bearer ${homeToken}` } })).status, 401)
check('…while the same token is a session at home',
      (await at(null, '/inventory', { headers: { authorization: `Bearer ${homeToken}` } })).status, 200)

// A write is the sharper half: a read below a gate is an empty list, a write is
// a refusal. `Customer` is @@gate("0.4.4.5") — create needs USER(4), and an
// unrecognised token is STRANGER(0).
const wrote = await at(HOST, '/customers', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${homeToken}` },
  body: JSON.stringify({ name: 'Crossed', firstName: 'Cross', lastName: 'Ed', email: `crossed-${RUN}@x.test` }),
})
check('and a write with it is refused at the other shop', wrote.status, 401)

const wroteHome = await at(HOST, '/customers', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${localToken}` },
  body: JSON.stringify({ name: 'Local', firstName: 'Loc', lastName: 'Al', email: `local-${RUN}@x.test` }),
})
check('…while that shop’s own manager may write there', wroteHome.status, 201)
// Asked of the FLAGSHIP, with the flagship's own session — `Customer` reads at
// level 1 with a row policy now, so an anonymous ask is a 401 rather than an
// empty list, and `total` would be `undefined` for a reason that has nothing to
// do with tenancy.
check('…and the customer landed in that shop only',
      (await (await at(null, `/customers?email=local-${RUN}@x.test`, {
        headers: { authorization: `Bearer ${homeToken}` },
      })).json()).total, 0)

// ─── the fourth thing: a shop differs in more than its rows ───────────────
//
// The three checks above separate the DATA, the PEOPLE and the SESSION, and all
// three are rows. A shop is also a BUSINESS — it has a name, and a customer
// reads that name on a receipt sent from an address (`FJS-D126`). None of that
// is a row, and until per-tenant configuration existed one deployment had one
// name and one from-address for every shop it served.
//
// The source here is the registry's own per-tenant meta blob, which has carried
// arbitrary JSON since tenants existed and which nothing read.

console.log('\n  the shopfront')

const settings = async (host) => (await at(host, '/shopfront', {
  method:  'POST',
  headers: { 'content-type': 'application/json', 'x-service-method': 'settings' },
  body:    '{}',
})).json()

const cfgHome = await settings(null)
const cfgAway = await settings(HOST)

check('the flagship reads its own name',        cfgHome.name, 'Flagship Store')
check('…and its own from-address',              cfgHome.from, 'orders@flagship.test')
check('the other shop reads a different name',  cfgAway.name, 'High Street')
check('…and a different from-address',          cfgAway.from, `orders@${SHOP}.test`)

// The half that makes it safe. Only the declared paths apply, so a shop cannot
// reach a value the deployment owns — and `database` could not be listed even
// by mistake, because junction refuses the reserved paths at boot.
check('a shop cannot move the port it is served on', cfgAway.port, cfgHome.port)

// The file this drive made, removed. A tenant that outlives its drive is a
// database nobody owns, and `delete` is the half of the fleet API that nothing
// else here exercises.
await shops.delete(SHOP)
check('and the shop is deleted with the drive that made it', shops.list().includes(SHOP), false)

console.log(`\n  ${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
