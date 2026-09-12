// tests/totp.test.ts
//
// The arithmetic alone — no database, no provider. Two things are graded here
// that nothing else can grade: agreement with RFC 6238's PUBLISHED VECTORS, and
// the three refusals a second factor is worth nothing without.
//
// An implementation that agrees with itself is the failure mode this file
// exists for. Every other test in this package could pass against a `hotp` that
// is internally consistent and matches no authenticator on earth, because both
// sides of the comparison would come from the same function. The vectors are
// the only assertion here written by somebody else.

import { describe, test, expect } from 'bun:test'
import {
  base32Encode, base32Decode, generateTotpSecret,
  hotp, totp, totpStep, verifyTotp, constantTimeEqual,
  otpauthUri, TOTP_DIGITS, TOTP_STEP_SEC,
  generateRecoveryCode, generateRecoveryCodes, normalizeRecoveryCode,
  RECOVERY_CODE_COUNT,
} from '../totp.ts'

const enc = (s: string) => new TextEncoder().encode(s)

// RFC 6238 § Appendix B, the SHA-1 rows. The seed is the ASCII string
// "12345678901234567890"; base32 of it is what an authenticator would be given.
const RFC_SECRET = base32Encode(enc('12345678901234567890'))

describe('base32 — RFC 4648 § 10 vectors', () => {
  // Unpadded, which is what otpauth:// carries. The padded forms in the RFC are
  // "MY======" and so on; the decode side accepts either.
  const vectors: Array<[string, string]> = [
    ['f',      'MY'],
    ['fo',     'MZXQ'],
    ['foo',    'MZXW6'],
    ['foob',   'MZXW6YQ'],
    ['fooba',  'MZXW6YTB'],
    ['foobar', 'MZXW6YTBOI'],
  ]

  for (const [plain, b32] of vectors) {
    test(`${JSON.stringify(plain)} encodes to ${b32}`, () => {
      expect(base32Encode(enc(plain))).toBe(b32)
    })
    test(`${b32} decodes back to ${JSON.stringify(plain)}`, () => {
      expect(new TextDecoder().decode(base32Decode(b32))).toBe(plain)
    })
  }

  test('padding is accepted on the way in', () => {
    expect(new TextDecoder().decode(base32Decode('MZXW6==='))).toBe('foo')
  })

  test('a character outside the alphabet is refused by name, not skipped', () => {
    // Skipping it decodes to different bytes and presents to a person as "my
    // authenticator app is broken".
    expect(() => base32Decode('MZXW6!')).toThrow(/not base32/)
    expect(() => base32Decode('MZXW60')).toThrow(/not base32/)  // 0 and 1 are not in RFC 4648
  })

  test('round-trips every length through the partial-group boundary', () => {
    // 1..7 bytes covers all five trailing-bit cases. The fill side of the last
    // group is invisible in a round trip through our own decoder and visible in
    // the vectors above, which is why both halves are here.
    for (let n = 1; n <= 7; n++) {
      const bytes = Uint8Array.from(Array.from({ length: n }, (_, i) => i * 37 + 1))
      expect(Array.from(base32Decode(base32Encode(bytes)))).toEqual(Array.from(bytes))
    }
  })
})

describe('TOTP — RFC 6238 § Appendix B, SHA-1', () => {
  // The RFC prints 8-digit codes. Six digits is the same truncation one power
  // down, so the expected value is the last six.
  const vectors: Array<[number, string]> = [
    [59,          '287082'],
    [1111111109,  '081804'],
    [1111111111,  '050471'],
    [1234567890,  '005924'],
    [2000000000,  '279037'],
    [20000000000, '353130'],
  ]

  for (const [unixSec, expected] of vectors) {
    test(`T=${unixSec} → ${expected}`, () => {
      expect(totp(RFC_SECRET, new Date(unixSec * 1000))).toBe(expected)
    })
  }

  test('the 2038 row is the one that fails a 32-bit counter', () => {
    // T=20000000000 is step 666666666, which fits — but the counter is written
    // as 8 bytes and a `>>> 32` on a JS number does not. This row and the one
    // above it are the only two that can tell the difference.
    expect(totp(RFC_SECRET, new Date(20000000000 * 1000))).toBe('353130')
  })

  test('a step is 30 seconds, and both edges belong to it', () => {
    const base = 1111111080 // a step boundary: 1111111080 / 30 is exact
    expect(totpStep(new Date(base * 1000))).toBe(base / TOTP_STEP_SEC)
    expect(totpStep(new Date((base + 29) * 1000))).toBe(base / TOTP_STEP_SEC)
    expect(totpStep(new Date((base + 30) * 1000))).toBe(base / TOTP_STEP_SEC + 1)
  })

  test('hotp is the same function with the counter handed in', () => {
    expect(hotp(RFC_SECRET, 1)).toBe(totp(RFC_SECRET, new Date(59 * 1000)))
  })
})

