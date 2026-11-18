// api/src/domain/chat/files.ts -- a team chat file's bytes, both ways, as raw
// routes (a service answers JSON only), moved from the chat prototype.
//
//   GET  /files/{id}?size=preview   the bytes, to whoever may read its FileInfo
//   POST /files?channel=<id>&name=  one file's bytes as the body, uploaded as the caller
//
// A screenshot in a private room is not public, so a URL alone must answer
// nobody. The caller's own read of the FileInfo (or, for an upload, of the
// channel) goes first, through the service, so the schema's @@allow decides
// and a row they may not read is a 404 like one that does not exist. The
// server is then asked with the caller's own token and grades them again.
//
// The upload reads its body as a stream: the API's parse bound is 256 KB and a
// screenshot is more, so it is registered with `{ body: 'stream' }`.

import type { App, RouteHandler } from '@frontierjs/junction'
import { isInlineSafe } from '@frontierjs/toolbelt/mime'
import { fileOf, land, uploadAs } from '../../providers/chat/index.ts'

export const FILES_PATH = '/files'
export const FILE_PATH  = '/files/{id}'

/** Past this the upload is refused before it is read whole. */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024

const SIZES = new Set(['full', 'preview', 'thumbnail'] as const)
type Size = typeof SIZES extends Set<infer S> ? S : never

type Info = { externalId: string, name: string, mimeType: string, hasPreviewImage: boolean, deletedAt: string | null }
type Room = { externalId: string, deletedAt: string | null }

/** The caller's own service, so the read is graded as them. */
const serviceAs = (app: App, ctx: any, name: string) => (app as any).service(name)

export const fileRoute = (app: App): RouteHandler => async (ctx: any) => {
  if (!ctx.user) return ctx.json({ message: 'Sign in first' }, 401)
  const id = String(ctx.route.id)
  const asked = String(ctx.query.size ?? 'full') as Size
  if (!SIZES.has(asked)) return ctx.json({ message: 'size is full, preview or thumbnail' }, 400)

  const page = await serviceAs(app, ctx, 'fileInfos').find({ externalId: id }, { directives: { limit: 1 } }) as { data?: Info[] }
  const info = page.data?.[0]
  if (!info || info.deletedAt) return ctx.json({ message: 'Not found' }, 404)

  const size = info.hasPreviewImage ? asked : 'full'
  const { bytes, type, error } = await fileOf(app, info.externalId, size)
  if (!bytes) {
    return error?.kind === 'gone' || error?.kind === 'forbidden'
      ? ctx.json({ message: 'Not found' }, 404)
      : ctx.json({ message: `The chat server did not answer the file (${error?.kind ?? 'no answer'})` }, 502)
  }

  // A preview and a thumbnail are the server's JPEGs; the file whole is what was uploaded.
  const mime = size === 'full' ? info.mimeType : (type ?? 'image/jpeg')
  const name = info.name.replace(/["\\\r\n]/g, '_')
  return new Response(new Uint8Array(bytes), { headers: {
    'content-type':           mime,
    'x-content-type-options': 'nosniff',
    // Images draw in the room; a .zip or an .html downloads.
    'content-disposition':    `${isInlineSafe(mime) ? 'inline' : 'attachment'}; filename="${name}"`,
    'cache-control':          'private, no-store',
  } })
}

/** The body, or null once it runs past `max` — the sender is told to stop there. */
async function readAtMost(stream: ReadableStream<Uint8Array> | null, max: number): Promise<Uint8Array | null> {
  if (!stream) return new Uint8Array(0)
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    let r: Awaited<ReturnType<typeof reader.read>>
    try { r = await reader.read() } catch (err) {
      // The route states `max` as its maxBodySize, so junction errors the read there.
      if ((err as Error)?.name === 'BodyTooLargeError') return null
      throw err
    }
    const { done, value } = r
    if (done || !value) break
    total += value.byteLength
    if (total > max) { try { await reader.cancel() } catch {} return null }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const c of chunks) { out.set(c, at); at += c.byteLength }
  return out
}

export const uploadRoute = (app: App): RouteHandler => async (ctx: any) => {
  if (!ctx.user) return ctx.json({ message: 'Sign in first' }, 401)
  const channel = String(ctx.query.channel ?? '')
  const name = String(ctx.query.name ?? '').trim()
  if (!channel || !name) return ctx.json({ message: 'POST /files takes ?channel=<the room\'s externalId>&name=<the file\'s name>' }, 400)

  const declared = Number(ctx.headers['content-length'])
  if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) return ctx.json({ message: `A file is at most ${MAX_UPLOAD_BYTES / 1_048_576} MB` }, 413)

  const page = await serviceAs(app, ctx, 'channels').find({ externalId: channel }, { directives: { limit: 1 } }) as { data?: Room[] }
  const room = page.data?.[0]
  if (!room || room.deletedAt) return ctx.json({ message: 'Not found' }, 404)

  const bytes = await readAtMost(ctx.body as ReadableStream<Uint8Array> | null, MAX_UPLOAD_BYTES)
  if (!bytes) return ctx.json({ message: `A file is at most ${MAX_UPLOAD_BYTES / 1_048_576} MB` }, 413)
  if (!bytes.byteLength) return ctx.json({ message: 'The body is the file\'s bytes, and it was empty' }, 400)

  const mimeType = (ctx.headers['content-type'] ?? '').split(';')[0]!.trim() || 'application/octet-stream'
  const { row, error } = await uploadAs(app, { channelExternalId: room.externalId, name, bytes, mimeType })
  if (!row) {
    if (error?.kind === 'auth_failed') return ctx.json({ message: 'Link your chat account first (Laptop → Chat)' }, 403)
    if (error?.kind === 'forbidden')   return ctx.json({ message: 'The chat server will not take a file into that room from you' }, 403)
    if (error?.kind === 'refused')     return ctx.json({ message: `The chat server refused the file: ${error.message}` }, 422)
    return ctx.json({ message: `The chat server did not take the file (${error?.kind ?? 'no answer'})` }, 502)
  }

  await land(app, 'FileInfo', [row])
  return ctx.json(row, 201)
}
