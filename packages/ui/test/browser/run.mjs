/*
 * run.mjs — the kit drive.
 *
 *   node test/browser/run.mjs                 every spec
 *   node test/browser/run.mjs datepicker      specs whose filename matches
 *   node test/browser/run.mjs --coverage      also list what no spec opens
 *   node test/browser/run.mjs --serve         serve the kit and stay up
 *
 * Needs Chrome on PATH or `$FJS_CHROME`.
 *
 * ── What this exists to reach ─────────────────────────────────────────
 *
 * `compile-all` proves a component emits parseable JS, `render` proves it
 * produces DOM, `attributes` proves the caller's attributes land. None of the
 * three runs a browser, so none of them can see the thing this kit exists to
 * add over `@frontierjs/css`: a roving tablist, a focus trap, a calendar that
 * changes month, a dropzone that accepts a file. `FJS-028` is the register
 * entry — 35 of 64 components had never been opened in a browser at all, and
 * what that cost was measured: `DatePicker` could not render AT ALL for as
 * long as it existed, and compiled cleanly the whole time.
 *
 * The drive that existed before this one lives in `example/`, and covering a
 * component there means first putting it on a real application screen. That
 * friction is why the long tail stayed dark. This one mounts the component
 * directly, so the cost of covering one is a fixture and a spec.
 *
 * ── Why CDP and not --dump-dom ────────────────────────────────────────
 *
 * `@frontierjs/css` drives Chrome with `--dump-dom`, which is right for a
 * package whose every claim is a computed style. Half of what is asserted here
 * is a response to INPUT, and a dispatched `KeyboardEvent` is not trusted: it
 * will not move focus, will not type into a field, and will not dismiss a
 * `[popover]`. Those are the paths most likely to be broken, so the input has
 * to come through the browser's own pipeline. The protocol is spoken over the
 * global `WebSocket`, so this adds no dependency either.
 *
 * ── Harness rules, learned in the other drive ─────────────────────────
 *
 * Never return a bare `null` from a probe — CDP omits `value` and it reads
 * back as `undefined`; wrap it in an object. Never start an evaluated
 * expression with `return` on its own line — ASI turns it into `return;`.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createKitServer } from './server.mjs'

const HERE   = fileURLToPath(new URL('.', import.meta.url))
const PKG    = fileURLToPath(new URL('../..', import.meta.url))
const CHROME = process.env.FJS_CHROME ?? 'google-chrome'

const argv     = process.argv.slice(2)
const serveOnly = argv.includes('--serve')
const showGap   = argv.includes('--coverage')
const verbose   = argv.includes('--verbose')
const filters   = argv.filter((a) => !a.startsWith('--'))

const green = (s) => `\x1b[32m${s}\x1b[0m`
const red   = (s) => `\x1b[31m${s}\x1b[0m`
const dim   = (s) => `\x1b[2m${s}\x1b[0m`

/* ─── the kit, served ─────────────────────────────────────────────────── */

const compileWarnings = []
const kit = createKitServer({ onWarning: (f, w) => compileWarnings.push([f, w]) })
const origin = await kit.listen()

if (serveOnly) {
  console.log(`kit served at ${origin}`)
  console.log(dim('fixtures are at /kit/test/browser/fixtures/<name>.mesa'))
} else {
  await drive()
}

/* ─── the drive ───────────────────────────────────────────────────────── */

