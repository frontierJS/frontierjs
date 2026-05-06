// filestorage/index.ts
// File storage — Total.js pattern rewritten for Bun.
// Chunked directory storage with metadata log.
// Range, stream, image detection, download headers all included.

import { join, extname } from 'node:path'
import { mkdir, unlink } from 'node:fs/promises'

// ─── Types ────────────────────────────────────────────────────────────────

export interface StorageFile {
  id:       string
  name:     string
  type:     string
  size:     number
  custom?:  Record<string, unknown>
  created:  string
  expires?: string
}

export interface StorageSaveOptions {
  custom?:  Record<string, unknown>
  expires?: Date
  headers?: Record<string, string>
}

export interface StorageReadResult {
  file:    ReturnType<typeof Bun.file>
  meta:    StorageFile
  stream:  () => ReadableStream
}

export interface IFileStorage {
  save(id: string, name: string, data: ArrayBuffer | Uint8Array | string, opts?: StorageSaveOptions): Promise<StorageFile>
  saveJson(id: string, value: unknown, opts?: StorageSaveOptions):                                    Promise<StorageFile>
  read(id: string):                                                                                   Promise<StorageReadResult | null>
  readJson<T = unknown>(id: string):                                                                  Promise<T | null>
  remove(id: string):                                                                                 Promise<boolean>
  exists(id: string):                                                                                 Promise<boolean>
  meta(id: string):                                                                                   Promise<StorageFile | null>
  list(limit?: number, skip?: number):                                                                Promise<{ total: number; data: StorageFile[] }>
  toResponse(id: string, req: Request, download?: string | boolean):                                  Promise<Response>
  stats():                                                                                            Promise<{ total: number; size: number }>
}

// ─── Image types ──────────────────────────────────────────────────────────

const IMAGE_TYPES: Record<string, string> = {
  jpg:  'image/jpeg', jpeg: 'image/jpeg',
  png:  'image/png',  gif:  'image/gif',
  svg:  'image/svg+xml', webp: 'image/webp',
  heic: 'image/heic', heif: 'image/heif',
  tiff: 'image/tiff', bmp:  'image/bmp',
}

const CONTENT_TYPES: Record<string, string> = {
  ...IMAGE_TYPES,
  pdf:  'application/pdf',
  txt:  'text/plain',
  json: 'application/json',
  mp4:  'video/mp4',
  webm: 'video/webm',
  mp3:  'audio/mpeg',
  csv:  'text/csv',
}

const RANGE_RE = /^bytes=(\d*)-(\d*)$/

// ─── createFileStorage ────────────────────────────────────────────────────
// One storage instance per named store (e.g. 'uploads', 'avatars').
// Files are stored under: {root}/{store}/{groupDir}/{id}.file
// groupDir = first 2 chars of id (like Total.js groupify)

