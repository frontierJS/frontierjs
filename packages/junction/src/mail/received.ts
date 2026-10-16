// mail/received.ts
// The receiving half of the mail battery: what a mail looks like once a
// provider has delivered it, and the kit that threads a reply onto the record
// it answers (`FJS-D1091`, `FJS-D1092`).
//
// Nothing here listens. Mail arrives through a conduit Receiver whose Dialect
// the mail vendor's connector exports (`FJS-D899`): the dialect parses the
// vendor's payload into a `ReceivedMail`, and the app's `apply` reads it with
// `splitAddress` and `readReplyTag`. A connector copies `ReceivedMail`
// structurally, as it already does `MailMessage`, so this file is the one
// place the shape is written.
//
// The reply token rides the plus-tag of the address our mail was sent FROM:
// `support+<token>@acme.test`. The shape of the token is forced by the
// address and is `@frontierjs/toolbelt/signature`'s `mintToken` — a local part
// is at most 64 octets, a receiving server may fold its case, and the ULID
// carries the instant it was minted, so expiry costs no bits and no row.
//
// The token proves that whoever holds it RECEIVED our mail, and nothing about
// who is holding it now: a forward and a reply-all both arrive carrying it. A
// valid tag threads the reply onto its record; attributing the reply to the
// person we wrote to also needs `from` to be the address the mail went to.
// Any other `from` is a claim, and lands on the same record as its own sender.

import { mintToken, readToken } from '@frontierjs/toolbelt/signature'
import { assertAddress, assertMailbox, SmtpError } from './smtp.ts'
import type { MailMessage } from './index.ts'

// ─── The shape ────────────────────────────────────────────────────────────

/**
 * One mail as it arrived — `MailMessage` read the other way. `from` is the
 * sender's mailbox as a header writes it (`Name <addr>` or bare); Message-ID
 * and In-Reply-To are in `headers`, where outbound already puts them, read
 * with `headerOf`. `recipient` is the envelope address this delivery is for,
 * which is where a reply tag rides; a mail cc'd to two of our addresses is
 * two deliveries with one Message-ID.
 */
export interface ReceivedMail extends Omit<MailMessage, 'from' | 'headers'> {
  from:      string
  headers:   Record<string, string>
  recipient: string
}

/** A header by name, case-insensitively; `null` when the mail has none. */
export function headerOf(mail: Pick<ReceivedMail, 'headers'>, name: string): string | null {
  const key = Object.keys(mail.headers ?? {}).find(k => k.toLowerCase() === name.toLowerCase())
  const value = key === undefined ? null : mail.headers[key]?.trim()
  return value || null
}

// ─── The reply tag ────────────────────────────────────────────────────────

/** RFC 5321 § 4.5.3.1.1 — the longest local part an address may carry. */
export const LOCAL_PART_MAX = 64

// One purpose for every reply tag, so a secret shared with another token kit
// (an unsubscribe link, a magic link) cannot mint a tag that threads a reply.
const REPLY_PURPOSE = 'mail.reply'

/**
 * `support@acme.test` + the id of the record a reply should land on →
 * `support+<token>@acme.test`, for the message's `replyTo`. `id` is a ULID
 * (Crockford base32 — anything else cannot survive a server folding case and
 * is refused by `mintToken`). Throws when the result is not a legal address:
 * a mailbox whose local part is longer than 21 characters cannot carry a tag
 * at all, and that is known at mint, before anything is sent.
 */
export async function replyAddress(base: string, id: string, secret: string): Promise<string> {
  const address = assertAddress(base, 'replyAddress base')
  const at      = address.lastIndexOf('@')
  const local   = address.slice(0, at)
  const domain  = address.slice(at + 1)
  if (local.includes('+'))
    throw new SmtpError(`Mail: '${base}' already carries a plus-tag — a reply address is minted from the bare mailbox`)
  const token  = await mintToken({ id, secret, purpose: REPLY_PURPOSE })
  const tagged = `${local}+${token}`
  if (tagged.length > LOCAL_PART_MAX)
    throw new SmtpError(
      `Mail: '${tagged}@${domain}' has a ${tagged.length}-octet local part, and a local part is at most ${LOCAL_PART_MAX}. ` +
      `A mailbox that carries a reply tag has at most ${LOCAL_PART_MAX - 1 - token.length} characters before the @`)
  return `${tagged}@${domain}`
}

/**
 * `Support+ABC@Acme.test` → `{ base: 'support@acme.test', tag: 'abc' }`.
 * Lower-cased, since the lookup it feeds is against an address the app
 * stored and a receiving server may have folded the case. A display-name
 * form is reduced to its address; anything that is not an address at all is
 * answered as a base with no tag rather than thrown, because a throw inside
 * `apply` is a 500 the provider retries.
 */
export function splitAddress(recipient: string): { base: string; tag: string | null } {
  let address = String(recipient ?? '').trim()
  try { address = assertMailbox(address, 'recipient').address } catch { /* not a mailbox: split what was given */ }
  address = address.toLowerCase()
  const at = address.lastIndexOf('@')
  if (at < 1) return { base: address, tag: null }
  const local  = address.slice(0, at)
  const domain = address.slice(at + 1)
  const plus   = local.indexOf('+')
  if (plus === -1) return { base: address, tag: null }
  const tag = local.slice(plus + 1)
  return { base: `${local.slice(0, plus)}@${domain}`, tag: tag || null }
}

export type ReplyReading =
  | { ok: true;  id: string }
  | { ok: false; reason: 'malformed' | 'forged' | 'expired' }

/**
 * Is this tag one `replyAddress` minted, and is it still in date? `id` comes
 * back upper-case, as a ULID is stored. `now` is seconds from the caller's
 * clock and `ttlSeconds` is required: a reply tag expires (`FJS-D1092`), and
 * an expired or forged one still delivers the mail — to the base address's
 * record, with `from` a claim — rather than refusing it. `forged` is graded
 * before `expired`, so an old tag with a wrong MAC is not reported as old.
 */
export async function readReplyTag(tag: string, opts: { secret: string; now: number; ttlSeconds: number }): Promise<ReplyReading> {
  if (!Number.isFinite(opts?.ttlSeconds) || opts.ttlSeconds <= 0)
    throw new TypeError('readReplyTag: ttlSeconds is required — a reply tag expires, and the app states how long it lives')
  const read = await readToken(tag, { secret: opts.secret, purpose: REPLY_PURPOSE, now: opts.now, ttlSeconds: opts.ttlSeconds })
  return read.ok ? { ok: true, id: read.id.toUpperCase() } : read
}
