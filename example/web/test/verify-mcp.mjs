/*
 * verify-mcp.mjs — the agent surface, spoken to by a REAL MCP client.
 *
 * `@frontierjs/mcp` has unit tests over a fixture app. This is the half they
 * cannot reach, and it is three separate claims:
 *
 *   • a real MCP CLIENT connects. Everything that came before was this repo
 *     talking to itself with `fetch` and a hand-written JSON-RPC envelope,
 *     which agrees with a server that gets the protocol wrong in the same way.
 *     `@modelcontextprotocol/client` does the handshake, the capability
 *     negotiation and the framing, and it is the thing a person's editor runs.
 *   • against a shop with `tenancy { strategy database }`, so there is no
 *     `app.db` at all and the schema comes off the tenant registry — the shape
 *     that made the first draft of the plugin serve a permanent 503.
 *   • with the app's OWN gate ladder, four standings deep. The counts in
 *     `packages/mcp/CHANGES.md` were hand measurements until this file, which
 *     is what made them the kind of number that goes quietly stale.
 *
 *   bun run verify:mcp
 *
 * Starts and stops its own API. No browser. Seeds first, because the ladder
 * assertions below are about the seed's accounts.
 *
 * It runs under **bun** where most drives here run under node, for `verify:site`'s
 * reason: the last section imports the app's own Litestone, which reaches
 * `bun:sqlite` and node's loader refuses the scheme.
 *
 * The trap this shape has: every route is under `/api`, so `/mcp` is a 404 and
 * reads exactly like a plugin that did not mount.
 */
import { spawn, execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/client'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '../..')
const API  = process.env.API_URL ?? 'http://localhost:8110'
const BASE = `${API}/api`
const MCP  = new URL(`${BASE}/mcp`)

const PASSWORD = 'correct-horse-battery'
const STAFF = 'sam@shop.test', ADMIN = 'alex@shop.test', SHOPPER = 'robin@buyer.test'

// ─── Server ────────────────────────────────────────────────────────────────

const procs = []
function start(cmd, args, name) {
  const p = spawn(cmd, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  p.stdout.on('data', () => {})
  p.stderr.on('data', d => { if (process.env.DEBUG) process.stderr.write(`[${name}] ${d}`) })
  procs.push(p)
  return p
}
const stopAll = () => {
  for (const p of procs) {
    try { process.kill(-p.pid, 'SIGTERM') } catch { try { p.kill('SIGTERM') } catch {} }
  }
}
process.on('exit', stopAll)
process.on('SIGINT', () => { stopAll(); process.exit(130) })

async function waitFor(url, label, tries = 120) {
  for (let i = 0; i < tries; i++) {
    try { if ((await fetch(url)).ok) return true } catch {}
    await new Promise(r => setTimeout(r, 250))
  }
  console.error(`${label} never answered on ${url}`)
  return false
}

{
  let busy = false
  try { await fetch(`${BASE}/products`, { signal: AbortSignal.timeout(500) }); busy = true } catch {}
  if (busy) {
    console.error(`port 8110 already answers — the API is still running from an earlier run.\n` +
                  `stop it first (\`bun run stop\`); this drive starts its own.`)
    process.exit(1)
  }
}

execFileSync('bun', ['run', 'db/seed.ts'], { cwd: ROOT, stdio: 'ignore' })
start('bun', ['run', 'api/index.ts'], 'api')
if (!await waitFor(`${BASE}/products`, 'api')) { stopAll(); process.exit(1) }

// ─── Assertions ────────────────────────────────────────────────────────────

let pass = 0, fail = 0
function check(name, actual, expected) {
  const ok = typeof expected === 'function' ? expected(actual) : JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) { pass++; console.log(`  ✓ ${name}`) }
  else    { fail++; console.log(`  ✗ ${name}\n      got      ${JSON.stringify(actual)}\n      expected ${typeof expected === 'function' ? '(predicate)' : JSON.stringify(expected)}`) }
}

const login = async (email) => {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  })
  return (await res.json()).token
}

