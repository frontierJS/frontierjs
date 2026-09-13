/**
 * installable.mjs — the manifest grader, held against Chrome's own answer.
 *
 * `src/postbuild/manifest.js` restates what a browser requires before it offers
 * to install a web app. A restatement of somebody else's rules is right on the
 * day it is written, so this asks Chrome — `Page.getInstallabilityErrors` —
 * about every case the grader decides, and fails on any case where the two
 * disagree. When a Chrome release moves a rule, this is what notices.
 *
 * Each case is a real build output directory: index.html, the manifest, the
 * icon files. It is graded from disk, then served over http://localhost (a
 * secure context, which installing requires) and loaded in headless Chrome.
 *
 * Every rule is asked both ways — a 144px icon beside a 143px one, `short_name`
 * alone beside no name at all — because a grader that refused everything would
 * agree with Chrome on every refusal.
 *
 * Usage, from the sierra package root: `bun run test:installable`.
 * Needs Chrome on PATH (or $FJS_CHROME).
 */

import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, extname } from 'node:path'
import { deflateSync } from 'node:zlib'

import { gradeManifest } from '../../src/postbuild/manifest.js'

const CHROME = process.env.FJS_CHROME ?? 'google-chrome'
const SCRATCH = mkdtempSync(join(tmpdir(), 'fjs-installable-'))

// ─── fixtures ─────────────────────────────────────────────────────────────────

function png(size) {
  const crc = (buf) => {
    let c = ~0
    for (const byte of buf) { c ^= byte; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)) }
    return ~c >>> 0
  }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data])
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body))
    return Buffer.concat([len, body, sum])
  }
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 4, 0x80)])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr.set([8, 6, 0, 0, 0], 8)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: size }, () => row)))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const SVG  = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>'
const icon = (src, sizes, extra = {}) => ({ src, ...(sizes ? { sizes } : {}), type: src.endsWith('.svg') ? 'image/svg+xml' : 'image/png', ...extra })
const ok   = { name: 'Shop', start_url: '/', display: 'standalone', icons: [icon('/i192.png', '192x192')] }
const FILES = { 'i192.png': png(192), 'i144.png': png(144), 'i143.png': png(143), 'i32.png': png(32), 'icon.svg': SVG }

const LINK = '/manifest.webmanifest'
const NAME = 'manifest-missing-name-or-short-name'
const ICON = 'no-acceptable-icon'
const DISP = 'manifest-display-not-supported'
const START = 'start-url-not-valid'
const NONE = 'no-manifest'
const READ = 'manifest-parsing-or-network-error'

/** [name, manifest (object, string, or null for none), expected codes, options] */
const CASES = [
  ['a whole manifest',               ok,                                                          []],
  ['short_name alone',               { ...ok, name: undefined, short_name: 'S' },                  []],
  ['no name at all',                 { ...ok, name: undefined },                                   [NAME]],
  ['display minimal-ui',             { ...ok, display: 'minimal-ui' },                             []],
  ['display fullscreen',             { ...ok, display: 'fullscreen' },                             []],
  ['display browser',                { ...ok, display: 'browser' },                                [DISP]],
  ['display omitted',                { ...ok, display: undefined },                                [DISP]],
  ['start_url "."',                  { ...ok, start_url: '.' },                                    []],
  ['start_url omitted',              { ...ok, start_url: undefined },                              [START]],
  ['start_url on another origin',    { ...ok, start_url: 'https://example.com/' },                 [START]],
  ['an icon of exactly 144px',       { ...ok, icons: [icon('/i144.png', '144x144')] },             []],
  ['an icon of 143px',               { ...ok, icons: [icon('/i143.png', '143x143')] },             [ICON]],
  ['a 32px file declaring 512',      { ...ok, icons: [icon('/i32.png', '512x512')] },              [ICON]],
  ['a 192px file declaring 48',      { ...ok, icons: [icon('/i192.png', '48x48')] },               [ICON]],
  ['an icon with no sizes',          { ...ok, icons: [icon('/i192.png')] },                        [ICON]],
  ['an SVG with sizes any',          { ...ok, icons: [icon('/icon.svg', 'any')] },                 []],
  ['an SVG with no sizes',           { ...ok, icons: [icon('/icon.svg')] },                        [ICON]],
  ['a maskable icon alone',          { ...ok, icons: [icon('/i192.png', '192x192', { purpose: 'maskable' })] }, [ICON]],
  ['"any maskable"',                 { ...ok, icons: [icon('/i192.png', '192x192', { purpose: 'any maskable' })] }, []],
  ['an icon file that is not there', { ...ok, icons: [icon('/gone.png', '192x192')] },             [ICON]],
  ['an icon path relative to the manifest', { ...ok, icons: [icon('i192.png', '192x192')] },       [], { at: '/app/manifest.webmanifest', filesUnder: 'app' }],
  ['two faults at once',             { ...ok, name: undefined, display: 'browser' },               [NAME, DISP]],
  ['a link to no file',              ok,                                                           [READ], { omitManifest: true }],
  ['a manifest that is not JSON',    '{ name: Shop',                                               [READ]],
  ['a manifest in public/ nothing links', ok,                                                      [NONE], { unlinked: true }],
]

