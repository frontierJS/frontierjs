// src/providers/storage/s3.ts
// The S3 protocol over conduit — basecamp's own copy of `conduit-s3`'s
// dialect (`FJS-D1490`), the way compute/digitalocean.ts is a copy of the
// connector in the sibling workspace: the image build packs workspace
// dependencies only (`FJS-D1185`), so a `link:` on the connector cannot ship.
// When that ruling flips, this file becomes an import line.
//
// SigV4 is NOT copied. It is `@frontierjs/toolbelt/sigv4` (`FJS-D892`), the
// one signer, and what is here is dialect: how a key becomes a path, what an
// XML `<Code>` means, and the descriptor a bucket registers as. One connector
// serves AWS, R2, B2, MinIO and SeaweedFS because path-style addressing
// (`<endpoint>/<bucket>/<key>`) is what every one of them accepts.
//
// The resolver's one string holds both halves of the credential as
// `<accessKeyId>:<secretAccessKey>` — `splitCredential` is the only reader,
// and it is why the form asks for one box rather than two.

import type { ConduitError, ConduitRequest, ConduitResult, Signer, TargetDescriptor } from '@frontierjs/conduit'
import { signRequest, presignUrl, uriEncode } from '@frontierjs/toolbelt/sigv4'

// ─── Failure ──────────────────────────────────────────────────────────────
// An S3 error is XML with a `<Code>`, and the status alone is not enough: a
// 403 is a wrong key (`SignatureDoesNotMatch`), a right key the policy
// refuses (`AccessDenied`), or a clock fifteen minutes out
// (`RequestTimeTooSkewed`), and only the first is a credential to forget.

export type S3FailureKind = 'missing' | 'forbidden' | 'clock_skew' | 'etag_mismatch' | 'refused' | ConduitError['kind']

export interface S3Failure { kind: S3FailureKind; code?: string; message: string; retryable: boolean; retryAfterMs?: number }

export function errorCode(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  return raw.match(/<Code>([^<]+)<\/Code>/)?.[1]
}

export function translate(error: ConduitError): S3Failure {
  const code = errorCode(error.raw)
  const base: S3Failure = { kind: error.kind, message: error.message, retryable: error.retryable,
    ...(code ? { code } : {}), ...(error.retry_after_ms !== undefined ? { retryAfterMs: error.retry_after_ms } : {}) }
  switch (code) {
    case 'NoSuchKey': case 'NoSuchBucket': return { ...base, kind: 'missing', retryable: false }
    case 'AccessDenied':                   return { ...base, kind: 'forbidden', retryable: false }
    case 'RequestTimeTooSkewed':           return { ...base, kind: 'clock_skew', retryable: false }
    case 'PreconditionFailed':             return { ...base, kind: 'etag_mismatch', retryable: false }
    case 'InvalidArgument': case 'MalformedXML': case 'EntityTooLarge': return { ...base, kind: 'refused', retryable: false }
    default: return base
  }
}

// ─── Signer ───────────────────────────────────────────────────────────────

export interface S3Credential { accessKeyId: string; secretAccessKey: string }

/** `"<accessKeyId>:<secretAccessKey>"` → the pair. The key id never holds a colon. */
export function splitCredential(secret: string): S3Credential {
  const i = secret.indexOf(':')
  if (i <= 0 || i === secret.length - 1) throw new Error('s3: the credential must be "<accessKeyId>:<secretAccessKey>"')
  return { accessKeyId: secret.slice(0, i), secretAccessKey: secret.slice(i + 1) }
}

export const S3_SIGNER = 's3-sigv4'

/** Installed once, in app.ts: `signers: { [S3_SIGNER]: s3Signer }`. The region
 *  rides the descriptor as `auth.params` (`FJS-2725`), so one signer serves
 *  every destination. */
export const s3Signer: Signer = async ({ secret, params, method, url, body, headers }) => {
  const { region, service = 's3' } = params
  // A target not built by s3Target. Thrown, so it is auth_failed with nothing sent.
  if (!region) throw new Error('s3: the target names no region (auth.params.region)')
  const { accessKeyId, secretAccessKey } = splitCredential(secret)
  // Every header conduit will send is signed, so a proxy that rewrites one is
  // a 403 rather than a silent difference; the hash goes over exactly the
  // bytes conduit serialized.
  const signed = await signRequest(method, url, headers, body ?? null, { accessKeyId, secretAccessKey, region, service, now: new Date() })
  return { headers: signed }
}

