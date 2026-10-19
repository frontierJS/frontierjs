// test/totp-export.test.ts
//
// FJS-3106: a seed or drive that must type a code for a secret it enrolled
// imports the package's arithmetic rather than carrying a second HOTP.

import { test, expect } from 'bun:test'
import pkg from '../package.json'
import * as local from '../totp.ts'

test('./totp is a published subpath, and it is the package\'s own totp.ts', () => {
  expect((pkg.exports as Record<string, string>)['./totp']).toBe('./totp.ts')
  expect((pkg.files as string[])).toContain('*.ts')
})

test('the subpath resolves by name and agrees with RFC 6238', async () => {
  const mod = await import('@frontierjs/auth/totp')
  expect(mod.totp).toBe(local.totp)
  // RFC 6238 Appendix B, SHA-1, T = 59 s -> 94287082 (8 digits); 6 digits is its tail.
  const secret = mod.base32Encode(new TextEncoder().encode('12345678901234567890'))
  expect(mod.totp(secret, new Date(59_000))).toBe('287082')
})
