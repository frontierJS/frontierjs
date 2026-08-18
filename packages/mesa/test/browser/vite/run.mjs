/*
 * run.mjs — the Vite plugin, in a real dev server, in a real browser.
 *
 *   node test/browser/vite/run.mjs             every spec
 *   node test/browser/vite/run.mjs hmr         specs whose filename matches
 *   node test/browser/vite/run.mjs --verbose   print the passing rows too
 *   node test/browser/vite/run.mjs --serve     start the app and stay up
 *
 * Needs Chrome on PATH or `$FJS_CHROME`.
 *
 * ── What this exists to reach ─────────────────────────────────────────
 *
 * `vite-server.test.js` starts a real dev server and asks it for what a
 * browser asks for, which is as far as Node can go: it proves the bytes are
 * right. What it cannot do is EXECUTE them, so the whole second half of the
 * plugin — the HMR boundary, the client that swaps a component in place, the
 * devtools page's own 18 KB of JavaScript — is unreached (`FJS-024`). HMR in
 * particular is proven only up to the frame Vite sends; nothing had ever
 * watched a component swap and its neighbours survive, which is the entire
 * claim being made over a full reload.
 *
 * ── The app is a COPY ─────────────────────────────────────────────────
 *
 * These specs edit source files, because that is what an HMR update is. They
 * edit a copy in a temp directory rather than the tree: a drive that mutates
 * tracked files leaves the repo dirty whenever it crashes, and two runs at
 * once would edit each other's fixture.
 *
 * ── The server ────────────────────────────────────────────────────────
 *
 * Middleware mode over a Node http server on port 0, with Vite's HMR socket
 * handed that same server — the OS picks the port, so this cannot collide with
 * a dev server someone is running (root CLAUDE.md § Ports). The compiled
 * output's runtime import is aliased to this package's own source rather than
 * resolved by name, for the reason every in-repo consumer does it: `bun
 * install` copies a workspace dependency, so a by-name resolution serves a
 * snapshot taken at install time.
 */
import { createServer as createHttpServer } from 'node:http'
import { cpSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runSpecs, dim } from '../drive.mjs'

const HERE    = fileURLToPath(new URL('.', import.meta.url))
const APP     = join(HERE, 'app')
const RUNTIME = fileURLToPath(new URL('../../../src/runtime.js', import.meta.url))

const argv      = process.argv.slice(2)
const serveOnly = argv.includes('--serve')
const verbose   = argv.includes('--verbose')
const filters   = argv.filter((a) => !a.startsWith('--'))

/* ─── the app, copied ─────────────────────────────────────────────────── */

const work = mkdtempSync(join(tmpdir(), 'fjs-mesa-vite-'))
cpSync(APP, work, { recursive: true })

/** The pristine bytes of every file a spec may edit, so a teardown can put
 *  them back whatever the spec did or failed to do. */
const pristine = new Map()
const source = (rel) => {
  if (!pristine.has(rel)) pristine.set(rel, readFileSync(join(work, rel), 'utf8'))
  return pristine.get(rel)
}
for (const f of ['src/Counter.mesa', 'src/Sibling.mesa', 'src/App.mesa']) source(f)

/* ─── writing a file so the watcher sees it ───────────────────────────
 *
 * Two writes to one file inside a few tens of milliseconds produce ONE watch
 * event — measured here at 23ms apart: the second write fired no `change` and
 * no update was ever sent, and the edit only arrived when a LATER edit flushed
 * it. That is a property of the file watcher every dev server sits on, and it
 * is invisible from inside a spec: the DOM shows the old content, which is
 * exactly what broken HMR shows.
 *
 * So every write goes through here, and it holds until the file has been quiet
 * long enough to be seen. A spec should be able to make two edits in a row
 * without knowing any of this.
 */
const SETTLE = 250
const lastWrite = new Map()

const put = async (rel, text) => {
  const since = Date.now() - (lastWrite.get(rel) ?? 0)
  if (since < SETTLE) await new Promise((r) => setTimeout(r, SETTLE - since))
  writeFileSync(join(work, rel), text)
  lastWrite.set(rel, Date.now())
}

const restoreAll = async () => {
  for (const [rel, text] of pristine) await put(rel, text)
}

/* ─── the dev server ──────────────────────────────────────────────────── */

const { createServer } = await import('vite')
const mesaPlugin = (await import('../../../mesa-vite/index.js')).default

const http = createHttpServer()

const vite = await createServer({
  root:       work,
  cacheDir:   join(work, '.vite'),
  configFile: false,
  logLevel:   'silent',
  // The HMR socket rides the same server, which is the only way to keep the
  // port ephemeral: Vite would otherwise open a second one of its own choosing.
  server:  { middlewareMode: true, hmr: { server: http } },
  resolve: { alias: { '@frontierjs/mesa/runtime.js': RUNTIME } },
  plugins: [mesaPlugin()],
})

http.on('request', vite.middlewares)
await new Promise((r) => http.listen(0, '127.0.0.1', r))
const origin = `http://127.0.0.1:${http.address().port}`

const shutdown = async () => {
  await vite.close().catch(() => {})
  await new Promise((r) => http.close(r))
  try { rmSync(work, { recursive: true, force: true }) } catch {}
}

/* ─── run ─────────────────────────────────────────────────────────────── */

if (serveOnly) {
  console.log(`mesa vite fixture served at ${origin}`)
  console.log(dim(`working copy: ${work}`))
  console.log(dim('edits to that copy hot-update the page; the tree is untouched'))
} else {
  const { infra, failures } = await runSpecs({
    origin,
    specDir: join(HERE, 'specs'),
    filters,
    verbose,
    ready: 'window.__appReady',
    extend: (browser) => ({
      /** Navigate, and wait for `ready` if one is given. */
      goto: (path, ready) => browser.navigate(origin + path, ready),
      /** Open a second tab on this server — the devtools panel needs one. */
      openTab: (path, ready) => browser.newPage(origin + path, ready),
      /** Rewrite a file in the working copy — this is what an edit IS.
       *  Await it: it may hold for the watcher, see `put`. */
      edit: (rel, from, to) => {
        const text = readFileSync(join(work, rel), 'utf8')
        if (!text.includes(from))
          throw new Error(`edit(${rel}): ${JSON.stringify(from)} is not in the file`)
        return put(rel, text.replace(from, to))
      },
      /** Replace a file wholesale — for the shapes an edit cannot express. */
      write: (rel, text) => put(rel, text),
      /** Put every file back, mid-spec. The teardown does this too. */
      restore: () => restoreAll(),
      /** What the page's console has been handed since it last loaded. */
      log: () => browser.evaluate('return { v: window.__hmrLog.slice() };').then((r) => r.v),
      /** Every HMR frame the page received, which is the other half of the
       *  question: a server that never sent and a client that never applied
       *  look identical from the DOM. */
      frames: () => browser.evaluate('return { v: window.__frames.slice() };').then((r) => r.v),
      /** How many times this tab has NAVIGATED — 1 means nothing reloaded. */
      boots: () => browser.evaluate('return { v: window.__boots };').then((r) => r.v),
    }),
    // Both halves matter: the files go back, and so does the page — a spec that
    // navigated to the devtools panel must not hand the next one that page.
    teardown: async (browser) => {
      await restoreAll()
      await browser.evaluate('sessionStorage.clear(); return true;').catch(() => {})
      await browser.navigate(origin + '/', 'window.__appReady')
    },
  })

  await shutdown()
  process.exit(failures || infra ? 1 : 0)
}
