// src/providers/storage/s3-sink.ts — an S3-shaped object store, standing in
// for every S3 vendor. Basecamp's copy of `conduit-s3`'s `sink.ts`, lifted
// the way edge/cloudflare-sink.ts and compute/digitalocean-sink.ts are: the
// image packs workspace dependencies only (`FJS-D1185`), so the sibling
// connector cannot be imported here. When `FJS-D1490` flips, this file becomes
// an import line.
//
// Path-style `/bucket/key`, PUT/GET/HEAD/DELETE, ListObjectsV2, conditional
// headers, XML errors, and a SigV4 VERIFIER written from the AWS rules with
// `node:crypto` — never by importing the signer in reverse, which would agree
// with it by construction. A presigned URL (`X-Amz-Signature` in the query,
// UNSIGNED-PAYLOAD) is verified too, because Outpost's `/backup` fetches one.
//
// Chaos: `{ lost }` applies the write and never answers, `{ slowDown:
// { retryAfter } }` one 503 `SlowDown`, `{ skew }` moves THIS clock by that
// many seconds so a well-signed request is `RequestTimeTooSkewed`. A key under
// `private/` is `AccessDenied` for every credential, which is what separates a
// policy refusal from a bad key — and is how a drive makes `test` answer
// `forbidden` without a second credential. `{ scope }` makes the credential a
// prefix-scoped key: an object key not starting with it is `AccessDenied`, as
// B2's *File name prefix* answers.
//
//   bun api/src/providers/storage/s3-sink.ts
//   endpoint http://127.0.0.1:8125 · region us-east-1 · credential AKIADEV:devsecret
//
// Port 8125 — project 2 (basecamp), backend (`docs/PORTS.md`); 7125 beside the
// test API in `verify:screens`.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

export interface S3SinkOptions { port?: number; accessKeyId?: string; secretAccessKey?: string; region?: string }

