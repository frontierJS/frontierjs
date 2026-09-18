/**
 * offline-shell.js — the app opens with no network.
 *
 * Phase 3 of the Homestead work (`IDEAS/homestead.md`). Phases 1 and 2 made a
 * write survive an outage; this makes the APP survive one. Before it, a page
 * navigated to with the network down lands on Chrome's own error screen and
 * every queue on the device is unreachable — measured by `verify:offline`,
 * whose reload assertion had to go back online to read the result.
 *
 * ── Why Sierra writes this file and the app writes its manifest ─────────────
 *
 * A manifest is a DECLARATION — a name, some icons, a color somebody chose —
 * so the app writes it and this pipeline only grades it. A precache list is a
 * DERIVATION: it is the set of files this build emitted, under the hashes this
 * build gave them, and nothing but the build knows those. An app maintaining
 * one by hand would ship a shell pointing at assets that no longer exist, and
 * the symptom is an app that opens offline into a blank page.
 *
 * ── What it will answer for, and what it will not touch ────────────────────
 *
 * **Only two things: a file it precached, and a navigation.** Everything else
 * falls through without `respondWith` being called at all, so the service
 * worker is not in the path of `/api`, `/ws`, an upload, or anything else this
 * framework moves. That is deliberate and it is the fail-closed shape: a
 * runtime cache would eventually answer a read with a row the live layer
 * believes it has already corrected, and a cached write is not a thing that can
 * be made safe. Writes made offline are the pending queue's job and no part of
 * this file knows they exist.
 *
 * Navigations are network-FIRST. Online, the shell is always the current one;
 * offline, the last one is served instead of an error page.
 *
 * ── Versioning, and why it DOES skipWaiting ────────────────────────────────
 *
 * The cache is named for the precache list's own digest, so a build that
 * emitted different files gets a different cache and `activate` deletes every
 * other one.
 *
 * The first version of this file did not call `skipWaiting`, on the reasoning
 * that a running page holds module references into the cache that activating
 * would sweep. `verify:shell` refuted it: without `skipWaiting` a new worker
 * stays in `waiting` for as long as any tab it would replace is open, and a
 * navigation in that tab does not release control — so the drive sat there
 * while the old shell stayed live. A phone with the app open for a week would
 * never see a release, which for an app whose whole promise is *works offline*
 * is the wrong failure.
 *
 * What the old reasoning got wrong is that the hazard is not new. A page that
 * asks for a chunk the deploy has removed fails with or without a worker, and
 * the fetch handler falls through to the network on a miss exactly as a page
 * with no worker does. Sierra already has the mechanism for that case —
 * `x-fjs-build`, which tells a client its bundle is not the build the server is
 * on. So: `skipWaiting` in install, `clients.claim` in activate.
 *
 * ── Opt-in, one word ───────────────────────────────────────────────────────
 *
 * `offline: true` in sierra.config.js. Nothing is written for an app that has
 * not asked: a service worker is the longest-lived thing a build can install on
 * somebody's device, and a framework installing one by default would be
 * deciding that for every app already shipped.
 */

import { readdir, readFile, writeFile, stat } from 'fs/promises'
import { join, relative, sep } from 'path'
import { createHash } from 'node:crypto'
import { gzipSync, brotliCompressSync, constants as zlibConstants } from 'node:zlib'

import { htmlFiles } from './html-files.js'

/**
 * What a first visit DOWNLOADS, which is the only size a budget can be about.
 *
 * Brotli, because that is what a server sends and `Content-Encoding` is not
 * optional on anything that matters. Gzip is reported beside it for a host that
 * only speaks that, and the raw total for reading a build — three numbers, one
 * of which is the one that is graded.
 *
 * Measured per file and summed rather than over a concatenation: a CDN
 * compresses each response on its own, and a joined stream compresses better
 * than the thing it stands for. That difference flatters a budget by the exact
 * amount nobody would notice.
 */
function weigh(buffers) {
  let raw = 0, gzip = 0, brotli = 0
  for (const b of buffers) {
    raw    += b.length
    gzip   += gzipSync(b, { level: 9 }).length
    brotli += brotliCompressSync(b, {
      params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 },
    }).length
  }
  return { raw, gzip, brotli }
}

const kB = (n) => Math.ceil(n / 1024)

