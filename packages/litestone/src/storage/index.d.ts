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
  /** The settled options, the environment's FILES_* names included. `publicBase` is read at every resolve. */
  config: FileStorageOptions
}
/** The environment names an option falls back to, keyed by that option (FJS-D1549). */
export declare const FILES_ENV: Readonly<Record<'provider' | 'bucket' | 'endpoint' | 'accessKeyId' | 'secretAccessKey' | 'publicBase', string>>
/** A File column value read from the server's disk. A string is never read as a path. */
export declare function fromPath(path: string): { readonly path: string }
export declare function fileUrl(ref: FileRef | string | null | undefined): string | null
export declare function fileUrls(refs: (FileRef | string)[] | string | null | undefined): string[]
export declare function useStorage(options: FileStorageOptions): {
  sign(ref: FileRef, opts?: { expiresIn?: number }): Promise<string>
  download(ref: FileRef): Promise<Buffer>
  delete(key: string): Promise<void>
}
export declare function createProvider(options: FileStorageOptions): unknown

export { ExternalRefPlugin } from '../index.d.ts'
