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
// Two ref forms, because this app has two kinds of credential:
//
//   `secret:<id>[#field]` — a Secret row, which is what a person typed into a
//                           form. Encrypted at rest, resolved here.
//   `env:<NAME>`          — a process-wide shared secret with no row and no
//                           owner. The outpost HMAC key is the only one: every
//                           machine in the fleet signs with it, so there is
//                           nothing per-target to store.
//
// Anything else resolves to null, which conduit treats as a hard failure
// (`auth_failed`) rather than sending unauthenticated traffic — so a typo
// cannot silently downgrade a request.
//
// Both are REFS. A descriptor that carried the material instead would put it in
// the registry and on the `GET /conduit-targets` answer, which is where the
// outpost secret sat until 2026-08-09 — in plaintext, and unusable besides,
// because conduit's hmac auth reads `ref` and nothing else.
//
// asSystem(): `Secret.data` is `@encrypted`, so a scoped client does not merely
// redact it, the key is absent from the row entirely. Reading it is a system
// act by construction. Nothing here returns the material to a caller — it goes
// to conduit's transport and no further.

import type { CredentialResolver } from '@frontierjs/conduit'
import type { BasecampDb } from './db.ts'
import { env } from './env.ts'

const REF     = /^secret:([^#]+)(?:#(.+))?$/
const ENV_REF = /^env:([A-Z0-9_]+)$/

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

      const named = ENV_REF.exec(ref)
      if (named) {
        const val = (env as Record<string, unknown>)[named[1]]
        return typeof val === 'string' && val
          ? val
          : miss(`${named[1]} is not declared in core/env.ts, or is empty`)
      }

      const m = REF.exec(ref)
      if (!m) return miss('not a ref this app issues — expected `secret:<id>[#field]` or `env:<NAME>`')
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
