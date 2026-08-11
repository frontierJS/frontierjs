// crypto.ts
// Internal cryptographic utilities.
// Nothing here is exported from the package — all usage is via auth.ts.

import { createHmac, randomBytes } from 'crypto'
import { parseTtl }                from '@frontierjs/junction'

// ─── Password hashing ─────────────────────────────────────────────────────
// Bun's native bcrypt — no external dep.

export async function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, { algorithm: 'bcrypt', cost: 12 })
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return Bun.password.verify(password, hash)
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
