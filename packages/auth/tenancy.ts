// tenancy.ts
// What the app's tenancy declaration says about a person, read off its client.
// This package declares no tenant column (`FJS-D1117`): the app's `tenancy`
// block is the one answer, and auth reads it here rather than at each caller.

import { authModelOf } from '@frontierjs/litestone'

type Tenancy = { strategy?: string; column?: string | null; claim?: string | null }

function tenancyOf(db: unknown): Tenancy | null {
  // An unknown property on a Litestone client throws rather than answering.
  try { return (db as { $tenancy?: Tenancy | null })?.$tenancy ?? null } catch { return null }
}

/** The claim `tenancy { claim }` names, where the schema declares row tenancy. */
export function tenancyClaim(db: unknown): string | null {
  const t = tenancyOf(db)
  return t?.strategy === 'row' && t.claim ? t.claim : null
}

/**
 * The column and claim row tenancy names, where the app's `@@auth` model declares
 * that column — a person is placed in a tenant by writing it, and their session
 * carries it as the claim. Null for a membership-tenanted app, whose column is
 * on another model and whose person is placed by a row this package does not
 * write.
 */
export function userTenancy(db: unknown): { column: string; claim: string } | null {
  const t = tenancyOf(db)
  if (t?.strategy !== 'row' || !t.column || !t.claim) return null
  const schema = (db as { $schema?: { models: Array<{ name: string; fields?: Array<{ name: string }> }> } })?.$schema
  const user = schema?.models ? authModelOf(schema) : null
  return user?.fields?.some(f => f.name === t.column) ? { column: t.column, claim: t.claim } : null
}
