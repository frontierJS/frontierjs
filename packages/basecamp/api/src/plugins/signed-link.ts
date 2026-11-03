// src/plugins/signed-link.ts — the one signer behind every link this hub mints
// for a route that carries its own credential (`backup-archive.ts`,
// `app-archive-upload.ts`, `app-archive-pull.ts`).
//
// A navigation carries no bearer and a stream route runs no pipeline, so the
// method that graded the caller signs the link and the route checks only the
// signature. The key is random per process: a restart voids every link
// outstanding, which costs a click, and there is no key to keep or leak.
//
// `purpose` is signed first, so a link minted for one route is no credential
// for another even when their fields happen to line up.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

const KEY = randomBytes(32)

export const LINK_TTL_MS = 5 * 60_000

/** Bun refuses a request body over 128 MB before any route reads it
 *  (`FJS-3090`). A link that would carry more is refused by the method that
 *  mints it, with a sentence, instead of by Bun with a bare 413. */
export const BODY_CEILING_BYTES = 128 * 1024 * 1024

const sign = (purpose: string, fields: readonly string[], expires: number) =>
  createHmac('sha256', KEY).update([purpose, ...fields, expires].join('\n')).digest('hex')

/** The expiry and signature one link carries. */
export function mint(purpose: string, fields: readonly string[], now = Date.now()): { expires: number; sig: string } {
  const expires = now + LINK_TTL_MS
  return { expires, sig: sign(purpose, fields, expires) }
}

/** Is this expiry and signature one `mint` made for these fields, still in time. */
export function check(purpose: string, fields: readonly string[], expires: unknown, sig: unknown): boolean {
  const at = Number(expires)
  if (!Number.isFinite(at) || at < Date.now()) return false
  const want = Buffer.from(sign(purpose, fields, at)), got = Buffer.from(String(sig ?? ''))
  return want.length === got.length && timingSafeEqual(want, got)
}
