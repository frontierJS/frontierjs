/*
 * drive.js — a real Chrome, driven over CDP. `@frontierjs/mesa/drive`.
 *
 * Launch a browser, attach to a page, send it INPUT the browser trusts, take
 * its network away (`createNetwork`), and collect everything the page threw.
 * It knows nothing about what is being tested: the caller brings a URL. The spec runner this repo's own drives use
 * sits on top of it in `test/browser/drive.mjs` and is not published.
 *
 * It lives in mesa because mesa is the leaf, so every package's drive and
 * every app's may import it (`FJS-D554`). In-repo callers import it by
 * relative path: a workspace dep resolves to a COPY under `node_modules/.bun/`,
 * so a by-name import drives a snapshot taken at install time.
 *
 * ── Why CDP and not --dump-dom ────────────────────────────────────────
 *
 * `@frontierjs/css` drives Chrome with `--dump-dom`, which is right for a
 * package whose every claim is a computed style. Half of what a component or a
 * screen is asked is a response to INPUT, and a dispatched `KeyboardEvent` is
 * not trusted: it will not move focus, will not type a character and will not
 * dismiss a `[popover]`. Those are the paths most likely to be broken, so input
 * has to come through the browser's own pipeline. The protocol is spoken over
 * the global `WebSocket`, so this adds no dependency.
 *
 * ── Harness rules, paid for once ──────────────────────────────────────
 *
 * Never return a bare `null` from a probe — CDP omits `value` and it reads
 * back as `undefined`; wrap it in an object. Never start an evaluated
 * expression with `return` on its own line — ASI turns it into `return;`.
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, readdirSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ─── which Chrome ─────────────────────────────────────────────────────

const CANDIDATES = [
  'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
]

// Synchronous, because a caller deciding whether to skip is inside a probe,
// and a probe answers rather than awaits.
function whichSync(bin) {
  try { return spawnSync('sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' }).status === 0 }
  catch { return false }
}

/** The binary, or null. A caller that would rather SKIP than fail asks this
 *  first: no Chrome is a fact about the machine, not about the app.
 *
 *  `$FJS_CHROME` is AUTHORITATIVE rather than preferred. Somebody who names a
 *  binary names it for a reason — a specific build, a specific version — and
 *  falling through to whatever else is installed answers a different question
 *  than the one they asked, silently. So a variable pointing at nothing is
 *  null. The world is injectable so both answers are testable on a machine
 *  with either. */
export function findChrome({ run = whichSync, exists = existsSync, candidates = CANDIDATES, env = process.env } = {}) {
  const named = env.FJS_CHROME
  if (named) return (named.includes('/') ? exists(named) : run(named)) ? named : null

  for (const c of candidates) {
    if (c.includes('/')) { if (exists(c)) return c; continue }
    if (run(c)) return c
  }
  return null
}

// ─── the browser's lifetime ───────────────────────────────────────────
//
// A drive that reaches close() cleans up after itself. A drive that throws, or
// takes a Ctrl-C, or dies on an unhandled rejection, used to leave Chrome
// running and its profile behind — and Chrome does not notice its launcher has
// gone, so it is reparented to init and stays up forever. Nineteen of them
// were found alive on one machine, the oldest 6.7 days old, holding 5GB of RAM
// and profile directories that were still growing (FJS-361).
//
// Two halves, because neither alone is enough:
//   · a signal-safe sweep of what THIS process launched, so an interrupted run
//     takes its browsers with it. Synchronous — an exit handler cannot await.
//   · a reap of PREVIOUS runs' profiles on the way in, past an age floor,
//     which is the only thing that covers a SIGKILL no handler can see. The
//     floor is what keeps a concurrent drive of the same suite safe.
//
// The sweep cannot come from litestone's tmp-dirs.js: mesa is the leaf and
// takes no framework dependency but @frontierjs/toolbelt, which does no I/O by
// ruling (FJS-D26). Change one, ask whether the other needs it.