describe('verifyTotp — what it answers, and the three ways it must refuse', () => {
  const at = new Date(1111111111 * 1000)

  test('answers the STEP a code belongs to, not a boolean', () => {
    // The whole reason a replay can be refused: the caller stores this and
    // compares the next one against it.
    expect(verifyTotp(RFC_SECRET, '050471', at)).toBe(totpStep(at))
  })

  test('accepts one step either side — and the pair is what makes drift a WINDOW', () => {
    const prev = totp(RFC_SECRET, new Date(at.getTime() - TOTP_STEP_SEC * 1000))
    const next = totp(RFC_SECRET, new Date(at.getTime() + TOTP_STEP_SEC * 1000))

    expect(verifyTotp(RFC_SECRET, prev, at)).toBe(totpStep(at) - 1)
    expect(verifyTotp(RFC_SECRET, next, at)).toBe(totpStep(at) + 1)

    // Two steps out is refused, which is what separates a window from "any
    // recent code". Asserted beside the acceptances above, because a function
    // that accepted everything satisfies the two rows before this one.
    const far = totp(RFC_SECRET, new Date(at.getTime() + TOTP_STEP_SEC * 2000))
    expect(verifyTotp(RFC_SECRET, far, at)).toBeNull()
  })

  test('drift: 0 accepts the current step and nothing else', () => {
    const prev = totp(RFC_SECRET, new Date(at.getTime() - TOTP_STEP_SEC * 1000))
    expect(verifyTotp(RFC_SECRET, '050471', at, 0)).toBe(totpStep(at))
    expect(verifyTotp(RFC_SECRET, prev, at, 0)).toBeNull()
  })

  test('a wrong code, a short code and a non-numeric code are all null', () => {
    expect(verifyTotp(RFC_SECRET, '000000', at)).toBeNull()
    expect(verifyTotp(RFC_SECRET, '05047', at)).toBeNull()
    expect(verifyTotp(RFC_SECRET, '', at)).toBeNull()
    // Refused before base32 or HMAC runs. A code that reaches the comparison as
    // a non-digit string is an input shape nothing downstream should see.
    expect(verifyTotp(RFC_SECRET, 'abcdef', at)).toBeNull()
  })

  test('another secret does not answer for this one', () => {
    const other = generateTotpSecret()
    expect(verifyTotp(other, '050471', at)).toBeNull()
  })
})

describe('constantTimeEqual', () => {
  test('equal, unequal, and unequal length', () => {
    expect(constantTimeEqual('050471', '050471')).toBe(true)
    expect(constantTimeEqual('050471', '050470')).toBe(false)
    // timingSafeEqual THROWS on a length mismatch, so the guard above it is
    // load-bearing rather than an optimization.
    expect(constantTimeEqual('050471', '05047')).toBe(false)
  })
})

describe('secrets and the enrollment URI', () => {
  test('a generated secret is 32 base32 characters of 20 bytes', () => {
    const s = generateTotpSecret()
    expect(s).toMatch(/^[A-Z2-7]{32}$/)
    expect(base32Decode(s).length).toBe(20)
  })

  test('two secrets differ', () => {
    expect(generateTotpSecret()).not.toBe(generateTotpSecret())
  })

  test('the URI carries the issuer TWICE, and the code it implies verifies', () => {
    const secret = generateTotpSecret()
    const uri    = otpauthUri({ secret, account: 'ada@example.com', issuer: 'Example Shop' })

    expect(uri.startsWith('otpauth://totp/Example%20Shop:ada%40example.com?')).toBe(true)

    const q = new URL(uri).searchParams
    expect(q.get('secret')).toBe(secret)
    expect(q.get('issuer')).toBe('Example Shop')   // the parameter current apps read
    expect(q.get('algorithm')).toBe('SHA1')
    expect(q.get('digits')).toBe(String(TOTP_DIGITS))
    expect(q.get('period')).toBe(String(TOTP_STEP_SEC))

    // The URI is only correct if a code derived from the secret it carries
    // verifies against it. Asserting the string alone passes against a URI
    // carrying somebody else's secret.
    const at = new Date()
    expect(verifyTotp(q.get('secret')!, totp(secret, at), at)).not.toBeNull()
  })
})

describe('recovery codes', () => {
  test('ten by default, all distinct', () => {
    const codes = generateRecoveryCodes()
    expect(codes.length).toBe(RECOVERY_CODE_COUNT)
    expect(new Set(codes).size).toBe(RECOVERY_CODE_COUNT)
  })

  test('grouped for transcription, and the confusable characters are absent', () => {
    for (const code of generateRecoveryCodes(50)) {
      expect(code).toMatch(/^[A-HJKMNP-TV-Z2-9]{5}-[A-HJKMNP-TV-Z2-9]{5}$/)
      // Crockford's four, plus the two digits they get mistyped as.
      expect(code).not.toMatch(/[01ILOU]/)
    }
  })

  test('normalize eats the hyphen, the spaces and the case', () => {
    expect(normalizeRecoveryCode('abcde-fghjk')).toBe('ABCDEFGHJK')
    expect(normalizeRecoveryCode(' ABCDE FGHJK ')).toBe('ABCDEFGHJK')
    expect(normalizeRecoveryCode('ABCDEFGHJK')).toBe('ABCDEFGHJK')
  })

  test('a generated code normalizes to something a lookup can match', () => {
    const code = generateRecoveryCode()
    expect(normalizeRecoveryCode(code)).toBe(code.replace('-', ''))
  })
})
