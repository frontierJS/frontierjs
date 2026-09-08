// src/providers/compute/index.ts
// Making and reading MACHINES at a cloud — the boundary, and who speaks it.
//
// Not an entry in `providers/index.ts`. That file holds ten interfaces the app
// resolves to a stub or an adapter at boot; this is a Conduit target, because
// `provider:<kind>` was already how `servers.sync` reached a cloud and a second
// mechanism beside it would be two owners of *talk to a vendor*
// (`docs/PROVISIONING.md` § D1). What lives here is the half a target cannot
// carry: which method and path a vendor wants, and what its answer means.
//
// ─── The target names an ACCOUNT ─────────────────────────────────────────
//
// `provider:<kind>:<accountId>`, never `provider:<kind>`. A vendor token is a
// `Secret` and a `Secret` belongs to a workspace, so a target keyed on the
// vendor alone can hold exactly one DigitalOcean for the whole install — and
// whichever workspace registered it last has its token used to read everybody
// else's machines (`FJS-1020`). `targetFor` is the one place the string is
// built and every caller goes through it.

import type { TargetDescriptor } from '@frontierjs/conduit'
import type { ProviderKind }     from '../../../../db/schema.d.ts'
import { digitalOcean }          from './digitalocean.ts'

// ─── What a caller gets back ─────────────────────────────────────────────

/** A machine size, as a picker needs it. Money is minor units plus a currency,
 *  never a float and never a symbol — the same rule `@money` holds at the Data
 *  boundary, because the divisor belongs to the currency. */
export interface ComputeSize {
  slug:        string
  label:       string
  vcpu:        number
  memoryMb:    number
  diskGb:      number
  priceMinor:  number
  currency:    string
  regions:     string[]
}

export interface ComputeRegion { slug: string; label: string; available: boolean }
export interface ComputeImage  { slug: string; label: string }

export interface ComputeCatalog {
  regions: ComputeRegion[]
  sizes:   ComputeSize[]
  images:  ComputeImage[]
}

/**
 * What a machine is doing, in ONE vocabulary.
 *
 * Not the vendor's own word. DigitalOcean says `active`, Hetzner says
 * `running`, and `servers.sync` translates a word into a declared MOVE through
 * a single table — so if each connector passed its own dialect through, that
 * table would grow a column per vendor and the one nobody updated would go
 * quiet rather than wrong. Normalizing here means a connector owns its dialect
 * and nothing downstream knows there was one.
 *
 * `unknown` is a real answer and is why this is not a bare string: a vendor
 * that grows a state we have never seen must be RECORDED as unrecognized, not
 * mapped to the nearest thing.
 */
export type MachineState =
  | 'running' | 'starting' | 'stopping' | 'off' | 'rebuilding' | 'deleting' | 'unknown'

/** What a vendor says about one machine, translated. Which MOVE a state makes
 *  is `servers.sync`'s question, and which moves are legal is the schema's. */
export interface ComputeMachine {
  providerServerId: string
  status:           MachineState
  ipAddress:        string | null
  region:           string | null
}

/**
 * What a caller asks for when it wants a machine.
 *
 * `userData` is the whole install — cloud-init, carrying the enrollment token.
 * It is the reason this app needs no SSH at all for a machine it made
 * (`FJS-D241`), and it is also the reason `tags` matters: a create that
 * succeeded at the vendor and crashed before recording the id leaves a machine
 * nobody here knows about, billing forever, and the tag is the ONLY thread back
 * to it. Every connector must send it.
 */
export interface MachineSpec {
  name:     string
  region:   string
  size:     string
  image:    string
  userData: string
  /** `server:<id>` — the `Server` row this machine is. Findable by a
   *  reconciliation pass, which is what makes an orphan visible at all. */
  tags:     string[]
}

/** The send half, bound to one target. Handed to a connector so a connector
 *  never holds `app` and can be exercised against a function in a test. */
export type ComputeSend = (req: {
  method: 'GET' | 'POST' | 'DELETE'
  path:   string
  body?:  unknown
}) => Promise<{
  data:   unknown
  /** The HTTP status the target answered with, where it answered at all.
   *  Carried because conduit's `kind` deliberately does not split 4xx by code
   *  — every one of them is `client_error`, since none is retryable and none
   *  says anything about the target's health. Which 4xx it was is the caller's
   *  question, and for a machine read the difference between 404 and 400 is
   *  *the vendor no longer has it* against *we asked wrongly*. */
  status?: number
  error?:  { kind: string; message?: string }
}>

