// @frontierjs/conduit-s3 — the S3 protocol over conduit (FJS-D889).
//
// Source: `packages/litestone/src/storage/providers/s3.js`, which signs with
// its own `fetch`. Here the object calls go through a declared `signed`
// target with `encoding: 'binary'`, and the presigned URL is the one call that
// never crosses conduit at all.
//
// One connector serves AWS, R2, B2, MinIO, SeaweedFS: path-style addressing
// (`<endpoint>/<bucket>/<key>`) is what every one of them accepts, where
// virtual-hosted style is AWS's and R2's. A vendor's extension stays the app's.

import type { ConduitRequest, ConduitResult, TargetDescriptor } from '@frontierjs/conduit'
import { S3_SIGNER, uriEncode } from './signer.ts'
import { translate, type S3Failure } from './errors.ts'

export * from './signer.ts'
export * from './errors.ts'

export type Send = <T>(req: Omit<ConduitRequest, 'target'>) => Promise<ConduitResult<T>>
export function bindSend(conduit: { send<T>(req: ConduitRequest): Promise<ConduitResult<T>> }, target: string): Send {
  return req => conduit.send({ target, ...req })
}

export interface S3TargetOptions {
  /** The endpoint, no bucket: `https://s3.us-east-1.amazonaws.com`, `http://127.0.0.1:9000`. */
  address: string
  region:  string
  ref:     string
  id?:     string
}

/** The target. It names `S3_SIGNER` and carries the region; register `{ [S3_SIGNER]: s3Signer }`. */
export function s3Target(opts: S3TargetOptions): TargetDescriptor {
  return {
    id:            opts.id ?? `provider:s3:${opts.region}`,
    kind:          'provider',
    protocol:      'http',
    address:       opts.address.replace(/\/$/, ''),
    encoding:      'binary',
    auth:          { type: 'signed', signer: S3_SIGNER, ref: opts.ref, params: { region: opts.region } },
    registered_at: Date.now(),
    last_seen_at:  null,
  }
}

/** The key is encoded per segment. Joined raw, a `?` or `#` in it ends the
 *  path and the signature agrees with the truncated request, so nothing refuses it. */
export function objectPath(bucket: string, key: string): string {
  return `/${uriEncode(bucket)}/${key.split('/').map(uriEncode).join('/')}`
}

export interface ObjectMeta { etag: string | null; size: number | null; contentType: string | null; lastModified: string | null }

const meta = (headers: Record<string, string> | undefined): ObjectMeta => ({
  etag:         headers?.etag ?? null,
  size:         headers?.['content-length'] !== undefined ? Number(headers['content-length']) : null,
  contentType:  headers?.['content-type'] ?? null,
  lastModified: headers?.['last-modified'] ?? null,
})

export async function putObject(send: Send, bucket: string, key: string, body: Uint8Array | string, opts: { contentType?: string; ifNoneMatch?: '*' } = {}): Promise<{ meta?: ObjectMeta; error?: S3Failure }> {
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body
  const r = await send<null>({ method: 'PUT', path: objectPath(bucket, key), body: bytes, headers: {
    'content-type': opts.contentType ?? 'application/octet-stream',
    ...(opts.ifNoneMatch ? { 'if-none-match': opts.ifNoneMatch } : {}),
  } })
  if (r.error) return { error: translate(r.error) }
  return { meta: meta(r.meta.headers) }
}

export async function getObject(send: Send, bucket: string, key: string, opts: { ifNoneMatch?: string } = {}): Promise<{ bytes?: Uint8Array; unchanged?: true; meta?: ObjectMeta; error?: S3Failure }> {
  const r = await send<Uint8Array | string | null>({ method: 'GET', path: objectPath(bucket, key), headers: {
    // Conduit's default `Accept: application/json` is signed and sent; S3 ignores it.
    ...(opts.ifNoneMatch ? { 'if-none-match': opts.ifNoneMatch } : {}),
  } })
  if (r.error) return { error: translate(r.error) }
  if (r.meta.status === 304) return { unchanged: true, meta: meta(r.meta.headers) }
  // A text/* object comes back decoded; bytes are what the caller asked for.
  const bytes = r.data === null ? new Uint8Array() : typeof r.data === 'string' ? new TextEncoder().encode(r.data) : r.data
  return { bytes, meta: meta(r.meta.headers) }
}

export async function headObject(send: Send, bucket: string, key: string): Promise<{ meta?: ObjectMeta; error?: S3Failure }> {
  const r = await send<null>({ method: 'HEAD', path: objectPath(bucket, key) })
  if (r.error) return { error: translate(r.error) }
  return { meta: meta(r.meta.headers) }
}

/** Gone is gone: a 404 on delete is success, because every path into a delete
 *  is a job that may be redelivered. */
export async function deleteObject(send: Send, bucket: string, key: string): Promise<{ gone: boolean; error?: S3Failure }> {
  const r = await send<null>({ method: 'DELETE', path: objectPath(bucket, key) })
  if (r.error) {
    const f = translate(r.error)
    if (f.kind === 'missing') return { gone: true }
    return { gone: false, error: f }
  }
  return { gone: true }
}

export interface ListedObject { key: string; size: number; etag: string | null; lastModified: string | null }

const unescapeXml = (s: string) => s.replace(/&(?:#x([0-9a-f]+)|#(\d+)|(amp|lt|gt|quot|apos));/gi, (_, hex, dec, name) =>
  hex ? String.fromCodePoint(parseInt(hex, 16)) : dec ? String.fromCodePoint(Number(dec)) : ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[name.toLowerCase()])
const tag = (xml: string, name: string) => { const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`)); return m ? unescapeXml(m[1]) : null }

/** One page of ListObjectsV2. `nextToken` is set while the listing is truncated;
 *  pass it back as `continuationToken` until it is not. Keys come back in
 *  UTF-8 binary order, which is what a prefix-and-stamp naming sorts by. */
export async function listObjects(send: Send, bucket: string, opts: { prefix?: string; continuationToken?: string; maxKeys?: number } = {}): Promise<{ objects?: ListedObject[]; nextToken?: string | null; error?: S3Failure }> {
  const r = await send<Uint8Array | string | null>({ method: 'GET', path: `/${uriEncode(bucket)}`, query: {
    'list-type':          2,
    prefix:               opts.prefix,
    'continuation-token': opts.continuationToken,
    'max-keys':           opts.maxKeys,
  } })
  if (r.error) return { error: translate(r.error) }
  // `application/xml` is neither JSON nor text/*, so conduit hands it over as bytes.
  const xml = r.data === null ? '' : typeof r.data === 'string' ? r.data : new TextDecoder().decode(r.data)
  const objects = [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map(([, c]) => ({
    key:          tag(c, 'Key') ?? '',
    size:         Number(tag(c, 'Size') ?? 0),
    etag:         tag(c, 'ETag'),
    lastModified: tag(c, 'LastModified'),
  }))
  return { objects, nextToken: tag(xml, 'IsTruncated') === 'true' ? tag(xml, 'NextContinuationToken') : null }
}