export function createFileStorage(name: string, rootDir: string): IFileStorage {

  const storeDir = join(rootDir, name)
  const logPath  = join(storeDir, 'files.log.json')

  async function ensureDir(path: string): Promise<void> {
    await mkdir(path, { recursive: true })
  }

  // Groupify id into 2-char subdirectory (prevents huge flat dirs)
  function groupDir(id: string): string {
    return id.slice(0, 2).toLowerCase().replace(/[^a-z0-9]/g, '_')
  }

  function filePath(id: string): string {
    return join(storeDir, groupDir(id), id + '.file')
  }

  function metaPath(id: string): string {
    return join(storeDir, groupDir(id), id + '.meta.json')
  }

  async function readMeta(id: string): Promise<StorageFile | null> {
    const path = metaPath(id)
    const file = Bun.file(path)
    if (!await file.exists()) return null
    try { return await file.json() as StorageFile } catch { return null }
  }

  async function writeMeta(meta: StorageFile): Promise<void> {
    const path = metaPath(meta.id)
    await ensureDir(join(storeDir, groupDir(meta.id)))
    await Bun.write(path, JSON.stringify(meta, null, 2))
  }

  return {

    // ── save ───────────────────────────────────────────────────
    async save(id, name, data, opts = {}): Promise<StorageFile> {
      const ext  = extname(name).slice(1).toLowerCase()
      const type = CONTENT_TYPES[ext] ?? 'application/octet-stream'
      const dir  = join(storeDir, groupDir(id))

      await ensureDir(dir)

      const buf     = typeof data === 'string'
        ? Buffer.from(data, 'utf8')
        : data

      await Bun.write(filePath(id), buf)

      const size = buf instanceof ArrayBuffer ? buf.byteLength : (buf as Uint8Array).byteLength

      const meta: StorageFile = {
        id,
        name,
        type,
        size,
        custom:  opts.custom,
        created: new Date().toISOString(),
        expires: opts.expires?.toISOString(),
      }

      await writeMeta(meta)
      return meta
    },

    // ── saveJson ───────────────────────────────────────────────
    async saveJson(id, value, opts = {}): Promise<StorageFile> {
      return this.save(id, id + '.json', JSON.stringify(value), opts)
    },

    // ── read ───────────────────────────────────────────────────
    async read(id): Promise<StorageReadResult | null> {
      const meta = await readMeta(id)
      if (!meta) return null

      // Check expiry
      if (meta.expires && new Date(meta.expires) <= new Date()) {
        await this.remove(id)
        return null
      }

      const file = Bun.file(filePath(id))
      if (!await file.exists()) return null

      return {
        file,
        meta,
        stream: () => file.stream()
      }
    },

    // ── readJson ───────────────────────────────────────────────
    async readJson<T>(id: string): Promise<T | null> {
      const result = await this.read(id)
      if (!result) return null
      try { return await result.file.json() as T } catch { return null }
    },

    // ── remove ─────────────────────────────────────────────────
    async remove(id): Promise<boolean> {
      const fp = filePath(id)
      const mp = metaPath(id)
      const existed = await Bun.file(fp).exists()
      await unlink(fp).catch(() => {})
      await unlink(mp).catch(() => {})
      return existed
    },

    // ── exists ─────────────────────────────────────────────────
    async exists(id): Promise<boolean> {
      return Bun.file(filePath(id)).exists()
    },

    // ── meta ───────────────────────────────────────────────────
    async meta(id): Promise<StorageFile | null> {
      return readMeta(id)
    },

    // ── list ───────────────────────────────────────────────────
    async list(limit = 20, skip = 0): Promise<{ total: number; data: StorageFile[] }> {
      const data: StorageFile[] = []
      try {
        const glob = new Bun.Glob('**/*.meta.json')
        for await (const f of glob.scan({ cwd: storeDir, absolute: false })) {
          const id   = f.replace(/^.*\//, '').replace('.meta.json', '')
          const meta = await readMeta(id)
          if (meta) data.push(meta)
        }
      } catch {}

      const total   = data.length
      const sliced  = data.slice(skip, skip + limit)
      return { total, data: sliced }
    },

    // ── toResponse ─────────────────────────────────────────────
    // Serves the file as an HTTP response with range, etag, content-type.
    async toResponse(id, req, download): Promise<Response> {
      const result = await this.read(id)
      if (!result) return new Response('Not Found', { status: 404 })

      const { file, meta } = result
      const size = file.size

      const etag         = `W/"${meta.id}-${meta.size}"`
      const lastModified = new Date(meta.created).toUTCString()

      // Cache check
      if (req.headers.get('if-none-match') === etag) {
        return new Response(null, { status: 304 })
      }

      const headers: Record<string, string> = {
        'content-type':  meta.type,
        'etag':          etag,
        'last-modified': lastModified,
        'accept-ranges': 'bytes',
        'cache-control': 'private, max-age=3600'
      }

      if (download) {
        const filename = typeof download === 'string' ? download : meta.name
        headers['content-disposition'] = `attachment; filename*=utf-8''${encodeURIComponent(filename)}`
      }

      // Range request
      const range = req.headers.get('range')
      if (range) {
        const match = RANGE_RE.exec(range)
        if (!match) return new Response('Invalid Range', { status: 416 })

        const start = match[1] ? parseInt(match[1], 10) : size - parseInt(match[2], 10)
        const end   = match[2] ? parseInt(match[2], 10) : size - 1
        const chunk = file.slice(start, end + 1)

        return new Response(chunk, {
          status:  206,
          headers: {
            ...headers,
            'content-range':  `bytes ${start}-${end}/${size}`,
            'content-length': String(end - start + 1)
          }
        })
      }

      headers['content-length'] = String(size)
      return new Response(file, { status: 200, headers })
    },

    // ── stats ──────────────────────────────────────────────────
    async stats(): Promise<{ total: number; size: number }> {
      let total = 0
      let size  = 0
      try {
        const glob = new Bun.Glob('**/*.file')
        for await (const f of glob.scan({ cwd: storeDir, absolute: false })) {
          const sz = Bun.file(join(storeDir, f)).size
          total++; size += sz
        }
      } catch {}

      return { total, size }
    }
  }
}
