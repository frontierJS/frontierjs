// Phase 9 — the Mesa HMR wrapper, driven with REAL compiler output.
//
// `injectJettyHMR` reads a shape it does not own: the JavaScript mesa's
// compiler emits. It matches that shape with two regexes, and the second one
// looked for a trailing `$runtime.$$delegate(…)`. Mesa's `FJS-470` renamed
// every emitted identifier to `$$`, so from that day every component carrying
// a delegated event — nearly all of them — was wrapped WITHOUT its
// registration call: it mounted fine, it never registered, and hot updates
// silently stopped swapping it. The build stayed green and jetty's ~450 tests
// stayed green, because nothing here had ever compiled a component (`FJS-481`).
//
// The two files that would have caught it, `test/hmr-fullflow.mjs` and
// `test/hmr-integration.mjs`, are in this directory and no script runs them —
// and could not: they import mesa by an absolute path from another machine
// (`/home/claude/repo/reading-list/...`). They are not repaired here; this file
// covers the same seam against the compiler that is actually installed.
//
// The compiler is imported by relative path — jetty takes mesa as an optional
// peer, and repo tests read workspace source directly since bun resolves a
// workspace dep to a copy.

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const { compileSource } = await import(resolve(HERE, '../../mesa/src/compiler.js'))
const { injectJettyHMR } = await import(resolve(HERE, '../src/build/mesa-plugin.js'))

let pass = 0
let fail = 0
const ok  = (m) => { pass++; console.log('  ✓', m) }
const bad = (m, i) => { fail++; console.log('  ✗', m); if (i) console.log('     →', i) }
const group = (n) => console.log(`\n[${n}]`)

const compile = async (src) =>
  (await compileSource(src, { filename: 'Widget.mesa', css: false, debug: false })).result

group('injectJettyHMR against real compiler output')

// The case that broke: a delegated event puts a trailing `$$delegate(…)` call
// after the component function, which is what Step 2's lookahead has to clear.
{
  const js = await compile(`<script>let c = 0</script><p on:click={() => c++}>{c}</p>`)
  if (!/\$\$delegate\(/.test(js)) bad('fixture does not delegate — the case under test is not present')
  else ok('fixture emits a trailing $$delegate call')

  // Caught rather than allowed to propagate: the plugin now throws when it
  // cannot recognize the shape, and a thrown error would kill this file before
  // it reported anything — which is a red that reads as a crash.
  let out = ''
  try { out = injectJettyHMR(js, '/app/src/Widget.mesa', '/app') }
  catch (e) { bad('a delegating component gets its HMR registration', e.message) }
  if (out && out.includes('__jettyMesa.register(')) ok('a delegating component gets its HMR registration')
  else if (out) bad('a delegating component gets its HMR registration', 'Step 2 did not match — HMR is silently dead for it')

  if (out && /function __mesaOrigFn\(__anchor, __props, __block\)/.test(out)) ok('the original function is renamed for the wrapper')
  else bad('the original function is renamed for the wrapper', 'Step 1 did not match')

  if (out && out.includes('export default function __mesaJettyHMRWrap')) ok('the wrapper becomes the default export')
  else bad('the wrapper becomes the default export')
}

// No delegated event — the other branch of the same lookahead.
{
  const js = await compile(`<script>let c = 0</script><p>{c}</p>`)
  if (/\$\$delegate\(/.test(js)) bad('fixture unexpectedly delegates')
  else ok('fixture emits no delegate call')

  const out = injectJettyHMR(js, '/app/src/Plain.mesa', '/app')
  if (out.includes('__jettyMesa.register(')) ok('a non-delegating component gets its HMR registration')
  else bad('a non-delegating component gets its HMR registration')
}

// A shape it cannot recognize must be loud. Silently returning a wrapper that
// never registers is what made the defect above invisible for weeks.
{
  let threw = null
  try { injectJettyHMR('export default function X(a, b, c) { return 1 }', '/app/src/X.mesa', '/app') }
  catch (e) { threw = e.message }
  if (threw && /shape this plugin matches has moved/.test(threw)) ok('an unrecognized shape throws at build time, naming the cause')
  else bad('an unrecognized shape throws at build time', threw ? `threw the wrong error: ${threw}` : 'did not throw')
}

console.log()
console.log(`${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
