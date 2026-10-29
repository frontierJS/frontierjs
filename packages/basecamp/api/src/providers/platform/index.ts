// src/providers/platform/index.ts
// Reading what a vendor runs WITHOUT a machine — a Cloudflare Worker, later a
// Vercel project or a Netlify site — the boundary, and who speaks it
// (`IDEAS/app-platforms.md`, `FJS-D1629`).
//
// The account is edge's and compute's: a `Secret` of kind `provider_key`,
// registered by `compute/accounts.ts` as the conduit target
// `provider:<kind>:<accountId>`. Cloudflare's target is already registered for
// DNS with the same address and bearer, so a platform connector carries no
// descriptor of its own; what lives here is which path the vendor wants for a
// project and what its answer means.
//
// `account` below is the VENDOR's account id, not the `Secret`'s: one token
// can open several, and every project path is under one of them.

import type { PlatformProvider } from '../../../../db/schema.d.ts'
import type { AccountSend }   from '../compute/index.ts'
import { cloudflare }         from './cloudflare.ts'

/** One vendor account the token opens. */
export interface PlatformAccount {
  id:   string
  name: string
}

/** One thing the vendor runs, as adopting it needs to see. `name` is the
 *  vendor's own (`AppPlatform.name`), `kind` whether it serves files only. */
export interface PlatformProject {
  name:       string
  /** The vendor's internal id when it differs from the name — a Worker's
   *  `tag`, which the Builds API addresses it by — else the name. */
  id:         string
  kind:       'site' | 'worker'
  createdAt:  string
  modifiedAt: string
  /** What last shipped it, in the vendor's word (`wrangler`, `dash`, …). */
  lastDeployedFrom: string | null
}

/** One upload. A version serves nothing until a deployment names it. */
export interface PlatformVersion {
  id:          string
  number:      number
  createdAt:   string
  source:      string | null
  author:      string | null
  message:     string | null
  triggeredBy: string | null
}

/** One change to what serves traffic — what an `observed` release records. A
 *  deployment holds one version, or two during a gradual rollout. */
export interface PlatformDeployment {
  id:        string
  createdAt: string
  source:    string | null
  author:    string | null
  message:   string | null
  versions:  { id: string; percent: number }[]
}

/** One platform vendor's dialect. Reads only, so far (`IDEAS/app-platforms.md`
 *  Phase 1); the ship half joins in Phase 2. */
export interface PlatformConnector {
  kind:  PlatformProvider
  label: string
  /** Does this token open at least one account? */
  verify(send: AccountSend): Promise<boolean>
  accounts(send: AccountSend): Promise<PlatformAccount[]>
  projects(send: AccountSend, account: string): Promise<PlatformProject[]>
  /** One project, or null when the vendor no longer has it. */
  project(send: AccountSend, account: string, name: string): Promise<PlatformProject | null>
  /** Newest first, at most `limit`. */
  versions(send: AccountSend, account: string, name: string, opts?: { limit?: number }): Promise<PlatformVersion[]>
  /** Newest first; the first is what serves now. */
  deployments(send: AccountSend, account: string, name: string): Promise<PlatformDeployment[]>
}

const CONNECTORS: Partial<Record<PlatformProvider, PlatformConnector>> = {
  cloudflare,
}

/** The vendors an App may run on without a machine. */
export function platformProviders(): { kind: PlatformProvider; label: string }[] {
  return Object.values(CONNECTORS).map(c => ({ kind: c!.kind, label: c!.label }))
}

export function platformConnectorFor(kind: PlatformProvider): PlatformConnector | null {
  return CONNECTORS[kind] ?? null
}
