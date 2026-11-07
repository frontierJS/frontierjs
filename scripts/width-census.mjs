#!/usr/bin/env node
// ============================================================
// Width census — what apps write at a width
//
//   node scripts/width-census.mjs              # the shape table, this repo and ../fjs-prototypes
//   node scripts/width-census.mjs --hides      # plus every show/hide query, file:line
//   node scripts/width-census.mjs --json       # one row per query
//   node scripts/width-census.mjs <root>...    # other roots
//
// The sample behind IDEAS/responsive-layout.md. Run it again after a phase
// lands and the shape it paves should drop. A copy of FCSS's own bundle is
// left out: its queries are the package's, and counting them graded the
// package as an app (lynx-spike's copies and litestone studio's added 36).
// ============================================================

import { execFileSync }                  from 'node:child_process'
import { readFileSync, existsSync }      from 'node:fs'
import { join, dirname, relative }       from 'node:path'
import { fileURLToPath }                 from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')

const NOT_APP_CSS = [
  /\/packages\/css\//,
  /\/lynx-spike\//,                        // FCSS bundle copies and probes
  /\/packages\/litestone\/src\/tools\/studio\.css$/,
  /\/packages\/email-kit\//,               // email-client CSS, not a layout
]
const WEBSITE = /\/frontierjs\/website\//

const { breakpoints } = JSON.parse(readFileSync(join(REPO, 'packages/css/vocabulary.json'), 'utf8'))
const SCALE   = Object.values(breakpoints)
const DENSITY = [320, 480]                 // derived density's two fjs container steps (FJS-D2021)

const SHAPES = [
  ['collapse', 'Columns become one below a width, or change count'],
  ['hide',     'Show or hide'],
  ['reflow',   'Custom reflow'],
  ['spacing',  'Padding step-ups, sizing, type'],
]

const args  = process.argv.slice(2)
const flags = new Set(args.filter(a => a.startsWith('--')))
const roots = args.filter(a => !a.startsWith('--'))
if (!roots.length) roots.push(REPO, join(REPO, '../fjs-prototypes'))

const rows = census(roots.filter(existsSync))

if (flags.has('--json')) console.log(JSON.stringify(rows, null, 2))
else report(rows)

function census(roots) {
  const files = execFileSync('rg', [
    '-l', '--glob', '!**/node_modules/**', '--glob', '!**/dist/**', '--glob', '!**/.cache/**',
    '-g', '*.mesa', '-g', '*.css', '@(media|container)[^{]*(width|inline-size)', ...roots,
  ], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).sort()

  return files.filter(f => !NOT_APP_CSS.some(re => re.test(f))).flatMap(queriesIn)
}

function queriesIn(file) {
  const src = readFileSync(file, 'utf8')
  const at  = /@(media|container)([^{;]*(?:width|inline-size)[^{;]*)\{/g
  const out = []
  let m
  while ((m = at.exec(src))) {
    const body = blockAfter(src, at.lastIndex)
    const cond = m[2].trim()
    const px   = [...cond.matchAll(/([\d.]+)(px|rem|em)/g)].map(([, n, u]) => u === 'px' ? +n : +n * 16)
    out.push({
      file:    relative(join(REPO, '..'), file),
      line:    src.slice(0, m.index).split('\n').length,
      at:      m[1],
      cond,
      website: WEBSITE.test(file),
      onScale: px.length > 0 && px.every(onScale),
      shape:   shapeOf(body),
      body:    body.slice(0, 220),
    })
  }
  return out
}

function blockAfter(src, start) {
  let i = start, depth = 1
  while (depth && i < src.length) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') depth--
    i++
  }
  return src.slice(start, i - 1).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ').trim()
}

// A `max-width` sits just under a step: 767px and 47.99rem both mean "below md"
function onScale(px) {
  return [...SCALE, ...DENSITY].some(step => px <= step && step - px <= 1)
}

function shapeOf(body) {
  // Declarations from inside the braces only: `.rows :global(.x)` is a selector, not a property
  const decls = [...body.matchAll(/\{([^{}]*)\}/g)]
    .flatMap(([, block]) => block.split(';'))
    .map(d => d.match(/^\s*([\w-]+)\s*:\s*(.+?)\s*$/))
    .filter(Boolean)
    .map(([, p, v]) => [p, v])
  const props = decls.map(([p]) => p)
  if (decls.some(([p, v]) => p === 'display' && v === 'none')) return 'hide'
  if (decls.length && props.every(p => p.startsWith('--'))) return 'spacing'
  if (decls.some(([p, v]) => isOneColumn(p, v)) || props.includes('grid-template-columns')) return 'collapse'
  if (props.every(p => /^(padding|margin|gap|row-gap|column-gap|font-size|line-height|--)/.test(p))) return 'spacing'
  return 'reflow'
}

function isOneColumn(prop, value) {
  return (prop === 'grid-template-columns' && /^(1fr|minmax\(0, ?1fr\)|100%|auto)$/.test(value))
    || (prop === 'flex-direction' && /column/.test(value))
    || (prop === 'grid-column' && /1 ?\/ ?-1/.test(value))
}

function report(rows) {
  const apps = rows.filter(r => !r.website)
  console.log(`${rows.length} width queries, ${apps.length} outside the marketing website`)
  console.log(`${rows.filter(r => r.onScale).length} of ${rows.length} on the breakpoint scale\n`)

  console.log('Shape (outside the website)')
  for (const [key, label] of SHAPES) {
    const n = apps.filter(r => r.shape === key).length
    console.log(`  ${String(n).padStart(3)}  ${pct(n, apps.length).padStart(4)}  ${label}`)
  }

  if (!flags.has('--hides')) return
  console.log('\nShow or hide')
  for (const r of apps.filter(r => r.shape === 'hide')) console.log(`  ${r.file}:${r.line}  ${r.cond}`)
}

function pct(n, of) {
  return of ? `${Math.round(100 * n / of)}%` : '-'
}
