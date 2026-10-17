// release.js — what a Release IS, computed from the tree.
//
// Phase 1b of IDEAS/release-transitions.md. Minting writes nothing and deploys
// nothing: it computes an object and answers it. That is not a limitation of
// this step, it is the property the whole design rests on — a Release id is
// content-addressed, so minting is a pure function of the tree and the
// configuration, and the same tree mints the same id on a laptop, in CI and on the
// target. *Build once, promote a digest* is only sayable if the thing being
// promoted has a name that does not depend on who computed it.
//
// The journal is a separate question and deliberately not answered here. It
// lives on the target (packages/cli/db/deploy.lite), and a Release is RECORDED
// there when a transition begins — which is 1e. Minting on a machine that
// cannot reach the target is the normal case.
//
// Four terms, and each is a fact about a different realm:
//
//   digest             the bytes            — Deployment. Null until 2.3f builds once
//   configurationHash  the configuration    — Deployment, per Environment
//   schemaHash         the data boundary    — Data, off the committed release surface
//   pivot              can N-1 still serve  — the verdict litestone already computes

import { createHash }              from 'crypto'
import { existsSync, readFileSync } from 'fs'
import { resolve }                 from 'path'

/**
 * The format this module mints. It is in the id, so a change to what a term
 * MEANS mints a different Release for the same tree — which is correct: two
 * ids that were computed by different rules are not the same claim.
 */
export const RELEASE_FORMAT = 1

const sha = (s) => createHash('sha256').update(s).digest('hex')

/** Short enough to type, long enough not to collide. Git's own default width. */
const short = (hex) => hex.slice(0, 12)

// ─── canonical form ──────────────────────────────────────────────────────────
//
// Hashing an object means choosing a serialization, and the choice has to be
// stable across every machine that mints. Sorted keys, no whitespace, and a
// value coerced to a string — so `{a:1}` and `{a:'1'}` hash the same, which is
// what an environment variable already means: everything in a configuration set
// reaches a process as text.

function canonical(obj) {
  return JSON.stringify(
    Object.keys(obj ?? {}).sort().map(k => [k, String(obj[k])]))
}

// ─── the configuration ───────────────────────────────────────────────────────
//
// An Environment provides values, and *references* to secrets — never secret
// values (invariant 2). The two are separate keys rather than one bag because
// the rule is not a convention to remember: a value is committed and a
// reference points at something that is not.
//
// **`values` are what the process runs on; `secretRefs` are named, not applied.**
// `06-swap` passes `values` to `docker run` as `--env K=V` after `--env-file`
// (FJS-D1029), so no file is written on the target (FJS-D1186). A secret
// reference stays in the operator's env file, graded present by key in
// `01b-env-check`, so the hash fixes which secrets a Release names and cannot say
// which value the file holds. The generation is the pair a revert compares:
// *has the configuration been changed since the release I am going back to*.
//
// A reference is pinned, and `latest` is refused by name. Cloud Run resolves a
// secret reference at instance startup, so `latest` means two instances of one
// immutable Release hold two different values and the Release is immutable in
// name only — its own documentation says to pin the version. A rotation moves
// the configuration to a new pinned version, which is a new generation, which is
// exactly the event a generation is for.

export class ConfigurationError extends Error {
  constructor(message, key) {
    super(message)
    this.name = 'ConfigurationError'
    this.key  = key
  }
}

const UNPINNED = /(^|[@:])latest$/i
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Resolve the configuration set for one target.
 *
 * Per-target beats app-wide, because that is what an override is for. The
 * absence of both is an empty set and NOT an error: an app that declares nothing
 * has a configuration set, and it hashes to a stable value like any other.
 */
export function configurationSet(deployConf, target) {
  const at      = deployConf?.[target] ?? {}
  const values  = { ...(deployConf?.configuration ?? {}), ...(at.configuration ?? {}) }
  const refs    = { ...(deployConf?.secrets  ?? {}), ...(at.secrets  ?? {}) }

  // A key becomes `--env KEY=` on a command line, so it is a name and nothing
  // else; a value is one scalar the shell can quote.
  for (const [key, value] of Object.entries(values)) {
    if (!ENV_NAME.test(key))
      throw new ConfigurationError(`configuration key ${JSON.stringify(key)} is not an environment variable name`, key)
    if (!['string', 'number', 'boolean'].includes(typeof value))
      throw new ConfigurationError(`configuration ${key} must be a string, number or boolean, got ${JSON.stringify(value)}`, key)
  }

  for (const [key, ref] of Object.entries(refs)) {
    if (!ENV_NAME.test(key))
      throw new ConfigurationError(`secret key ${JSON.stringify(key)} is not an environment variable name`, key)
    if (typeof ref !== 'string' || !ref.trim())
      throw new ConfigurationError(`secret ${key} must be a reference like "name@3", got ${JSON.stringify(ref)}`, key)
    if (UNPINNED.test(ref.trim()))
      throw new ConfigurationError(
        `secret ${key} names "${ref}" — a reference must be pinned. ` +
        `A secret is resolved when a process starts, so "latest" makes two instances of one ` +
        `Release hold two different values. Name the version: "${ref.replace(UNPINNED, '@<version>')}".`,
        key)
    // A value that looks like a secret is the mistake this split exists to make
    // visible, and it is worth one guess: a reference is short and has no
    // newlines, so anything long is almost certainly the secret itself.
    if (ref.length > 200 || ref.includes('\n'))
      throw new ConfigurationError(`secret ${key} looks like a VALUE, not a reference — a Release records references only`, key)
  }

  const hash = sha(`configuration\n${canonical(values)}\n${canonical(refs)}`)
  return { values, secretRefs: refs, hash, count: Object.keys(values).length + Object.keys(refs).length }
}

