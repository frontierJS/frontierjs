/**
 * web/test/verify-offline.mjs — what the app does with no server reachable.
 *
 * Started by `bun run verify:offline`. Starts BOTH servers itself, for the
 * reason `verify-catalog` does: what it proves spans them, and a drive that
 * joined a running pair would grade whichever build those were serving.
 *
 * ─── What is under test ──────────────────────────────────────────────────
 *
 * The Homestead work (`IDEAS/homestead.md`) end to end, in the order a device
 * meets it: a write made with no server is HELD and replayed once the network
 * returns (`FJS-D298`–`FJS-D300`); a photograph drains behind the row it
 * belongs to, as a second queue (`FJS-D301`); a write survives the page that
 * made it; a whole stocktake is walked with nothing sent, under a key the
 * BROWSER minted; and two writers on one row merge per column, or conflict and
 * name the column (`FJS-D334`, `FJS-D338`).
 *
 * **The masked outage is the subtle one and it is asserted deliberately.**
 * Chrome's offline emulation refuses new connections and carries frames on a
 * socket that is already open, so a write made in the first seconds of an
 * outage leaves on a socket nothing has confirmed and lands late with the
 * screen never told anything. That is a requirement rather than a defect: a
 * queue entry clears on an ACKNOWLEDGEMENT and never on a send.
 *
 * **Sever sockets by subprotocol, never by origin.** The client's WebSocket is
 * same-origin in dev because the dev server proxies `/api` and `/ws`, so a rule
 * that spares vite's HMR channel by ORIGIN — to stop the page reloading when
 * its socket closes — skips the only socket that matters, reports *nothing to
 * cut*, and makes a masked delivery look like a client that retried. Vite's
 * socket is told apart by `vite-hmr` and never by where it points.
 *
 * ─── The trap this file exists to stay out of ─────────────────────────────
 *
 * Coming back online is not one moment. Chrome's `fetch` works again the
 * instant the emulation lifts, but the client's WebSocket went down with the
 * network and comes back on its own backoff. An assertion made in between is
 * asking a client that is still offline, and it fails intermittently — the kind
 * of red nobody reruns twice before deleting. `net.waitOnline()` is in
 * `lib/offline.mjs` for that reason and every restore here goes through it.
 */
import { spawn, execFileSync } from 'node:child_process'
import { dirname, join }       from 'node:path'
import { fileURLToPath }       from 'node:url'

import { createNetwork } from './lib/offline.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '../..')
const API  = process.env.API_URL ?? 'http://localhost:8110'
const UI   = process.env.UI_URL  ?? 'http://localhost:8010'

const CHROME = process.env.FJS_CHROME ?? 'google-chrome'

// A 1x1 PNG. Small enough to inline and real enough to decode, which is the
// only property the assertion cares about — a file that is served and is not
// an image passes every check but the one a browser makes.
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

// ─── Servers ───────────────────────────────────────────────────────────────

const procs = []
function start(cmd, args, name) {
  // Detached, so stopAll can signal the GROUP: `bun run api` and `npx vite` are
  // both launchers, and killing the launcher leaves the app holding the port.
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

for (const [port, what] of [[8110, 'the API'], [8010, 'the dev server']]) {
  let busy = false
  try { await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(500) }); busy = true } catch {}
  if (busy) {
    console.error(`port ${port} already answers — ${what} is still running from an earlier run.\n` +
                  `stop it first (\`bun run stop\`); this drive starts its own.`)
    process.exit(1)
  }
}

execFileSync('bun', ['run', 'db/seed.ts'], { cwd: ROOT, stdio: 'ignore' })

start('bun', ['run', 'api/index.ts'], 'api')
start('npx', ['vite', '-c', 'web/config/vite.config.js'], 'web')

if (!await waitFor(`${API}/api/products`, 'api')) { stopAll(); process.exit(1) }
if (!await waitFor(UI, 'web'))                    { stopAll(); process.exit(1) }

// ─── Chrome over CDP ───────────────────────────────────────────────────────

start(CHROME, [
  '--headless=new', '--remote-debugging-port=9222', '--disable-gpu',
  '--no-sandbox', '--window-size=1400,1000', 'about:blank',
], 'chrome')

let wsUrl = null
for (let i = 0; i < 80 && !wsUrl; i++) {
  try {
    const v = await (await fetch('http://localhost:9222/json/version')).json()
    wsUrl = v.webSocketDebuggerUrl
  } catch { await new Promise(r => setTimeout(r, 250)) }
}
if (!wsUrl) { console.error('chrome never came up'); stopAll(); process.exit(1) }