/** A URL a machine uses directly — the pre-signed PUT a fleet `/backup` gets
 *  (`FJS-D1485`). It never crosses conduit: the caller hands in the resolver's
 *  answer and the URL carries the signature. */
export function presign(opts: { method?: 'GET' | 'PUT'; url: string; credential: string; region: string; expiresIn?: number; service?: string }): Promise<string> {
  const { accessKeyId, secretAccessKey } = splitCredential(opts.credential)
  return presignUrl(opts.method ?? 'GET', opts.url, { accessKeyId, secretAccessKey, region: opts.region, service: opts.service ?? 's3', now: new Date() }, opts.expiresIn ?? 3600)
}

// ─── Target ───────────────────────────────────────────────────────────────

export type Send = <T>(req: Omit<ConduitRequest, 'target'>) => Promise<ConduitResult<T>>
export function bindSend(conduit: { send<T>(req: ConduitRequest): Promise<ConduitResult<T>> }, target: string): Send {
  return req => conduit.send({ target, ...req })
}

export interface S3TargetOptions {
  id:      string
  /** The endpoint, no bucket: `https://s3.us-east-1.amazonaws.com`, `http://127.0.0.1:9000`. */
  address: string
  region:  string
  ref:     string
}

/** The descriptor. The credential is a REF the resolver reads at send time;
 *  the material never reaches the registry. */