function writeCase(dir, manifest, opts) {
  const at = opts.at ?? LINK
  mkdirSync(dir, { recursive: true })
  const link = opts.unlinked ? '' : `<link rel="manifest" href="${at}">`
  writeFileSync(join(dir, 'index.html'), `<!doctype html><html><head><title>t</title>${link}</head><body>app</body></html>`)
  const iconsDir = join(dir, opts.filesUnder ?? '')
  mkdirSync(iconsDir, { recursive: true })
  for (const [name, body] of Object.entries(FILES)) writeFileSync(join(iconsDir, name), body)
  if (!opts.omitManifest) {
    const file = join(dir, at.replace(/^\//, ''))
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, typeof manifest === 'string' ? manifest : JSON.stringify(manifest))
  }
  // The unlinked case is a Vite root whose public/ holds the file and whose
  // build carries the copy, which is what `vite build` leaves.
  if (opts.unlinked) {
    mkdirSync(join(dir, 'public'), { recursive: true })
    writeFileSync(join(dir, 'public', 'manifest.webmanifest'), JSON.stringify(manifest))
  }
}

// ─── Chrome ───────────────────────────────────────────────────────────────────

let served = null
const TYPES = { '.html': 'text/html', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' }
const server = createServer((req, res) => {
  const path = join(served, decodeURIComponent(new URL(req.url, 'http://x').pathname))
  const file = path.endsWith('/') ? join(path, 'index.html') : path
  if (!existsSync(file)) { res.writeHead(404); res.end(); return }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' })
  res.end(readFileSync(file))
})
await new Promise(r => server.listen(0, 'localhost', r))
const origin = `http://localhost:${server.address().port}`

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  '--remote-debugging-port=0', `--user-data-dir=${join(SCRATCH, 'profile')}`, 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] })
chrome.on('error', (e) => { console.error(`Chrome could not be started (${CHROME}): ${e.message}`); process.exit(1) })

const wsUrl = await new Promise((resolve, reject) => {
  let buf = ''
  const timer = setTimeout(() => reject(new Error('Chrome did not report a debugging port')), 15000)
  chrome.stderr.on('data', (d) => {
    buf += d
    const m = buf.match(/ws:\/\/[^\s]+/)
    if (m) { clearTimeout(timer); resolve(m[0]) }
  })
})

const ws = new WebSocket(wsUrl)
await new Promise(r => ws.addEventListener('open', r))
let id = 0
const pending = new Map()
const waiters = []
ws.addEventListener('message', (e) => {
  const msg = JSON.parse(e.data)
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
  for (const w of waiters.splice(0)) if (w.method === msg.method) w.done(); else waiters.push(w)
})
const send = (method, params = {}, sessionId) => new Promise(r => {
  const n = ++id
  pending.set(n, r)
  ws.send(JSON.stringify({ id: n, method, params, sessionId }))
})
const next = (method) => new Promise(done => waiters.push({ method, done }))

const { result: target } = await send('Target.createTarget', { url: 'about:blank' })
const { result: attach } = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true })
const session = attach.sessionId
await send('Page.enable', {}, session)

// Chrome names one missing icon twice, and a manifest it could not read fails
// every rule after that one as well; the grader stops at the first.
const normalize = (errors) => {
  const ids = errors.map(e => e.errorId === 'manifest-missing-suitable-icon' ? ICON : e.errorId)
  return ids.includes(READ) ? [READ] : [...new Set(ids)].sort()
}

// ─── run ──────────────────────────────────────────────────────────────────────

let failed = 0
let refusals = 0

for (const [i, [name, manifest, expected, opts = {}]] of CASES.entries()) {
  const dir = join(SCRATCH, `case-${i}`)
  writeCase(dir, manifest, opts)

  const verdict = gradeManifest(dir, dir)
  const graded  = (verdict?.problems ?? []).map(p => p.code).sort()

  served = dir
  const loaded = next('Page.loadEventFired')
  await send('Page.navigate', { url: `${origin}/?case=${i}` }, session)
  await loaded
  const { result } = await send('Page.getInstallabilityErrors', {}, session)
  const chromeSays = normalize(result?.installabilityErrors ?? [{ errorId: 'no answer from Chrome' }])

  const want = [...expected].sort()
  const same = JSON.stringify(graded) === JSON.stringify(chromeSays) && JSON.stringify(graded) === JSON.stringify(want)
  refusals += graded.length
  if (!same) failed++
  console.log(`  ${same ? 'ok  ' : 'FAIL'} ${name}${same ? '' : `\n         expected ${JSON.stringify(want)}, grader ${JSON.stringify(graded)}, Chrome ${JSON.stringify(chromeSays)}`}`)
}

// No manifest anywhere is the one case the two answer differently by design:
// Chrome says the page is not installable, and the build has nothing to report
// about a feature nobody asked for.
{
  const dir = join(SCRATCH, 'nothing')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>t</title><body>app</body>')
  served = dir
  const loaded = next('Page.loadEventFired')
  await send('Page.navigate', { url: `${origin}/?nothing` }, session)
  await loaded
  const { result } = await send('Page.getInstallabilityErrors', {}, session)
  const same = gradeManifest(dir, dir) === null && JSON.stringify(normalize(result.installabilityErrors)) === JSON.stringify([NONE])
  if (!same) failed++
  console.log(`  ${same ? 'ok  ' : 'FAIL'} no manifest at all: the grader is silent and Chrome says ${NONE}`)
}

const exited = new Promise(r => chrome.on('exit', r))
chrome.kill()
server.close()
await exited
rmSync(SCRATCH, { recursive: true, force: true })

// The control: a run where the grader refused nothing agrees with Chrome only
// on the installable half.
if (refusals === 0) { console.error('\n  the grader refused nothing in any case — this run proves nothing'); process.exit(1) }

console.log(failed ? `\n  ${failed} case(s) where the grader and Chrome disagree\n` : `\n  all ${CASES.length + 1} cases agree with Chrome\n`)
process.exit(failed ? 1 : 0)
