// src/providers/source/index.ts
// Writing to a FORGE — the boundary, and who speaks it.
//
// The edge pattern, for the reason `FJS-D1571` gives: a GitHub token is a
// workspace ACCOUNT, a `Secret` of kind `provider_key`, registered as the
// conduit target `provider:<kind>:<accountId>` by `compute/accounts.ts`. What
// lives here is what a target cannot carry — the two things an App's
// repository is told at connect, the one file read from it, and what the
// forge's answer means.
//
// The token is used at setup and to read a file a person asks for, never on
// a release: a push arrives on the webhook's HMAC (`plugins/push.ts`) and the
// machine clones with the deploy key, so a revoked token is found at the next
// connect or read, never at a push. A write goes through `sendVia` and so
// meets its guard: a process pointed at the real forge by mistake rewrites a
// real repository's hooks.

import type { TargetDescriptor }  from '@frontierjs/conduit'
import type { ProviderKind }      from '../../../../db/schema.d.ts'
import type { AccountSend }       from '../compute/index.ts'
import { github }                 from './github.ts'

/** A repository at a forge, as its API addresses it. */
export interface SourceRepo {
  owner: string
  name:  string
}

/** The forge answered as though the repository were not there. A forge says
 *  this for a repository the token was not given too, so a workspace holding
 *  several tokens asks the next one. */
export class RepoUnseen extends Error {}

/** A key the forge lets clone the repository. */
export interface DeployKey {
  id:       string
  title:    string
  /** The public half as the forge holds it: `<type> <base64>`, no comment. */
  key:      string
  readOnly: boolean
}

/** A webhook on the repository. The secret is never read back: a forge
 *  answers it masked, so a hook found by its URL is rewritten whole. */
export interface PushHook {
  id:     string
  url:    string
  events: string[]
  active: boolean
}

/** One forge's dialect. `kind`, `label`, `descriptor` and `verify` are the
 *  account half every connector shares (`AccountConnector` in
 *  `compute/accounts.ts`); the two writes are the forge's own. Each is safe to
 *  repeat: a second connect finds what the first wrote. */
export interface SourceConnector {
  kind:    ProviderKind
  label:   string
  address: string
  descriptor(opts: { accountId: string; ref: string; address?: string }): TargetDescriptor
  /** Does the forge accept this token? */
  verify(send: AccountSend): Promise<boolean>
  /** Make the repository trust this public key, read-only. Answers the key as
   *  the forge holds it, whether it was added now or was already there. */
  setDeployKey(send: AccountSend, repo: SourceRepo, key: { title: string; key: string }): Promise<DeployKey>
  /** Make the repository send its pushes to this URL, signed with this secret.
   *  A hook already at the URL is updated rather than a second one added. */
  setPushHook(send: AccountSend, repo: SourceRepo, hook: { url: string; secret: string }): Promise<PushHook>
  /** The first of `paths` the repository holds at `ref` (no ref is the default
   *  branch), or null for none. A repository the token does not see throws
   *  `RepoUnseen`, so a missing file is never read as a missing repository. */
  readFile(send: AccountSend, repo: SourceRepo, at: { paths: string[]; ref?: string | null }): Promise<{ path: string; content: string } | null>
}

const CONNECTORS: Partial<Record<ProviderKind, SourceConnector>> = {
  github,
}

/** The source connector for a vendor, or null where this app writes to no
 *  repository there. */
export function sourceConnectorFor(kind: ProviderKind | null | undefined): SourceConnector | null {
  if (!kind) return null
  return CONNECTORS[kind] ?? null
}
