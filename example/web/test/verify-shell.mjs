/**
 * web/test/verify-shell.mjs — the app OPENS with no network.
 *
 * Started by `bun run verify:shell`. Phase 3 of the Homestead work
 * (`IDEAS/homestead.md`). Phases 1 and 2 made a write survive an outage; this
 * is the other half of the same promise, and until now it was false: a page
 * navigated to with the network down landed on Chrome's own error screen, and
 * from there every queue on the device is unreachable. `verify:offline`'s
 * reload assertion had to come back online to read its own result.
 *
 * ── Why this is not part of verify:offline ────────────────────────────────
 *
 * A service worker only exists in a BUILD. `verify:offline` drives the dev
 * server, where registering one would fight vite's HMR — and vite's own socket
 * is already the trap that drive spent two wrong conclusions on. So this one
 * builds, serves `dist/` through the same `preview.mjs` `verify:build` uses,
 * and runs on the test tier (7011) so it cannot collide with a preview left
 * behind by a build run.
 *
 * ── The assertion that matters is the NEGATIVE one ────────────────────────
 *
 * A shell that opens offline is easy. A shell that opens offline and has
 * quietly become a cache in front of the API is a disaster with no symptom: a
 * read answers 200 with rows the live layer believes it has already corrected.
 * So the drive asks, with the network down, for something under `/api` and
 * requires it to FAIL — the worker must not be in that path at all.
 */
import { spawn, execFileSync } from 'node:child_process'
import { writeFileSync, rmSync } from 'node:fs'
import { dirname, join }       from 'node:path'
import { fileURLToPath }       from 'node:url'

import { createNetwork } from './lib/offline.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '../..')
const API  = process.env.API_URL ?? 'http://localhost:8110'
const PORT = process.env.PREVIEW_PORT ?? '7011'
const UI   = `http://localhost:${PORT}`

const CHROME = process.env.FJS_CHROME ?? 'google-chrome'

// Written into the SOURCE tree for one rebuild and removed in `finally`. It is
// the only way to make a second build emit a different precache list, since a
// reproducible build gives unchanged sources the same hashes.
//
// `.js` and not `.txt`: the shell is CODE and pages, so a text file is copied
// into the build and precached by nothing — the first version of this used one
// and printed the same digest twice while claiming a rebuild had happened.
const MARKER = join(HERE, '..', 'public', 'verify-shell-marker.js')

// ─── Servers ───────────────────────────────────────────────────────────────

const procs = []
function start(cmd, args, name, env) {
  const p = spawn(cmd, args, {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
    env: { ...process.env, ...env },
  })
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

async function waitFor(url, label, tries = 160) {
  for (let i = 0; i < tries; i++) {
    try { if ((await fetch(url)).ok) return true } catch {}
    await new Promise(r => setTimeout(r, 250))
  }
  console.error(`${label} never answered on ${url}`)
  return false
}

for (const [port, what] of [[8110, 'the API'], [Number(PORT), 'the preview server']]) {
  let busy = false
  try { await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(500) }); busy = true } catch {}
  if (busy) {
    console.error(`port ${port} already answers — ${what} is still running from an earlier run.`)
    process.exit(1)
  }
}

// The build is the thing under test, so it is made here rather than assumed. A
// preview server pointed at a stale `dist/` reports on the previous fix.
console.log('  building…')
execFileSync('npx', ['vite', 'build', '-c', 'web/config/vite.config.js'], { cwd: ROOT, stdio: 'ignore' })
execFileSync('bun', ['run', 'db/seed.ts'], { cwd: ROOT, stdio: 'ignore' })

start('bun', ['run', 'api/index.ts'], 'api')
start(process.execPath, [join(HERE, 'preview.mjs')], 'preview', { PREVIEW_PORT: PORT })

if (!await waitFor(`${API}/api/products`, 'api')) { stopAll(); process.exit(1) }
if (!await waitFor(UI, 'preview'))                { stopAll(); process.exit(1) }

// ─── Chrome over CDP ───────────────────────────────────────────────────────