// One real client per standing. `connect()` is the handshake — a server that
// negotiated the protocol wrongly fails HERE rather than on a tool call, which
// is the whole reason this drive does not speak JSON-RPC by hand.
const open = async (token) => {
  const client = new Client({ name: 'verify-mcp', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(MCP, {
    requestInit: token ? { headers: { authorization: `Bearer ${token}` } } : {},
  })
  await client.connect(transport)
  return client
}
const names = async (client) => (await client.listTools()).tools.map(t => t.name).sort()

const staffToken   = await login(STAFF)
const adminToken   = await login(ADMIN)
const shopperToken = await login(SHOPPER)

// ─── A client connects at all ──────────────────────────────────────────────

console.log('\na real MCP client, against a real shop')
let stranger, shopper, staff, admin
{
  stranger = await open(null)
  check('the handshake completes with no credential', true, true)

  const info = stranger.getServerVersion?.() ?? {}
  check('and the server names itself', [info.name, info.version], ['shop', '1.0.0'])

  shopper = await open(shopperToken)
  staff   = await open(staffToken)
  admin   = await open(adminToken)
  check('and once per standing', true, true)
}

// ─── The ladder ────────────────────────────────────────────────────────────

console.log('\nthe tool list is the caller\'s')
let strangerTools = [], staffTools = []
{
  strangerTools      = await names(stranger)
  const shopperTools = await names(shopper)
  staffTools         = await names(staff)

  const adminTools = await names(admin)

  // Both halves stated. A surface answering nobody satisfies every refusal
  // below on its own; one answering everybody satisfies every affordance.
  check('a stranger is offered tools, and not none', strangerTools.length, n => n > 0)
  check('a shopper is offered strictly more', shopperTools.length, n => n > strangerTools.length)
  check('an administrator more again', adminTools.length, n => n > shopperTools.length)

  // **The list is the LADDER's and the rows are the POLICY's**, which are two
  // mechanisms this drive asserted as one on its first run. `sam` carries
  // `isStaff` and reads every order in the shop; `robin` reads their own. That
  // is a row policy, and it moves nobody up a rung — so the two are offered the
  // IDENTICAL tool list, and the difference between them shows up only in what
  // a call answers. The section below is the other half of this row.
  check('staff stand on the shopper\'s rung, so their tool lists are identical',
        staffTools, shopperTools)

  // Monotonic: climbing a rung never LOSES a tool. A rule written the wrong way
  // round shows up here and in no single count.
  check('and nothing a stranger may reach is withheld from a shopper',
        strangerTools.every(n => shopperTools.includes(n)), true)
  check('nor from staff', shopperTools.every(n => staffTools.includes(n)), true)
}

console.log('\nthe gate decides, one tool at a time')
{
  const shopperTools = await names(shopper)
  // `Order` reads at 1, so the whole service appears one rung up from nobody.
  check('a stranger is not offered the order list', strangerTools.includes('orders_find'), false)
  check('a shopper is', shopperTools.includes('orders_find'), true)

  // `refund` is `@gate 5` over an update of 4 — a floor, not a replacement —
  // and the rung that clears it is the ADMIN, not `sam`. In this seed `sam` is
  // role 'user' carrying `isStaff`, which reads every order and does not reach
  // 5; `alex` is role 'admin' and the only account that does. Asserting it of
  // "staff" is the mistake the ladder exists to make visible, and this drive
  // made it on its first run.
  const adminTools = await names(admin)
  check('a shopper is not offered the refund move', shopperTools.includes('orders_refund'), false)
  check('nor is staff, who read every order and still do not clear 5',
        staffTools.includes('orders_refund'), false)
  check('the administrator is', adminTools.includes('orders_refund'), true)
  check('and the ordinary move beside it is a shopper\'s', shopperTools.includes('orders_pay'), true)
}

// ─── A call is a service call ──────────────────────────────────────────────

console.log('\na tool call goes through the service, as the caller')
{
  const read = await staff.callTool({ name: 'products_find', arguments: { query: {}, directives: { limit: 2 } } })
  const text = read.content?.[0]?.text ?? ''
  check('staff read the catalog through a tool', [read.isError ?? false, text.length > 0], [false, true])

  // The row policy is the Data boundary's and it applies here the same as over
  // HTTP: the pair is what says so. Both callers may list orders; the shopper
  // sees their own.
  const count = async (client) => {
    const res = await client.callTool({ name: 'orders_find', arguments: { query: {}, directives: { limit: 200 } } })
    const body = JSON.parse(res.content[0].text)
    return (body.data ?? body).length
  }
  const staffOrders   = await count(staff)
  const shopperOrders = await count(shopper)
  check('a shopper\'s order list is strictly smaller than staff\'s, from one declaration',
        [shopperOrders > 0, shopperOrders < staffOrders], [true, true])
}

console.log('\nfind describes its filters, and the SDK\'s validator still takes an operator')
{
  const find = (await staff.listTools()).tools.find(t => t.name === 'orders_find')
  const q    = find?.inputSchema?.properties?.query
  check('orders_find names status as a filter, with its values',
        q?.properties?.status?.anyOf?.[0]?.enum?.includes('paid'), true)

  // The SDK validates before dispatch. A filter typed as its value alone would
  // refuse this call here, while the Data boundary takes it; the pair is the
  // plain value beside it.
  const call = async (query) => {
    const res = await staff.callTool({ name: 'orders_find', arguments: { query, directives: { limit: 200 } } })
    return { error: res.isError ?? false, rows: res.isError ? 0 : (JSON.parse(res.content[0].text).data ?? []).length }
  }
  const plain = await call({ status: 'paid' })
  const op    = await call({ status: { in: ['paid', 'shipped'] } })
  check('a plain filter is taken', [plain.error, plain.rows > 0], [false, true])
  check('an operator filter is taken, and answers at least as many', [op.error, op.rows >= plain.rows], [false, true])

  const typed = await staff.callTool({ name: 'orders_find', arguments: { query: {}, directives: { limit: 'twenty' } } })
    .catch(err => ({ isError: true, content: [{ text: String(err?.message ?? err) }] }))
  check('a directive of the wrong type is refused, naming the field',
        [typed.isError ?? false, /limit/.test(typed.content?.[0]?.text ?? '')], [true, true])
}

console.log('\nthe affordance is not the boundary')
{
  // A withheld tool is not registered for that caller, so the refusal is the
  // protocol's. Fail-closed, and NOT Invariant 6 — which is the row after it.
  let refused = null
  try { await shopper.callTool({ name: 'orders_refund', arguments: { id: 1 } }) }
  catch (err) { refused = String(err?.message ?? err) }
  check('a tool this caller was not offered is refused by name', refused, s => /not found/i.test(s ?? ''))

  // Invariant 6 proper: a tool the caller IS offered, whose call the Data
  // boundary still refuses. `pay` moves `pending → paid`, so an order already
  // paid is a legal caller making a legal call on an illegal transition.
  const orders = JSON.parse((await staff.callTool({
    name: 'orders_find', arguments: { query: { status: 'paid' }, directives: { limit: 1 } },
  })).content[0].text)
  const paid = (orders.data ?? orders)[0]
  check('the seed has an order already paid', !!paid, true)
  if (paid) {
    const again = await staff.callTool({ name: 'orders_pay', arguments: { id: paid.id } })
    check('paying it again is refused by the boundary, not by the tool list',
          [again.isError ?? false, /not found/i.test(again.content?.[0]?.text ?? '')], [true, false])
  }
}

// ─── What is never in a tool description ───────────────────────────────────

console.log('\nno credential column reaches a tool schema')
{
  // Derived, not typed: the protected set is exactly what the two audiences
  // disagree about, so a column the seed grows arrives here without this file
  // being opened.
  const { generateJsonSchema } = await import('@frontierjs/litestone')
  const { parse } = await import('@frontierjs/litestone/parser')
  const { readFileSync } = await import('node:fs')
  const schema = parse(readFileSync(join(ROOT, 'db/schema.lite'), 'utf8')).schema
  const defsAt = (audience) =>
    (generateJsonSchema(schema, { mode: 'full', audience }).$defs ?? {})
  const client = defsAt('client'), system = defsAt('system')

  const guarded = []
  for (const [model, def] of Object.entries(system)) {
    const open = client[model]?.properties ?? {}
    for (const key of Object.keys(def.properties ?? {})) if (!(key in open)) guarded.push(key)
  }
  // The control. A derivation that found nothing passes the loop below
  // vacuously, which looks identical to a surface that leaked everything.
  check('the shop declares protected columns at all', guarded.length, n => n > 0)

  // A name protected on one model can be an ordinary column on another —
  // `providerRef` is @guarded on PaymentMethod and a labelled column on
  // Payment — and a tool on the wire does not say which model it is over, so
  // those names are graded by the pair below rather than by the search.
  const openSomewhere = new Set(Object.values(client).flatMap(d => Object.keys(d.properties ?? {})))
  const tools      = (await admin.listTools()).tools
  const everything = JSON.stringify(tools)
  const leaked = [...new Set(guarded)].filter(key => !openSomewhere.has(key) && everything.includes(`"${key}"`))
  check('and none of them appears in any tool an administrator is offered', leaked, [])

  const filters = (name) => Object.keys(tools.find(t => t.name === name)?.inputSchema?.properties?.query?.properties ?? {})
  check('a name guarded on one model is not a filter there, and is one where it is open',
        [filters('paymentMethods_find').length > 0, filters('paymentMethods_find').includes('providerRef'),
         filters('payments_find').includes('providerRef')],
        [true, false, true])
}

// ─── Result ────────────────────────────────────────────────────────────────

console.log(`\n${fail === 0 ? '✓' : '✗'} ${pass}/${pass + fail} checks passed\n`)
for (const c of [stranger, shopper, staff, admin]) { try { await c?.close() } catch {} }
stopAll()
process.exit(fail === 0 ? 0 : 1)