const REAP_AFTER_MS = 60 * 60 * 1000
const PROFILE_PREFIX = 'fjs-drive-'

/** Chrome processes this run launched, with the profile each one holds and
 *  whether that profile is the caller's to keep. */
const launched = new Set()
let sweepInstalled = false

/** Block the thread. An exit handler cannot await, and the wait below is not
 *  optional — see sweepLaunched(). */
function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }

/** Kill every process holding a profile, Chrome's children included. Killing
 *  the browser alone leaves a renderer or the GPU process winding down with
 *  the profile open, and it writes the directory back after it is removed. The
 *  pattern starts past the dashes, or pkill reads it as an option. */
function killHolders(entry) {
  try { entry.chrome.kill('SIGKILL') } catch { /* already gone */ }
  try { spawnSync('pkill', ['-KILL', '-f', `user-data-dir=${entry.profile}`]) } catch { /* no pkill */ }
}

function sweepLaunched() {
  if (!launched.size) return
  for (const entry of launched) killHolders(entry)
  // Every browser dies BEFORE any profile is removed, and then the thread
  // waits. Removing straight after the kill does not fail — it SUCCEEDS, and
  // Chrome, still shutting down, writes the directory back: measured, a
  // profile removed at 0ms was on disk again 1.5s later with Default/ in it
  // and 16MB, while 200ms was already enough for it to stay gone. `maxRetries`
  // cannot cover that, because the removal is not what fails.
  sleepSync(300)
  for (const entry of launched) {
    if (entry.keep) continue
    try { rmSync(entry.profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }) } catch { /* the next run's reap gets it */ }
  }
  launched.clear()
}

function installSweep() {
  if (sweepInstalled) return
  sweepInstalled = true
  process.on('exit', sweepLaunched)
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => { sweepLaunched(); process.exit(sig === 'SIGINT' ? 130 : 143) })
  }
  // Without this an unhandled rejection prints and leaves Chrome up: the
  // default handler exits without running an ordinary exit path on every
  // runtime here.
  process.on('uncaughtException',  (e) => { sweepLaunched(); console.error(e); process.exit(1) })
  process.on('unhandledRejection', (e) => { sweepLaunched(); console.error(e); process.exit(1) })
}

function reapStaleProfiles() {
  const cutoff = Date.now() - REAP_AFTER_MS
  let entries
  try { entries = readdirSync(tmpdir()) } catch { return }
  for (const name of entries) {
    if (!name.startsWith(PROFILE_PREFIX)) continue
    const full = join(tmpdir(), name)
    try {
      if (statSync(full).mtimeMs > cutoff) continue
      rmSync(full, { recursive: true, force: true })
    } catch { /* a concurrent drive got there first */ }
  }
}

// ─── the browser ──────────────────────────────────────────────────────

/** Launch Chrome, attach to one page, and answer everything a drive needs to
 *  reach it. The caller closes it.
 *
 *  `errors` is a live array — anything the page threw or reported since it was
 *  last emptied. A component that throws while rendering still leaves a
 *  partial tree, so an assertion about what IS there passes over the top of
 *  it; read this after every step that can fail.
 *
 *    windowSize — `'W,H'`
 *    bootstrap  — script run before anything else in every document, for a
 *                 drive over a page it does not own
 *    profile    — a directory the CALLER owns, kept across close() and across
 *                 launches. IndexedDB, Cache Storage, the service worker and
 *                 OPFS belong to the profile, so a drive that reopens an
 *                 offline app on a fresh temp one is measuring a new phone.
 *                 Omitted, each launch gets a temp profile that is removed
 *                 with it. Two browsers cannot hold one profile at once;
 *                 close() waits for Chrome to exit, so a relaunch after it is
 *                 safe
 *    args       — further Chrome flags, appended. The port and the profile are
 *                 the driver's and refused here: the attach reads the port
 *                 Chrome picked, and the sweep finds its browsers by profile
 *
 *  The handle's `send(method, params, sessionId)` is the browser-level call,
 *  for a drive that attaches targets of its own — an extension's popup or its
 *  service worker; `cmd` is the same call bound to the page.
 *
 *  A launch that fails THROWS, with a sentence naming the fix. It never exits
 *  the process: the caller may be a long-lived one (fli, a lesson) for which
 *  no Chrome is a skip. */