/**
 * One cloud's dialect. Everything vendor-specific is behind this and nothing
 * else in the app names a vendor's URL, header or JSON shape.
 */
export interface ComputeConnector {
  kind:    ProviderKind
  label:   string
  /** Where the vendor is, when nothing overrides it. */
  address: string
  /** The descriptor this account registers as. The credential is a REF the
   *  resolver reads at send time; the material never reaches the registry. */
  descriptor(opts: { accountId: string; ref: string; address?: string }): TargetDescriptor
  /** Regions, sizes and images, as a picker needs them. */
  catalog(send: ComputeSend): Promise<ComputeCatalog>
  /** One machine, or null where the vendor says it is gone. */
  machine(send: ComputeSend, providerServerId: string): Promise<ComputeMachine | null>
  /** Does this token work? The call is deliberately the cheapest read the
   *  vendor offers, because it runs when somebody presses Verify. */
  verify(send: ComputeSend): Promise<boolean>

  /**
   * Make a machine. Answers the vendor's id for it, which is the only thing
   * that has to survive: with the id the row can be finished later, and
   * without it the machine is an orphan the tag has to find.
   */
  create(send: ComputeSend, spec: MachineSpec): Promise<{ providerServerId: string }>

  /**
   * Unmake one. Answers whether the vendor accepted the instruction — NOT
   * whether the machine is gone, which is a later read. A vendor that has
   * never heard of the id answers true, because *there is nothing to destroy*
   * and *it is destroyed* are the same outcome and a destroy that cannot be
   * retried to completion is worse than one that is idempotent.
   */
  destroy(send: ComputeSend, providerServerId: string): Promise<boolean>

  /**
   * Every machine at this account carrying one of our tags.
   *
   * The reconciliation read, and the only question that can find what nothing
   * here recorded. It is a LIST rather than a lookup for exactly that reason:
   * an orphan has no id on this side to look up with.
   */
  tagged(send: ComputeSend, tag: string): Promise<ComputeMachine[]>
}

// ─── The registry ────────────────────────────────────────────────────────

const CONNECTORS: Partial<Record<ProviderKind, ComputeConnector>> = {
  digitalocean: digitalOcean,
}

/** The connector for a cloud, or null where this app cannot speak to it.
 *  `custom` is a machine somebody else made and is null by construction. */
export function connectorFor(kind: ProviderKind | null | undefined): ComputeConnector | null {
  if (!kind || kind === 'custom') return null
  return CONNECTORS[kind] ?? null
}

/** Every cloud this app can speak to, for a picker. */
export function computeProviders(): { kind: ProviderKind; label: string }[] {
  return Object.values(CONNECTORS)
    .filter((c): c is ComputeConnector => Boolean(c))
    .map(c => ({ kind: c.kind, label: c.label }))
}

/**
 * The Conduit target for one ACCOUNT at one cloud. The only place this string
 * is built — `servers.sync` used to assemble `provider:${kind}` inline, which
 * is the defect this function exists to make unrepeatable.
 */
export function targetFor(kind: ProviderKind, accountId: string): string {
  return `provider:${kind}:${accountId}`
}

/**
 * The tag every machine this app makes carries, whichever `Server` it is.
 *
 * TWO tags rather than one, because a vendor's tag filter is an EXACT match
 * and not a prefix — DigitalOcean's `?tag_name=` is, and so is Hetzner's label
 * selector for a full key. So `basecamp:server:<id>` alone can only be searched
 * for by somebody who already knows the id, which is precisely what a
 * reconciliation sweep does not have: an orphan is a machine with no row here.
 *
 * The fleet tag is what makes one sweep cover everything; the identity tag is
 * what turns a found machine back into a row.
 */
export const FLEET_TAG = 'basecamp'

/**
 * The identity tag. One function, three readers — the create that applies it,
 * the reconcile that reads it back, and the test that asserts it crossed. A tag
 * spelled differently in any of the three is an orphan reconciliation cannot
 * see, which is the failure the tag exists to prevent.
 */
export function machineTag(serverId: string): string {
  return `basecamp:server:${serverId}`
}

/** Both, in the order a vendor lists them back. */
export function machineTags(serverId: string): string[] {
  return [FLEET_TAG, machineTag(serverId)]
}
