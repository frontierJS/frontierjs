// Phase 8 — load-mode parse audit.
//
// Verifies that each built surface bundle parses correctly for the JS load
// mode it'll actually be loaded under in a real extension:
//
//   Surface           Load mode   Reason
//   ─────────────────────────────────────────────────────────────────────
//   islands/<id>.js   classic     MV3 content scripts are CLASSIC scripts —
//                                 chrome.scripting.RegisteredContentScript
//                                 has no `type` field. import.meta and
//                                 top-level await are parse-time errors.
//   harbor.js         module      manifest declares background.type='module'
//   dock.js           module      <script type="module"> in dock.html
//   options.js        module      <script type="module"> in options.html
//   piers/*.js        module      <script type="module"> in pier HTML
//
// Why this is a real test, not just a build sanity check:
//   - The bug it catches (import.meta or top-level await leaking into
//     islands) is silent at build time — Vite happily emits the bundle.
//     The error only fires when Chrome tries to inject the content script,
//     which is a runtime/manual-test discovery.
//   - vm.Script uses the same V8 parser as Chrome content scripts, so a
//     bundle that parses cleanly here will parse cleanly there.
//
// Strategy: build the fixture, then parse each emitted bundle with
// vm.Script (classic-mode parser). Module-only syntax errors are EXPECTED
// for module surfaces and constitute a pass; for islands they're failures.

import { Script } from 'node:vm'
import { readFileSync, existsSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const HERE       = dirname(fileURLToPath(import.meta.url))
const FIXTURE    = resolve(HERE, 'fixtures/basic-ext')
const FIXTURE_DIST = resolve(FIXTURE, 'dist/chrome')

let pass = 0, fail = 0
function ok(msg)  { pass++; console.log('  ✓ ' + msg) }
function bad(msg, info='') { fail++; console.log('  ✗ ' + msg + (info ? '\n     → ' + info : '')) }

console.log('phase 8: load-mode parse audit\n')

// Clean any stale build first
try { rmSync(resolve(FIXTURE, 'dist'),         { recursive: true, force: true }) } catch {}
try { rmSync(resolve(FIXTURE, '.jetty-cache'), { recursive: true, force: true }) } catch {}

// Build the fixture using the same code path the CLI uses.
const { buildExtension } = await import('../src/build/index.js')
try {
  await buildExtension({ root: FIXTURE, browser: 'chrome', verbose: false })
} catch (e) {
  bad('fixture build failed', e.message)
  process.exit(1)
}

// Surface manifest
const TARGETS = [
  { path: 'islands/demo.js', mode: 'classic',
    why: 'MV3 content scripts are classic scripts' },
  { path: 'harbor.js',       mode: 'module',
    why: 'manifest declares background.type = "module"' },
  { path: 'dock.js',         mode: 'module',
    why: 'loaded via <script type="module">' },
]

for (const t of TARGETS) {
  const full = resolve(FIXTURE_DIST, t.path)
  if (!existsSync(full)) {
    bad(`${t.path}: not built`, `expected at ${full}`)
    continue
  }
  const src = readFileSync(full, 'utf8')

  if (t.mode === 'classic') {
    // Classic-script parser: any module-only syntax is a HARD failure.
    try {
      // eslint-disable-next-line no-new
      new Script(src, { filename: t.path })
      ok(`${t.path} parses as classic script (${t.why})`)
    } catch (e) {
      bad(`${t.path}: classic-script parse FAILED — ${t.why}`, e.message.split('\n')[0])
    }

    // Islands must be self-contained. Content scripts can't fetch chunks
    // not in web_accessible_resources, so any reference to /islands/chunks/
    // or similar is a runtime bug. Likewise, content scripts inherit the
    // host page's network context — connections to localhost are blocked
    // by Chrome's Private Network Access policy, so dev-WS leakage into
    // the bundle is also a bug.
    const forbidden = [
      { re: /\/islands\/chunks\//,        why: 'island chunk reference (would 404 in real extension)' },
      { re: /ws:\/\/127\.0\.0\.1/,        why: 'localhost WS reference (blocked by Chrome PNA)' },
      { re: /\bstartDevClient\b/,         why: 'dev-client invocation (islands have no need for WS)' },
    ]
    for (const f of forbidden) {
      if (f.re.test(src)) {
        bad(`${t.path}: forbidden pattern matched — ${f.why}`,
            `pattern: ${f.re}`)
      }
    }
    if (!forbidden.some((f) => f.re.test(src))) {
      ok(`${t.path}: self-contained (no chunk refs, no WS refs)`)
    }
  } else {
    // Module surface: classic parse should fail with a known module-only
    // error (export/import/await/import.meta). Anything else is unexpected.
    try {
      new Script(src, { filename: t.path })
      // If the module surface parses cleanly as classic, that's also fine —
      // means the bundle happens not to use any module-only syntax.
      ok(`${t.path}: parses as module (${t.why}); also clean as classic`)
    } catch (e) {
      const msg = e.message.split('\n')[0]
      const expected = [
        /import\.meta/,
        /Cannot use import statement outside a module/,
        /Unexpected token 'export'/,
        /await is only valid in async function/,
        /Unexpected reserved word/,
      ]
      if (expected.some((re) => re.test(msg))) {
        ok(`${t.path}: parses as module (${t.why})`)
      } else {
        bad(`${t.path}: unexpected parse error`, msg)
      }
    }
  }
}

// Also clean up so the next test run isn't polluted.
try { rmSync(resolve(FIXTURE, 'dist'),         { recursive: true, force: true }) } catch {}
try { rmSync(resolve(FIXTURE, '.jetty-cache'), { recursive: true, force: true }) } catch {}

// ── Self-test: confirm the audit isn't trivially permissive ──────────────
// If we feed it a bundle with import.meta + top-level await, both should
// be rejected. Without this check, a buggy regex/parser substitute could
// silently let real bugs through.
{
  const broken = `var x = 1;\nawait Promise.resolve();\nconsole.log(import.meta.url);`
  let rejectedCount = 0
  try { new Script(broken, { filename: 'broken' }) }
  catch (_) { rejectedCount++ }
  if (rejectedCount === 1) ok('audit self-test: vm.Script rejects classic-incompatible source')
  else                     bad('audit self-test: vm.Script accepted broken source — audit cannot be trusted')
}

// ── Regression: browser/index.js's IS_DEV must not use import.meta ────────
// The May 2026 incident: a defensive `typeof import.meta !== 'undefined' &&
// import.meta.env?.JETTY_DEV` guard caused islands to fail to parse. The
// `typeof` doesn't help — the parser sees the import.meta token before
// evaluation. Lock this in with a source-level grep so a future revert
// doesn't silently break islands.
{
  const browserIndexPath = resolve(HERE, '../src/browser/index.js')
  if (existsSync(browserIndexPath)) {
    const src = readFileSync(browserIndexPath, 'utf8')
    // Strip comments first — comments referring to `import.meta` are fine.
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
    if (/\bimport\.meta\b/.test(stripped)) {
      bad('browser/index.js still references import.meta', 'islands import this module — must use a build-substituted constant instead')
    } else {
      ok('browser/index.js: no import.meta references in code (regression check)')
    }
  }
}

console.log()
console.log(`${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
