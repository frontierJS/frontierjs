// src/core/credentials.ts
// Conduit's credential resolver, backed by Basecamp's own Secret model.
//
// A conduit target carries a credential REFERENCE, never the credential — the
// registry, `resolve()`, `list()` and the `GET /conduit-targets` management
// route all see the ref and nothing else. Conduit's default resolver reads
// `process.env`, which is exactly wrong for a credential a person typed into a
// form five seconds ago: it is in the database, encrypted, and there is no
// process restart between the two.
//
// Three ref forms, because this app has three kinds of credential:
//
//   `secret:<id>[#field]` — a Secret row, which is what a person typed into a
//                           form. Encrypted at rest, resolved here.
//   `env:<NAME>`          — a process-wide secret with no row and no owner.
//   `hub:signing`         — this install's own Ed25519 private key, which
//                           signs every command to an Outpost (`FJS-D1604`).
//                           Derived from ENCRYPTION_KEY, never stored, so a
//                           restore under the same key keeps every machine
//                           enrolled and rotating that key re-enrolls them.
//
// Anything else resolves to null, which conduit treats as a hard failure
// (`auth_failed`) rather than sending unauthenticated traffic — so a typo
// cannot silently downgrade a request.
//
// All are REFS. A descriptor that carried the material instead would put it in
// the registry and on the `GET /conduit-targets` answer, in plaintext.
//
// asSystem(): `Secret.data` is `@encrypted`, so a scoped client does not merely
// redact it, the key is absent from the row entirely. Reading it is a system
// act by construction. Nothing here returns the material to a caller — it goes
// to conduit's transport and no further.

import type { CredentialResolver } from '@frontierjs/conduit'
import { generateSigningKeys } from '@frontierjs/toolbelt/signature'
import type { BasecampDb } from './db.ts'
import { env } from './env.ts'

const REF     = /^secret:([^#]+)(?:#(.+))?$/
const ENV_REF = /^env:([A-Z0-9_]+)$/

/** The ref a conduit target to an Outpost signs under. */
export const HUB_SIGNING_REF = 'hub:signing'

// The HKDF label is the key's name: changing it is a new hub key and every
// machine enrolls again.
const HUB_KEY_INFO = 'basecamp hub signing key v1'
let hubKeys: Promise<{ publicKey: string; privateKey: string }> | null = null

/**
 * This install's signing pair, derived from ENCRYPTION_KEY. The public half is
 * what an Outpost is handed at enrollment and pins; the private half leaves
 * this process only as a signature.
 */
export function hubSigningKeys(): Promise<{ publicKey: string; privateKey: string }> {
  hubKeys ??= (async () => {
    const ikm  = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.ENCRYPTION_KEY), 'HKDF', false, ['deriveBits'])
    const seed = await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(), info: new TextEncoder().encode(HUB_KEY_INFO) }, ikm, 256)
    return generateSigningKeys({ seed: new Uint8Array(seed) })
  })()
  return hubKeys
}

/**
 * `secret:<id>` — the one place this string shape is built.
 *
 * `Secret.data` holds a JSON document, because one secret often carries a pair
 * (a certificate and its key). A resolver answers ONE string, so a caller names
 * which key it wants: `secretRef(id, 'token')`. With no field the whole
 * document is returned, which is what a single-value secret wants.
 */
export function secretRef(secretId: string, field?: string): string {
  return field ? `secret:${secretId}#${field}` : `secret:${secretId}`
}

/**
 * `env:<NAME>` — a shared secret the process holds, named rather than carried.
 *
 * Read through `env` and not `process.env`, so a name that is not declared in
 * core/env.ts resolves to null and the send fails closed. A target signed with
 * a credential nobody declared is a target that works until the machine it was
 * configured on is replaced.
 */
export function envRef(name: string): string {
  return `env:${name}`
}

export function createSecretResolver(db: BasecampDb): CredentialResolver {
  return {
    async get(ref: string): Promise<string | null> {
      // The two early returns warn for the same reason the four below do: a
      // credential that does not resolve is a send with no credential, and
      // every one of these arrives at the caller as the vendor's own 401.
      const miss = (why: string) => {
        console.warn(`[credentials] ${ref} resolved to nothing — ${why}`)
        return null
      }

      if (ref === HUB_SIGNING_REF) return (await hubSigningKeys()).privateKey

      const named = ENV_REF.exec(ref)
      if (named) {
        const val = (env as Record<string, unknown>)[named[1]]
        return typeof val === 'string' && val
          ? val
          : miss(`${named[1]} is not declared in core/env.ts, or is empty`)
      }

      const m = REF.exec(ref)
      if (!m) return miss('not a ref this app issues — expected `secret:<id>[#field]`, `env:<NAME>` or `hub:signing`')
      const [, id, field] = m

      const secret = await (db as any).asSystem().secret.findFirst({ where: { id } })

      if (!secret)       return miss('no Secret row with that id')
      if (!secret.data)  return miss('the row has no data column — it may have been read without decryption')
      if (!field)        return secret.data as string

      let parsed: unknown
      try {
        parsed = JSON.parse(secret.data as string)
      } catch {
        return miss(`the data column is not JSON (${String(secret.data).slice(0, 12)}…)`)
      }
      const val = (parsed as Record<string, unknown> | null)?.[field]
      if (typeof val !== 'string')
        return miss(`the document has no string field '${field}' (keys: ${Object.keys((parsed ?? {}) as object).join(', ') || 'none'})`)
      return val
    },
  }
}
