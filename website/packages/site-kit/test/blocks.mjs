/*
 * blocks.mjs — every block compiles to JavaScript that parses, and each one
 * renders the markup a static page relies on.
 *
 * A clean compile is not the check (Invariant 15): Mesa can report no errors
 * and emit a module that throws on load, so the output is parsed too.
 *
 * Run: node test/blocks.mjs
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseJs } from 'acorn'
// Relative, not the specifier: bun's workspace copy under node_modules/.bun is
// a snapshot from install time, so the specifier would test stale compiler code.
import { compileSource } from '../../../../packages/mesa/src/compiler.js'
import { renderComponent } from '../../../../packages/mesa/src/render-component.js'

const ROOT   = fileURLToPath(new URL('..', import.meta.url))
const BLOCKS = join(ROOT, 'src', 'blocks')

const failed = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `\n    ${detail}`}`)
  if (!ok) failed.push(label)
}

for (const name of readdirSync(BLOCKS).filter((f) => f.endsWith('.mesa')).sort()) {
  const src = readFileSync(join(BLOCKS, name), 'utf8')
  try {
    const ctx = await compileSource(src, { filename: name })
    parseJs(ctx.result, { ecmaVersion: 'latest', sourceType: 'module' })
    check(`${name} compiles to parseable JS`, true)
  } catch (err) {
    check(`${name} compiles to parseable JS`, false, err.message)
  }
}

// ── Marquee ──────────────────────────────────────────────────────────────────
// The loop is seamless only if the slot renders twice, and a screen reader
// hears the items once only if the second copy is hidden.
{
  const { html } = await renderComponent(
    `<script>import Marquee from './src/blocks/Marquee.mesa'</script>
     <Marquee label="Features" duration="80s" reverse><b>one</b><b>two</b></Marquee>`,
    { cwd: ROOT, filename: 'MarqueeProbe.mesa' })

  const tracks = [...html.matchAll(/<div[^>]*class="track[^"]*"[^>]*>(.*?)<\/div>/g)]
  check('Marquee renders two tracks', tracks.length === 2, `got ${tracks.length}`)
  check('Marquee repeats the slot in both', tracks.every((m) => m[1].includes('<b>one</b><b>two</b>')))
  check('Marquee hides the second copy only',
    !/aria-hidden/.test(tracks[0]?.[0] ?? '') && /aria-hidden="true"/.test(tracks[1]?.[0] ?? ''))
  check('Marquee names its region', /role="region" aria-label="Features"/.test(html))
  check('Marquee carries duration and direction',
    /--marquee-duration: 80s/.test(html) && /class="marquee[^"]*\breverse\b/.test(html))

  const { html: bare } = await renderComponent(
    `<script>import Marquee from './src/blocks/Marquee.mesa'</script><Marquee>x</Marquee>`,
    { cwd: ROOT, filename: 'MarqueeBare.mesa' })
  check('Marquee without a label claims no region', !/role=|aria-label=/.test(bare))
}

if (failed.length) {
  console.error(`\n${failed.length} failed`)
  process.exit(1)
}