const ws = new WebSocket(wsUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })

let msgId = 0
const pending = new Map()
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
}
function send(method, params = {}, sessionId) {
  const id = ++msgId
  return new Promise(res => {
    pending.set(id, res)
    ws.send(JSON.stringify({ id, method, params, sessionId }))
  })
}

const { result: { targetId } }  = await send('Target.createTarget', { url: 'about:blank' })
const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true })
await send('Page.enable', {}, sessionId)
await send('Runtime.enable', {}, sessionId)

async function evaluate(expr) {
  const { result } = await send('Runtime.evaluate', {
    expression: `(async () => (${expr}))()`,
    awaitPromise: true, returnByValue: true,
  }, sessionId)
  if (result?.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
  return result?.result?.value
}

async function until(expr, label, tries = 100) {
  for (let i = 0; i < tries; i++) {
    if (await evaluate(expr)) return true
    await new Promise(r => setTimeout(r, 150))
  }
  throw new Error(`timed out waiting for ${label}`)
}

const net = await createNetwork(send, sessionId, evaluate)

// ─── Assertions ────────────────────────────────────────────────────────────

let pass = 0, fail = 0
function check(name, actual, expected) {
  const ok = typeof expected === 'function' ? expected(actual) : JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) { pass++; console.log(`  ✓ ${name}`) }
  else    { fail++; console.log(`  ✗ ${name}\n      got      ${JSON.stringify(actual)}\n      expected ${typeof expected === 'function' ? '(predicate)' : JSON.stringify(expected)}`) }
}