export async function openChrome({ windowSize = '1280,900', bootstrap, profile: kept, args = [] } = {}) {
  const owned = args.find((a) => /^--(remote-debugging-port|user-data-dir)\b/.test(a))
  if (owned) throw new Error(`openChrome: ${owned.split('=')[0]} is the driver's own flag — the attach and the profile sweep depend on it`)
  const exe = findChrome()
  if (!exe)
    throw new Error(process.env.FJS_CHROME
      ? `$FJS_CHROME names ${process.env.FJS_CHROME} and there is no such binary`
      : 'no Chrome on this machine — install Chrome or Chromium, or point $FJS_CHROME at a binary')

  installSweep()
  reapStaleProfiles()
  if (kept) mkdirSync(kept, { recursive: true })
  const profile = kept ?? mkdtempSync(join(tmpdir(), PROFILE_PREFIX))
  // A port Chrome PICKS and a profile of its own, both. A fixed 9222 is held by
  // whichever browser bound it first, so a second drive attaches to another
  // run's session and grades that screen — measured in example's `verify:stock`,
  // reading *Sign out* and 43 rows while asserting a signed-out visitor is
  // refused (`FJS-740` one layer over). The default profile carries a previous
  // run's `localStorage`, and with it that run's sign-in.
  const chrome  = spawn(exe, [
    '--headless=new', '--disable-gpu', '--no-sandbox',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    `--window-size=${windowSize}`,
    // Specs read color and geometry; a non-sRGB profile or a scrollbar taking
    // width makes a hit test land on the wrong element.
    '--force-color-profile=srgb', '--hide-scrollbars',
    ...args,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] })

  const entry = { chrome, profile, keep: !!kept }
  launched.add(entry)

  // A launch that fails leaves no browser and no temp profile behind.
  const abandon = (e) => {
    launched.delete(entry)
    try { chrome.kill('SIGKILL') } catch { /* never started */ }
    if (!entry.keep) try { rmSync(profile, { recursive: true, force: true }) } catch {}
    throw e
  }

  const wsUrl = await new Promise((resolve, reject) => {
    let buf = ''
    const timer = setTimeout(() => reject(new Error('Chrome never announced a DevTools port')), 15000)
    chrome.on('error', (e) => { clearTimeout(timer); reject(new Error(`could not launch ${exe}: ${e.message}`)) })
    chrome.stderr.on('data', (d) => {
      buf += d
      const m = buf.match(/ws:\/\/[^\s]+/)
      if (m) { clearTimeout(timer); resolve(m[0]) }
    })
  }).catch(abandon)

  const browser = new WebSocket(wsUrl)
  await new Promise((resolve, reject) => {
    browser.addEventListener('open', resolve, { once: true })
    browser.addEventListener('error', () => reject(new Error('could not attach to Chrome')), { once: true })
  }).catch(abandon)

  let nextId = 1
  const pending = new Map()

  // Bounded, because a service worker or a database worker that takes the
  // renderer down with it leaves every renderer-bound call unanswered, and an
  // unbounded one is a drive that sits silent forever — a renderer crash filed
  // as a hang (`FJS-1179`). The message says which.
  function send(method, params = {}, sessionId) {
    const id = nextId++
    browser.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      setTimeout(() => {
        if (!pending.delete(id)) return
        reject(new Error(`${method} did not answer in 30s — the renderer is gone or wedged`))
      }, 30000)
    })
  }

  const errors = []
  const listeners = new Map()

  /** Hear a CDP event — `on('Network.webSocketFrameReceived', (params) => …)`.
   *  An Observer: it receives the event and cannot change what the page does.
   *  Answers the unsubscribe. The collected `errors` are the driver's policy on
   *  the console; a drive that holds a stricter one, or counts frames, reads
   *  the events here instead of opening a second socket to the same browser.
   *  A domain must be enabled for its events to arrive: Page and Runtime are. */
  function on(method, fn) {
    if (!listeners.has(method)) listeners.set(method, new Set())
    listeners.get(method).add(fn)
    return () => listeners.get(method).delete(fn)
  }

  browser.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
      return
    }
    for (const fn of listeners.get(msg.method) ?? []) fn(msg.params, msg.sessionId)
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails
      errors.push('exception: ' + (d?.exception?.description ?? d?.text))
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error')
      errors.push('console.error: ' + msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '))
    // A framework warning is a failure. Mesa reports a corrupt render it
    // SURVIVES — a duplicate {#each} key, an unknown block — through
    // console.warn, and carries on drawing something wrong: a keyed list given
    // one key twice left an orphaned node on screen per render, which every
    // assertion about the current page walked straight past (`FJS-315`). Only
    // [Mesa] is promoted; a page's own warnings are its business.
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'warning') {
      const text = msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ')
      if (text.startsWith('[Mesa]')) errors.push('console.warn: ' + text)
    }
  })

  const { targetId }  = await send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
  const cmd = (method, params) => send(method, params, sessionId)

  // A headless window's FOCUS belongs to the browser, not the page: about thirty
  // seconds after launch Chrome starts its component extensions, the window
  // blurs, and from then on `el.focus()` moves `activeElement` and fires no
  // `focus` event. A combobox that opens on focus then never opens, and the
  // failure lands on whichever step the drive reached at that second
  // (`FJS-1084`). Emulated focus keeps the page focused whatever the window does.
  await cmd('Emulation.setFocusEmulationEnabled', { enabled: true })
  await cmd('Page.enable')
  await cmd('Runtime.enable')

  // Runs before anything else in EVERY document, including one this drive
  // navigates to later. A drive over a page it owns installs its probes from
  // that page's own script; a drive over a page it does NOT own — the REPL,
  // a devtools panel — has nowhere to put them, and reaching for a probe that
  // is not there reads as the page being broken.
  if (bootstrap) await cmd('Page.addScriptToEvaluateOnNewDocument', { source: bootstrap })

  async function evaluate(expression) {
    const r = await cmd('Runtime.evaluate', {
      expression: `(async () => { ${expression} })()`,
      awaitPromise: true, returnByValue: true,
    })
    if (r.exceptionDetails)
      throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
    return r.result.value
  }

  /** Navigate, wait for load, and optionally poll an expression the page sets
   *  once its own boot has finished. */
  async function navigate(url, ready) {
    await cmd('Page.navigate', { url })
    await evaluate(`
      if (document.readyState !== 'complete')
        await new Promise(r => window.addEventListener('load', r, { once: true }));
      ${ready ? `await new Promise(r => { const t = setInterval(() => { if (${ready}) { clearInterval(t); r() } }, 10) });` : ''}
      return true;
    `)
  }

  /** Press a key through the input pipeline. A dispatched KeyboardEvent is not
   *  trusted and moves no focus and types no character. A printable key needs
   *  `text` — and must NOT also get a separate `char` event, which types
   *  everything twice and reads exactly like a control that cannot filter.
   *
   *  `text` also decides whether the browser runs a key's DEFAULT ACTION.
   *  Enter on a focused <button> is a click Chrome synthesizes from the
   *  character, so an Enter with no `text` moves through every listener and
   *  activates nothing — a control that ignores Enter and a harness that never
   *  pressed it look identical. That is why Enter carries `\r` in the table
   *  below rather than being treated as non-printable. */
  async function key(k, opts = {}) {
    const { code = k.length === 1 ? `Key${k.toUpperCase()}` : k, keyCode = 0, modifiers = 0, text } = opts
    const printable = k.length === 1 && modifiers === 0
    const chars = text ?? (printable ? k : null)
    const base = {
      key: k, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers,
      ...(chars !== null ? { text: chars, unmodifiedText: chars } : {}),
    }
    await cmd('Input.dispatchKeyEvent', { type: 'keyDown', ...base })
    await cmd('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
  }

  const KEYS = {
    Tab:        { code: 'Tab',        keyCode: 9 },
    Enter:      { code: 'Enter',      keyCode: 13, text: '\r' },
    Escape:     { code: 'Escape',     keyCode: 27 },
    ' ':        { code: 'Space',      keyCode: 32 },
    End:        { code: 'End',        keyCode: 35 },
    Home:       { code: 'Home',       keyCode: 36 },
    ArrowLeft:  { code: 'ArrowLeft',  keyCode: 37 },
    ArrowUp:    { code: 'ArrowUp',    keyCode: 38 },
    ArrowRight: { code: 'ArrowRight', keyCode: 39 },
    ArrowDown:  { code: 'ArrowDown',  keyCode: 40 },
    Backspace:  { code: 'Backspace',  keyCode: 8 },
  }

  const press = (k, modifiers = 0) => key(k, { ...(KEYS[k] ?? {}), modifiers })
  const type  = async (text) => { for (const ch of text) await key(ch) }

  /** A real click at an element's center, through the input pipeline.
   *
   *  `el.click()` is enough for a handler, and not enough for anything the
   *  browser itself decides: light-dismissing a `[popover]`, closing a
   *  `<dialog>` by its backdrop, or a `:focus-visible` that only a real
   *  pointer or key produces. */
  async function clickAt(selector) {
    const box = await evaluate(`
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error('clickAt: no element for ' + ${JSON.stringify(selector)});
      // A press is dispatched at viewport coordinates, so an element below the
      // fold is clicked at a point that is off-screen — the event lands on
      // whatever is at those coordinates, or nowhere, and the assertion
      // afterwards reads as a control that does nothing. The test is the POINT
      // this will press, not the element: a control straddling the bottom edge
      // has its top in view and its center past it, which is the whole of a
      // full-width field at the end of a long form. Scroll ONLY when that
      // point is out of view — a spec that has positioned the page
      // deliberately (a popover testing where it flips) must not have that
      // undone.
      let r = el.getBoundingClientRect();
      const at = () => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
      let p = at();
      if (p.x < 0 || p.x > innerWidth || p.y < 0 || p.y > innerHeight) {
        el.scrollIntoView({ block: 'center', inline: 'center' });
        await new Promise((res) => setTimeout(res, 50));
        r = el.getBoundingClientRect();
        p = at();
      }
      return p;
    `)
    for (const kind of ['mousePressed', 'mouseReleased'])
      await cmd('Input.dispatchMouseEvent', {
        type: kind, x: box.x, y: box.y, button: 'left', clickCount: 1,
        buttons: kind === 'mousePressed' ? 1 : 0,
      })
  }

  /** Open a SECOND page on the same browser, and answer a handle to it.
   *
   *  A relay between two tabs cannot be asked of one: `BroadcastChannel` is
   *  same-origin and cross-document by definition, so a single target can post
   *  and never receive its own message. The handle is deliberately small —
   *  evaluate, navigate, close — because a spec driving two pages at once
   *  wants the second one to be a fixture, not a second drive. Its errors are
   *  collected into the SAME array, so a throw in the other tab still fails
   *  the spec that opened it. */
  async function newPage(url = 'about:blank', ready) {
    const t2 = await send('Target.createTarget', { url: 'about:blank' })
    const s2 = await send('Target.attachToTarget', { targetId: t2.targetId, flatten: true })
    const cmd2 = (method, params) => send(method, params, s2.sessionId)
    await cmd2('Page.enable')
    await cmd2('Runtime.enable')
    if (bootstrap) await cmd2('Page.addScriptToEvaluateOnNewDocument', { source: bootstrap })

    const evaluate2 = async (expression) => {
      const r = await cmd2('Runtime.evaluate', {
        expression: `(async () => { ${expression} })()`,
        awaitPromise: true, returnByValue: true,
      })
      if (r.exceptionDetails)
        throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
      return r.result.value
    }

    const navigate2 = async (to, waitFor) => {
      await cmd2('Page.navigate', { url: to })
      await evaluate2(`
        if (document.readyState !== 'complete')
          await new Promise(r => window.addEventListener('load', r, { once: true }));
        ${waitFor ? `await new Promise(r => { const t = setInterval(() => { if (${waitFor}) { clearInterval(t); r() } }, 10) });` : ''}
        return true;
      `)
    }

    if (url !== 'about:blank') await navigate2(url, ready)

    return {
      evaluate: evaluate2,
      navigate: navigate2,
      close: () => send('Target.closeTarget', { targetId: t2.targetId }).catch(() => {}),
    }
  }

  async function close() {
    await cmd('Target.closeTarget', { targetId }).catch(() => {})
    chrome.kill()
    // Chrome is still flushing its profile when kill() returns, so removing
    // the directory straight away throws ENOTEMPTY — and threw it before the
    // report was printed, which turned every run into a stack trace with no
    // results.
    //
    // Waiting for 'exit' is not enough either, and the failure is the other
    // way round: the removal SUCCEEDS and Chrome's children, still winding
    // down, write the profile back. Measured — every drive run left a full
    // ~1MB profile behind for as long as this file has existed, 174 of them
    // and 1.8GB by the time anyone looked (FJS-361). The extra wait is after
    // the browser is already gone, so it costs one run 300ms, once.
    await new Promise((r) => { chrome.once('exit', r); setTimeout(r, 3000) })
    killHolders(entry)
    await new Promise((r) => setTimeout(r, 300))
    if (!entry.keep) try { rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }) } catch {}
    launched.delete(entry)
  }

  return { cmd, send, evaluate, navigate, newPage, key, press, type, clickAt, on, errors, close }
}