/** What a shell is made of. A route chunk is one of these; a photograph is not. */
import { WASM_DIR } from '../build/local-db-plugin.js'

const SHELL_EXT = new Set(['.js', '.css', '.woff', '.woff2', '.svg', '.webmanifest', '.json'])

const extOf = (name) => {
  const i = name.lastIndexOf('.')
  return i < 0 ? '' : name.slice(i)
}

/** Every file under `dir`, at any depth, as paths relative to it. */
async function walk(dir, base = dir) {
  const out = []
  let entries
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === 'node_modules') continue
      out.push(...await walk(full, base))
    } else {
      out.push(relative(base, full).split(sep).join('/'))
    }
  }
  return out
}

/**
 * Write `sw.js` and register it from every page.
 *
 * @param {object|true} offlineConfig — sierra.config.js `offline`
 * @param {string} outDir
 * @param {string} root — the Vite root, which is where the BASELINE lives. Not
 *   `outDir`: a build empties its own output, so a baseline written there is
 *   gone before the next build can read it — measured, by writing one.
 * @returns {Promise<string|null>} a line for the build log, or null
 */
export async function writeOfflineShell(offlineConfig, outDir, root) {
  if (!offlineConfig) return null

  const cfg   = offlineConfig === true ? {} : offlineConfig
  const scope = cfg.scope ?? '/'

  const all   = await walk(outDir)
  const pages = (await htmlFiles(outDir)).map(p => relative(outDir, p).split(sep).join('/'))

  // The shell is the code and the pages, and it is deliberately not everything.
  // An `include` widens it — an app whose offline screen needs an icon set says
  // so — and `sw.js` itself is never in its own precache list.
  const extra  = new Set(cfg.include ?? [])

  // The engine, when the app asked for a database. It is `.mjs` and `.wasm`,
  // neither of which is shell-shaped by extension — and it has to be here
  // rather than left to the browser's own cache, because a device that has
  // never fetched it has no engine at exactly the moment it needs one. This is
  // the weight `FJS-D302`'s baseline exists to make somebody agree to.
  const wantsDb = !!cfg.db
  const assets = all.filter(f =>
    f !== 'sw.js' &&
    (SHELL_EXT.has(extOf(f)) || extra.has(f) ||
     (wantsDb && f.startsWith(`${WASM_DIR}/`) && extOf(f) !== '.d.mts')))

  // `/` rather than `index.html`: that is the URL a navigation asks for, and a
  // cache keyed by the file name would miss every one of them.
  const urls = [...new Set([
    scope,
    ...pages.map(p => '/' + p),
    ...assets.map(a => '/' + a),
  ])].sort()

  // Measured rather than rhetorical — this is the phase where the byte budget
  // in `IDEAS/offline-first-and-release.md` stops being a sentence.
  const buffers = []
  for (const f of [...pages, ...assets]) {
    try { buffers.push(await readFile(join(outDir, f))) } catch { /* raced with a rebuild */ }
  }
  const weight = weigh(buffers)

  const version = createHash('sha256').update(urls.join('\n')).digest('hex').slice(0, 12)
  await writeFile(join(outDir, 'sw.js'), swSource(version, urls, scope), 'utf8')

  const snippet =
    '<script>' +
    "if('serviceWorker' in navigator)addEventListener('load',function(){" +
    `navigator.serviceWorker.register('${scope}sw.js'.replace('//','/'),{scope:'${scope}'}).catch(function(){})` +
    '})</script>'

  for (const page of await htmlFiles(outDir)) {
    const html = await readFile(page, 'utf8')
    if (html.includes('serviceWorker.register')) continue
    await writeFile(
      page,
      html.includes('</body>') ? html.replace('</body>', snippet + '</body>') : html + snippet,
      'utf8',
    )
  }

  const verdict = await gradeBudget(kB(weight.brotli), cfg, root ?? outDir)

  return `sw.js — ${urls.length} file(s) precached · ${kB(weight.brotli)} kB over the wire ` +
         `(${kB(weight.gzip)} kB gzip, ${kB(weight.raw)} kB raw)${verdict}`
}

