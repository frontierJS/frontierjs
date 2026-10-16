// ============================================================
// Conduit — the mirror claim (`FJS-D1125`)
//
// A connector exports a claim naming the app models a Provider feeds: for
// each, how its object becomes a row (`parse`) and which writes the app's
// default service may forward (`create`/`update`/`delete` to a request). The
// app binds it in wiring, `app.conduit.mirror(mattermost.mirror)`.
//
// This file is the Provider half of a forward: build the request, spend the
// model's target, read the answer back through the same `parse` the socket
// uses, so a write and a sync cannot disagree on a row's shape. Landing the
// row is the Data half and junction's — the generated verb asks
// `mirrored(accessor)` at call time, upserts what this answers by the key
// `@@mirror(key:)` names, and re-reads it as the caller.
//
// A failure is thrown carrying `status`, which junction's one error mapper
// turns into the HTTP answer (Invariant 4); this file names no HTTP class.
// ============================================================

import type { ConduitRequest, ConduitResult, ConduitError } from './types.ts'

/** A request a verb builds; the model names the target it spends. */
export type MirrorVerb = Omit<ConduitRequest, 'target' | 'who'>

export type MirrorRow = Record<string, unknown>

export interface MirrorModel<Row = MirrorRow, Remote = any, Create = any, Patch = any, Scope = any> {
  /** The row field holding the Provider's id; must be the column `@@mirror(key:)` names. */
  key:    string
  /** The target every verb on this model spends. */
  target: string
  /** A Provider object to a row, or null for one this model does not read. */
  parse(remote: Remote, scope?: Scope): Row | null
  create?(input: Create): MirrorVerb
  update?(key: string, patch: Patch): MirrorVerb
  delete?(key: string): MirrorVerb
}

export interface MirrorClaim {
  provider: string
  /** Keyed by the app's PascalCase model name (`Post`, `ChannelMember`). */
  models:   Record<string, MirrorModel<any, any, any, any, any>>
}

/**
 * What a claimed model's generated verbs forward through. Each answers the row
 * parsed from the Provider's response, or null where the response carries none
 * (a delete answering `{ status: 'OK' }`). A verb the claim does not export is
 * absent, and the generated verb refuses it by name.
 */
export interface MirrorForward {
  provider: string
  model:    string
  key:      string
  create?(input: unknown): Promise<MirrorRow | null>
  update?(key: string, patch: unknown): Promise<MirrorRow | null>
  remove?(key: string): Promise<MirrorRow | null>
}

/** One claimed model, for the boot check against the schema. */
export interface ClaimedModel {
  provider: string
  model:    string
  accessor: string
  key:      string
}

// ─── Shape refusals ──────────────────────────────────────────

const MODEL_FIELDS = new Set(['key', 'target', 'parse', 'create', 'update', 'delete'])
const PASCAL       = /^[A-Z][A-Za-z0-9]*$/

/** Refuses by name a claim conduit cannot forward through. */
export function assertClaim(claim: unknown): asserts claim is MirrorClaim {
  const c = claim as Partial<MirrorClaim> | null
  if (!c || typeof c !== 'object') throw new TypeError('[conduit] mirror() takes a claim: { provider, models }')
  if (typeof c.provider !== 'string' || !c.provider)
    throw new TypeError('[conduit] a mirror claim names its provider')
  const at = `[conduit] mirror claim '${c.provider}'`
  for (const k of Object.keys(c)) if (k !== 'provider' && k !== 'models')
    throw new TypeError(`${at}: unknown field '${k}' — a claim is { provider, models }`)
  if (!c.models || typeof c.models !== 'object' || !Object.keys(c.models).length)
    throw new TypeError(`${at}: names no models`)
  for (const [name, m] of Object.entries(c.models)) {
    // The claim is keyed the way the schema names a model (Invariant 2); a
    // camelCase key would resolve to the same accessor and read as a typo of it.
    if (!PASCAL.test(name))
      throw new TypeError(`${at}: model '${name}' — a claim is keyed by the schema's model name, PascalCase singular`)
    const where = `${at}: ${name}`
    if (!m || typeof m !== 'object') throw new TypeError(`${where} is not a model`)
    for (const k of Object.keys(m)) if (!MODEL_FIELDS.has(k))
      throw new TypeError(`${where}: unknown field '${k}' — expected ${[...MODEL_FIELDS].join(', ')}`)
    if (typeof m.key !== 'string' || !m.key)       throw new TypeError(`${where}: key names the row field holding the Provider's id`)
    if (typeof m.target !== 'string' || !m.target) throw new TypeError(`${where}: target names the target its verbs spend`)
    if (typeof m.parse !== 'function')             throw new TypeError(`${where}: parse is required — it is how a forward's answer becomes a row`)
    for (const verb of ['create', 'update', 'delete'] as const)
      if (m[verb] !== undefined && typeof m[verb] !== 'function') throw new TypeError(`${where}: ${verb} is a function`)
  }
}