export function s3Target(opts: S3TargetOptions): TargetDescriptor {
  return {
    id:            opts.id,
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

// ─── Objects ──────────────────────────────────────────────────────────────

export interface ObjectMeta { etag: string | null; size: number | null; contentType: string | null; lastModified: string | null }

const meta = (headers: Record<string, string> | undefined): ObjectMeta => ({
  etag:         headers?.etag ?? null,
  size:         headers?.['content-length'] !== undefined ? Number(headers['content-length']) : null,
  contentType:  headers?.['content-type'] ?? null,
  lastModified: headers?.['last-modified'] ?? null,
})

// A bucket with Object Lock refuses a PUT that carries no Content-MD5
// (`FJS-4218`), so every PUT sends one. A pre-signed URL leaves the header
// unsigned, so whoever holds the URL adds it.
export const contentMd5 = (bytes: Uint8Array): string => new Bun.CryptoHasher('md5').update(bytes).digest('base64')

/** `contentMd5` of a file, read as a stream: an archive can be gigabytes. */
export async function fileMd5(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher('md5')
  for await (const chunk of Bun.file(path).stream()) hasher.update(chunk)
  return hasher.digest('base64')
}

export async function putObject(send: Send, bucket: string, key: string, body: Uint8Array | string, opts: { contentType?: string; ifNoneMatch?: '*' } = {}): Promise<{ meta?: ObjectMeta; error?: S3Failure }> {
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body
  const r = await send<null>({ method: 'PUT', path: objectPath(bucket, key), body: bytes, headers: {
    'content-type': opts.contentType ?? 'application/octet-stream',
    'content-md5':  contentMd5(bytes),
    ...(opts.ifNoneMatch ? { 'if-none-match': opts.ifNoneMatch } : {}),
  } })
  if (r.error) return { error: translate(r.error) }
  return { meta: meta(r.meta.headers) }
}

export async function getObject(send: Send, bucket: string, key: string, opts: { ifNoneMatch?: string } = {}): Promise<{ bytes?: Uint8Array; unchanged?: true; meta?: ObjectMeta; error?: S3Failure }> {
  const r = await send<Uint8Array | string | null>({ method: 'GET', path: objectPath(bucket, key), headers: {
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
 *  is a job that may be redelivered.
 *
 *  Without `versionId`, a versioned bucket writes a delete marker and answers
 *  204 while the object stays, billed and locked; only a delete naming the
 *  version removes one. A version under Object Lock is refused, and the
 *  refusal's code does not say why: SeaweedFS and S3 answer `AccessDenied`,
 *  the code a key without delete gets. So a refused version delete reads the
 *  version's retention and legal hold, and answers `locked` only when one of
 *  them holds it now; a refusal it cannot name stays the error. */
export async function deleteObject(send: Send, bucket: string, key: string, opts: { versionId?: string } = {}): Promise<{ gone: boolean; locked?: { until: string | null }; error?: S3Failure }> {
  const versioned = opts.versionId !== undefined && opts.versionId !== 'null'
  const r = await send<null>({ method: 'DELETE', path: objectPath(bucket, key), ...(versioned ? { query: { versionId: opts.versionId } } : {}) })
  if (r.error) {
    const f = translate(r.error)
    if (f.kind === 'missing') return { gone: true }
    const locked = versioned && f.kind !== 'clock_skew' && f.kind !== 'auth_failed' ? await lockOn(send, bucket, key, opts.versionId!) : null
    return locked ? { gone: false, locked } : { gone: false, error: f }
  }
  return { gone: true }
}

/** Every version and delete marker of exactly `key`, deleted by id, so a
 *  versioned bucket keeps nothing billed behind a marker. `locked` when the
 *  vendor's lock refused any version; that version and every one after it
 *  stay. A bucket that keeps no versions (`NotImplemented`, R2) takes a plain
 *  delete, and its lock's refusal is unprobed, so it comes back as the error. */
export async function deleteEveryVersion(send: Send, bucket: string, key: string): Promise<{ gone: true } | { locked: { until: string | null } } | { error: S3Failure }> {
  const all: ListedVersion[] = []
  let next: { keyMarker: string; versionIdMarker: string | null } | undefined
  do {
    const page = await listObjectVersions(send, bucket, { prefix: key, next })
    if (page.error?.code === 'NotImplemented') {
      const { error } = await deleteObject(send, bucket, key)
      return error ? { error } : { gone: true }
    }
    if (page.error) return { error: page.error }
    all.push(...page.versions!.filter(v => v.key === key))
    next = page.next ?? undefined
  } while (next)
  // Markers last: a marker left over a locked version is what hides it from a listing.
  for (const v of [...all.filter(v => !v.deleteMarker), ...all.filter(v => v.deleteMarker)]) {
    const done = await deleteObject(send, bucket, key, { versionId: v.versionId })
    if (done.locked) return { locked: done.locked }
    if (done.error) return { error: done.error }
  }
  return { gone: true }
}

/** What holds a version now: a retention date ahead of now, or a legal hold. Null when neither can be read as holding it. */
async function lockOn(send: Send, bucket: string, key: string, versionId: string, now = Date.now()): Promise<{ until: string | null } | null> {
  const read = async (sub: 'retention' | 'legal-hold') => {
    const r = await send<Uint8Array | string | null>({ method: 'GET', path: objectPath(bucket, key), query: { [sub]: '', versionId } })
    return r.error ? '' : r.data === null ? '' : typeof r.data === 'string' ? r.data : new TextDecoder().decode(r.data)
  }
  const until = tag(await read('retention'), 'RetainUntilDate')
  if (until && Date.parse(until) > now) return { until }
  return tag(await read('legal-hold'), 'Status') === 'ON' ? { until: null } : null
}

/** The bucket's Object Lock default, from `GetObjectLockConfiguration`.
 *  `enabled: false` when the bucket answers that it has none; an error when it
 *  cannot say, which is R2's answer for its bucket locks and a key without the
 *  permission alike, so the caller grades that as unknown, never as unlocked. */
export async function getObjectLock(send: Send, bucket: string): Promise<{ lock?: { enabled: boolean; mode: string | null; days: number | null }; error?: S3Failure }> {
  const r = await send<Uint8Array | string | null>({ method: 'GET', path: `/${uriEncode(bucket)}`, query: { 'object-lock': '' } })
  if (r.error) {
    const f = translate(r.error)
    return f.code === 'ObjectLockConfigurationNotFoundError' ? { lock: { enabled: false, mode: null, days: null } } : { error: f }
  }
  const xml   = r.data === null ? '' : typeof r.data === 'string' ? r.data : new TextDecoder().decode(r.data)
  const days  = tag(xml, 'Days'), years = tag(xml, 'Years')
  return { lock: {
    enabled: tag(xml, 'ObjectLockEnabled') === 'Enabled',
    mode:    tag(xml, 'Mode'),
    days:    days ? Number(days) : years ? Number(years) * 365 : null,
  } }
}

// ─── Listing ──────────────────────────────────────────────────────────────

export interface ListedObject { key: string; size: number; etag: string | null; lastModified: string | null }

const unescapeXml = (s: string) => s.replace(/&(?:#x([0-9a-f]+)|#(\d+)|(amp|lt|gt|quot|apos));/gi, (_, hex, dec, name) =>
  hex ? String.fromCodePoint(parseInt(hex, 16)) : dec ? String.fromCodePoint(Number(dec)) : ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[name.toLowerCase()])
const tag = (xml: string, name: string) => { const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`)); return m ? unescapeXml(m[1]) : null }

/** One page of ListObjectsV2. `nextToken` is set while the listing is truncated;
 *  pass it back as `continuationToken` until it is not. Keys come back in
 *  UTF-8 binary order, which is what a prefix-and-stamp naming sorts by. */
export async function listObjects(send: Send, bucket: string, opts: { prefix?: string; delimiter?: string; continuationToken?: string; maxKeys?: number } = {}): Promise<{ objects?: ListedObject[]; prefixes?: string[]; nextToken?: string | null; error?: S3Failure }> {
  const r = await send<Uint8Array | string | null>({ method: 'GET', path: `/${uriEncode(bucket)}`, query: {
    'list-type':          2,
    prefix:               opts.prefix,
    delimiter:            opts.delimiter,
    'continuation-token': opts.continuationToken,
    'max-keys':           opts.maxKeys,
  } })
  if (r.error) return { error: translate(r.error) }
  // `application/xml` is neither JSON nor text/*, so conduit hands it over as bytes.
  return parseListing(r.data === null ? '' : typeof r.data === 'string' ? r.data : new TextDecoder().decode(r.data))
}

export interface ListedVersion { key: string; versionId: string; deleteMarker: boolean; isLatest: boolean; lastModified: string | null }

/** One page of ListObjectVersions: each version and delete marker under the
 *  prefix. An unversioned bucket lists one version per key, id `null`. R2
 *  keeps no versions and refuses the call, which the caller reads as "delete
 *  plainly". Pass `next` back until it is null. */
export async function listObjectVersions(send: Send, bucket: string, opts: { prefix?: string; next?: { keyMarker: string; versionIdMarker: string | null } } = {}): Promise<{ versions?: ListedVersion[]; next?: { keyMarker: string; versionIdMarker: string | null } | null; error?: S3Failure }> {
  const r = await send<Uint8Array | string | null>({ method: 'GET', path: `/${uriEncode(bucket)}`, query: {
    // Conduit drops a null; the empty string is what sends the bare subresource.
    versions:            '',
    prefix:              opts.prefix,
    'key-marker':        opts.next?.keyMarker,
    'version-id-marker': opts.next?.versionIdMarker ?? undefined,
  } })
  if (r.error) return { error: translate(r.error) }
  const xml = r.data === null ? '' : typeof r.data === 'string' ? r.data : new TextDecoder().decode(r.data)
  const versions = [...xml.matchAll(/<(Version|DeleteMarker)>([\s\S]*?)<\/\1>/g)].map(([, kind, c]) => ({
    key:          tag(c, 'Key') ?? '',
    versionId:    tag(c, 'VersionId') ?? 'null',
    deleteMarker: kind === 'DeleteMarker',
    isLatest:     tag(c, 'IsLatest') === 'true',
    lastModified: tag(c, 'LastModified'),
  }))
  const next = tag(xml, 'IsTruncated') === 'true'
    ? { keyMarker: tag(xml, 'NextKeyMarker') ?? '', versionIdMarker: tag(xml, 'NextVersionIdMarker') }
    : null
  return { versions, next }
}

/** A ListObjectsV2 answer's XML, read. Apart from `listObjects` because
 *  `/setup`'s restore lists over a pre-signed URL: no row, so no target. */
export function parseListing(xml: string): { objects: ListedObject[]; prefixes: string[]; nextToken: string | null } {
  const objects = [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map(([, c]) => ({
    key:          tag(c, 'Key') ?? '',
    size:         Number(tag(c, 'Size') ?? 0),
    etag:         tag(c, 'ETag'),
    lastModified: tag(c, 'LastModified'),
  }))
  // With a delimiter, each key's next segment once: a Litestream replica's databases.
  const prefixes = [...xml.matchAll(/<CommonPrefixes>([\s\S]*?)<\/CommonPrefixes>/g)].map(([, c]) => tag(c, 'Prefix') ?? '')
  return { objects, prefixes, nextToken: tag(xml, 'IsTruncated') === 'true' ? tag(xml, 'NextContinuationToken') : null }
}
