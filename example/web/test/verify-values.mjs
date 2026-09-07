/**
 * web/test/verify-values.mjs — a declared value set, in a real browser.
 *
 * `valueset ProductColor { source Color  value name  scope current  order
 * sortOrder, name }` and `ProductVariant.color @values(ProductColor, open)`.
 * Everything else about the feature is covered by unit tests on both sides of
 * the wire; what nothing else can reach is the claim the whole design rests on:
 *
 *   the list the picker OFFERS is the list the Data boundary ACCEPTS
 *
 * …and, one axis along, that the order it offers them in is the order the SET
 * declared rather than the alphabet — which the assertion above cannot see,
 * because it sorts both sides before comparing them.
 *
 * Those are two different code paths — sierra sends the declared `@@scope` as a
 * filter and litestone applies it as a policy predicate — and they only agree
 * because a `$scope` key survives junction's `autoFilter` on the way through.
 * A unit test on either side passes with the crossing broken.
 *
 * The offered list is read signed OUT — `Color` is `@@gate("0.4.4.5")` — which
 * is what keeps the picker assertions out of the 10-per-15-minutes login window
 * the other drives share. The two sections that need staff (a refused write, and
 * a colorway retired out from under a variant) take ONE token over HTTP between
 * them.
 *
 * Both servers must be up:
 *
 *   bun run api     # terminal 1
 *   bun run web     # terminal 2
 *   bun run verify:values
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { requireServers } from './lib/preflight.mjs'

const UI     = process.env.UI_URL  ?? 'http://localhost:8010'
const API    = process.env.API_URL ?? 'http://localhost:8110'
const CHROME = process.env.FJS_CHROME ?? 'google-chrome'

await requireServers([['api (bun run api)', `${API}/api/health`], ['web (bun run web)', UI]])

// ─── CDP ──────────────────────────────────────────────────────────────────

const profile = mkdtempSync(join(tmpdir(), 'fjs-values-'))
const chrome  = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] })

chrome.on('error', (e) => { console.error(`Could not launch ${CHROME}: ${e.message}`); process.exit(1) })

const wsUrl = await new Promise((resolve, reject) => {
  let buf = ''
  const t = setTimeout(() => reject(new Error('Chrome never announced a DevTools port')), 15000)
  chrome.stderr.on('data', (d) => {
    buf += d
    const m = buf.match(/ws:\/\/[^\s]+/)
    if (m) { clearTimeout(t); resolve(m[0]) }
  })
})

const browser = new WebSocket(wsUrl)
await new Promise((r) => browser.addEventListener('open', r, { once: true }))

let nextId = 1
const pending = new Map()
const noise   = []

function send(method, params = {}, sessionId) {
  const id = nextId++
  browser.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    setTimeout(() => pending.has(id) && reject(new Error(`${method} timed out`)), 30000)
  })
}

browser.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
    return
  }
  if (msg.method === 'Runtime.exceptionThrown')
    noise.push('exception: ' + (msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text))
  if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type))
    noise.push(msg.params.type + ': ' + msg.params.args.map(a => a.value ?? a.description ?? '').join(' '))
})

const { targetId }  = await send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
await send('Page.enable', {}, sessionId)
await send('Runtime.enable', {}, sessionId)

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', {
    expression: `(async () => { ${expression} })()`,
    awaitPromise: true, returnByValue: true,
  }, sessionId)
  if (r.exceptionDetails)
    throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
  return r.result.value
}

await send('Page.navigate', { url: `${UI}/products/` }, sessionId)
await evaluate(`
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    if (document.querySelector('#app .shell')) return true;
    await new Promise(r => setTimeout(r, 40));
  }
  throw new Error('the app never mounted — #app .shell absent after 15s');
`)

// The resource module, imported the way a page imports it. `<script module>`
// runs once at import, so this is the same `productVariants` every screen holds.
await evaluate(`
  const m = await import('/src/resources/ProductVariant.mesa');
  window.variants = m.productVariants ?? Object.values(m).find(v => v?.formFields);
  if (!window.variants) throw new Error('ProductVariant.mesa exported no resource');
`)

// ─── assertions ───────────────────────────────────────────────────────────

const results = []
const t = (name, got, want) => results.push({ name, got, want })

// What the schema says the column is. `open` is the strength that decides the
// control: a picker cannot express "or type a new one".
const rule = await evaluate(`
  const f = window.variants.formFields().find(f => f.name === 'color');
  return { control: f?.control, set: f?.set, strength: f?.strength,
           allowNew: f?.allowNew, value: f?.valueField, scopes: f?.rule?.values?.scopes };
`)
t('control.kind',     rule.control,  'combobox')
t('control.set',      rule.set,      'ProductColor')
t('control.strength', rule.strength, 'open')
t('control.allowNew', rule.allowNew, true)
t('control.scopes',   rule.scopes,   ['current'])
// `value name` rather than the id — what is stored is the colorway itself.
t('control.storesName', rule.value, 'name')

// The picker's own request, made by the browser through the real client.
const offered = await evaluate(`
  const r = await window.variants.options('color');
  return { labels: r.options.map(o => o.label), values: r.options.map(o => o.value),
           recent: r.options.map(o => !!o.recent) };
`)

// Read straight off the API, unscoped, so the two lists are compared rather
// than a hardcoded one asserted — an `open` binding grows the table, so any
// fixed expectation here goes stale on its own the first time a drive runs.
const all     = (await (await fetch(`${API}/api/colors?$limit=100`)).json()).data
const current = all.filter(c => !c.retired).map(c => c.name).sort()
const retired = all.filter(c => c.retired).map(c => c.name)

t('scope.somethingToNarrow', retired.length > 0, true)
t('offers.everyCurrentOne',  [...offered.labels].sort(), current)
t('offers.noRetiredOne',     offered.labels.filter(n => retired.includes(n)), [])
t('offers.storesTheName',    offered.values, offered.labels)

// ─── the ORDER it offers them in ──────────────────────────────────────────
//
// The third axis (`FJS-D121`), and the only one of the three whose failure is
// invisible: a list in the wrong order is a working picker. The set declares
// `order recent(ProductVariant.color, createdAt), sortOrder, name` — a head,
// then the merchandised row — and the negative control is the alphabetical list
// beside it, which is what every picker in every app offered before a set could
// state an order, and what the two assertions above still pass against.
const live      = all.filter(c => !c.retired)
const byName    = new Map(live.map(c => [c.name, c]))
const declared  = [...live]
  .sort((a, b) => (a.sortOrder - b.sortOrder) || a.name.localeCompare(b.name))
  .map(c => c.name)
const alphabetical = [...declared].sort((a, b) => a.localeCompare(b))

// What the head should be, computed from the variants themselves rather than
// typed here — the rank is derived, so an expectation that is not is a second
// implementation of it that goes stale the first time the seed changes.
const headFromDb = async () => {
  const rows = (await (await fetch(`${API}/api/product-variants?$limit=500`)).json()).data
  const last = new Map()
  for (const v of rows) {
    const at = String(v.createdAt ?? '')
    if (!last.has(v.color) || at > last.get(v.color)) last.set(v.color, at)
  }
  return [...last.entries()]
    .sort((a, b) => (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0))
    .map(([color]) => color)
    .filter(c => byName.has(c))
    .slice(0, 5)
}

const expected = (head) => head.concat(declared.filter(n => !head.includes(n)))

const head0 = await headFromDb()

t('order.theyDiffer',   JSON.stringify(declared) !== JSON.stringify(alphabetical), true)
t('order.somethingRanked', head0.length > 0, true)
t('order.asDeclared',   offered.labels, expected(head0))
// The WHOLE list, not its first entry: the head owns position 0 now, and a
// colorway that is alphabetically first can sit there by coincidence — which it
// does in this seed. A picker ignoring the declaration produces `alphabetical`
// exactly, so that is what the offered list has to differ from.
t('order.notAlphabet',  JSON.stringify(offered.labels) !== JSON.stringify(alphabetical), true)
t('order.headIsMarked', offered.recent.slice(0, head0.length), head0.map(() => true))
t('order.tailIsNot',    offered.recent.slice(head0.length).some(Boolean), false)

// …and the boundary refuses exactly what the picker withheld. Signed in,
// because `ProductVariant` is `@@gate("0.4.4.5")` and an anonymous patch is
// refused by the gate — which would look identical from here and prove nothing.

// Through the app's own session module, which is what a screen uses — a token
// pushed onto the client by hand would be a different code path from the one a
// signed-in person is on.
await evaluate(`
  const { signIn } = await import('/src/session.js');
  await signIn('alex@shop.test', 'correct-horse-battery');
`)

const refused = await evaluate(`
  const one = (await window.variants.service.find({}, { limit: 1 })).data[0];
  try {
    await window.variants.save({ id: one.id, color: ${JSON.stringify(retired[0] ?? 'Ochre')} }, { mode: 'patch' });
    return { threw: false };
  } catch (err) {
    const fe = window.variants.fieldErrors(err);
    return { threw: true, fields: Object.keys(fe.fields ?? {}), message: fe.fields?.color ?? fe.message ?? String(err)};
  }
`)
t('refusal.threw',   refused.threw, true)
t('refusal.field',   refused.fields, ['color'])
t('refusal.saysSet', /not offered by ProductColor/.test(refused.message ?? ''), true)

// ─── a DEPENDENT set ──────────────────────────────────────────────────────
//
// `ProductImage.variantId @values(ProductVariants, dependsOn: productId)` — the
// list is THIS product's variants, and a photograph pinned to another product's
// variant is a row the relation alone accepts, because both columns are valid
// foreign keys and nothing compared them (`FJS-D122`).
//
// The same crossing as above and it is asked the same way: the picker sends the
// controlling value as an ordinary column filter, the Data boundary grades the
// PAIR. A unit test on either side passes with the crossing broken.

await evaluate(`
  const m = await import('/src/resources/ProductImage.mesa');
  window.images = m.productImages ?? Object.values(m).find(v => v?.formFields);
  if (!window.images) throw new Error('ProductImage.mesa exported no resource');
`)

const dep = await evaluate(`
  const f = window.images.formFields().find(f => f.name === 'variantId');
  return f?.rule?.values?.dependsOn ?? null;
`)
t('dependent.declared', dep, { field: 'productId', match: 'productId' })

// Nothing chosen yet: there is no list to offer, and offering the unnarrowed
// one would put values on screen the boundary refuses. It asks nobody at all.
const awaiting = await evaluate(`
  const r = await window.images.options('variantId', { record: {} });
  return { count: r.options.length, awaiting: r.awaiting };
`)
t('dependent.emptyUntilChosen', awaiting, { count: 0, awaiting: 'productId' })

// The offered list is compared against the API's own answer rather than a fixed
// one — the seed grows, and a hardcoded list goes stale on its own.
const anImage = (await (await fetch(`${API}/api/product-images?$limit=1`)).json()).data[0]
const mine    = (await (await fetch(`${API}/api/product-variants?productId=${anImage.productId}&$limit=100`)).json()).data
const foreign = (await (await fetch(`${API}/api/product-variants?$limit=100`)).json()).data
  .find(v => v.productId !== anImage.productId)

t('dependent.somethingToExclude', !!foreign, true)

const offeredIds = await evaluate(`
  const r = await window.images.options('variantId', { record: { productId: ${anImage.productId} } });
  return r.options.map(o => o.value);
`)
t('dependent.offersOwn',      [...offeredIds].sort((a, b) => a - b), mine.map(v => v.id).sort((a, b) => a - b))
t('dependent.withholdsOther', offeredIds.includes(foreign.id), false)

// …and the boundary refuses exactly what the picker withheld. Both halves, or a
// guard that refused every variant would look identical from the refused side.
const depRefused = await evaluate(`
  try {
    await window.images.save({ id: ${anImage.id}, variantId: ${foreign.id} }, { mode: 'patch' });
    return { threw: false };
  } catch (err) {
    const fe = window.images.fieldErrors(err);
    return { threw: true, fields: Object.keys(fe.fields ?? {}), message: fe.fields?.variantId ?? fe.message ?? String(err) };
  }
`)
t('dependent.refusesForeign', depRefused.threw, true)
t('dependent.namesTheField',  depRefused.fields, ['variantId'])
t('dependent.saysWhy',        /not for productId/.test(depRefused.message ?? ''), true)

const depAccepted = await evaluate(`
  await window.images.save({ id: ${anImage.id}, variantId: ${mine[0].id} }, { mode: 'patch' });
  const back = await window.images.service.get(${anImage.id});
  return back.variantId;
`)
t('dependent.takesOwn', depAccepted, mine[0].id)

// ─── a value the list no longer offers ────────────────────────────────────
//
// The three ways a stored value falls out of its own list are one problem
// (`FJS-D225`), and this is the one a real shop hits: a colorway is retired
// while variants are still holding it. `@@scope(current, retired == false)`
// then excludes it from every picker, and a native <select> bound to a value it
// does not contain shows the FIRST option instead — the wrong value, silently.
//
// The retire happens over HTTP rather than in the page, because no screen edits
// a colour and inventing one here would test a fixture. It is put back
// afterwards, so the seed is left as it was found.

const staffToken = (await (await fetch(`${API}/api/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'alex@shop.test', password: 'correct-horse-battery' }),
})).json()).token

// A single row comes back as the row, where a list comes back in an envelope.
const setRetired = (id, retired) => fetch(`${API}/api/colors/${id}`, {
  method:  'PATCH',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${staffToken}` },
  body:    JSON.stringify({ retired }),
})
const isRetiredNow = async (id) => (await (await fetch(`${API}/api/colors/${id}`)).json()).retired

const variant = await evaluate(`
  const v = (await window.variants.service.find({}, { limit: 1 })).data[0];
  window.aVariant = v;
  return { id: v.id, color: v.color };
`)
const colorRow = all.find(c => c.name === variant.color)
t('unavailable.foundOneInUse', !!colorRow, true)

await setRetired(colorRow.id, true)
t('unavailable.retiredIt', await isRetiredNow(colorRow.id), true)

const pinned = await evaluate(`
  const r = await window.variants.options('color', { record: window.aVariant, reload: true });
  const first = r.options[0];
  return {
    stillOffered: r.options.filter(o => !o.unavailable).map(o => o.value).includes(window.aVariant.color),
    value:        first?.value,
    label:        first?.label,
    disabled:     first?.disabled === true,
    unavailable:  first?.unavailable === true,
  };
`)
t('unavailable.notOfferedAnyMore', pinned.stillOffered, false)
t('unavailable.pinnedFirst',       pinned.value,        variant.color)
t('unavailable.saysSo',            pinned.label,        `${variant.color} (unavailable)`)
t('unavailable.cannotBeChosen',    pinned.disabled,     true)
t('unavailable.isMarked',          pinned.unavailable,  true)

await setRetired(colorRow.id, false)
t('unavailable.putItBack', await isRetiredNow(colorRow.id), false)

// ─── the head MOVES, and nothing wrote it down ────────────────────────────
//
// The learned half (`FJS-964`), and the assertion that separates it from every
// other way this could have been built: the rank is DERIVED from the variants
// themselves, so moving a colorway onto the shop's newest variant changes the
// picker with nothing having been counted, incremented or invalidated. A stored
// rank passes every assertion above and fails this one.
//
// It MOVES a row rather than making one, and that is not tidiness: a variant is
// `@@softDelete` with `@@unique([productId, color, size])`, and a soft-deleted
// row keeps its unique values on purpose (`FJS-204`) — so a drive that created
// and removed one would refuse itself with a 409 the second time it ran.
//
// The colorway chosen is the one furthest from the head — the last of the
// merchandised row that is not already in it, and not already on that product
// at that size — so a head that ignored the rank could not produce it by luck.
const asStaff = (path, init = {}) => fetch(`${API}${path}`, {
  ...init,
  headers: { 'content-type': 'application/json', authorization: `Bearer ${staffToken}`, ...(init.headers ?? {}) },
})

const askAgain = () => evaluate(`
  const r = await window.variants.options('color', { reload: true });
  return { labels: r.options.map(o => o.label), recent: r.options.map(o => !!o.recent) };
`)

const variants = (await (await fetch(`${API}/api/product-variants?$limit=500`)).json()).data
const newest   = variants.reduce((a, b) => (String(a.createdAt) >= String(b.createdAt) ? a : b))
const taken    = new Set(variants
  .filter(v => v.productId === newest.productId && v.size === newest.size)
  .map(v => v.color))
const cold = [...declared].reverse().find(n => !head0.includes(n) && !taken.has(n))

t('recent.somethingCold', typeof cold === 'string', true)

// The newest row, because the rank is MAX(createdAt) per colorway: moving an
// old variant would put the colorway in the list at the old row's instant,
// which is exactly where it does not belong.
const moved = await (await asStaff(`/api/product-variants/${newest.id}`, {
  method: 'PATCH', body: JSON.stringify({ color: cold }),
})).json()

t('recent.variantMoved', moved?.color, cold)

const afterCut = await askAgain()
t('recent.headMoved',    afterCut.labels[0],  cold)
t('recent.marked',       afterCut.recent[0],  true)
// The rest of the list is untouched: a head is a prefix, not a re-sort, so a
// value that moved to the top LEAVES the page beneath rather than appearing
// twice or pushing everything down by one.
t('recent.listIsSame',   [...afterCut.labels].sort(), [...offered.labels].sort())
t('recent.appearsOnce',  afterCut.labels.filter(n => n === cold).length, 1)

// And nothing was written down: putting the variant back where it was restores
// the picker exactly, with no rank to invalidate and nothing to recompute.
await asStaff(`/api/product-variants/${newest.id}`, {
  method: 'PATCH', body: JSON.stringify({ color: newest.color }),
})
const afterPull = await askAgain()
t('recent.headWentBack', afterPull.labels, offered.labels)


t('consoleNoise', noise.filter(n => !/favicon|autocomplete/i.test(n)), [])

// ─── report ───────────────────────────────────────────────────────────────

let failed = 0
for (const r of results) {
  const ok = JSON.stringify(r.got) === JSON.stringify(r.want)
  if (!ok) failed++
  console.log(ok ? `  ok   ${r.name}` : `  FAIL ${r.name}\n         want ${JSON.stringify(r.want)}\n         have ${JSON.stringify(r.got)}`)
}

await send('Target.closeTarget', { targetId })
browser.close()
chrome.kill()
try { rmSync(profile, { recursive: true, force: true, maxRetries: 3 }) } catch {}

if (failed) { console.error(`\n${failed} assertion(s) failed`); process.exit(1) }
console.log(`\n${results.length} assertion(s) passed`)
