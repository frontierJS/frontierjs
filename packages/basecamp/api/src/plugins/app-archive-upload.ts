// src/plugins/app-archive-upload.ts — an archive a person sends, into the app's bucket.
//
//   PUT /app-archive-upload/{appId}?name=&by=&expires=&sig=   body: the file
//     → 201 { row } · 403 a bad or expired link · 4xx/502 { message }
//
// The stream half of `appBackups.upload`. A service body is buffered under
// `maxBodySize`, so the bytes cannot reach a service method; a stream route
// runs no pipeline, so the method grades the caller (gate, key scope, the
// app in their workspace, the hub refused, a destination required) and mints
// a link signed over the app, the file name, the uploader and five minutes.
// This route checks that signature and nothing else, as `backup-archive.ts`
// does for a download (`signed-link.ts` owns the key).
//
// Not single-use: the link is a bearer credential until it expires.

import { importAppArchive } from '../domain/backup/app-archive-import.ts'
import { mint, check }      from './signed-link.ts'
import type { App }         from '@frontierjs/junction'

/** The link one upload is sent to, good for five minutes. */
export function mintUploadUrl(appId: string, name: string, by: string, now = Date.now()): string {
  const { expires, sig } = mint('app-archive-upload', [appId, name, by], now)
  const q = new URLSearchParams({ name, by, expires: String(expires), sig })
  return `/app-archive-upload/${encodeURIComponent(appId)}?${q}`
}

const signed = (appId: string, q: Record<string, unknown>) =>
  check('app-archive-upload', [appId, String(q.name ?? ''), String(q.by ?? '')], q.expires, q.sig)

export function appArchiveUpload(app: App) {
  app.put('/app-archive-upload/{appId}', async (ctx) => {
    const appId = ctx.route.appId
    // One answer for a bad, an expired and a forged link: the remedy is the same.
    if (!signed(appId, ctx.query)) return ctx.json({ message: 'This upload link has expired. Choose the file again.' }, 403)
    const by   = String(ctx.query.by)
    const done = await importAppArchive(app, { appId, name: String(ctx.query.name), by, body: ctx.body as ReadableStream<Uint8Array> | null })
    if ('refused' in done) return ctx.json({ message: done.refused }, done.status)
    app.logger.info('app archive uploaded', { backupId: done.row.id, appId, by })
    return ctx.json(done.row, 201)
  }, { body: 'stream' })
}
