// core/tenancy.js — what a `tenancy { }` block MEANS, resolved once.
//
// The block is parsed in parser.js and desugared there for strategy row; this
// module is the other half — the declaration turned into the values a caller
// can act on: absolute paths, env vars read, defaults filled.
//
// It exists because four readers ask the same question and none of them may
// answer it differently: `createTenantRegistry` (which files, which registry,
// which key), the CLI's `tenant` commands and Studio's tenant switcher, and
// Junction's per-request resolution. Before the block there were three answers
// — a JS call, a partial `litestone.config.js` slice, and nothing at all in the
// schema — so `litestone tenant create` and the running app could disagree
// about where a tenant lives while both looked right.
//
// Precedence is the same everywhere and stated once here: an explicit option
// beats the declaration, which beats the default. A caller passing nothing gets
// what the seed says.

import { resolve, dirname, envVar } from '#host'

const DEFAULTS = {
  dir:      'tenants',
  registry: 'tenants-registry.db',
  maxOpen:  100,
}

// ─── Admitted is not a member ────────────────────────────────────────────────
//
// Under `tenancy { strategy row }` the generated deny reads two claims: the
// tenant claim a MEMBER carries, and this twin, which a caller admitted into the
// tenant without being one of its members carries instead — a guest on the
// roster, a share-link holder. A policy saying `workspaceId == auth().workspaceId`
// reads only the first, so admission never widens the common policy by accident
// and the app grants a guest something narrower on purpose (`FJS-D1100`).
export const tenantAdmission = (claim) => `${claim}Admitted`

// { kind:'literal', value } | { kind:'env', var, default } → string | null
function readValue(def, what) {
  if (def == null) return null
  if (def.kind === 'env') {
    const val = envVar(def.var) ?? def.default
    if (!val) throw new Error(`tenancy: ${what} reads env var '${def.var}', which is not set and has no default`)
    return val
  }
  return def.value
}

/**
 * The tenancy declaration, resolved.
 *
 * @param {object}  schema           parsed schema (parseResult.schema)
 * @param {object}  [opts]
 * @param {string}  [opts.schemaPath] the .lite file, when the caller has one — relative
 *                                    paths in the block resolve against ITS directory,
 *                                    the same rule the CLI applies to `migrations`
 * @param {object}  [opts.overrides]  explicit values that beat the declaration
 * @returns {object|null} null when the schema declares no tenancy
 *
 * database → { strategy, dir, registry, maxOpen, key, resolve }
 * row      → { strategy, column, claim, admission }
 */
export function resolveTenancy(schema, { schemaPath = null, overrides = {} } = {}) {
  const t = schema?.tenancy
  if (!t) return null

  const base = schemaPath ? dirname(resolve(schemaPath)) : process.cwd()
  const at   = (p) => (p == null ? null : resolve(base, p))

  // Row tenancy has no `resolve`: the tenant is a claim on the principal, and
  // where a request names it is the app resolver's `tenantFrom` (`FJS-D360`).
  if (t.strategy === 'row') {
    return {
      strategy: 'row',
      column:   overrides.column ?? t.column,
      claim:    overrides.claim  ?? t.claim,
      admission: tenantAdmission(overrides.claim ?? t.claim),
    }
  }

  // No default: which of a subdomain, a header and a claim names the tenant is
  // a deployment fact nothing can infer, and guessing would route every
  // request at one tenant in silence.
  const resolution = overrides.resolve ?? t.resolve ?? null

  return {
    strategy: 'database',
    dir:      at(overrides.dir      ?? readValue(t.dir,      'dir')      ?? DEFAULTS.dir),
    registry: at(overrides.registry ?? readValue(t.registry, 'registry') ?? DEFAULTS.registry),
    maxOpen:  overrides.maxOpen ?? t.maxOpen ?? DEFAULTS.maxOpen,
    // The key is a SECRET and never a path: it is read as a value, whatever
    // spelling the block used, and resolving it as a path would turn a 64-char
    // hex string into an absolute filename.
    key:      overrides.key ?? readValue(t.key, 'key'),
    resolve:  resolution,
  }
}

/**
 * Which tenant is this request for?
 *
 * The `resolve` half of the declaration, applied. Deliberately takes plain
 * values rather than a request object — Litestone has no HTTP layer and
 * Junction has two transports whose shapes differ, so the caller supplies the
 * three things any of them can produce.
 *
 * @param {object} resolution  { kind: 'subdomain'|'header'|'claim', name }
 * @param {object} from        { host, headers, principal }
 * @returns {string|null}
 */
export function tenantFrom(resolution, { host = null, headers = null, principal = null } = {}) {
  if (!resolution) return null
  switch (resolution.kind) {
    case 'subdomain': {
      if (!host) return null
      // Port first — `acme.example.com:8100` has a colon, and a bare
      // `localhost:8100` must not answer 'localhost' as a tenant.
      const name  = String(host).split(':')[0]
      const parts = name.split('.')
      // `acme.localhost` is TWO labels and is a tenant, because `.localhost` is
      // a reserved TLD (RFC 6761) that every browser and resolver already sends
      // to the loopback. Without this, `resolve subdomain` is the one
      // resolution nobody can develop against: the first thing anyone types is
      // `acme.localhost:8000`, and it answered null — which reads as the
      // registry not knowing the tenant rather than the host never naming one.
      const floor = parts[parts.length - 1] === 'localhost' ? 2 : 3
      if (parts.length < floor) return null
      return parts[0] || null
    }
    case 'header': {
      if (!headers) return null
      const key = String(resolution.name).toLowerCase()
      // Header names are case-insensitive and the two transports disagree about
      // which case they hand over.
      for (const [k, v] of Object.entries(headers))
        if (k.toLowerCase() === key) return v == null ? null : String(v)
      return null
    }
    case 'claim': {
      const v = principal?.[resolution.name]
      return v == null ? null : String(v)
    }
    default:
      return null
  }
}
