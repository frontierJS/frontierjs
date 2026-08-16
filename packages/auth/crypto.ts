// crypto.ts
// Internal cryptographic utilities.
// Nothing here is exported from the package — all usage is via auth.ts.

import { createHmac, randomBytes } from 'crypto'
import { parseTtl }                from '@frontierjs/junction'

// ─── Password hashing ─────────────────────────────────────────────────────
// Bun's native bcrypt — no external dep.

export const BCRYPT_COST = 12

export async function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, { algorithm: 'bcrypt', cost: BCRYPT_COST })
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return Bun.password.verify(password, hash)
}

// A bcrypt hash of a value nobody holds, at the same cost every stored password
// is written with. Nothing is ever meant to match it; it exists to be compared
// against and thrown away.
//
// A login that bails before the comparison answers in a millisecond where one
// that reaches it answers in ~220ms, and that difference is readable from a
// clock alone — so an identical error message still tells a caller whether an
// address exists. `payPasswordCost` is what the early-bail paths call so every
// refusal costs the same. The remaining difference is a database read, which is
// three orders of magnitude below the bcrypt and not separable from noise.
//
// The cost is asserted against BCRYPT_COST in tests/flows.test.ts: raise the
// cost and this literal has to be regenerated, or the gap quietly reopens.
export const DUMMY_HASH = '$2b$12$rbdqjSKMTYmj64JolfD1NOrdSG1SE3VW2XQ25qeYqQsRXuWq1WpYy'

export async function payPasswordCost(password: string): Promise<void> {
  await Bun.password.verify(password, DUMMY_HASH)
}

// ─── API key generation + hashing ─────────────────────────────────────────
// Raw key is returned once to the caller — never stored.
// HMAC-SHA256 of the raw key is stored in credentials.value.
// The field is also @guarded(all) so the hash never leaks in API responses.
//
// The HMAC key is the app's encryptionKey from LitestoneAuthOptions — not a
// hardcoded constant. This ensures stored hashes cannot be brute-forced
// without knowing the application secret.

// Both an API key and a session token arrive as a Bearer token, and the
// transport has exactly one door for them (verifySession). The prefix is what
// lets that door route without a wasted session lookup on every machine
// request — so it is a constant here rather than a literal in the template.
export const API_KEY_PREFIX = 'fjs_'

export function generateApiKey(): string {
  return `${API_KEY_PREFIX}${randomBytes(32).toString('base64url')}`
}

export function hashApiKey(rawKey: string, secret: string): string {
  return createHmac('sha256', secret).update(rawKey).digest('hex')
}

// ─── Verification tokens ──────────────────────────────────────────────────
// Opaque random token — stored as-is in verifications.value.
// The field is @guarded(all) so it never leaks in API responses.

export function generateToken(): string {
  return randomBytes(32).toString('base64url')
}

// ─── Session tokens ───────────────────────────────────────────────────────
// UUID — simple, indexed, opaque.

export function generateSessionToken(): string {
  return crypto.randomUUID()
}

// ─── TTL helper ───────────────────────────────────────────────────────────

export function expiresAt(ttl: string): string {
  return new Date(Date.now() + parseTtl(ttl)).toISOString()
}