// ─── the schema term ─────────────────────────────────────────────────────────
//
// The committed release surface IS the term, so it is hashed rather than
// re-derived. Three reasons and the third is the one that matters: it is
// exactly what `fli release:check` classifies, the `snapshots` CI phase already
// fails a stale one, and a second derivation here would be a second answer to
// *what is the data boundary of this release* that could disagree with the
// first.

export function schemaSurfaceHash(dbDir) {
  const file = resolve(dbDir, 'release.snapshot.md')
  if (!existsSync(file))
    return { hash: null, source: null, missing: file }
  return { hash: sha(readFileSync(file, 'utf8')), source: file, missing: null }
}

// ─── the Release ─────────────────────────────────────────────────────────────

/**
 * Mint a Release from terms already computed.
 *
 * The id is the hash of the terms and of nothing else — not the time, not the
 * operator, not the branch. Two builds of an unchanged tree against unchanged
 * configuration mint the same id, which is what makes a redeploy a no-op rather than
 * a second Release, and what lets a digest be promoted between environments
 * instead of rebuilt.
 *
 * `environment` is NOT in the id, deliberately. One artefact promotes from
 * staging to production unchanged and only its configuration differs (invariant 1) —
 * so the environment is on the row and the configuration is in the hash.
 */
export function mintRelease({
  app,
  environment,
  digest       = null,
  imageRef     = null,
  configurationHash,
  generation   = 1,
  schemaHash   = null,
  pivot        = 'unknown',
  pivotDeclared = false,
  pivotFindings = [],
  audienceKey  = 'everyone',
  createdBy    = null,
} = {}) {
  if (!app)               throw new ConfigurationError('a Release needs an app id — set deploy.app_id in frontier.config.js', 'app_id')
  if (!configurationHash) throw new ConfigurationError('a Release needs a configuration hash', 'configuration')

  // litestone's ladder has a fourth rung this journal does not store. `pivot`
  // answers one question — can Release N-1 still serve this database — and
  // `unchanged` and `expand` are both yes, so the two are one value here.
  // Normalized where the id is computed, or the hashed term and the stored
  // column disagree about the same Release. Without it a release with no schema
  // findings is dropped by `INSERT OR IGNORE` against the pivot CHECK, and the
  // deploy dies one statement later on the transition's foreign key, naming
  // neither the column nor the value.
  if (pivot === 'unchanged') pivot = 'expand'

  // Named terms rather than a positional join: a joined string is one field
  // moving away from silently hashing the same as a different Release.
  const id = short(sha([
    `format=${RELEASE_FORMAT}`,
    `app=${app}`,
    `digest=${digest ?? ''}`,
    `configuration=${configurationHash}`,
    `schema=${schemaHash ?? ''}`,
    `pivot=${pivot}`,
  ].join('\n')))

  return {
    id, app, environment,
    digest, imageRef,
    configurationHash, generation,
    schemaHash,
    pivot, pivotDeclared, pivotFindings,
    audienceKey,
    formatVersion: RELEASE_FORMAT,
    createdBy,
  }
}

/** What a Release says about itself, for a person rather than for a diff. */
export function formatRelease(rel, { configuration } = {}) {
  const lines = []
  const row = (k, v) => lines.push(`  ${k.padEnd(14)}${v}`)

  lines.push(`  Release ${rel.id}`)
  lines.push('')
  row('app',        `${rel.app}${rel.environment ? ` · ${rel.environment}` : ''}`)
  // A tag is not an identity — two hosts at one commit hold two images with the
  // same name — so an absent digest says so rather than showing the tag as if
  // it were one.
  row('digest',     rel.digest ?? '— not built (fli deploy builds on the target; see 2.3f)')
  if (rel.imageRef) row('image', `${rel.imageRef}  (a name, not an identity)`)
  row('configuration', `${short(rel.configurationHash)}  · generation ${rel.generation}` +
                       (configuration ? `  · ${configuration.count} key(s), ${Object.keys(configuration.secretRefs).length} secret ref(s)` : ''))
  row('schema',     rel.schemaHash ? short(rel.schemaHash) : '— no release.snapshot.md (run fli release:check)')
  row('pivot',      rel.pivot + (rel.pivotDeclared ? '  (declared)' : ''))
  if (rel.pivot === 'contract')
    lines.push('', '  This deploy is the pivot: after it, only forward.')
  return lines.join('\n')
}
