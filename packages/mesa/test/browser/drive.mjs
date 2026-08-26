/*
 * drive.mjs — a real Chrome, driven over CDP, and the spec runner on top of it.
 *
 * This is the harness half of a browser drive: launching Chrome, speaking the
 * protocol, sending INPUT the browser trusts, loading `*.spec.mjs` files and
 * printing the report. It knows nothing about what is being tested — the
 * caller brings an origin to navigate to and whatever extra members its specs
 * need on `t`.
 *
 * It lives in mesa because mesa is the leaf: `@frontierjs/ui` already reads
 * this package by relative path (a workspace dep resolves to a COPY under
 * `node_modules/.bun/`, so a by-name import would drive a snapshot taken at
 * install time), and a second drive elsewhere reads it the same way. One CDP
 * client, so a trap learned in one drive is fixed for both.
 *
 * ── Why CDP and not --dump-dom ────────────────────────────────────────
 *
 * `@frontierjs/css` drives Chrome with `--dump-dom`, which is right for a
 * package whose every claim is a computed style. Half of what a component or a
 * dev server is asked here is a response to INPUT, and a dispatched
 * `KeyboardEvent` is not trusted: it will not move focus, will not type a
 * character and will not dismiss a `[popover]`. Those are the paths most
 * likely to be broken, so input has to come through the browser's own
 * pipeline. The protocol is spoken over the global `WebSocket`, so this adds
 * no dependency.
 *
 * ── Harness rules, paid for once ──────────────────────────────────────
 *
 * Never return a bare `null` from a probe — CDP omits `value` and it reads
 * back as `undefined`; wrap it in an object. Never start an evaluated
 * expression with `return` on its own line — ASI turns it into `return;`.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, readdirSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'

const CHROME = process.env.FJS_CHROME ?? 'google-chrome'

export const green = (s) => `\x1b[32m${s}\x1b[0m`
export const red   = (s) => `\x1b[31m${s}\x1b[0m`
export const dim   = (s) => `\x1b[2m${s}\x1b[0m`

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

/** Chrome processes this run launched, with the profile each one holds. */
const launched = new Set()
let sweepInstalled = false

/** Block the thread. An exit handler cannot await, and the wait below is not
 *  optional — see sweepLaunched(). */
function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }

function sweepLaunched() {
  if (!launched.size) return
  for (const entry of launched) {
    try { entry.chrome.kill('SIGKILL') } catch { /* already gone */ }
  }
  // Every browser dies BEFORE any profile is removed, and then the thread
  // waits. Removing straight after the kill does not fail — it SUCCEEDS, and
  // Chrome, still shutting down, writes the directory back: measured, a
  // profile removed at 0ms was on disk again 1.5s later with Default/ in it
  // and 16MB, while 200ms was already enough for it to stay gone. `maxRetries`
  // cannot cover that, because the removal is not what fails.
  sleepSync(300)
  for (const entry of launched) {
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

/** Launch Chrome, attach to one page, and answer everything a spec needs to
 *  reach it. The caller closes it.
 *
 *  `errors` is a live array — anything the page threw or reported since it was
 *  last emptied. A component that throws while rendering still leaves a
 *  partial tree, so a spec asserting on what IS there passes over the top of
 *  it; the drive reads this after every spec. */
export async function openChrome({ windowSize = '1280,900', bootstrap } = {}) {
  installSweep()
  reapStaleProfiles()
  const profile = mkdtempSync(join(tmpdir(), PROFILE_PREFIX))
  const chrome  = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    `--window-size=${windowSize}`,
    // Specs read colour and geometry; a non-sRGB profile or a scrollbar taking
    // width makes a hit test land on the wrong element.
    '--force-color-profile=srgb', '--hide-scrollbars',
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] })

  const entry = { chrome, profile }
  launched.add(entry)

  chrome.on('error', (e) => {
    console.error(`Could not launch ${CHROME}: ${e.message}\n` +
      `Install Chrome or Chromium, or point $FJS_CHROME at a binary.`)
    process.exit(2)
  })

  const wsUrl = await new Promise((resolve, reject) => {
    let buf = ''
    const timer = setTimeout(() => reject(new Error('Chrome never announced a DevTools port')), 15000)
    chrome.stderr.on('data', (d) => {
      buf += d
      const m = buf.match(/ws:\/\/[^\s]+/)
      if (m) { clearTimeout(timer); resolve(m[0]) }
    })
  }).catch((e) => { console.error(e.message); process.exit(2) })

  const browser = new WebSocket(wsUrl)
  await new Promise((r) => browser.addEventListener('open', r, { once: true }))

  let nextId = 1
  const pending = new Map()

  function send(method, params = {}, sessionId) {
    const id = nextId++
    browser.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      setTimeout(() => pending.has(id) && reject(new Error(`${method} timed out`)), 30000)
    })
  }

  const errors = []

  browser.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
      return
    }
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
   *  Enter on a focused <button> is a click Chrome synthesises from the
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

  /** A real click at an element's centre, through the input pipeline.
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
      // has its top in view and its centre past it, which is the whole of a
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
    await new Promise((r) => setTimeout(r, 300))
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }) } catch {}
    launched.delete(entry)
  }

  return { cmd, evaluate, navigate, newPage, key, press, type, clickAt, errors, close }
}

// ─── the spec runner ──────────────────────────────────────────────────

/** What every spec is handed, before the caller extends it. `rows` is the
 *  spec's own result list; `allowed` collects the page errors this spec has
 *  said it is provoking. */
