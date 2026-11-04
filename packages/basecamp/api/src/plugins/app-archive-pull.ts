// src/plugins/app-archive-pull.ts — a machine-kept app archive, pulled through the hub.
//
//   PUT /app-archive-pull/{id}?expires=&sig=            body: the file  → 201 { bytes }
//   GET /app-archive-pull/{id}?name=&expires=&sig=      ← <slug>-<stamp>.tar.gz, then gone
//
// The route pair behind `appBackups.download` for an archive no bucket holds
// (`FJS-D1833`). The machine PUTs its archive here by a link the method
// minted, the method answers a GET link once that PUT has landed, and the
// browser follows it as a navigation. Two links, two purposes: the one that
// writes cannot read.
//
// ─── The copy is temporary ────────────────────────────────────────────────
//
// It sits under `pullDir` only between the PUT and the GET. The GET deletes
// it, and any file older than `STALE_MS` goes whenever either route runs and
// at registration: a pull abandoned after the PUT, or across a restart (which
// voids every link, so nothing could ever fetch it), would otherwise keep a
// whole archive on the hub's disk forever.
//
// The path is in `NAVIGATED_API_PATHS` (web/config/api-paths.js), or both
// proxies answer the navigation with the SPA shell.

import { createReadStream, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { tmpdir }                       from 'node:os'
import { dirname, join }                from 'node:path'
import { Readable }                     from 'node:stream'
import { BODY_CEILING_BYTES, check, mint } from './signed-link.ts'
import type { App }                     from '@frontierjs/junction'

/** Longer than a pull can take (the PUT is bounded by the link's five minutes). */
const STALE_MS = 10 * 60_000

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** Beside the live database, on the volume the hub's own archives use; an
 *  in-memory database has no directory, so a test env uses the system temp. */
export function pullDir(app: App): string {
  const live = (app as any).sqlite?.filename
  return !live || live === ':memory:' ? join(tmpdir(), 'basecamp-app-pulls') : join(dirname(live), 'app-pulls')
}

/** Delete every temp file older than the stale age; answers how many went. */
export function sweepPulls(app: App, now = Date.now()): number {
  const dir = pullDir(app)
  let gone = 0
  try {
    for (const file of readdirSync(dir)) {
      const path = join(dir, file)
      if (now - statSync(path).mtimeMs <= STALE_MS) continue
      rmSync(path, { force: true }); gone++
    }
  } catch { /* no directory yet: nothing to sweep */ }
  return gone
}

/** The pair of links one pull uses: `put` for the machine, `get` for the
 *  browser. Both are paths; the caller makes `put` absolute. */
export function mintPullUrls(id: string, name: string, now = Date.now()): { put: string; get: string } {
  const put = mint('app-archive-pull-put', [id], now)
  const get = mint('app-archive-pull-get', [id, name], now)
  return {
    put: `/app-archive-pull/${id}?expires=${put.expires}&sig=${put.sig}`,
    get: `/app-archive-pull/${id}?${new URLSearchParams({ name, expires: String(get.expires), sig: get.sig })}`,
  }
}

const plain = (status: number, text: string) =>
  new Response(text, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } })

const EXPIRED = 'This download link has expired. Press Download again.'

export function appArchivePull(app: App) {
  sweepPulls(app)

  app.put('/app-archive-pull/{id}', async (ctx) => {
    const id = ctx.route.id
    // One answer for a bad, an expired and a forged link: the remedy is the same.
    if (!ID.test(id) || !check('app-archive-pull-put', [id], ctx.query.expires, ctx.query.sig))
      return ctx.json({ message: EXPIRED }, 403)
    sweepPulls(app)
    const body = ctx.body as ReadableStream<Uint8Array> | null
    if (!body) return ctx.json({ message: 'The archive is empty' }, 400)

    const dir = pullDir(app)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const path = join(dir, `${id}.tar.gz`), partial = `${path}.partial`
    // A stream route bounds nothing a chunked sender writes, so the count is kept here.
    const sink = Bun.file(partial).writer()
    const reader = body.getReader()
    let bytes = 0, over = false
    try {
      for (let r = await reader.read(); !r.done; r = await reader.read()) {
        bytes += r.value.byteLength
        if (bytes > BODY_CEILING_BYTES) { over = true; break }
        sink.write(r.value)
      }
    } finally { await sink.end(); reader.releaseLock() }
    if (over || !bytes) {
      rmSync(partial, { force: true })
      return ctx.json({ message: over ? `The archive is over ${BODY_CEILING_BYTES} bytes` : 'The archive is empty' }, over ? 413 : 400)
    }
    renameSync(partial, path)
    return ctx.json({ bytes }, 201)
  }, { body: 'stream' })

  app.get('/app-archive-pull/{id}', async (ctx) => {
    const id = ctx.route.id, name = String(ctx.query.name ?? '')
    if (!ID.test(id) || !check('app-archive-pull-get', [id, name], ctx.query.expires, ctx.query.sig))
      return plain(403, EXPIRED)
    sweepPulls(app)

    const path = join(pullDir(app), `${id}.tar.gz`)
    let size: number
    try { size = statSync(path).size } catch { return plain(404, 'That archive is no longer on the hub. Press Download again.') }
    // Unlinked once open: the stream keeps reading the inode, and nothing is
    // left behind however the browser ends the transfer.
    const file = createReadStream(path)
    file.once('open', () => rmSync(path, { force: true }))
    return new Response(Readable.toWeb(file) as unknown as ReadableStream, { headers: {
      'content-type':        'application/gzip',
      'content-length':      String(size),
      'content-disposition': `attachment; filename="${name.replace(/[^A-Za-z0-9._-]/g, '-')}"`,
      'cache-control':       'no-store',
    } })
  })
}
