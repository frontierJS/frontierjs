// totp.ts
// RFC 6238 time-based one-time passwords, and RFC 4648 base32 under it.
// Pure arithmetic — no database, no configuration, and no clock of its own.
//
// `at` is a parameter on everything that needs an instant, for the same reason
// `sweepRenewals({ at })` takes one: a drift window, an expiry and a replay are
// all statements about two instants, and a function that reads the wall clock
// can only be tested by waiting.
//
// Nothing here is exported from the package — usage is via auth.ts and the
// account service.

import { createHmac, randomBytes, timingSafeEqual } from 'crypto'

// ─── base32 (RFC 4648, unpadded) ──────────────────────────────────────────
// An authenticator app reads the secret out of an otpauth:// URI, and that URI
// carries base32. base64url would be one character shorter and no app on any
// platform would accept it.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32Encode(bytes: Uint8Array): string {
  let out  = ''
  let bits = 0
  let acc  = 0

  for (const byte of bytes) {
    acc  = (acc << 8) | byte
    bits += 8
    while (bits >= 5) {
      out  += ALPHABET[(acc >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  // The trailing partial group is left-aligned — zero-fill on the RIGHT. Filling
  // on the left shifts every bit of the last character and produces a secret an
  // app accepts, enrolls, and then disagrees with on every code.
  if (bits > 0) out += ALPHABET[(acc << (5 - bits)) & 31]

  return out
}

export function base32Decode(text: string): Uint8Array {
  const clean = text.replace(/=+$/, '').replace(/\s+/g, '').toUpperCase()
  const out: number[] = []
  let bits = 0
  let acc  = 0

  for (const ch of clean) {
    const v = ALPHABET.indexOf(ch)
    // Refused by name rather than skipped. A typo in a hand-copied secret would
    // otherwise decode to different bytes and present as "the app is wrong".
    if (v < 0) throw new Error(`[auth] not base32: ${JSON.stringify(ch)}`)
    acc  = (acc << 5) | v
    bits += 5
    if (bits >= 8) {
      out.push((acc >>> (bits - 8)) & 255)
      bits -= 8
    }
  }

  return Uint8Array.from(out)
}

// ─── Secrets ──────────────────────────────────────────────────────────────

/** 20 bytes — SHA-1's block feed, and what every authenticator expects. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20))
}

// ─── HOTP / TOTP ──────────────────────────────────────────────────────────
// SHA-1, 6 digits, 30-second steps. All three are wrong to make configurable:
// they are what the authenticator on the other side implements, and a mismatch
// is not an error anywhere — it is codes that never match.

export const TOTP_DIGITS   = 6
export const TOTP_STEP_SEC = 30

/** The step a moment falls in. The unit every comparison here is made in. */
export function totpStep(at: Date, stepSec = TOTP_STEP_SEC): number {
  return Math.floor(at.getTime() / 1000 / stepSec)
}

export function hotp(secret: string, counter: number, digits = TOTP_DIGITS): string {
  const key = base32Decode(secret)

  // The counter is 8 bytes big-endian. Written through a DataView as a BigInt
  // because a step is seconds/30 and a bitwise `>>>` over it is a 32-bit
  // operation — correct until 2038 and then silently not.
  const buf = new Uint8Array(8)
  new DataView(buf.buffer).setBigUint64(0, BigInt(counter))

  const mac    = createHmac('sha1', key).update(buf).digest()
  const offset = mac[mac.length - 1] & 0x0f
  const code   = ((mac[offset] & 0x7f) << 24)
               | ((mac[offset + 1] & 0xff) << 16)
               | ((mac[offset + 2] & 0xff) << 8)
               |  (mac[offset + 3] & 0xff)

  return String(code % 10 ** digits).padStart(digits, '0')
}

/** The code for one instant. */
export function totp(secret: string, at: Date, digits = TOTP_DIGITS): string {
  return hotp(secret, totpStep(at), digits)
}

/**
 * Which step a code belongs to, or `null`.
 *
 * Answers the STEP rather than a boolean, and that is the whole reason a replay
 * can be refused: the caller stores what it accepted and compares the next one
 * against it. A boolean here makes the 30-second window a 30-second replay
 * window, and nothing about the code would look wrong.
 *
 * `drift` is in steps either side. One is ±30s and is what every implementation
 * allows; more widens the guessable space linearly.
 */
export function verifyTotp(
  secret: string,
  code:   string,
  at:     Date,
  drift   = 1,
): number | null {
  const digits = code.length
  if (digits !== TOTP_DIGITS || !/^\d+$/.test(code)) return null

  const now = totpStep(at)
  for (let d = -drift; d <= drift; d++) {
    if (constantTimeEqual(code, hotp(secret, now + d, digits))) return now + d
  }
  return null
}

/**
 * Both codes are six ASCII digits, so length is not secret and an unequal
 * length is a plain false. What must not leak is WHERE they differ: `===` on a
 * string returns at the first differing byte, which is a readable oracle over a
 * space small enough to walk.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  return timingSafeEqual(Buffer.from(a), Buffer.from(b))
}

// ─── Enrollment URI ───────────────────────────────────────────────────────

/**
 * The `otpauth://` URI an authenticator scans. `setupTotp`'s declared `qr` is
 * this string — rendering it as a QR code is the app's, because a server that
 * drew one would be choosing an image format and a size for every screen.
 *
 * `issuer` appears twice on purpose: in the label prefix, which is what old
 * apps read, and as a parameter, which is what current ones read. An app that
 * only reads one shows the account under a blank issuer.
 */
export function otpauthUri(opts: {
  secret:  string
  account: string
  issuer:  string
  digits?: number
  stepSec?: number
}): string {
  const label = `${encodeURIComponent(opts.issuer)}:${encodeURIComponent(opts.account)}`
  const q     = new URLSearchParams({
    secret:    opts.secret,
    issuer:    opts.issuer,
    algorithm: 'SHA1',
    digits:    String(opts.digits  ?? TOTP_DIGITS),
    period:    String(opts.stepSec ?? TOTP_STEP_SEC),
  })
  return `otpauth://totp/${label}?${q}`
}

// ─── Recovery codes ───────────────────────────────────────────────────────
// The way back when the device is gone. Generated here, hashed and stored by
// the caller as Credential rows, and DELETED on use rather than flagged.

export const RECOVERY_CODE_COUNT = 10

/**
 * Crockford's exclusions — `I`, `L`, `O` and `U` — plus `0` and `1`, which are
 * what `O` and `I` get mistyped as rather than the other way around. Thirty
 * characters, so a recovery code is ~49 bits over ten of them. Grouped with a
 * hyphen because that is how they get written down, and stripped again on the
 * way in.
 */
const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789'

export function generateRecoveryCode(): string {
  let out = ''
  for (let i = 0; i < 10; i++) {
    out += RECOVERY_ALPHABET[uniformIndex(RECOVERY_ALPHABET.length)]
    if (i === 4) out += '-'
  }
  return out
}

/**
 * `randomBytes(1)[0] % 30` is not uniform — 256 is not a multiple of 30, so the
 * first 16 characters of the alphabet come up slightly more often. It costs a
 * fraction of a bit per character and there is no reason to pay it: a byte
 * landing in the biased tail is drawn again.
 */
function uniformIndex(n: number): number {
  const limit = 256 - (256 % n)
  for (;;) {
    const b = randomBytes(1)[0]
    if (b < limit) return b % n
  }
}

export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  return Array.from({ length: count }, () => generateRecoveryCode())
}

/** What a code is compared as. A person retypes the hyphen, or does not. */
export function normalizeRecoveryCode(code: string): string {
  return code.replace(/[\s-]+/g, '').toUpperCase()
}