// ─── Failures ────────────────────────────────────────────────

/**
 * A Provider failure as the status the app answers. A 4xx the Provider gave
 * names the caller's input, so it reaches the caller; a Provider that is down
 * is 502/503/504; a request conduit refused to build is the app's own bug and
 * carries no status, which the mapper answers 500.
 */
function statusOf(error: ConduitError, status: number | undefined): number | undefined {
  switch (error.kind) {
    case 'client_error':      return status === 404 || status === 409 || status === 410 ? status : 422
    case 'auth_failed':       return 403
    case 'rate_limited':      return 429
    case 'timeout':           return 504
    case 'circuit_open':
    case 'overloaded':        return 503
    case 'connection_failed':
    case 'server_error':
    case 'invalid_response':
    case 'redirected':
    case 'stream_error':      return 502
    default:                  return undefined
  }
}

function failure(message: string, status: number | undefined): Error {
  const err = new Error(message) as Error & { status?: number }
  if (status) err.status = status
  return err
}

// ─── The table ───────────────────────────────────────────────

const camel = (name: string) => name.charAt(0).toLowerCase() + name.slice(1)

export function createMirrors(send: (req: ConduitRequest) => Promise<ConduitResult<unknown>>) {
  const byAccessor = new Map<string, { provider: string; model: string; spec: MirrorModel }>()

  function claim(input: MirrorClaim): void {
    assertClaim(input)
    // Checked whole before any is added, so a refused claim leaves nothing behind.
    for (const model of Object.keys(input.models)) {
      const held = byAccessor.get(camel(model))
      if (held)
        throw new TypeError(
          `[conduit] mirror claim '${input.provider}': ${model} is already claimed by '${held.provider}'. ` +
          `One Provider owns a mirrored model's writes.`)
    }
    for (const [model, spec] of Object.entries(input.models))
      byAccessor.set(camel(model), { provider: input.provider, model, spec })
  }

  function claimed(): ClaimedModel[] {
    return [...byAccessor].map(([accessor, c]) => ({ provider: c.provider, model: c.model, accessor, key: c.spec.key }))
  }

  function mirrored(accessor: string): MirrorForward | undefined {
    const held = byAccessor.get(accessor)
    if (!held) return undefined
    const { provider, model, spec } = held
    const at = `${provider} ${model}`

    // A builder's throw is the caller's input refused before anything left.
    const build = (verb: string, fn: () => MirrorVerb): MirrorVerb => {
      try { return fn() } catch (err) {
        throw failure(`${at}.${verb}: ${(err as Error)?.message ?? String(err)}`, 400)
      }
    }

    const forward = async (verb: string, req: MirrorVerb): Promise<MirrorRow | null> => {
      const res = await send({ ...req, target: spec.target })
      if (res.error) {
        const open = res.error.indeterminate ? ' — it may have been applied there, and the sync will say' : ''
        throw failure(`${at}.${verb}: ${provider} answered ${res.error.kind}${open}: ${res.error.message}`, statusOf(res.error, res.meta.status))
      }
      try { return spec.parse(res.data) } catch (err) {
        throw failure(`${at}.${verb}: ${provider} answered a ${model} the claim cannot read — ${(err as Error)?.message ?? String(err)}`, 502)
      }
    }

    return {
      provider, model, key: spec.key,
      ...(spec.create ? { create: (input: unknown) => forward('create', build('create', () => spec.create!(input))) } : {}),
      ...(spec.update ? { update: (key: string, patch: unknown) => forward('update', build('update', () => spec.update!(key, patch))) } : {}),
      ...(spec.delete ? { remove: (key: string) => forward('delete', build('delete', () => spec.delete!(key))) } : {}),
    }
  }

  return { claim, claimed, mirrored }
}
