// src/providers/model/anthropic.ts
// Anthropic's dialect, and the one owner of a workspace's Anthropic key
// (`FJS-D2109`).
//
// The key is a workspace ACCOUNT like a GitHub token (`FJS-D1571`): a `Secret`
// of kind `providerKey`, `providerKind: anthropic`, registered as the conduit
// target `provider:anthropic:<accountId>` by `compute/accounts.ts`. The target
// exists for `verify`; a run of Claude Code is not a conduit call, so the key
// leaves here as a string for `anthropicKey`'s one caller to hand a child's
// environment.

import { createSecretResolver }   from '../../core/credentials.ts'
import { targetFor }              from '../compute/index.ts'
import type { TargetDescriptor }  from '@frontierjs/conduit'
import type { AccountSend }       from '../compute/index.ts'
import type { ProviderKind }      from '#db/schema.d.ts'
import type { App }               from '@frontierjs/junction'

const API = 'https://api.anthropic.com'

/** Unpinned, Anthropic answers in whatever version it defaults to that year. */
const API_VERSION = '2023-06-01'

/** The account half every connector shares (`AccountConnector` in
 *  `compute/accounts.ts`); nothing here writes to the vendor. */
export interface ModelConnector {
  kind:  ProviderKind
  label: string
  descriptor(opts: { accountId: string; ref: string; address?: string }): TargetDescriptor
  /** Does Anthropic accept this key? */
  verify(send: AccountSend): Promise<boolean>
}

export const anthropic: ModelConnector = {
  kind:  'anthropic',
  label: 'Anthropic',

  descriptor({ accountId, ref, address }): TargetDescriptor {
    return {
      id:            targetFor('anthropic', accountId),
      kind:          'provider',
      protocol:      'http',
      address:       address || API,
      auth:          { type: 'api_key', ref, header: 'x-api-key' },
      headers:       { 'anthropic-version': API_VERSION },
      registered_at: Date.now(),
      last_seen_at:  null,
    } as TargetDescriptor
  },

  async verify(send): Promise<boolean> {
    // The cheapest authenticated read: it bills nothing and needs no grant, so
    // a 401 is the key refused and any other client error is a key this
    // account cannot use, which a run would refuse the same way.
    const res = await send({ method: 'GET', path: '/v1/models?limit=1' })
    if (res.error) {
      if (res.status && res.status < 500) return false
      throw new Error(`Anthropic: ${res.error.kind}`)
    }
    return true
  },
}

const CONNECTORS: Partial<Record<ProviderKind, ModelConnector>> = { anthropic }

/** The model connector for a vendor, or null where this app calls no model there. */
export function modelConnectorFor(kind: ProviderKind | null | undefined): ModelConnector | null {
  if (!kind) return null
  return CONNECTORS[kind] ?? null
}

/**
 * The Anthropic key a run in this workspace spends, or null where it holds none.
 * The one place a key is resolved for a run; the token goes to the child's
 * environment (`site-ask.ts`) and nowhere else — no argv, status file, row or log.
 *
 * Read as the system, scoped to the workspace: an editor holding a grant on a
 * site is not an administrator and cannot read a `Secret`, and the grant is what
 * authorizes the ask (`gitCredential` reasons the same). Several keys answer in
 * name order, so which one bills is the one that sorts first.
 */
export async function anthropicKey(app: App, workspaceId: string): Promise<string | null> {
  const { tokenRef } = await import('../compute/accounts.ts')
  const db       = (app as unknown as { db: any }).db
  const accounts = await db.asSystem().secret.findMany({
    where:   { workspaceId, kind: 'providerKey', providerKind: 'anthropic' },
    select:  { id: true },
    orderBy: { name: 'asc' },
  }) as { id: string }[]

  for (const a of accounts) {
    const token = await createSecretResolver(db).get(tokenRef(a.id))
    if (typeof token === 'string' && token) return token
  }
  return null
}