/**
 * The byte budget: a ceiling with a baseline that ratchets down only
 * (`FJS-D302`, Invariant 14's mechanism applied to a second axis).
 *
 * A ceiling this framework picked would be wrong for every app, and the first
 * thing anybody would do is raise it. A number nothing enforces is a number
 * nobody reads — which is what the build printed before this, and why there had
 * never been a budget. So the app adopts whatever it costs today and cannot get
 * worse:
 *
 *   · no baseline file        — write one, and say so. There is no other way to
 *                               start, and refusing a first build would make
 *                               the feature un-adoptable.
 *   · under it                — pass, and say what it could be lowered to.
 *                               NOT rewritten on its own: a file that changes
 *                               on every build is a diff nobody reads, and the
 *                               lowering is somebody's decision to record.
 *   · over it                 — THROW. The build fails with both numbers.
 *
 * `FJS_OFFLINE_BASELINE=update` writes the current number, which is the
 * deliberate act — lowering it after a win, or raising it after a feature
 * somebody chose to pay for.
 */
async function gradeBudget(over, cfg, root) {
  const file = cfg.baseline ?? join(root, 'offline-baseline.json')

  let baseline = null
  try { baseline = JSON.parse(await readFile(file, 'utf8')).shellKB ?? null } catch { /* none yet */ }

  const write = async () => writeFile(
    file,
    JSON.stringify({
      // Named rather than bare, because a second axis will want this file and a
      // number with no name is one nobody can add to.
      shellKB: over,
      note: 'The offline shell over the wire, in kB (brotli). Ratchets down only — FJS-D302. ' +
            'Rewrite with FJS_OFFLINE_BASELINE=update.',
    }, null, 2) + '\n',
    'utf8',
  )

  if (process.env.FJS_OFFLINE_BASELINE === 'update') { await write(); return ' · baseline written' }
  if (baseline == null) { await write(); return ` · baseline adopted at ${over} kB` }
  if (over > baseline) {
    throw new Error(
      `[Sierra] the offline shell is ${over} kB over the wire and the baseline is ${baseline} kB.\n` +
      `  A shell that grows is a first visit that got slower for everybody who installs it, and the\n` +
      `  budget ratchets down only (FJS-D302). Take the weight back out, or record the decision to\n` +
      `  pay for it: FJS_OFFLINE_BASELINE=update bun run build\n` +
      `  The baseline lives in ${file}`,
    )
  }
  return over < baseline ? ` · ${baseline - over} kB under the baseline` : ' · at the baseline'
}

/**
 * The worker itself.
 *
 * Written as a string rather than shipped as a file because the precache list
 * and the cache name are both this build's, and a file plus a generated
 * manifest beside it is two artifacts that can disagree about which build they
 * are.
 */
function swSource(version, urls, scope) {
  return `// Generated by @frontierjs/sierra. Do not edit — the next build overwrites it.
const VERSION = ${JSON.stringify(version)}
const CACHE   = 'fjs-shell-' + VERSION
const SHELL   = ${JSON.stringify(urls, null, 0)}
const INDEX   = ${JSON.stringify(scope)}

self.addEventListener('install', (e) => {
  // Waiting for every tab to close means a phone with the app open never sees a
  // release — measured, not assumed: without this the drive's rebuild never
  // activated, because a navigation in the same tab does not release control.
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const name of await caches.keys())
      if (name.startsWith('fjs-shell-') && name !== CACHE) await caches.delete(name)
    await self.clients.claim()
  })())
})

self.addEventListener('fetch', (e) => {
  const req = e.request
  if (req.method !== 'GET') return

  // A navigation: the network decides while there is one, and the last shell
  // answers when there is not. This is what makes the app openable with no
  // server — every queue on the device is unreachable from an error page.
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try { return await fetch(req) }
      catch {
        const c = await caches.open(CACHE)
        return (await c.match(new URL(req.url).pathname)) || (await c.match(INDEX)) ||
               new Response('offline', { status: 503 })
      }
    })())
    return
  }

  // Anything else is answered ONLY if this build precached it. No runtime
  // caching, so /api, /ws and every upload are untouched — respondWith is not
  // even called for them, which is the difference between a worker that is out
  // of the way and one that merely tries to be.
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return
  if (!SHELL.includes(url.pathname)) return

  e.respondWith((async () => {
    const c    = await caches.open(CACHE)
    const hit  = await c.match(url.pathname)
    if (hit) return hit
    return fetch(req)
  })())
})
`
}
