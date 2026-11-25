// web/src/lib/files.js -- a post's files, as Messages draws, uploads and opens them.
//
// The file routes answer only a caller they can grade (api/src/domain/chat/files.ts),
// so an <img src> cannot reach them: a plain link carries no bearer. The bytes go
// through `client.fetch`, which carries the client's own credentials, and a page
// draws them from a blob URL, fetched once per tab per file and size.
import { getClient } from '@frontierjs/sierra/resource'

/** A FileInfo row as a screen reads it. */
export const attachmentOf = (f) => ({
  id: f.externalId,
  name: f.name ?? 'file',
  mime: f.mimeType ?? 'application/octet-stream',
  size: f.size ?? null,
  preview: !!f.hasPreviewImage,
  width: f.width ?? null,
  height: f.height ?? null,
})

export const isImage = (mime) => typeof mime === 'string' && mime.startsWith('image/')

export const fileSize = (n) => n == null ? '' : n < 1024 ? `${n} B` : n < 1_048_576 ? `${Math.round(n / 1024)} KB` : `${(n / 1_048_576).toFixed(1)} MB`

/** Past this the server refuses the upload (`MAX_UPLOAD_BYTES`), so the box says so before sending it. */
export const MAX_FILE_BYTES = 50 * 1024 * 1024
export const MAX_FILES = 5

const api = () => {
  const client = getClient()
  if (!client) throw new Error('This build names no API.')
  return client
}

/** The response for one file: `full`, or an image's `preview`. Throws the server's message. */
export const fetchFile = (id, size = 'full') => api().fetch(`/files/${encodeURIComponent(id)}?size=${size}`)

const blobs = new Map()

/** A blob URL a page can put in an <img src>. */
export function fileBlobUrl(id, size = 'preview') {
  const key = `${id}:${size}`
  if (blobs.has(key)) return blobs.get(key)
  const p = fetchFile(id, size).then((r) => r.blob()).then((b) => URL.createObjectURL(b))
  blobs.set(key, p)
  p.catch(() => blobs.delete(key))
  return p
}

const pictures = new Map()
const RETRY_MS = 60_000

/**
 * A blob URL for a person's chat picture, or '' when there is none to draw. The
 * route answers only a signed-in caller, so it goes through `client.fetch` like a
 * file. A failure is remembered for a minute: a room of one author's posts must
 * not ask again for every post while the chat server is down.
 */
export function profileImageUrl(profileExternalId) {
  if (!profileExternalId) return Promise.resolve('')
  const kept = pictures.get(profileExternalId)
  if (kept && (kept.ok || Date.now() - kept.at < RETRY_MS)) return kept.p
  const entry = { ok: true, at: Date.now(), p: null }
  entry.p = api().fetch(`/profiles/${encodeURIComponent(profileExternalId)}/image`)
    .then((r) => r.blob())
    .then((b) => URL.createObjectURL(b))
    .catch(() => { entry.ok = false; return '' })
  pictures.set(profileExternalId, entry)
  return entry.p
}

/** Save a file: the bytes are fetched with the member's credentials, then handed to the browser as a download. */
export async function downloadFile(file) {
  const blob = await (await fetchFile(file.id, 'full')).blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = file.name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

const pad = (n) => String(n).padStart(2, '0')
/** A browser names every pasted screenshot `image.png`; it is named for when it was pasted, as the server's own client does. */
export function nameOf(file, at = new Date()) {
  if (file.name && file.name !== 'image.png' && file.name !== 'blob') return file.name
  const ext = (file.type?.split('/')[1] ?? 'png').replace('jpeg', 'jpg').replace(/[^a-z0-9]/g, '') || 'png'
  return `Image Pasted at ${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}-${pad(at.getMinutes())}-${pad(at.getSeconds())}.${ext}`
}

/** Upload one file into a channel as the reader; answers its FileInfo id. Throws the server's message. */
export async function uploadFile(channelExternalId, file) {
  const name = nameOf(file)
  const q = `channel=${encodeURIComponent(channelExternalId)}&name=${encodeURIComponent(name)}`
  const res = await api().fetch(`/files?${q}`, { method: 'POST', body: file, headers: { 'Content-Type': file.type || 'application/octet-stream' } })
  const row = await res.json()
  return { id: row.externalId, name: row.name ?? name, size: row.size ?? file.size, mime: row.mimeType ?? file.type }
}
