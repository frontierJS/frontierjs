// @frontierjs/litestone/storage — object storage, a battery (FJS-D635).

import type { FileRef, LitestonePlugin } from '../index.d.ts'

export interface FileStorageOptions {
  provider?:        'r2' | 's3' | 'b2' | 'minio' | 'local'
  bucket?:          string
  endpoint?:        string
  accessKeyId?:     string
  secretAccessKey?: string
  publicBase?:      string
  keyPattern?:      string   // default: ':model/:field/:uuid.:ext'
  region?:          string
  // provider: 'local' — read by storage/providers/local.js and undeclared
  // here, so the local branch of every dev config was a type error.
  localPath?:       string   // default: <main database's directory>/files, or './storage' in memory (FJS-D1549)
  localUrl?:        string   // default: http://localhost:<localPort>/storage
  localPort?:       number   // default: 3001
}

export declare function FileStorage(options?: FileStorageOptions): LitestonePlugin & {
  /** The directory a local store writes under, which junction serves; null for any other provider. */
  readonly localRoot: string | null
  /** The settled options, the environment's FILES_* names included. `publicBase` and `signingKey` are read at every resolve. */
  config: FileStorageOptions & { signingKey?: string }
  /** Whether a request for a local `key` carries a live signature from a read (FJS-D1703). */
  verify(key: string, signed: { exp?: string; sig?: string }): boolean
}
/** The environment names an option falls back to, keyed by that option (FJS-D1549). */
export declare const FILES_ENV: Readonly<Record<'provider' | 'bucket' | 'endpoint' | 'accessKeyId' | 'secretAccessKey' | 'publicBase', string>>
/** A File column value read from the server's disk. A string is never read as a path. `move: true` hands the file over: a local store renames it in after one read for the hash, any other provider removes it once stored. */
export declare function fromPath(path: string, options?: { move?: boolean }): { readonly path: string; readonly move: boolean }
/** A File column value read from a stream, such as a request's `req.body`. `type` is a claim; the bytes' head decides. A remote provider needs `size` before the first byte, and the byte count is checked against it. */
export declare function fromStream(
  readable: ReadableStream<Uint8Array> | import('node:stream').Readable,
  options?: { name?: string; type?: string; size?: number },
): { readonly readable: ReadableStream<Uint8Array>; readonly name?: string; readonly type?: string; readonly size: number | null }
/** A stored ref as the object: a ref passes through, its JSON text is parsed, anything else is null. */
export declare function parseRef(value: FileRef | string | null | undefined): FileRef | null
export declare function fileUrl(ref: FileRef | string | null | undefined): string | null
export declare function fileUrls(refs: (FileRef | string)[] | string | null | undefined): string[]
export declare function useStorage(options: FileStorageOptions): {
  sign(ref: FileRef, opts?: { expiresIn?: number }): Promise<string>
  download(ref: FileRef): Promise<Buffer>
  /** The bytes as a stream, for an object too large to hold whole. */
  stream(ref: FileRef): Promise<ReadableStream<Uint8Array>>
  /** The file's absolute path under provider 'local', null for any other, for a tool that reads a file by name. */
  path(ref: FileRef): string | null
  /** Removes the stored object a ref names. A bare key string is refused: pass the ref, or its JSON text. */
  delete(ref: FileRef | string): Promise<void>
  /** The public URL of a ref under the config's publicBase, null without a ref. */
  url(ref: FileRef | string | null | undefined): string | null
}
export declare function createProvider(options: FileStorageOptions): unknown

export { ExternalRefPlugin } from '../index.d.ts'