try {
  // ─── the instrument ──────────────────────────────────────────────────────
  //
  // Before anything about the app: does the network control work at all? A
  // control that silently does nothing would make every assertion below pass
  // for the wrong reason — the write would simply land, and nothing about
  // holding one would have been asserted, because the page was never offline.

  console.log('\n  offline — the instrument')

  await send('Page.navigate', { url: UI + '/' }, sessionId)
  await until(`document.readyState === 'complete'`, 'the first page')

  check('online to begin with', await evaluate('navigator.onLine'), true)

  const seen = await net.withOffline(async () => ({
    onLine: await evaluate('navigator.onLine'),
    fetched: await evaluate(`
      fetch('${API}/api/products?$limit=1').then(r => r.ok).catch(() => 'refused')
    `),
  }))
  check('the page is told it is offline', seen.onLine, false)
  check('a request from the page is refused', seen.fetched, 'refused')

  // The socket registry is what makes offline mean one thing. Without it the
  // page's HTTP is down and its live connection is not, which is the state the
  // first run of this drive passed eight assertions in.
  check('the socket registry is installed before the app boots',
        await evaluate('!!globalThis.__fjsSockets'), true)
  console.log(`      (the signed-out home page had ${net.severed} app socket(s) to sever)`)

  check('back online after the block', await net.waitOnline({ socket: false }), true)
  check('a request from the page works again', await evaluate(`
    fetch('${API}/api/products?$limit=1').then(r => r.ok).catch(() => 'refused')
  `), true)

  // ─── held, then replayed ─────────────────────────────────────────────────

  console.log('\n  offline — a write made with no server')

  await send('Page.navigate', { url: UI + '/' }, sessionId)
  await until(`!!document.querySelector('header button')`, 'the shell')
  await evaluate(`
    (() => {
      const b = [...document.querySelectorAll('header button')]
        .find(x => x.textContent.includes('Sign in (admin)'))
      if (!b) throw new Error('no admin sign-in button in the header')
      b.click(); return true
    })()
  `)
  await until(`[...document.querySelectorAll('header .badge')].some(b => b.textContent.includes('level 5'))`,
              'the admin badge')

  const token = await evaluate(`localStorage.getItem('shop_token')`)
  const auth  = { authorization: 'Bearer ' + token }
  const ledger = async () => (await (await fetch(`${API}/api/inventory?$limit=1`, { headers: auth })).json()).total

  await send('Page.navigate', { url: UI + '/inventory' }, sessionId)
  await until(`!!document.querySelector('#adjust-form #aj-submit')`, 'the adjustment form')
  await until(`document.querySelectorAll('#aj-variant option').length > 1`, 'the variant list')

  // A real submit, through the same control a person uses. Setting `.value` is
  // not enough on its own — the binding is an event listener, so the events a
  // person's typing would raise have to be raised here too, or the component's
  // state never changes and the submit button stays disabled.
  async function submitAdjustment(note, quantity, kind) {
    // Applied in the polling loop below rather than once. A successful adjust
    // reloads the shelf list, which re-renders the variant <select>, and a fill
    // that lands mid-re-render sets a value the option list does not hold yet —
    // so the binding never sees a variant and the submit button stays disabled
    // forever, which reads as an app that refused the write.
    const fill = () => evaluate(`
      (() => {
        const set = (sel, v) => {
          const el = document.querySelector(sel)
          el.value = v
          el.dispatchEvent(new Event('input',  { bubbles: true }))
          el.dispatchEvent(new Event('change', { bubbles: true }))
        }
        set('#aj-variant', ${JSON.stringify(String(fattestVariant))})
        set('#aj-quantity', ${JSON.stringify(String(quantity))})
        set('#aj-kind', ${JSON.stringify(kind)})
        set('#aj-note', ${JSON.stringify(note)})
        return document.querySelector('#aj-variant').value
      })()
    `)

    await fill()
    for (let i = 0; i < 60; i++) {
      const st = await evaluate(`
        (() => {
          const b = document.querySelector('#aj-submit')
          return {
            present: !!b,
            enabled: !!b && !b.disabled,
            denied:  !!document.querySelector('#inventory-denied'),
            badge:   document.querySelector('header .badge')?.textContent?.trim() ?? null,
            head:    document.body.innerText.slice(0, 140).replace(/\s+/g, ' '),
          }
        })()
      `)
      if (st.enabled) {
        await evaluate(`(() => { document.querySelector('#aj-submit').click(); return true })()`)
        return st
      }
      if (!st.present) return st
      await new Promise(r => setTimeout(r, 150))
      await fill()
    }
    return { present: true, enabled: false, timedOut: true }
  }

  // The shelf with the most on it, so a -1 is never the one the service has to
  // refuse. Read from the API rather than from the select, which shows SKUs.
  const allVariants = await (await fetch(`${API}/api/product-variants?$limit=500`, { headers: auth })).json()
  const fattest = allVariants.data.reduce((a, b) => (b.stock > a.stock ? b : a))
  const fattestVariant = fattest.id
  console.log(`      (working on ${fattest.sku}, ${fattest.stock} on hand)`)

  // ── the positive control ────────────────────────────────────────────────
  //
  // Whether the form below reaches the server AT ALL, with the network up. It
  // is here because `held` and `never attempted` are the same reading
  // otherwise: a selector that stopped matching, or a submit button that stayed
  // disabled, would leave the ledger unchanged and the offline assertion would
  // pass while proving nothing.

  // The instrument block severed the client's socket, and it reconnects on its
  // own backoff. Asking for a write before it is back measures the backoff.
  check('the app reconnected after the instrument block', await net.waitOnline(), true)

  const start = await ledger()
  check('the ledger has rows to begin with', start, n => n > 0)

  await submitAdjustment('verify-offline: positive control, network up', 1, 'returned')
  let online = start
  for (let i = 0; i < 120 && online === start; i++) {
    online = await ledger()
    if (online === start) await new Promise(r => setTimeout(r, 250))
  }
  if (online === start) {
    console.log('      form said: ' + JSON.stringify(await evaluate(`
      ({
        errors: [...document.querySelectorAll('#adjust-form .field-error, #adjust-form [role="alert"]')]
                  .map(e => e.textContent.trim()),
        alert:  document.querySelector('#inventory-error')?.textContent?.trim() ?? null,
        toasts: [...document.querySelectorAll('.toast, [role="status"], [role="alert"]')]
                  .map(t => t.textContent.trim()).slice(0, 4),
      })
    `)))
  }
  check('this form does reach the server when the network is up', online, start + 1)

  // ── the negative control ────────────────────────────────────────────────

  // Same settle the second block needs: the positive control's adjust holds
  // `ajBusy` until its own reload of the shelves is done, and going offline
  // inside that window leaves the button disabled on a form nobody can use.
  await until(`!document.querySelector('#aj-submit').disabled`, 'the form to settle')

  const before = await ledger()
  const toastsBefore = await evaluate(`
    [...document.querySelectorAll('.toast, [role="status"], [role="alert"]')]
      .filter(t => /on hand/i.test(t.textContent)).length
  `)

  const held = await net.withOffline(async () => {
    // What the screen IS, before asking it to do anything. A form that is gone
    // is a finding and not a TypeError, and the drive has to say which.
    const screen = await evaluate(`
      ({
        form:   !!document.querySelector('#adjust-form #aj-submit'),
        denied: !!document.querySelector('#inventory-denied'),
        badge:  document.querySelector('header .badge')?.textContent?.trim() ?? null,
        head:   document.body.innerText.slice(0, 160).replace(/\s+/g, ' '),
      })
    `)
    if (!screen.form) return { screen, toastsNow: toastsBefore }

    const submitted = await submitAdjustment('verify-offline: written with the network down', -1, 'adjusted')
    screen.atSubmit = submitted

    // Let the failure resolve. There is nothing to wait FOR here — the whole
    // finding is that the app has no state for a write it could not send — so
    // this is a bounded settle rather than a condition, and it is the only
    // sleep in the file.
    await new Promise(r => setTimeout(r, 2500))

    // Read from NODE, whose network Chrome's emulation does not touch. This is
    // what separates "the write never went" from "the write went later": if the
    // ledger has already moved here, the page reached the server while it was
    // being told it could not.
    const duringOffline = await ledger()

    return {
      screen,
      duringOffline,
      // A COUNT and not a boolean: the positive control's toast is still on
      // screen while this block runs, so "is there one" is true either way.
      toastsNow: await evaluate(`
        [...document.querySelectorAll('.toast, [role="status"], [role="alert"]')]
          .filter(t => /on hand/i.test(t.textContent)).length
      `),
    }
  })

  console.log(`      (severed ${net.severed} app socket(s) for the offline block)`)
  check('the adjustment form is still on screen with the network down',
        held.screen, v => v.form === true)
  // The half that keeps `held` honest: the button was present, enabled and
  // clicked while the network was down. Without this, a form that quietly went
  // away — a session that could not be refreshed offline would do it — reads as
  // a write that was made and held, when nothing was ever submitted.
  check('the correction was actually submitted with the network down',
        held.screen?.atSubmit ?? null, v => v?.enabled === true)
  check('the screen did not claim the correction landed', held.toastsNow, toastsBefore)

  // Nothing reached the server while the page was being told it could not.
  check('nothing reached the server while the page was offline', held.duringOffline, before)

  check('back online', await net.waitOnline(), true)

  // Give a queue every chance to exist before concluding there is none: wait
  // out a reconnect and then some, so the count is a reading and not a race.
  await new Promise(r => setTimeout(r, 5000))
  const after = await ledger()

  // The write was recorded before it was sent, kept when it could not go, and
  // replayed on the socket's own `connect`. The key it carries is what makes
  // replaying safe when nobody can say whether the first attempt arrived.
  check('the correction was HELD and replayed once the network returned', after, before + 1)

  // ─── the outage that has not been noticed yet ────────────────────────────
  //
  // The same act with the socket left OPEN, which is what the first seconds of
  // a real outage look like: the peer has not found out. Chrome refuses new
  // connections and carries frames on an existing one, so the call goes out and
  // is delivered when the network returns — and the screen was never told
  // anything was wrong.
  //
  // It is the reason this drive severs by default. An instrument that stopped
  // at the CDP call would have measured this and reported it as a queue.

  console.log('\n  offline — the same write, socket left open')

  await until(`!document.querySelector('#aj-submit').disabled`, 'the form to settle')
  const beforeOpen = await ledger()

  const masked = await net.withOffline(async () => {
    const st = await submitAdjustment('verify-offline: socket still open', -1, 'adjusted')
    await new Promise(r => setTimeout(r, 2500))
    return { st, during: await ledger() }
  }, { sever: false })

  check('submitted with the network down and the socket up', masked.st, v => v?.enabled === true)
  check('still nothing reached the server while offline', masked.during, beforeOpen)
  check('the socket was left alone', net.severed, 0)

  await net.waitOnline({ socket: false })
  let masksTo = beforeOpen
  for (let i = 0; i < 60 && masksTo === beforeOpen; i++) {
    masksTo = await ledger()
    if (masksTo === beforeOpen) await new Promise(r => setTimeout(r, 250))
  }
  check('an open socket masks the outage — the write lands when the network returns',
        masksTo, beforeOpen + 1)

  // ─── and the page it did not live through ────────────────────────────────

  console.log('\n  offline — a write the page did not live through')

  await until(`!document.querySelector('#aj-submit').disabled`, 'the form to settle')
  const beforeReload = await ledger()

  // Let the previous write finish settling first. `ajBusy` is held for the whole
  // of the adjust call INCLUDING its reload of the shelves, so going offline
  // while that is in flight leaves the submit button disabled on a form nobody
  // can use — and the drive would report a refusal the app never made.
  await until(`!document.querySelector('#aj-submit').disabled`, 'the form to settle')

  await net.goOffline()
  const submittedAgain = await submitAdjustment('verify-offline: the page will not live', -1, 'adjusted')
  check('a second correction was submitted with the network down',
        submittedAgain, v => v?.enabled === true)

  // The tab goes. Navigating with the network down lands on Chrome's own error
  // page, which is exactly the point: whatever the client was holding is gone
  // with the document that held it.
  await send('Page.navigate', { url: UI + '/inventory' }, sessionId)
  await new Promise(r => setTimeout(r, 1000))
  await net.goOnline()
  await net.waitOnline({ socket: false })

  await send('Page.navigate', { url: UI + '/inventory' }, sessionId)
  await until(`!!document.querySelector('header button')`, 'the shell after the reload')
  await new Promise(r => setTimeout(r, 4000))

  let afterReload = beforeReload
  for (let i = 0; i < 80 && afterReload === beforeReload; i++) {
    afterReload = await ledger()
    if (afterReload === beforeReload) await new Promise(r => setTimeout(r, 250))
  }

  // The half that needed real storage. The document that held the intent is
  // gone — navigated away with the network down, which lands on Chrome's own
  // error page — and the write still arrives, because the entry was in
  // IndexedDB and the next client to boot drained it. An in-memory queue passes
  // every assertion above this one and fails this.
  check('the correction survived the page itself and replayed', afterReload, beforeReload + 1)

  // ─── phase 2 — a write that depends on a write nobody has sent ───────────
  //
  // Everything above is one flat row: a correction nothing references, whose
  // key the server can assign whenever it finally sees it. A stocktake is the
  // shape that breaks: the sheet and its counts are written in the same minute
  // in a room with no signal, and the count has to name the sheet BEFORE
  // anything has been inserted anywhere.
  //
  // `StocktakeSheet` and `StocktakeCount` both declare `String @id
  // @default(uuid())`, so litestone crosses `x-mint` and sierra states the key
  // on the create. What is asserted here is the only thing that matters about
  // that: the id the BROWSER put on the sheet is the id the SERVER ends up
  // holding, and the counts still point at it.

  console.log('\n  offline — a sheet and its counts, neither of them sent')

  const sheetsTotal = async () =>
    (await (await fetch(`${API}/api/stocktake-sheets?$limit=1`, { headers: auth })).json()).total
  const countsOf = async (id) =>
    (await (await fetch(`${API}/api/stocktake-counts?sheetId=${encodeURIComponent(id)}`, { headers: auth })).json())

  await send('Page.navigate', { url: UI + '/stocktake' }, sessionId)
  await until(`!!document.querySelector('#start-sheet')`, 'the stocktake screen')
  await until(`document.querySelectorAll('#count-variant option').length > 1 || !!document.querySelector('#start-sheet')`,
              'the screen to settle')

  const sheetsBefore = await sheetsTotal()

  // Two different shelves, so a count that overwrote the other would show up as
  // a missing row rather than as a right answer.
  //
  // Read FRESH rather than from `allVariants` at the top of the file, and each
  // count is deliberately one more than what is on the shelf. A drive that
  // counted a fixed number passed once and then posted nothing on every later
  // run, because the close it had just made had moved the shelf to exactly the
  // number it counts — a green that means *this ran before*.
  const nowVariants = await (await fetch(`${API}/api/product-variants?$limit=500`, { headers: auth })).json()
  const twoShelves  = nowVariants.data.filter(v => v.stock > 0).slice(0, 2)
    .map((v, i) => ({ id: v.id, stock: v.stock, counted: v.stock + 1 + i }))
  check('there are two shelves to count', twoShelves.length, 2)

  const walk = await net.withOffline(async () => {
    await evaluate(`(() => { document.querySelector('#start-sheet').click(); return true })()`)
    // The create cannot resolve — it is held — so the screen advances on the
    // key it minted rather than on a server answer. That IS the feature.
    await until(`!!document.querySelector('#sheet-id')`, 'the sheet to appear with no server')

    const mintedId = await evaluate(`document.querySelector('#sheet-id').textContent.trim()`)

    for (const [i, shelf] of twoShelves.entries()) {
      const variantId = shelf.id
      const fill = () => evaluate(`
        (() => {
          const set = (sel, v) => {
            const el = document.querySelector(sel)
            if (!el) return false
            el.value = v
            el.dispatchEvent(new Event('input',  { bubbles: true }))
            el.dispatchEvent(new Event('change', { bubbles: true }))
            return true
          }
          set('#count-variant', ${JSON.stringify(String(variantId))})
          set('#count-counted', ${JSON.stringify(String(shelf.counted))})
          set('#count-note', 'verify-offline: counted in the dark')
          return document.querySelector('#count-variant')?.value ?? null
        })()
      `)
      await fill()
      // The first shelf is photographed. A file input cannot be filled by
      // setting `.value` — the browser refuses it — so the bytes go in through
      // a DataTransfer, which is the same object a drag-and-drop would build.
      if (i === 0) await evaluate(`
        (() => {
          const el = document.querySelector('#count-damage')
          if (!el) return false
          const b64 = ${JSON.stringify(PNG_B64)}
          const bin = atob(b64)
          const buf = new Uint8Array(bin.length)
          for (let n = 0; n < bin.length; n++) buf[n] = bin.charCodeAt(n)
          const dt = new DataTransfer()
          dt.items.add(new File([buf], 'damage.png', { type: 'image/png' }))
          el.files = dt.files
          el.dispatchEvent(new Event('change', { bubbles: true }))
          return el.files.length === 1
        })()
      `)
      let clicked = false
      for (let k = 0; k < 60 && !clicked; k++) {
        clicked = await evaluate(`
          (() => {
            const b = document.querySelector('#add-count')
            if (!b || b.disabled) return false
            b.click(); return true
          })()
        `)
        if (!clicked) { await new Promise(r => setTimeout(r, 150)); await fill() }
      }
      if (!clicked) throw new Error('the count button never enabled with the network down')
      await until(`document.querySelectorAll('.count-row').length === ${i + 1}`, `count ${i + 1} on screen`)
    }

    await new Promise(r => setTimeout(r, 1500))

    return {
      mintedId,
      rows:    await evaluate(`document.querySelectorAll('.count-row').length`),
      heldSay: await evaluate(`document.querySelector('#stocktake-pending [data-pending]')?.dataset?.pending ?? null`),
      onServer: await sheetsTotal(),
      // The counts on screen all name the key the browser made. If any of them
      // carried a null or an empty sheetId, the drain would land them against
      // nothing and the failure would be a foreign key error minutes later.
      referenced: await evaluate(`
        [...document.querySelectorAll('.count-row')].map(r => r.dataset.sheet)
      `),
      shots: await evaluate(`
        [...document.querySelectorAll('.count-row [data-shot]')].map(c => c.dataset.shot)
      `),
    }
  })

  console.log(`      (severed ${net.severed} app socket(s); sheet ${walk.mintedId})`)

  check('the sheet got a key with no server reachable', walk.mintedId, v => /^[0-9a-f-]{36}$/.test(v ?? ''))
  check('both counts were recorded on the device', walk.rows, 2)
  // Three rows and one photograph. The badge counts the attachment because a
  // screen saying *3 held* while a photograph is also waiting is understating
  // what has not arrived — which is the number a person decides on.
  check('the screen counts the photograph among what is held', walk.heldSay, '4')
  check('nothing reached the server while the room was counted', walk.onServer, sheetsBefore)
  check('every count names the key the browser minted',
        walk.referenced, v => v.length === 2 && v.every(x => x === walk.mintedId))
  check('one of the counts carries a photograph and the other does not',
        walk.shots, v => JSON.stringify(v) === '["yes","no"]')

  check('back online after the stocktake', await net.waitOnline(), true)

  // The drain. Order is what makes this work: the sheet was queued first, so it
  // is sent first, and the counts land against a row that exists by then. A
  // queue that replayed in any other order would fail on the foreign key.
  let landed = null
  for (let i = 0; i < 120; i++) {
    const r = await countsOf(walk.mintedId)
    if (r.total === 2) { landed = r; break }
    await new Promise(r2 => setTimeout(r2, 250))
  }

  check('the sheet and both counts reached the server', landed, v => v?.total === 2)
  check('a sheet exists under the key the browser made',
        (await fetch(`${API}/api/stocktake-sheets/${walk.mintedId}`, { headers: auth })).status,
        200)
  check('the counts point at that sheet and not at a key the server invented',
        (landed?.data ?? []).map(c => c.sheetId),
        v => v.length === 2 && v.every(x => x === walk.mintedId))
  check('what was counted is what arrived',
        (landed?.data ?? []).map(c => c.counted).sort((x, y) => x - y),
        v => JSON.stringify(v) === JSON.stringify(twoShelves.map(t => t.counted).sort((x, y) => x - y)))

  // The count carries what the SYSTEM thought at the moment of counting — a
  // receipt rather than a sum. Recomputing it at close would compare against a
  // shelf that has moved since, and the gap is the whole finding.
  check('each count also carries what the shelf was believed to hold',
        (landed?.data ?? []).map(c => c.expected).sort((x, y) => x - y),
        v => JSON.stringify(v) === JSON.stringify(twoShelves.map(t => t.stock).sort((x, y) => x - y)))

  // ─── the bytes, which are not a row ──────────────────────────────────────
  //
  // `FJS-D301`: two queues. The row half replayed above WITHOUT the photograph,
  // and the bytes are a second queue draining after it as a patch naming the
  // row — which only works because the row's key is the one this browser
  // minted. A 4MB photograph therefore never blocks a 200-byte correction
  // behind it, which is the whole argument for the split.
  //
  // The assertion is decoding and not presence. A ref written into the column
  // with no object behind it answers a URL, and a URL is not a photograph.

  let withShot = null
  for (let i = 0; i < 160; i++) {
    const r = await countsOf(walk.mintedId)
    withShot = (r.data ?? []).find(c => c.damage)
    if (withShot) break
    await new Promise(r2 => setTimeout(r2, 250))
  }

  check('the photograph reached the server after the row it belongs to', withShot, v => !!v?.damage)
  check('exactly one count has one', (await countsOf(walk.mintedId)).data.filter(c => c.damage).length, 1)

  const shotUrl = String(withShot?.damage ?? '')
  const shotRes = await fetch(shotUrl.startsWith('http') ? shotUrl : API + shotUrl)
  const shotBuf = shotRes.ok ? new Uint8Array(await shotRes.arrayBuffer()) : new Uint8Array()
  check('the bytes are served back', shotRes.status, 200)
  check('and they are the PNG that was taken', shotBuf, v =>
    v.length > 0 && v[0] === 0x89 && v[1] === 0x50 && v[2] === 0x4e && v[3] === 0x47)

  // The only honest one, the way `verify:catalog` proves a product photograph:
  // a browser decodes it. A file that is served but not an image passes every
  // assertion above.
  const decoded = await evaluate(`
    new Promise(res => {
      const img = new Image()
      img.onload  = () => res({ ok: true, w: img.naturalWidth, h: img.naturalHeight })
      img.onerror = () => res({ ok: false })
      img.src = ${JSON.stringify(shotUrl)}
    })
  `)
  check('a browser decodes it', decoded, v => v?.ok === true && v.w > 0 && v.h > 0)

  // ─── and the differences post ────────────────────────────────────────────
  //
  // Closing is server work by definition — it reads every count and writes the
  // ledger — so it is not queued and could not be. What it proves here is that
  // the offline rows are ORDINARY rows by the time they matter: the same verb
  // that would close a sheet counted at a desk closes this one.

  const ledgerBeforeClose = await ledger()
  const closed = await fetch(`${API}/api/stocktake-sheets/${walk.mintedId}`, {
    method:  'POST',
    headers: { ...auth, 'content-type': 'application/json', 'x-service-method': 'close' },
    body:    '{}',
  })
  const closeBody = await closed.json()
  check('the sheet closed', closed.status, 200)
  check('it posted one movement per shelf that disagreed', closeBody?.posted?.length, 2)
  check('each movement is the difference and nothing else',
        (closeBody?.posted ?? []).map(p => p.delta).sort((x, y) => x - y), v => JSON.stringify(v) === '[1,2]')
  check('the ledger grew by exactly what was posted',
        await ledger(), ledgerBeforeClose + 2)

  // The replay hazard, asserted rather than assumed: a device that held a close
  // would send it twice, and a stocktake posted twice is a shop that has
  // invented stock. The sheet refuses on its own state.
  const twice = await fetch(`${API}/api/stocktake-sheets/${walk.mintedId}`, {
    method:  'POST',
    headers: { ...auth, 'content-type': 'application/json', 'x-service-method': 'close' },
    body:    '{}',
  })
  check('closing it a second time is refused', twice.status, 409)

  // ─── two writers, one row, different columns ─────────────────────────────
  //
  // Phase 5 (`FJS-D334`, `FJS-D338`). `ProductVariant` declares `@@sync(field)`
  // because the schema's own note says why: a person edits the price and every
  // sale, delivery and stocktake writes `stock`, so a row-wide revision reports
  // a conflict about a change nobody made.
  //
  // Asked here rather than in a unit test because it is the only place the
  // WHOLE path runs — the envelope on the wire, the bridge unwrapping it, the
  // service passing it down, and litestone comparing against a real row. Each
  // half passes its own tests with the other half missing.

  console.log('\n  offline — two writers, one row')

  const variantUrl = (id) => `${API}/api/product-variants/${id}`
  // A single unwraps its envelope and a list keeps one, so both shapes are
  // read rather than guessed at.
  const unwrap = (b) => (b && typeof b === 'object' && 'data' in b && !Array.isArray(b.data))
    ? b.data : b
  const readVariant = async (id) =>
    unwrap(await (await fetch(variantUrl(id), { headers: auth })).json()) ?? null

  const enveloped = (data, base) => ({
    method:  'PATCH',
    headers: { ...auth, 'content-type': 'application/json', 'x-fjs-write': 'enveloped' },
    body:    JSON.stringify({ data, base }),
  })

  const firstVariant = (await (await fetch(
    `${API}/api/product-variants?$limit=1`, { headers: auth })).json())?.data?.[0]
  const vid = firstVariant?.id
  check('a variant to contend over', typeof vid === 'number', true)

  // Both writers read the same row. One of them then goes into the stockroom.
  const asRead = await readVariant(vid)

  // The other saves first, over the network, touching a DIFFERENT column.
  const theirs = await fetch(variantUrl(vid), {
    method:  'PATCH',
    headers: { ...auth, 'content-type': 'application/json' },
    body:    JSON.stringify({ barcode: `BC-${Date.now()}`, version: asRead.version }),
  })
  check('the other writer saved', theirs.status, 200)

  // Now the held write drains, made against a revision that has moved.
  const newPrice = (asRead.price ?? 0) + 101
  const merged = await fetch(variantUrl(vid), enveloped(
    { price: newPrice, version: asRead.version },
    asRead,
  ))
  check('the held write is accepted, not refused', merged.status, 200)

  const theirBarcode = unwrap(await theirs.json())?.barcode
  const afterMerge = await readVariant(vid)
  check('my column won',       afterMerge.price,   newPrice)
  check('and theirs survived', afterMerge.barcode, theirBarcode)

  // ── the control: it is the BASE doing the work, not the envelope ──────────
  //
  // The identical stale write with no base is a plain version conflict. Without
  // this the test above passes against a boundary that simply stopped checking
  // the revision, which is the opposite of the feature.
  const noBase = await fetch(variantUrl(vid), {
    method:  'PATCH',
    headers: { ...auth, 'content-type': 'application/json' },
    body:    JSON.stringify({ price: newPrice + 1, version: asRead.version }),
  })
  check('the same stale write with no base is refused', noBase.status, 409)

  // ── and a column both of them moved is the one question a person answers ──
  const fresh = await readVariant(vid)
  const contested = (fresh.price ?? 0) + 7
  await fetch(variantUrl(vid), {
    method:  'PATCH',
    headers: { ...auth, 'content-type': 'application/json' },
    body:    JSON.stringify({ price: contested, version: fresh.version }),
  })
  const clash = await fetch(variantUrl(vid), enveloped(
    { price: contested + 50, version: fresh.version },
    fresh,
  ))
  check('two writers on ONE column is a conflict', clash.status, 409)
  const clashBody = await clash.json()
  const payload = clashBody?.error ?? clashBody
  check('and it names the column', JSON.stringify(payload), v => v.includes('price'))
  // A retry would re-send the whole patch and overwrite the other writer.
  check('it is not retryable', JSON.stringify(payload), v => !v.includes('"retryable":true'))
  check('and nothing was written', (await readVariant(vid)).price, contested)

  // Put the row back. Other drives count this shop's null barcodes and read its
  // price range, and a drive that leaves a row moved makes the NEXT one fail for
  // a reason that has nothing to do with what it tests.
  const toRestore = await readVariant(vid)
  await fetch(variantUrl(vid), {
    method:  'PATCH',
    headers: { ...auth, 'content-type': 'application/json' },
    body:    JSON.stringify({
      price:   asRead.price,
      barcode: asRead.barcode,
      version: toRestore.version,
    }),
  })
  const restored = await readVariant(vid)
  check('the drive leaves the row as it found it',
        [restored.price, restored.barcode], [asRead.price, asRead.barcode])

} catch (err) {
  fail++
  console.log(`\n  ✗ drive threw: ${err.message}`)
} finally {
  console.log(`\n  ${pass} passed, ${fail} failed\n`)
  stopAll()
  process.exit(fail ? 1 : 0)
}