// ─── the network ──────────────────────────────────────────────────────
//
// An offline app makes claims about what it does with no server reachable, and
// every one of them is easy to prove against a stub and wrong in a stockroom. A
// `fetch` swapped for a throwing function drops no WebSocket, fails no request
// already in flight and survives no reconnect, which is where the defects are.
// So this is Chrome's own offline mode, the one the DevTools network panel
// switches.
//
// **The emulation does not close a socket that is already open.** New
// connections are refused and an existing one keeps carrying frames, so an app
// is still talking to its server while the page is told it is offline, and
// that reads green and means nothing. Going offline is therefore two things:
// the emulation, and severing the sockets the page opened, through a registry
// installed before the page's first script so the app's own socket is in it.
// Severing is harsher than a real outage, which leaves a socket that looks
// open and swallows a send; `withOffline(fn, { sever: false })` is that case.
//
// Vite's HMR socket is never severed: its client reloads the page when it
// closes, and with the network down the reload lands on
// ERR_INTERNET_DISCONNECTED and the app is gone mid-assertion. It is told apart
// by its SUBPROTOCOL, `vite-hmr`, not its origin — a dev server that proxies
// the API puts the app's socket on the page's origin too.
//
// The emulation is per TARGET: a page from `newPage()` stays on the network.
// A service worker has a network of its own and is not covered.

