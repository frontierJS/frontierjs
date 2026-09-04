/**
 * web/test/verify-values.mjs — a declared value set, in a real browser.
 *
 * `valueset ProductColour { source Colour  value name  scope current }` and
 * `ProductVariant.colour @values(ProductColour, open)`. Everything else about
 * the feature is covered by unit tests on both sides of the wire; what nothing
 * else can reach is the claim the whole design rests on:
 *
 *   the list the picker OFFERS is the list the Data boundary ACCEPTS
 *
 * Those are two different code paths — sierra sends the declared `@@scope` as a
 * filter and litestone applies it as a policy predicate — and they only agree
 * because a `$scope` key survives junction's `autoFilter` on the way through.
 * A unit test on either side passes with the crossing broken.
 *
 * Signs in for nothing. `Colour` is `@@gate("0.4.4.5")`, so the offered list is
 * a public read, which keeps this drive out of the 10-per-15-minutes login
 * window the other five share.
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
  const f = window.variants.formFields().find(f => f.name === 'colour');
  return { control: f?.control, set: f?.set, strength: f?.strength,
           allowNew: f?.allowNew, value: f?.valueField, scopes: f?.rule?.values?.scopes };
`)
t('control.kind',     rule.control,  'combobox')
t('control.set',      rule.set,      'ProductColour')
t('control.strength', rule.strength, 'open')
t('control.allowNew', rule.allowNew, true)
t('control.scopes',   rule.scopes,   ['current'])
// `value name` rather than the id — what is stored is the colourway itself.
t('control.storesName', rule.value, 'name')

// The picker's own request, made by the browser through the real client.
const offered = await evaluate(`
  const r = await window.variants.options('colour');
  return { labels: r.options.map(o => o.label), values: r.options.map(o => o.value) };
`)

// Read straight off the API, unscoped, so the two lists are compared rather
// than a hardcoded one asserted — an `open` binding grows the table, so any
// fixed expectation here goes stale on its own the first time a drive runs.
const all     = (await (await fetch(`${API}/api/colours?$limit=100`)).json()).data
const current = all.filter(c => !c.retired).map(c => c.name).sort()
const retired = all.filter(c => c.retired).map(c => c.name)

t('scope.somethingToNarrow', retired.length > 0, true)
t('offers.everyCurrentOne',  [...offered.labels].sort(), current)
t('offers.noRetiredOne',     offered.labels.filter(n => retired.includes(n)), [])
t('offers.storesTheName',    offered.values, offered.labels)

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
    await window.variants.save({ id: one.id, colour: ${JSON.stringify(retired[0] ?? 'Ochre')} }, { mode: 'patch' });
    return { threw: false };
  } catch (err) {
    const fe = window.variants.fieldErrors(err);
    return { threw: true, fields: Object.keys(fe.fields ?? {}), message: fe.fields?.colour ?? fe.message ?? String(err)};
  }
`)
t('refusal.threw',   refused.threw, true)
t('refusal.field',   refused.fields, ['colour'])
t('refusal.saysSet', /not offered by ProductColour/.test(refused.message ?? ''), true)

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
