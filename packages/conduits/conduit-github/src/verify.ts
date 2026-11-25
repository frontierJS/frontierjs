// src/verify.ts — is this really GitHub?
//
// GitHub signs the exact bytes of the delivery with the hook's secret and
// sends `X-Hub-Signature-256: sha256=<hex>`. Forgejo and Gitea send the same
// header over the same scheme, so one verifier serves all three. Two details
// that are each a hole: the HMAC is over the RAW bytes (a re-serialized body is
// a different document); and the compare is constant-time with the length
// checked first, because `timingSafeEqual` throws on a mismatch, which is
// itself an oracle. There is no timestamp in the scheme, so there is no clock
// to take and no freshness to grade: a captured delivery verifies forever, and
// replay is the receiver's dedupe, keyed on the signed bytes.

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import type { PushEvent } from './types.ts'

export type Verified = { ok: true } | { ok: false; reason: string }

export function verifyGithubSignature(opts: { rawBody: string | Uint8Array; header: string | null | undefined; secret: string | undefined }): Verified {
  const { rawBody, header, secret } = opts
  if (!secret) return { ok: false, reason: 'no hook secret is configured on this side' }
  if (!header?.startsWith('sha256=')) return { ok: false, reason: 'no X-Hub-Signature-256' }
  const want = Buffer.from(createHmac('sha256', secret).update(rawBody).digest('hex'), 'utf8')
  const have = Buffer.from(header.slice('sha256='.length), 'utf8')
  if (have.length !== want.length || !timingSafeEqual(have, want)) return { ok: false, reason: 'signature does not match' }
  return { ok: true }
}

type Headers = Record<string, string | undefined>
const first = (h: Headers, ...names: string[]) => names.map(n => h[n]).find(Boolean)
const text = (v: unknown) => typeof v === 'string' && v ? v : null

/**
 * The push a delivery names, or null for an event nobody asked us to act on
 * (a ping, an issue comment): the receiver answers 200 and ignores it, because
 * a 4xx is retried and shown red. Header names are lower-case, as a receiver
 * reads them; the three forges all send `head_commit`.
 */
export function parsePush(d: { headers: Headers; body: unknown }): PushEvent | null {
  const kind = first(d.headers, 'x-github-event', 'x-forgejo-event', 'x-gitea-event')
  if (kind && kind !== 'push') return null
  const body = (d.body && typeof d.body === 'object' ? d.body : {}) as Record<string, any>
  const after = typeof body.after === 'string' ? body.after : null
  const head  = body.head_commit && typeof body.head_commit === 'object' ? body.head_commit : {}
  return {
    id:   first(d.headers, 'x-github-delivery', 'x-forgejo-delivery', 'x-gitea-delivery') ?? randomUUID(),
    type: 'push',
    payload: {
      ref:           text(body.ref),
      after,
      deleted:       body.deleted === true || (after != null && /^0+$/.test(after)),
      defaultBranch: text(body.repository?.default_branch),
      author:        text(head.author?.name) ?? text(head.author?.username) ?? text(head.author?.email) ?? text(body.pusher?.name),
      message:       text(head.message),
    },
  }
}