async function drive() {
  const specDir = join(HERE, 'specs')
  let specFiles = existsSync(specDir)
    ? readdirSync(specDir).filter((f) => f.endsWith('.spec.mjs')).sort()
    : []

  if (filters.length)
    specFiles = specFiles.filter((f) => filters.some((x) => f.includes(x)))

  if (!specFiles.length) {
    console.error(filters.length ? `No spec matches: ${filters.join(', ')}` : 'No specs found.')
    await kit.close()
    process.exit(2)
  }

  const profile = mkdtempSync(join(tmpdir(), 'fjs-ui-drive-'))
  const chrome  = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--window-size=1280,900',
    // The tests read colour and geometry; a non-sRGB profile or a scrollbar
    // taking width makes a hit-test land on the wrong element.
    '--force-color-profile=srgb', '--hide-scrollbars',
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] })

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

  // Anything the page threw or logged as an error, since the last reset. A
  // component that throws while rendering still leaves a partial tree, so a
  // spec asserting on what IS there can pass over the top of it.
  let pageErrors = []

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
      pageErrors.push('exception: ' + (d?.exception?.description ?? d?.text))
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error')
      pageErrors.push('console.error: ' + msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '))
  })

  const { targetId }  = await send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
  const cmd = (method, params) => send(method, params, sessionId)

  await cmd('Page.enable')
  await cmd('Runtime.enable')

  async function evaluate(expression) {
    const r = await cmd('Runtime.evaluate', {
      expression: `(async () => { ${expression} })()`,
      awaitPromise: true, returnByValue: true,
    })
    if (r.exceptionDetails)
      throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
    return r.result.value
  }

  await cmd('Page.navigate', { url: origin + '/' })
  await evaluate(`
    if (document.readyState !== 'complete')
      await new Promise(r => window.addEventListener('load', r, { once: true }));
    await new Promise(r => { const t = setInterval(() => { if (window.__kitReady) { clearInterval(t); r() } }, 10) });
    return true;
  `).catch((e) => {
    console.error(`The kit page never booted: ${e.message}`)
    process.exit(2)
  })

  /* ─── what a spec is handed ─────────────────────────────────────────── */

  /** Press a key through the input pipeline. A dispatched KeyboardEvent is not
   *  trusted and moves no focus and types no character. A printable key needs
   *  `text` — and must NOT also get a separate `char` event, which types
   *  everything twice and reads exactly like a component that cannot filter.
   *
   *  `text` also decides whether the browser runs a key's DEFAULT ACTION.
   *  Enter on a focused <button> is a click Chrome synthesises from the
   *  character, so an Enter with no `text` moves through every listener and
   *  activates nothing — a menu item that ignores Enter and a harness that
   *  never pressed it look identical. That is why Enter carries `\r` in the
   *  table below rather than being treated as non-printable. */
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
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    `)
    for (const type of ['mousePressed', 'mouseReleased'])
      await cmd('Input.dispatchMouseEvent', {
        type, x: box.x, y: box.y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0,
      })
  }

  /* ─── run ───────────────────────────────────────────────────────────── */

  const results = []          // { spec, name, ok, detail }
  const covered = new Set()
  let infra = 0

  for (const file of specFiles) {
    const mod = await import(join(specDir, file))
    const specName = mod.name ?? basename(file, '.spec.mjs')
    const rows = []

    const t = {
      evaluate, press, type, key, clickAt,
      /** Mount a fixture by name — `fixtures/<name>.mesa`. */
      mount: (fixture, props = {}) => evaluate(
        `return await window.kitMount(${JSON.stringify(`/kit/test/browser/fixtures/${fixture}.mesa`)}, ${JSON.stringify(props)});`
      ),
      ok:  (v, label) => rows.push({ name: label, ok: !!v, detail: `got ${JSON.stringify(v)}` }),
      /** Assert on a value that is REACHED rather than one that is already
       *  there. Mesa flushes its effects on a microtask, so the DOM text
       *  behind a state change lands after the round trip that caused it: a
       *  plain read straight after a click sees the previous value and reports
       *  a working component as broken. Polls up to 2s and returns early. */
      eventually: async (expr, expected, label) => {
        const want = String(expected)
        const actual = await evaluate(`
          const t0 = Date.now();
          let v;
          for (;;) {
            v = (${expr});
            if (String(v) === ${JSON.stringify(want)} || Date.now() - t0 > 2000) break;
            await new Promise(r => setTimeout(r, 20));
          }
          return { v };
        `)
        rows.push({
          name: label, ok: String(actual.v) === want,
          detail: `expected ${JSON.stringify(want)}, got ${JSON.stringify(actual.v)}`,
        })
      },
      is:  (actual, expected, label) => rows.push({
        name: label, ok: Object.is(actual, expected),
        detail: `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
      }),
      match: (actual, re, label) => rows.push({
        name: label, ok: re.test(String(actual ?? '')),
        detail: `expected ${re} to match ${JSON.stringify(actual)}`,
      }),
    }

    pageErrors = []
    try {
      await mod.run(t)
    } catch (err) {
      rows.push({ name: 'spec threw', ok: false, detail: String(err.message ?? err) })
      infra++
    }
    // Unmount before reading errors: a teardown that throws is a real defect
    // and belongs to the spec that caused it.
    await evaluate('return window.kitUnmount();').catch(() => {})
    for (const e of pageErrors)
      rows.push({ name: 'the page reported an error', ok: false, detail: e })

    for (const c of mod.covers ?? []) covered.add(c)
    for (const r of rows) results.push({ spec: specName, ...r })
  }

  await cmd('Target.closeTarget', { targetId }).catch(() => {})
  chrome.kill()
  // Chrome is still flushing its profile when kill() returns, so removing the
  // directory straight away throws ENOTEMPTY — and threw it before the report
  // was printed, which turned every run into a stack trace with no results.
  await new Promise((r) => { chrome.once('exit', r); setTimeout(r, 3000) })
  try { rmSync(profile, { recursive: true, force: true }) } catch {}
  await kit.close()

  /* ─── report ────────────────────────────────────────────────────────── */

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

  for (const [file, w] of compileWarnings) console.log(`${dim('!')} ${file.replace(PKG, '')} — ${w}`)

  // Coverage is the point of the exercise, so it is reported every run rather
  // than being a number kept by hand in a status file.
  const all = componentNames()
  const unknown = [...covered].filter((c) => !all.includes(c))
  const gap = all.filter((c) => !covered.has(c))

  console.log('')
  console.log(`${all.length - gap.length}/${all.length} components opened in a browser by this drive`)
  if (showGap && gap.length) console.log(dim('not yet: ' + gap.join(', ')))
  for (const u of unknown)
    console.log(red(`✗ a spec claims to cover "${u}" — no such component file`))

  const failures = results.filter((r) => !r.ok).length + unknown.length
  console.log(failures
    ? red(`${failures} failing`) + dim(`, ${results.length - failures + unknown.length} passing`)
    : green(`${results.length} passing`))
  console.log('')

  process.exit(failures || infra ? 1 : 0)
}

/** Every component in the kit, as `<tier>/<Name>` — the same key a spec's
 *  `covers` list uses. Derived from the tree so a new component is uncovered
 *  the moment it is added, rather than when someone remembers to say so. */
function componentNames() {
  const out = []
  for (const tier of readdirSync(join(PKG, 'components'))) {
    for (const f of readdirSync(join(PKG, 'components', tier)))
      if (f.endsWith('.mesa')) out.push(`${tier}/${basename(f, '.mesa')}`)
  }
  return out.sort()
}