start(CHROME, [
  '--headless=new', '--remote-debugging-port=9223', '--disable-gpu',
  '--no-sandbox', '--window-size=1400,1000', 'about:blank',
], 'chrome')

let wsUrl = null
for (let i = 0; i < 80 && !wsUrl; i++) {
  try {
    const v = await (await fetch('http://localhost:9223/json/version')).json()
    wsUrl = v.webSocketDebuggerUrl
  } catch { await new Promise(r => setTimeout(r, 250)) }
}
if (!wsUrl) { console.error('chrome never came up'); stopAll(); process.exit(1) }

const ws = new WebSocket(wsUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })

let msgId = 0
const inflight = new Map()
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id && inflight.has(m.id)) { inflight.get(m.id)(m); inflight.delete(m.id) }
}
// Bounded, and the bound is the lesson of `FJS-1179`. Two of the things under
// test here run OUTSIDE the page — a service worker and the local database's
// own worker — and when one of them takes the renderer down with it, every
// renderer-bound CDP call simply never answers. An unbounded `send` turns that
// into a drive that sits there forever with no output, which is how a renderer
// crash was filed as a hang and stayed one. A method name and a number is a
// place to start.
const CDP_TIMEOUT = 30000
function send(method, params = {}, sessionId) {
  const id = ++msgId
  return new Promise((res, rej) => {
    const timer = setTimeout(() => {
      inflight.delete(id)
      rej(new Error(`${method} did not answer in ${CDP_TIMEOUT}ms — the renderer is gone or wedged`))
    }, CDP_TIMEOUT)
    inflight.set(id, (m) => { clearTimeout(timer); res(m) })
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

async function until(expr, label, tries = 120) {
  for (let i = 0; i < tries; i++) {
    if (await evaluate(expr)) return true
    await new Promise(r => setTimeout(r, 250))
  }
  throw new Error(`timed out waiting for ${label}`)
}

let pass = 0, fail = 0
function check(name, actual, expected) {
  const ok = typeof expected === 'function' ? expected(actual) : actual === expected
  if (ok) { pass++; console.log(`  ✓ ${name}`) }
  else {
    fail++
    console.log(`  ✗ ${name}`)
    console.log(`      got      ${JSON.stringify(actual)}`)
    console.log(`      expected ${typeof expected === 'function' ? '(predicate)' : JSON.stringify(expected)}`)
  }
}

try {
  const net = await createNetwork(send, sessionId, evaluate)

  // ─── the build wrote one ────────────────────────────────────────────────

  console.log('\n  the shell the build wrote')

  const swRes  = await fetch(`${UI}/sw.js`)
  const swText = swRes.ok ? await swRes.text() : ''
  check('the build emitted sw.js', swRes.status, 200)
  check('it names a versioned cache', swText, v => /const CACHE\s+= 'fjs-shell-' \+ VERSION/.test(v))
  check('it precaches this build\'s own files', swText, v => /const SHELL\s+= \[/.test(v))
  // The one thing a shell must never become. Asserted against the SOURCE as
  // well as against behavior below, because a runtime cache added later would
  // pass every behavioral test on the day it was added.
  check('it does no runtime caching', swText, v => !/cache\.put\(|c\.put\(/.test(v))

  // ─── it registers, and takes control ────────────────────────────────────

  console.log('\n  it registers')

  await send('Page.navigate', { url: UI + '/' }, sessionId)
  await until(`!!document.querySelector('header button')`, 'the shell')
  check('the page registers a worker', await evaluate(`
    navigator.serviceWorker.ready.then(r => !!r.active).catch(() => false)
  `), true)

  // A worker is `ready` before it controls the page that installed it. The
  // reload is what puts the page under it, and every assertion below depends
  // on that — a drive that skipped it would measure a page the worker is not
  // in front of and pass for the wrong reason.
  await send('Page.navigate', { url: UI + '/' }, sessionId)
  await until(`!!navigator.serviceWorker.controller`, 'the worker to take control')
  await until(`!!document.querySelector('header button')`, 'the shell again')
  check('and the page is under it', await evaluate(`!!navigator.serviceWorker.controller`), true)

  const cached = await evaluate(`
    caches.keys().then(ks => ks.filter(k => k.startsWith('fjs-shell-')).length)
  `)
  check('exactly one shell cache exists', cached, 1)

  // ─── the positive control ───────────────────────────────────────────────
  //
  // With the network up the app still works through the worker. Without this,
  // an app that had quietly stopped rendering would pass the offline assertion
  // by failing identically in both directions.

  console.log('\n  online, through the worker')

  // Inventory and the stocktake both read at level 5, so the drive signs in as
  // an administrator. A screen that renders "administrators only" offline would
  // satisfy every assertion below and prove nothing about the shell.
  // Waited for rather than assumed. The shell is served through the worker and
  // the worker is installing a precache that grew by an engine, so first paint
  // is later than it was — and an unguarded click reports *no admin sign-in
  // button*, which reads as the app being broken rather than as the drive being
  // early.
  // A session OUTLIVES the run. The browser profile is reused, so a second run
  // of this drive opens already signed in and there is no button to press — the
  // step then reports *no admin sign-in button in the header*, which reads as
  // the app being broken and is the drive assuming a state it never checked.
  // Signed in or signing in, the assertion below is the same one.
  const signedIn = `[...document.querySelectorAll('header .badge')].some(b => b.textContent.includes('level 5'))`
  if (!await evaluate(signedIn)) {
    await until(`[...document.querySelectorAll('header button')].some(x => x.textContent.includes('Sign in (admin)'))`,
                'the sign-in buttons in the header')
    await evaluate(`
      (() => {
        const b = [...document.querySelectorAll('header button')]
          .find(x => x.textContent.includes('Sign in (admin)'))
        b.click(); return true
      })()
    `)
  }
  await until(signedIn, 'the admin badge')

  // ─── hydration — a screen this device has NEVER opened ──────────────────
  //
  // Phase 4's last owing. The device used to be only as full as what a screen
  // happened to read, so a person who signed in and walked into a basement
  // without opening the right screen had an empty database — and `@@sync`'s
  // read direction was a claim with nothing behind it. The warm a resource
  // declares now fills the tables, at boot and whenever the identity changes.
  //
  // **Two halves make it an assertion, and `FJS-D337` moved one of them.** The
  // screen has not been opened in this browser, so nothing was ever written
  // through a `load()` — and the warm no longer fills the list cache for a
  // model the device kept, so there is no slot under the question this screen
  // asks. The cache is emptied anyway, as the control that says so: with an
  // entry in place the screen renders identically whether or not a row ever
  // reached the device.
  //
  // **What is left to wait on is the call itself.** The slot used to be both
  // the fallback and the signal that the warm's `find` came back; with the slot
  // gone the frame is the only fact, so it is tapped before the app's first
  // script and the page reloaded under the tap. One attached afterwards is one
  // that missed. `warmOffline` awaits the write-through, so a settled call
  // means the rows are on the device rather than in flight to it.

  console.log('\n  offline — a screen this device has never opened')

  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      (() => {
        const seen = { asked: null, done: false }
        globalThis.__fjsWarm = seen
        const Prev = globalThis.WebSocket
        globalThis.WebSocket = new Proxy(Prev, {
          construct(target, args) {
            const sock = new target(...args)
            // An own property over the prototype's, so the client's own send
            // is the one being watched rather than a second socket.
            const pass = sock.send.bind(sock)
            sock.send = (payload) => {
              try {
                const f = JSON.parse(payload)
                if (f && f.type === 'service_call' && f.service === 'inventory' && f.method === 'find') seen.asked = f.id
              } catch {}
              return pass(payload)
            }
            sock.addEventListener('message', (e) => {
              try { if (seen.asked !== null && JSON.parse(e.data).id === seen.asked) seen.done = true } catch {}
            })
            return sock
          },
        })
      })()
    `,
  }, sessionId)

  await send('Page.navigate', { url: UI + '/' }, sessionId)
  await until(`!!document.querySelector('header button')`, 'the shell under the tap')
  await until(
    `!!globalThis.__fjsWarm && (__fjsWarm.done
      || performance.getEntriesByType('resource').some(e => e.name.includes('/api/inventory')))`,
    'the declared read to be warmed')

  // The ruling itself, in a real browser: one grain, and it is the device's.
  check('the warm wrote no keyed slot for a model the device keeps', await evaluate(`
    new Promise(res => {
      const req = indexedDB.open('fjs-lists')
      req.onerror   = () => res(-1)
      req.onsuccess = () => {
        const db = req.result
        if (!db.objectStoreNames.contains('lists')) return res(0)
        const tx  = db.transaction('lists', 'readonly')
        const all = tx.objectStore('lists').getAll()
        all.onsuccess = () => res(all.result.filter(r => String(r.key).includes('inventory')).length)
        all.onerror   = () => res(-1)
      }
    })
  `), 0)

  const hydrated = await net.withOffline(async () => {
    const cleared = await evaluate(`
      new Promise(res => {
        const req = indexedDB.open('fjs-lists')
        req.onerror   = () => res('no database')
        req.onsuccess = () => {
          const db = req.result
          // A store that was never created and one emptied here are one fact —
          // nothing is left to answer from. Since FJS-D337 the warm writes no
          // slot, so a device-held model may reach this with no store at all.
          if (!db.objectStoreNames.contains('lists')) return res('empty')
          const tx = db.transaction('lists', 'readwrite')
          tx.objectStore('lists').clear()
          tx.oncomplete = () => res('empty')
          tx.onerror    = () => res('failed')
        }
      })
    `)
    await send('Page.navigate', { url: UI + '/inventory' }, sessionId)
    await until(`!!document.querySelector('header button')`, 'the shell on a screen never opened')
    for (let i = 0; i < 40; i++) {
      if (await evaluate(`document.querySelectorAll('tr.movement').length > 0`)) break
      await new Promise(r => setTimeout(r, 250))
    }
    return { cleared, ledger: await evaluate(`document.querySelectorAll('tr.movement').length`) }
  })

  check('the cache held nothing under the question', hydrated.cleared, 'empty')
  check('a screen never opened online still has its ledger', hydrated.ledger, v => v > 0)

  check('back online after the hydration block', await net.waitOnline({ socket: false }), true)

  await send('Page.navigate', { url: UI + '/inventory' }, sessionId)
  await until(`!!document.querySelector('#adjust-form #aj-submit')`, 'the inventory screen')
  check('a real screen renders with the network up', await evaluate(`
    document.querySelectorAll('.level-row').length
  `), v => v > 0)

  // The ledger is `InventoryMovement`, which declares `@@sync` — so this list
  // is the one the device is allowed to keep. Read now, compared offline.
  await until(`document.querySelectorAll('tr.movement').length > 0`, 'the ledger')
  const ledgerOnline = await evaluate(`document.querySelectorAll('tr.movement').length`)
  check('the ledger has rows to compare against', ledgerOnline, v => v > 0)

  // ─── and now with nothing reachable ─────────────────────────────────────

  console.log('\n  offline — the app opens anyway')

  const opened = await net.withOffline(async () => {
    // A navigation, not a reload: this is the case that produced Chrome's error
    // page for the whole of phases 0 to 2.
    await send('Page.navigate', { url: UI + '/stocktake' }, sessionId)
    await until(`!!document.body && document.body.innerText.length > 0`, 'something to be on screen')

    // What the API does with no network, asked from the page. It has to FAIL.
    // A 200 here would mean the worker had become a cache in front of the
    // server, which is the one outcome worse than an error page.
    const api = await evaluate(`
      fetch('${API}/api/products?$limit=1').then(r => 'answered ' + r.status).catch(() => 'refused')
    `)

    return {
      chromeError: await evaluate(`
        /ERR_INTERNET_DISCONNECTED|No internet|ERR_FAILED/i.test(document.body.innerText)
      `),
      header:  await evaluate(`!!document.querySelector('header button')`),
      title:   await evaluate(`document.title`),
      screen:  await evaluate(`!!document.querySelector('#start-sheet') || !!document.querySelector('#stocktake-denied')`),
      storage: await evaluate(`typeof indexedDB !== 'undefined'`),
      api,
    }
  })

  console.log(`      (severed ${net.severed} app socket(s))`)

  check('this is not Chrome\'s error page',        opened.chromeError, false)
  check('the app\'s own shell rendered',            opened.header, true)
  check('with the app\'s title',                    opened.title, v => typeof v === 'string' && v.length > 0)
  check('and the route\'s own screen under it',     opened.screen, true)
  check('the device\'s durable storage is reachable', opened.storage, true)
  // The whole reason this is safe to ship.
  check('the API is NOT served from the cache',     opened.api, 'refused')

  // ─── and it has something IN it ─────────────────────────────────────────
  //
  // The shell alone is a working app over empty tables, which reads to a person
  // as *the data is gone*. A model that declared `@@sync` has its lists kept on
  // the device, and a load that cannot reach the server answers with the last
  // one instead of throwing.

  console.log('\n  offline — and the screen is not empty')

  const kept = await net.withOffline(async () => {
    await send('Page.navigate', { url: UI + '/inventory' }, sessionId)
    await until(`!!document.querySelector('header button')`, 'the shell with no network')
    // Give the load its chance to fail and fall back. There is nothing to wait
    // FOR if the feature is absent, so this is a bounded settle.
    for (let i = 0; i < 40; i++) {
      if (await evaluate(`document.querySelectorAll('tr.movement').length > 0`)) break
      await new Promise(r => setTimeout(r, 250))
    }
    return {
      // The session is the thing that has to survive first: with no server
      // `auth.me()` cannot answer, and an app that opens signed OUT hides every
      // gated screen from the person holding the device.
      // Every badge, not the first: the header carries more than one and the
      // first is a build label.
      level: await evaluate(`
        [...document.querySelectorAll('header .badge')].some(b => b.textContent.includes('level 5'))
      `),
      ledger: await evaluate(`document.querySelectorAll('tr.movement').length`),
      // The LEVELS are not a table and not a model — they are a join and a
      // clock, computed per read — so nothing keeps them and this screen is
      // honestly half empty. Asserted so the cache's edge is stated rather
      // than discovered.
      levels: await evaluate(`document.querySelectorAll('.level-row').length`),
    }
  })

  check('the session survived the server being unreachable', kept.level, true)
  check('the ledger this device had seen is still on screen', kept.ledger, ledgerOnline)
  check('and what was never a list is not invented', kept.levels, 0)

  // ─── and SQL is what answered ───────────────────────────────────────────
  //
  // Every assertion above passes with the device's database absent, because the
  // list cache underneath answers the same question with the same rows — which
  // makes the whole of `offline: { db: true }` a feature that can be off and
  // green. So the cache is EMPTIED with the network already down, and the
  // screen asked again. What is left that can answer is the database.
  //
  // The store is cleared rather than the database deleted: `deleteDatabase`
  // waits on every open connection, and the page holding one is the page that
  // has to do the deleting.

  console.log('\n  offline — and it was SQL that answered')

  const fromSql = await net.withOffline(async () => {
    const cleared = await evaluate(`
      new Promise(res => {
        const req = indexedDB.open('fjs-lists')
        req.onerror   = () => res('no database')
        req.onsuccess = () => {
          const db = req.result
          // A store that was never created and one emptied here are one fact —
          // nothing is left to answer from. Since FJS-D337 the warm writes no
          // slot, so a device-held model may reach this with no store at all.
          if (!db.objectStoreNames.contains('lists')) return res('empty')
          const tx = db.transaction('lists', 'readwrite')
          tx.objectStore('lists').clear()
          tx.oncomplete = () => res('empty')
          tx.onerror    = () => res('failed')
        }
      })
    `)

    await send('Page.navigate', { url: UI + '/inventory' }, sessionId)
    await until(`!!document.querySelector('header button')`, 'the shell with an empty cache')
    for (let i = 0; i < 40; i++) {
      if (await evaluate(`document.querySelectorAll('tr.movement').length > 0`)) break
      await new Promise(r => setTimeout(r, 250))
    }
    return {
      cleared,
      ledger: await evaluate(`document.querySelectorAll('tr.movement').length`),
      // The engine's own files, under the pool directory litestone names. An
      // empty OPFS is a database that never opened, which is the failure this
      // whole block exists to tell apart from a cache that happened to hit.
      opfs: await evaluate(`
        (async () => {
          const root = await navigator.storage.getDirectory()
          const names = []
          for await (const [n] of root.entries()) names.push(n)
          return names
        })()
      `),
    }
  })

  check('the list cache really was empty',          fromSql.cleared, 'empty')
  check('the device kept SQLite\'s own files',      fromSql.opfs, v => Array.isArray(v) && v.length > 0)
  check('and the ledger came back without a cache', fromSql.ledger, ledgerOnline)

  check('back online', await net.waitOnline({ socket: false }), true)

  // ─── a second build replaces the first ──────────────────────────────────
  //
  // The failure a precached shell invites: a device that keeps serving the
  // build it first saw. The cache is named for a digest of the precache list,
  // and `activate` deletes every other one — so what is asserted is that there
  // is still exactly ONE cache after a rebuild, not that the new one exists.

  console.log('\n  a rebuild does not leave the old shell behind')

  await send('Page.navigate', { url: UI + '/' }, sessionId)
  await until(`!!document.querySelector('header button')`, 'the shell')
  const before = await evaluate(`caches.keys().then(ks => ks.filter(k => k.startsWith('fjs-shell-')))`)

  // A stale cache the sweep has to find. Seeded rather than waited for, because
  // the failure this guards against is a device that accumulates one shell per
  // release and never gets its quota back.
  await evaluate(`caches.open('fjs-shell-stale').then(() => true)`)

  // **The rebuild has to emit something different.** A reproducible build gives
  // the same filenames the same hashes, so rebuilding unchanged sources gives
  // the same digest and the same cache name — the first version of this block
  // passed while proving nothing, printing one digest twice. A file in
  // `public/` is copied into the build and is therefore in the precache list.
  writeFileSync(MARKER, '// verify-shell: a file that changes the precache digest\n')
  execFileSync('npx', ['vite', 'build', '-c', 'web/config/vite.config.js'], { cwd: ROOT, stdio: 'ignore' })

  // Two loads: the first installs the new worker, the second is controlled by
  // it. This block is why `skipWaiting` is in the generated worker at all —
  // without it the new one sat in `waiting` forever, because a navigation in
  // the same tab does not release the old worker's client.
  for (let i = 0; i < 2; i++) {
    await send('Page.navigate', { url: UI + '/' }, sessionId)
    await until(`!!document.querySelector('header button')`, 'the shell after the rebuild')
    await new Promise(r => setTimeout(r, 1500))
  }
  await until(`caches.keys().then(ks => ks.filter(k => k.startsWith('fjs-shell-')).length === 1)`,
              'the old caches to be swept')

  const after = await evaluate(`caches.keys().then(ks => ks.filter(k => k.startsWith('fjs-shell-')))`)
  check('the rebuild really did emit a different shell', after[0], v => v !== before[0])
  check('the stale cache was swept', after, v => !v.includes('fjs-shell-stale'))
  check('still exactly one shell cache', after.length, 1)
  check('and the app still renders on it', await evaluate(`!!document.querySelector('header button')`), true)
  console.log(`      (${before[0]} → ${after[0]})`)

} catch (err) {
  fail++
  console.log(`\n  ✗ drive threw: ${err.message}`)
} finally {
  try { rmSync(MARKER, { force: true }) } catch {}
  console.log(`\n  ${pass} passed, ${fail} failed\n`)
  stopAll()
  process.exit(fail ? 1 : 0)
}
