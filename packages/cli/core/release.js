// release.js — what a Release IS, computed from the tree.
//
// Phase 1b of IDEAS/release-transitions.md. Minting writes nothing and deploys
// nothing: it computes an object and answers it. That is not a limitation of
// this step, it is the property the whole design rests on — a Release id is
// content-addressed, so minting is a pure function of the tree and the
// bindings, and the same tree mints the same id on a laptop, in CI and on the
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
//   digest       the bytes            — Deployment. Null until 2.3f builds once
//   bindingsHash the configuration    — Deployment, per Environment
//   schemaHash   the data boundary    — Data, off the committed release surface
//   pivot        can N-1 still serve  — the verdict litestone already computes

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
// what an environment variable already means: everything in a binding set
// reaches a process as text.

function canonical(obj) {
  return JSON.stringify(
    Object.keys(obj ?? {}).sort().map(k => [k, String(obj[k])]))
}

// ─── the bindings ────────────────────────────────────────────────────────────
//
// An Environment provides values, and *references* to secrets — never secret
// values (invariant 2). The two are separate keys rather than one bag because
// the rule is not a convention to remember: a value is committed and a
// reference points at something that is not.
//
// **The hash covers a DECLARATION, not the running configuration.** `fli` writes
// no `.env` on a target — the operator owns that file, and the container is
// started with `--env-file` against it — so nothing here is applied by a deploy.
// What the hash and the generation are for is the pair a revert compares:
// *has the configuration been changed since the release I am going back to*.
// Reading it as *what the process is running on* is `FJS-585`, and the two
// places that invite it are the `values` recorded beside the hash and the word
// "configuration" in `release:mint`'s own table.
//
// A reference is pinned, and `latest` is refused by name. Cloud Run resolves a
// secret reference at instance startup, so `latest` means two instances of one
// immutable Release hold two different values and the Release is immutable in
// name only — its own documentation says to pin the version. A rotation moves
// the binding to a new pinned version, which is a new generation, which is
// exactly the event a generation is for.

export class BindingError extends Error {
  constructor(message, key) {
    super(message)
    this.name = 'BindingError'
    this.key  = key
  }
}

const UNPINNED = /(^|[@:])latest$/i

/**
 * Resolve the binding set for one target.
 *
 * Per-target beats app-wide, because that is what an override is for. The
 * absence of both is an empty set and NOT an error: an app that binds nothing
 * has a binding set, and it hashes to a stable value like any other.
 */
export function bindingSet(deployConf, target) {
  const at      = deployConf?.[target] ?? {}
  const values  = { ...(deployConf?.bindings ?? {}), ...(at.bindings ?? {}) }
  const refs    = { ...(deployConf?.secrets  ?? {}), ...(at.secrets  ?? {}) }

  for (const [key, ref] of Object.entries(refs)) {
    if (typeof ref !== 'string' || !ref.trim())
      throw new BindingError(`secret ${key} must be a reference like "name@3", got ${JSON.stringify(ref)}`, key)
    if (UNPINNED.test(ref.trim()))
      throw new BindingError(
        `secret ${key} names "${ref}" — a reference must be pinned. ` +
        `A secret is resolved when a process starts, so "latest" makes two instances of one ` +
        `Release hold two different values. Name the version: "${ref.replace(UNPINNED, '@<version>')}".`,
        key)
    // A value that looks like a secret is the mistake this split exists to make
    // visible, and it is worth one guess: a reference is short and has no
    // newlines, so anything long is almost certainly the secret itself.
    if (ref.length > 200 || ref.includes('\n'))
      throw new BindingError(`secret ${key} looks like a VALUE, not a reference — a Release records references only`, key)
  }

  const hash = sha(`bindings\n${canonical(values)}\n${canonical(refs)}`)
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
 * bindings mint the same id, which is what makes a redeploy a no-op rather than
 * a second Release, and what lets a digest be promoted between environments
 * instead of rebuilt.
 *
 * `environment` is NOT in the id, deliberately. One artefact promotes from
 * staging to production unchanged and only its bindings differ (invariant 1) —
 * so the environment is on the row and the bindings are in the hash.
 */
export function mintRelease({
  app,
  environment,
  digest       = null,
  imageRef     = null,
  bindingsHash,
  generation   = 1,
  schemaHash   = null,
  pivot        = 'unknown',
  pivotDeclared = false,
  pivotFindings = [],
  audienceKey  = 'everyone',
  createdBy    = null,
} = {}) {
  if (!app)          throw new BindingError('a Release needs an app id — set deploy.app_id in frontier.config.js', 'app_id')
  if (!bindingsHash) throw new BindingError('a Release needs a bindings hash', 'bindings')

  // Named terms rather than a positional join: a joined string is one field
  // moving away from silently hashing the same as a different Release.
  const id = short(sha([
    `format=${RELEASE_FORMAT}`,
    `app=${app}`,
    `digest=${digest ?? ''}`,
    `bindings=${bindingsHash}`,
    `schema=${schemaHash ?? ''}`,
    `pivot=${pivot}`,
  ].join('\n')))

  return {
    id, app, environment,
    digest, imageRef,
    bindingsHash, generation,
    schemaHash,
    pivot, pivotDeclared, pivotFindings,
    audienceKey,
    formatVersion: RELEASE_FORMAT,
    createdBy,
  }
}

/** What a Release says about itself, for a person rather than for a diff. */
export function formatRelease(rel, { bindings } = {}) {
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
  // Named as DECLARED, because the values recorded beside this hash are not
  // applied by any step — the container reads the target's own env file, which
  // `fli` does not write (`FJS-585`). A reader who takes this as the running
  // configuration is reading a fact about the repository.
  row('bindings',   `${short(rel.bindingsHash)}  · generation ${rel.generation}  (declared)` +
                    (bindings ? `  · ${bindings.count} binding(s), ${Object.keys(bindings.secretRefs).length} secret ref(s)` : ''))
  row('schema',     rel.schemaHash ? short(rel.schemaHash) : '— no release.snapshot.md (run fli release:check)')
  row('pivot',      rel.pivot + (rel.pivotDeclared ? '  (declared)' : ''))
  if (rel.pivot === 'contract')
    lines.push('', '  This deploy is the pivot: after it, only forward.')
  return lines.join('\n')
}