const OFFLINE = { offline: true,  latency: 0, downloadThroughput: 0,  uploadThroughput: 0 }
const ONLINE  = { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }

/** Network controls for a browser from `openChrome`. Call it BEFORE the first
 *  navigation, or the page's sockets are not in the registry and
 *  `goOffline()` answers null.
 *
 *    const net = await createNetwork(browser)
 *    await net.withOffline(async () => { … })   // restored even on a throw */
export async function createNetwork(browser) {
  const { cmd, evaluate } = browser
  await cmd('Network.enable')

  // How many sockets the last going-offline cut: the difference between the
  // app's connection being down and the page never having had one. Without it
  // waitOnline waits out its budget on a page that opens no socket at all.
  let lastSevered = 0

  // A Proxy rather than a subclass, so `instanceof WebSocket` and the static
  // constants still read through.
  await cmd('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      (() => {
        const Native = WebSocket
        const open = new Set()
        globalThis.__fjsSockets = open
        globalThis.WebSocket = new Proxy(Native, {
          construct(target, args) {
            const sock = new target(...args)
            sock.__fjsVite = [].concat(args[1] ?? []).includes('vite-hmr')
            open.add(sock)
            sock.addEventListener('close', () => open.delete(sock))
            return sock
          },
        })
      })()
    `,
  })

  const emulate = (conditions) => cmd('Network.emulateNetworkConditions', conditions)

  /** Close the sockets the app opened; null when the page has no registry. */
  const severSockets = () => evaluate(`
    const open = globalThis.__fjsSockets
    if (!open) return { n: null }
    let n = 0
    for (const s of [...open]) {
      if (s.__fjsVite) continue
      if (s.readyState === 0 || s.readyState === 1) { n++; s.close(4000, 'drive: offline') }
      open.delete(s)
    }
    return { n }
  `).then((r) => r.n)

  /** Is the app's socket back? Asked of the registry, not of anything the app
   *  renders: a status attribute is an app's choice and most do not make it,
   *  so a wait on one silently never waits. Null is a page with no socket. */
  const socketUp = () => evaluate(`
    const open = globalThis.__fjsSockets
    if (!open) return { up: null }
    let any = false
    for (const s of open) {
      if (s.__fjsVite) continue
      any = true
      if (s.readyState === 1) return { up: true }
    }
    return { up: any ? false : null }
  `).then((r) => r.up)

  /** Wait for the network, and by default for the app's socket to come back
   *  with it. They are not the same moment: the gap is the client's reconnect
   *  backoff, and a drive that asserts the instant goOnline() resolves is
   *  asking a client that is still down. */
  async function waitOnline({ tries = 120, socket = true } = {}) {
    // Nothing was cut, so there is no reconnect to wait for. A page that opens
    // its socket lazily is the ordinary case, not a failure.
    const wantSocket = socket && lastSevered > 0
    for (let i = 0; i < tries; i++) {
      if (await evaluate('return navigator.onLine')) {
        if (!wantSocket) return true
        const up = await socketUp()
        if (up === null || up === true) return true
      }
      await new Promise((r) => setTimeout(r, 250))
    }
    return false
  }

  return {
    /** Refuse new connections and close the page's open sockets. Answers how
     *  many it severed, or null when the page loaded before the registry. */
    async goOffline() {
      await emulate(OFFLINE)
      const n = await severSockets()
      lastSevered = n ?? 0
      return n
    },

    /** The page can reach the network again; its socket may not be back yet. */
    goOnline: () => emulate(ONLINE),

    waitOnline,

    /** How many sockets the last going-offline cut. */
    get severed() { return lastSevered },

    /** Run `fn` with the network down and put it back whatever happens — a
     *  failed assertion inside would otherwise leave every later one running
     *  against a dead network. `sever: false` leaves the app's socket open,
     *  which is a real outage's first seconds, before the peer has noticed. */
    async withOffline(fn, { sever = true } = {}) {
      await emulate(OFFLINE)
      lastSevered = sever ? ((await severSockets()) ?? 0) : 0
      try { return await fn() }
      finally { await emulate(ONLINE) }
    },
  }
}