const xml = (code: string, message: string, status: number, headers: Record<string, string> = {}) =>
  new Response(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`, { status, headers: { 'content-type': 'application/xml', ...headers } })

const hex = (b: Buffer | Uint8Array) => Buffer.from(b).toString('hex')
const sha256 = (d: Buffer | Uint8Array | string) => createHash('sha256').update(d).digest('hex')
const hmac = (k: Buffer | string, d: string) => createHmac('sha256', k).update(d).digest()

/** AWS UriEncode, from the rules: every byte outside A-Za-z0-9-_.~ as %XX uppercase. */
function awsEncode(s: string): string {
  let out = ''
  for (const b of Buffer.from(s, 'utf8')) {
    const c = String.fromCharCode(b)
    out += /[A-Za-z0-9\-_.~]/.test(c) ? c : '%' + b.toString(16).toUpperCase().padStart(2, '0')
  }
  return out
}
const canonicalUri   = (pathname: string) => pathname.split('/').map(seg => { try { return awsEncode(decodeURIComponent(seg)) } catch { return awsEncode(seg) } }).join('/')
const canonicalQuery = (params: URLSearchParams, skip?: string) =>
  [...params].filter(([k]) => k !== skip).map(([k, v]) => [awsEncode(k), awsEncode(v)]).sort(([a, b], [c, d]) => a < c ? -1 : a > c ? 1 : b < d ? -1 : b > d ? 1 : 0).map(([k, v]) => `${k}=${v}`).join('&')

const amzToDate = (amz: string) => new Date(amz.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z'))

export function startS3Sink(opts: S3SinkOptions = {}) {
  const AK = opts.accessKeyId ?? 'AKIADEV', SK = opts.secretAccessKey ?? 'devsecret', REGION = opts.region ?? 'us-east-1'
  const objects = new Map<string, { bytes: Uint8Array<ArrayBuffer>; contentType: string; etag: string; lastModified: string }>()
  const seen: { method: string; path: string; status: number }[] = []
  const armed = { lost: false, slowDown: null as null | { retryAfter: number }, skew: 0, scope: null as null | string }
  const hanging: Array<() => void> = []

  function signingKey(dateStamp: string, region: string, service: string) {
    return hmac(hmac(hmac(hmac(`AWS4${SK}`, dateStamp), region), service), 'aws4_request')
  }

  /** Null when the request verifies, else the XML refusal. */
  function verify(req: Request, url: URL, body: Uint8Array): Response | null {
    const now = Date.now() + armed.skew * 1000
    const auth = req.headers.get('authorization')
    if (auth) {
      const m = auth.match(/^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/)
      if (!m) return xml('AuthorizationHeaderMalformed', 'The authorization header is malformed', 400)
      const [, ak, dateStamp, region, service, signedHeaders, sig] = m
      if (ak !== AK) return xml('InvalidAccessKeyId', 'The AWS Access Key Id you provided does not exist in our records.', 403)
      if (region !== REGION) return xml('AuthorizationHeaderMalformed', `the region '${region}' is wrong; expecting '${REGION}'`, 400)
      const amzDate = req.headers.get('x-amz-date') ?? ''
      if (Math.abs(now - amzToDate(amzDate).getTime()) > 15 * 60 * 1000) return xml('RequestTimeTooSkewed', 'The difference between the request time and the current time is too large.', 403)
      const claimed = req.headers.get('x-amz-content-sha256') ?? ''
      const actual  = sha256(body)
      if (claimed !== 'UNSIGNED-PAYLOAD' && claimed !== actual) return xml('XAmzContentSHA256Mismatch', 'The provided x-amz-content-sha256 does not match what was computed.', 400)
      const names = signedHeaders.split(';')
      const canonHeaders = names.map(n => `${n}:${(n === 'host' ? url.host : req.headers.get(n) ?? '').trim().replace(/\s+/g, ' ')}\n`).join('')
      const canonical = [req.method, canonicalUri(url.pathname), canonicalQuery(url.searchParams), canonHeaders, signedHeaders, claimed].join('\n')
      const toSign = ['AWS4-HMAC-SHA256', amzDate, `${dateStamp}/${region}/${service}/aws4_request`, sha256(canonical)].join('\n')
      const want = hex(hmac(signingKey(dateStamp, region, service), toSign))
      if (want.length !== sig.length || !timingSafeEqual(Buffer.from(want), Buffer.from(sig))) return xml('SignatureDoesNotMatch', 'The request signature we calculated does not match the signature you provided.', 403)
      return null
    }
    const q = url.searchParams
    if (q.get('X-Amz-Algorithm') === 'AWS4-HMAC-SHA256') {
      const [ak, dateStamp, region, service] = (q.get('X-Amz-Credential') ?? '').split('/')
      if (ak !== AK) return xml('InvalidAccessKeyId', 'no such key', 403)
      const amzDate = q.get('X-Amz-Date') ?? ''
      const issued  = amzToDate(amzDate).getTime()
      // AWS bounds the expiry to 1..604800 seconds and answers 400 outside it,
      // so a negative expiry never reaches the expired branch below.
      const expires = Number(q.get('X-Amz-Expires') ?? 0)
      if (!(expires >= 1 && expires <= 604800)) return xml('AuthorizationQueryParametersError', 'X-Amz-Expires must be between 1 and 604800', 400)
      if (now > issued + expires * 1000) return xml('AccessDenied', 'Request has expired', 403)
      const canonical = [req.method, canonicalUri(url.pathname), canonicalQuery(q, 'X-Amz-Signature'), `host:${url.host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n')
      const toSign = ['AWS4-HMAC-SHA256', amzDate, `${dateStamp}/${region}/${service}/aws4_request`, sha256(canonical)].join('\n')
      const want = hex(hmac(signingKey(dateStamp, region, service), toSign)), sig = q.get('X-Amz-Signature') ?? ''
      if (want.length !== sig.length || !timingSafeEqual(Buffer.from(want), Buffer.from(sig))) return xml('SignatureDoesNotMatch', 'presigned signature does not match', 403)
      return null
    }
    return xml('AccessDenied', 'Access Denied', 403)
  }

  // ListObjectsV2. The token is the last key returned, so a page boundary that
  // falls between two keys sharing a prefix is what the paging row crosses.
  function list(bucket: string, q: URLSearchParams): Response {
    const prefix = q.get('prefix') ?? '', after = q.get('continuation-token') ?? q.get('start-after') ?? ''
    const max = Math.min(Number(q.get('max-keys') ?? 1000), 1000)
    const keys = [...objects.keys()].filter(id => id.startsWith(`${bucket}/`)).map(id => id.slice(bucket.length + 1))
      .filter(k => k.startsWith(prefix) && (!after || Buffer.compare(Buffer.from(k), Buffer.from(after)) > 0))
      .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
    const page = keys.slice(0, max), truncated = keys.length > max
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    const contents = page.map(k => { const o = objects.get(`${bucket}/${k}`)!
      return `<Contents><Key>${esc(k)}</Key><LastModified>${new Date(o.lastModified).toISOString()}</LastModified><ETag>${esc(o.etag)}</ETag><Size>${o.bytes.byteLength}</Size><StorageClass>STANDARD</StorageClass></Contents>` }).join('')
    return new Response(`<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${esc(bucket)}</Name><Prefix>${esc(prefix)}</Prefix><KeyCount>${page.length}</KeyCount><MaxKeys>${max}</MaxKeys><IsTruncated>${truncated}</IsTruncated>${contents}${truncated ? `<NextContinuationToken>${esc(page[page.length - 1])}</NextContinuationToken>` : ''}</ListBucketResult>`,
      { status: 200, headers: { 'content-type': 'application/xml' } })
  }

  const server = Bun.serve({
    port: opts.port ?? 0,
    async fetch(req) {
      const url = new URL(req.url), path = url.pathname
      if (path === '/_sink/seen')  return Response.json({ requests: seen, keys: [...objects.keys()] })
      if (path === '/_sink/reset') { seen.length = 0; Object.assign(armed, { lost: false, slowDown: null, skew: 0, scope: null }); return Response.json({ ok: true }) }
      if (path === '/_sink/arm')   { Object.assign(armed, await req.json()); return Response.json({ ok: true }) }

      const body = new Uint8Array(await req.arrayBuffer())
      // Recorded on ARRIVAL, so a request held open by `lost` still counts as
      // an attempt the connector made.
      const entry = { method: req.method, path, status: 0 }
      seen.push(entry)
      const record = (res: Response) => { entry.status = res.status; return res }

      const refused = verify(req, url, body)
      if (refused) return record(refused)

      if (armed.slowDown) { const { retryAfter } = armed.slowDown; armed.slowDown = null; return record(xml('SlowDown', 'Please reduce your request rate.', 503, { 'retry-after': String(retryAfter) })) }

      const listing = path.match(/^\/([^/]+)\/?$/)
      if (listing && req.method === 'GET' && url.searchParams.get('list-type') === '2') return record(list(decodeURIComponent(listing[1]), url.searchParams))

      const m = path.match(/^\/([^/]+)\/(.+)$/)
      if (!m) return record(xml('InvalidRequest', 'path-style /bucket/key only', 400))
      const bucket = decodeURIComponent(m[1]), key = m[2].split('/').map(decodeURIComponent).join('/')
      const id = `${bucket}/${key}`
      if (key.startsWith('private/')) return record(xml('AccessDenied', 'Access Denied', 403))
      if (armed.scope != null && !key.startsWith(armed.scope)) return record(xml('AccessDenied', 'Access Denied', 403))

      let answer: Response
      const obj = objects.get(id)
      const headersFor = (o: NonNullable<typeof obj>) => ({ etag: o.etag, 'content-type': o.contentType, 'content-length': String(o.bytes.byteLength), 'last-modified': o.lastModified })

      if (req.method === 'PUT') {
        if (req.headers.get('if-none-match') === '*' && obj) answer = xml('PreconditionFailed', 'At least one of the pre-conditions you specified did not hold', 412)
        else {
          const etag = `"${createHash('md5').update(body).digest('hex')}"`
          objects.set(id, { bytes: body, contentType: req.headers.get('content-type') ?? 'application/octet-stream', etag, lastModified: new Date().toUTCString() })
          answer = new Response(null, { status: 200, headers: { etag } })
        }
      } else if (req.method === 'GET' || req.method === 'HEAD') {
        if (!obj) answer = xml('NoSuchKey', 'The specified key does not exist.', 404)
        else if (req.headers.get('if-none-match') === obj.etag) answer = new Response(null, { status: 304, headers: { etag: obj.etag } })
        else answer = new Response(req.method === 'HEAD' ? null : obj.bytes, { status: 200, headers: headersFor(obj) })
      } else if (req.method === 'DELETE') {
        if (!obj) answer = xml('NoSuchKey', 'The specified key does not exist.', 404)
        else { objects.delete(id); answer = new Response(null, { status: 204 }) }
      } else answer = xml('MethodNotAllowed', req.method, 405)

      if (armed.lost) { armed.lost = false; await new Promise<void>(r => hanging.push(r)) }
      return record(answer)
    },
  })
  return { port: server.port, url: `http://127.0.0.1:${server.port}`, region: REGION, credential: `${AK}:${SK}`, stop() { for (const r of hanging) r(); server.stop(true) } }
}

if (import.meta.main) console.log(`[s3-sink] ${startS3Sink({ port: Number(process.env.S3_SINK_PORT ?? 8125) }).url}`)
