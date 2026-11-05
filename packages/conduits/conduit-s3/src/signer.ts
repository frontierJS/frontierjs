// src/signer.ts — SigV4 through conduit's signer seam (FJS-D891).
//
// SigV4 is NOT forked here: it is `@frontierjs/toolbelt/sigv4` (FJS-D892). The
// kit is pure, so the instant is passed in on every signature; litestone's
// storage layer keeps a cache of derived day-keys beside the same kit, which a
// signer here does without, at four HMACs a request.
//
// The region and the service ride the descriptor as `auth.params` (FJS-2725),
// so one signer serves every region: `signers: { [S3_SIGNER]: s3Signer }`.
// The resolver's one string holds both halves of the credential as
// `<accessKeyId>:<secretAccessKey>`.

import type { Signer } from '@frontierjs/conduit'
import { signRequest, presignUrl, uriEncode } from '@frontierjs/toolbelt/sigv4'

export { uriEncode }

export interface S3Credential { accessKeyId: string; secretAccessKey: string }

/** `"<accessKeyId>:<secretAccessKey>"` → the pair. The key id never holds a colon. */
export function splitCredential(secret: string): S3Credential {
  const i = secret.indexOf(':')
  if (i <= 0 || i === secret.length - 1) throw new Error('s3: the credential must be "<accessKeyId>:<secretAccessKey>"')
  return { accessKeyId: secret.slice(0, i), secretAccessKey: secret.slice(i + 1) }
}

export const S3_SIGNER = 's3-sigv4'

export const s3Signer: Signer = async ({ secret, params, method, url, body, headers }) => {
  const { region, service = 's3' } = params
  // A target not built by s3Target. Thrown, so it is auth_failed with nothing sent.
  if (!region) throw new Error('s3: the target names no region (auth.params.region)')
  const { accessKeyId, secretAccessKey } = splitCredential(secret)
  // Every header conduit will send is signed, so a proxy that rewrites one
  // is a 403 rather than a silent difference. `body` is the bytes conduit
  // serialized — string for a text put, Uint8Array for binary — and the
  // hash goes over exactly those.
  const signed = await signRequest(method, url, headers, body ?? null, { accessKeyId, secretAccessKey, region, service, now: new Date() })
  return { headers: signed }
}

/** A URL the browser uses directly. It never crosses conduit: the connector
 *  mints it, and the secret is the resolver's answer handed in by the caller. */
export function presign(opts: { method?: 'GET' | 'PUT'; url: string; credential: string; region: string; expiresIn?: number; service?: string }): Promise<string> {
  const { accessKeyId, secretAccessKey } = splitCredential(opts.credential)
  return presignUrl(opts.method ?? 'GET', opts.url, { accessKeyId, secretAccessKey, region: opts.region, service: opts.service ?? 's3', now: new Date() }, opts.expiresIn ?? 3600)
}