function baseAssertions(rows, browser, allowed) {
  return {
    evaluate: browser.evaluate,
    /** Expect a page error matching `re` rather than failing on it.
     *
     *  A spec that provokes a diagnostic on purpose — a duplicate `{#each}`
     *  key, a component that will not compile — is asserting the thing the
     *  drive otherwise treats as a failure. Stating the pattern is not the
     *  same as muting the channel: anything else the page reports still
     *  fails, which is the difference between an allowance and a silence. */
    allow: (re) => allowed.push(re),
    press:    browser.press,
    type:     browser.type,
    key:      browser.key,
    clickAt:  browser.clickAt,
    ok:  (v, label) => rows.push({ name: label, ok: !!v, detail: `got ${JSON.stringify(v)}` }),
    /** Assert on a value that is REACHED rather than one already there. Mesa
     *  flushes its effects on a microtask, so the DOM behind a state change
     *  lands after the round trip that caused it: a plain read straight after
     *  a click sees the previous value and reports a working component as
     *  broken. Polls up to 2s and returns early.
     *
     *  `ms` is for a round trip that is not a microtask. A file-watch → compile
     *  → socket → re-render is seconds, not milliseconds, and measurably so:
     *  the second write to one file arrived ~4.5s after it was made. Waiting
     *  the default there reports working HMR as an update that never came. */
    eventually: async (expr, expected, label, ms = 2000) => {
      const want = String(expected)
      const actual = await browser.evaluate(`
        const t0 = Date.now();
        let v;
        for (;;) {
          v = (${expr});
          if (String(v) === ${JSON.stringify(want)} || Date.now() - t0 > ${Number(ms)}) break;
          await new Promise(r => setTimeout(r, 20));
        }
        return { v };
      `)
      rows.push({
        name: label, ok: String(actual.v) === want,
        detail: `expected ${JSON.stringify(want)}, got ${JSON.stringify(actual.v)}`,
      })
    },
    is: (actual, expected, label) => rows.push({
      name: label, ok: Object.is(actual, expected),
      detail: `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    }),
    match: (actual, re, label) => rows.push({
      name: label, ok: re.test(String(actual ?? '')),
      detail: `expected ${re} to match ${JSON.stringify(actual)}`,
    }),
  }
}

/** Run every `*.spec.mjs` under `specDir` against a page at `origin`.
 *
 *  Returns `{ results, infra, failures }` and prints the report. The caller
 *  owns the server, the exit code and anything it wants printed alongside.
 *
 *    origin    — navigated to once, before the first spec
 *    ready     — an expression the page sets when its own boot has finished
 *    extend    — `(browser) => ({ … })`, extra members on `t`
 *    teardown  — run after each spec, BEFORE its errors are read: a teardown
 *                that throws is a real defect and belongs to the spec that
 *                caused it. An expression string is evaluated in the page; a
 *                function is called with the browser, for a drive that has to
 *                put something back on disk as well
 *    coverage  — `{ all, show, noun }`, checked against each spec's `covers`
 *    notes     — `() => string[]`, printed under the spec rows
 *    bootstrap — script run before anything else in every document, for a
 *                drive over a page it does not own */
export async function runSpecs({
  origin, specDir, filters = [], verbose = false,
  ready, extend, teardown, coverage, notes, windowSize, bootstrap,
}) {
  let specFiles = existsSync(specDir)
    ? readdirSync(specDir).filter((f) => f.endsWith('.spec.mjs')).sort()
    : []

  if (filters.length)
    specFiles = specFiles.filter((f) => filters.some((x) => f.includes(x)))

  if (!specFiles.length) {
    console.error(filters.length ? `No spec matches: ${filters.join(', ')}` : 'No specs found.')
    return { results: [], infra: 1, failures: 1 }
  }

  const browser = await openChrome({ windowSize, bootstrap })

  await browser.navigate(origin, ready).catch((e) => {
    console.error(`The page never booted: ${e.message}`)
    process.exit(2)
  })

  const results = []          // { spec, name, ok, detail }
  const covered = new Set()
  let infra = 0

  for (const file of specFiles) {
    const mod = await import(join(specDir, file))
    const specName = mod.name ?? basename(file, '.spec.mjs')
    const rows = []
    const allowed = []
    const t = { ...baseAssertions(rows, browser, allowed), ...(extend?.(browser) ?? {}) }

    browser.errors.length = 0
    try {
      await mod.run(t)
    } catch (err) {
      rows.push({ name: 'spec threw', ok: false, detail: String(err.message ?? err) })
      infra++
    }
    if (typeof teardown === 'function') {
      try { await teardown(browser) } catch (err) {
        rows.push({ name: 'teardown threw', ok: false, detail: String(err.message ?? err) })
      }
    } else if (teardown) {
      await browser.evaluate(teardown).catch(() => {})
    }
    for (const e of browser.errors) {
      if (allowed.some((re) => re.test(e))) continue
      rows.push({ name: 'the page reported an error', ok: false, detail: e })
    }

    for (const c of mod.covers ?? []) covered.add(c)
    for (const r of rows) results.push({ spec: specName, ...r })
  }

  await browser.close()

  // ─── report ─────────────────────────────────────────────────────────

  const bySpec = new Map()
  for (const r of results) {
    if (!bySpec.has(r.spec)) bySpec.set(r.spec, [])
    bySpec.get(r.spec).push(r)
  }

  console.log('')
  for (const [spec, rows] of bySpec) {
    const bad = rows.filter((r) => !r.ok).length
    console.log(`${bad ? red('✗') : green('✓')} ${spec} ${dim(`(${rows.length - bad}/${rows.length})`)}`)
    for (const r of rows) {
      if (!r.ok) console.log(`    ${red('✗')} ${r.name}\n      ${r.detail}`)
      // `--verbose` prints the passes too. Worth having: a spec that THROWS
      // half way reports one failure and no clue which step it reached, and
      // the rows are the only record of how far it got.
      else if (verbose) console.log(`    ${green('✓')} ${dim(r.name)}`)
    }
  }

  for (const line of notes?.() ?? []) console.log(`${dim('!')} ${line}`)

  let unknown = []
  if (coverage) {
    // Coverage is the point of the exercise, so it is reported every run
    // rather than being a number kept by hand in a status file.
    const all = coverage.all
    unknown = [...covered].filter((c) => !all.includes(c))
    const gap = all.filter((c) => !covered.has(c))

    console.log('')
    console.log(`${all.length - gap.length}/${all.length} ${coverage.noun ?? 'cases'} opened in a browser by this drive`)
    if (coverage.show && gap.length) console.log(dim('not yet: ' + gap.join(', ')))
    for (const u of unknown)
      console.log(red(`✗ a spec claims to cover "${u}" — no such entry`))
  }

  const failures = results.filter((r) => !r.ok).length + unknown.length
  console.log(failures
    ? red(`${failures} failing`) + dim(`, ${results.length - failures + unknown.length} passing`)
    : green(`${results.length} passing`))
  console.log('')

  return { results, infra, failures }
}
