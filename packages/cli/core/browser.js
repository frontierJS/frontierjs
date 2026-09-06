// ─── browser.js — a page, opened, for something to be asked of it ────────────
//
// The tutorial teaches Data, API and Deployment by asking the running world.
// The UI realm had no way to be asked at all: every assertion in every lesson
// is HTTP or a file, so a person finishes the course having never seen a form
// render. This is what lets a lesson open one.
//
// ── Why this is not mesa's harness ───────────────────────────────────────────
//
// `packages/mesa/test/browser/drive.mjs` drives Chrome for this repo's own
// drives, and it is a SPEC RUNNER — specs, filtering, reporting, a bootstrap
// injected before the page's own scripts. Two things make it the wrong thing to
// reach for here. It is not published (`files:` is `src` and `mesa-vite`), so an
// app that installed the framework has no harness at any path; and what a probe
// needs is one question and one answer, not a run.
//
// So this is deliberately small: launch, navigate, evaluate, close. Everything
// a lesson asserts goes through `page.eval(expr)` and comes back as JSON.
//
// ── The traps, all of which cost somebody a day in the other harness ─────────
//
// `--remote-debugging-port=0` and the URL read off stderr, because a fixed 9222
// is taken by the developer's own Chrome and attaching to it would drive their
// real profile. A temp profile per launch, swept on exit and on a signal, or a
// killed lesson leaves a headless Chrome and a directory behind. And the page's
// exceptions are COLLECTED: a component that throws while rendering still
// leaves a partial tree, so an assertion about what is on the page passes over
// the top of a broken render unless somebody looks.

import { spawn, spawnSync }                        from 'child_process'
import { mkdtempSync, rmSync, existsSync }         from 'fs'
import { tmpdir }                                  from 'os'
import { join }                                    from 'path'

const PROFILE_PREFIX = 'fli-page-'

// The same variable every drive in this repo reads, so a machine that has been
// told once has been told for everything.
const CANDIDATES = [
  'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
]

// `command -v` synchronously: every caller is inside a probe, and a probe
// answers rather than awaits. Injectable, so a test can drive both answers
// without depending on what is installed on the machine running it.
function whichSync(bin) {
  try { return spawnSync('sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' }).status === 0 }
  catch { return false }
}

/** The binary, or null. A lesson SKIPS by name rather than failing when this is
 *  null: no Chrome is a fact about the machine, not about the app.
 *
 *  `$FJS_CHROME` is AUTHORITATIVE rather than preferred. Somebody who names a
 *  binary names it for a reason — a specific build, a specific version — and
 *  falling through to whatever else is installed answers a different question
 *  than the one they asked, silently. So a variable pointing at nothing is null
 *  here, and the caller says which variable. */
export function findChrome({ run = whichSync, exists = existsSync, candidates = CANDIDATES, env = process.env } = {}) {
  const named = env.FJS_CHROME
  if (named) return (named.includes('/') ? exists(named) : run(named)) ? named : null

  for (const c of candidates) {
    if (c.includes('/')) { if (exists(c)) return c; continue }
    if (run(c)) return c
  }
  return null
}

const live = new Set()
let sweeping = false

function sweep() {
  for (const e of live) {
    try { e.chrome.kill('SIGKILL') } catch {}
    try { rmSync(e.profile, { recursive: true, force: true }) } catch {}
  }
  live.clear()
}

function installSweep() {
  if (sweeping) return
  sweeping = true
  process.on('exit', sweep)
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'])
    process.on(sig, () => { sweep(); process.exit(sig === 'SIGINT' ? 130 : 143) })
}

/**
 * Open one page and hand back what a probe needs.
 *
 *   eval(expr)   evaluate in the page, awaited, answered as JSON
 *   errors       everything the page threw or logged as an error, live
 *   close()      stop Chrome and remove the profile
 *
 * Throws with a sentence naming the fix when there is no Chrome — callers that
 * would rather skip ask `findChrome()` first.
 */
export async function openPage({ url, chrome: bin, windowSize = '1280,900', timeoutMs = 30000 } = {}) {
  const exe = bin ?? findChrome()
  if (!exe)
    throw new Error(process.env.FJS_CHROME
      ? `$FJS_CHROME names ${process.env.FJS_CHROME} and there is no such binary`
      : 'no Chrome on this machine — install Chrome or Chromium, or point $FJS_CHROME at a binary')

  installSweep()
  const profile = mkdtempSync(join(tmpdir(), PROFILE_PREFIX))
  const chrome  = spawn(exe, [
    '--headless=new', '--disable-gpu', '--no-sandbox',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    `--window-size=${windowSize}`,
    '--force-color-profile=srgb', '--hide-scrollbars',
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] })

  const entry = { chrome, profile }
  live.add(entry)

  const cleanup = () => {
    live.delete(entry)
    try { chrome.kill('SIGKILL') } catch {}
    try { rmSync(profile, { recursive: true, force: true }) } catch {}
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
  }).catch((e) => { cleanup(); throw e })

  const sock = new WebSocket(wsUrl)
  await new Promise((resolve, reject) => {
    sock.addEventListener('open',  resolve, { once: true })
    sock.addEventListener('error', () => reject(new Error('could not attach to Chrome')), { once: true })
  }).catch((e) => { cleanup(); throw e })

  let nextId    = 1
  const pending = new Map()
  const errors  = []

  const send = (method, params = {}, sessionId) => {
    const id = nextId++
    sock.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      setTimeout(() => pending.has(id) && (pending.delete(id), reject(new Error(`${method} timed out`))), timeoutMs)
    })
  }

  sock.addEventListener('message', (ev) => {
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
    if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type))
      errors.push(`console.${msg.params.type}: ` +
        msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '))
  })

  // One tab, and a session on it. Every later call carries the session id.
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })

  await send('Page.enable', {}, sessionId)
  await send('Runtime.enable', {}, sessionId)

  const page = {
    errors,
    async goto(to) {
      await send('Page.navigate', { url: to }, sessionId)
      await page.eval('new Promise(r => document.readyState === "complete" ? r(1) : addEventListener("load", () => r(1)))')
    },
    /** Evaluate in the page and answer the VALUE. Awaited and returned by value,
     *  so a probe writes `await page.eval('document.querySelectorAll("input").length')`
     *  and gets a number rather than a remote object handle. */
    async eval(expr) {
      // A navigation destroys the execution context, and a form flow navigates
      // by design — a sign-in, a save that goes to the record it just made. The
      // evaluate that lands in that window fails about the CONTEXT rather than
      // about the page, which reads to a caller as the assertion being wrong.
      // Retried once, and only for that: any other throw is the page's.
      for (let attempt = 0; ; attempt++) {
        try {
          const r = await send('Runtime.evaluate', {
            expression: `(async () => (${expr}))()`,
            awaitPromise: true, returnByValue: true,
          }, sessionId)
          if (r.exceptionDetails)
            throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
          return r.result?.value
        } catch (e) {
          const stale = /navigated or closed|context was destroyed|Cannot find context/i.test(e.message)
          if (!stale || attempt > 0) throw e
          await new Promise(r => setTimeout(r, 300))
        }
      }
    },
    close() { try { sock.close() } catch {} ; cleanup() },
  }

  if (url) await page.goto(url)
  return page
}
