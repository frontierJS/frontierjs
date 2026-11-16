// release.js — what a Release IS: one content-addressed id for both deploy paths.
//
// `fli deploy` and Basecamp → Outpost each mint here (`FJS-D2171`). A Release id
// that two writers computed by two copies of the rule is two ids the first time
// either copy moves, and drift grading (`FJS-D740`) would then call one release
// two. So the rule lives once, in the package both paths already import.
//
// Minting writes nothing. The id is a pure function of its terms, so the same
// bytes, configuration and schema mint the same id on a laptop, in Basecamp and
// on the machine.
//
//   digest             the bytes            — Deployment
//   configurationHash  the configuration    — Deployment, per Environment
//   schemaHash         the data boundary    — Data, off the committed release surface
//
// Whether N-1 can still serve is NOT a term. It is relative to what is serving,
// so it is the transition's verdict, asked on the machine (`FJS-4004`).

import { createHash }               from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { resolve }                  from 'node:path'

/**
 * The format this module mints. It is in the id, so a change to what a term
 * MEANS mints a different Release for the same tree: two ids computed by
 * different rules are not the same claim.
 */
export const RELEASE_FORMAT = 2

const sha = (s) => createHash('sha256').update(s).digest('hex')

/** Short enough to type, long enough not to collide. Git's own default width. */
const short = (hex) => hex.slice(0, 12)

/** A configuration term refused by name; `key` is the variable it names. */
export class ConfigurationError extends Error {
  /** @param {string} message @param {string} [key] */
  constructor(message, key) {
    super(message)
    this.name = 'ConfigurationError'
    this.key  = key
  }
}

// Sorted keys, no whitespace, every value as text — so `{a:1}` and `{a:'1'}`
// hash the same, which is what an environment variable already means.
const canonical = (obj) =>
  JSON.stringify(Object.keys(obj ?? {}).sort().map(k => [k, String(obj[k])]))

const UNPINNED = /(^|[@:])latest$/i
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Hash a configuration: plain `values` the process runs on, and `secretRefs`
 * that name a secret's pinned version and never its value (`FJS-D2182`).
 *
 * `latest` is refused: a secret resolved at process start makes two instances
 * of one Release hold two values. A ref that looks like a value — long, or
 * multi-line — is refused too, since that is the mistake the split exists to
 * make visible.
 *
 * @param {Record<string, string|number|boolean>} [values]
 * @param {Record<string, string>} [secretRefs]
 * @returns {{ hash: string, count: number }}
 */
export function configurationHash(values = {}, secretRefs = {}) {
  for (const [key, value] of Object.entries(values)) {
    if (!ENV_NAME.test(key))
      throw new ConfigurationError(`configuration key ${JSON.stringify(key)} is not an environment variable name`, key)
    if (!['string', 'number', 'boolean'].includes(typeof value))
      throw new ConfigurationError(`configuration ${key} must be a string, number or boolean, got ${JSON.stringify(value)}`, key)
  }

  for (const [key, ref] of Object.entries(secretRefs)) {
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
    if (ref.length > 200 || ref.includes('\n'))
      throw new ConfigurationError(`secret ${key} looks like a VALUE, not a reference — a Release records references only`, key)
  }

  return {
    hash:  sha(`configuration\n${canonical(values)}\n${canonical(secretRefs)}`),
    count: Object.keys(values).length + Object.keys(secretRefs).length,
  }
}

/**
 * The schema term: a hash of the committed `release.snapshot.md`, which is
 * exactly what `fli release:check` classifies. A second derivation here would
 * be a second answer to *what is this release's data boundary*.
 *
 * @param {string} dbDir
 * @returns {{ hash: string|null, source: string|null, missing: string|null }}
 */
export function schemaSurfaceHash(dbDir) {
  const file = resolve(dbDir, 'release.snapshot.md')
  if (!existsSync(file))
    return { hash: null, source: null, missing: file }
  return { hash: sha(readFileSync(file, 'utf8')), source: file, missing: null }
}

/**
 * @typedef {object} Release
 * @property {string} id
 * @property {string} app
 * @property {string|null} environment
 * @property {string|null} digest
 * @property {string|null} imageRef
 * @property {string} configurationHash
 * @property {string|null} schemaHash
 * @property {string} audienceKey
 * @property {number} formatVersion
 * @property {string|null} createdBy
 */

/**
 * Mint a Release from terms already computed.
 *
 * The id is the hash of the terms and nothing else — not the time, the operator
 * or the branch. `environment` is on the row and never in the id: what promotes
 * between environments is the digest, and the Release does not (`FJS-D636`,
 * `FJS-D2181`), because a configuration change is a new Release.
 *
 * @param {{ app: string, environment?: string|null, digest?: string|null,
 *           imageRef?: string|null, configurationHash: string,
 *           schemaHash?: string|null, audienceKey?: string,
 *           createdBy?: string|null }} terms
 * @returns {Release}
 */
export function mintRelease({
  app,
  environment  = null,
  digest       = null,
  imageRef     = null,
  configurationHash,
  schemaHash   = null,
  audienceKey  = 'everyone',
  createdBy    = null,
}) {
  if (!app)               throw new ConfigurationError('a Release needs an app id — set deploy.app_id in frontier.config.js', 'app_id')
  if (!configurationHash) throw new ConfigurationError('a Release needs a configuration hash', 'configuration')

  // Named terms rather than a positional join: in a joined string one field
  // moving can hash the same as a different Release.
  const id = short(sha([
    `format=${RELEASE_FORMAT}`,
    `app=${app}`,
    `digest=${digest ?? ''}`,
    `configuration=${configurationHash}`,
    `schema=${schemaHash ?? ''}`,
  ].join('\n')))

  return {
    id, app, environment,
    digest, imageRef,
    configurationHash,
    schemaHash,
    audienceKey,
    formatVersion: RELEASE_FORMAT,
    createdBy,
  }
}

/**
 * Whether a deploy passes the point after which a revert cannot restore the
 * database, from the verdict the target gave (`livePivot`).
 *
 * `unchanged` and `expand` leave N-1 able to serve, so no. **A contract, an
 * unknown and a missing verdict all count as crossing** while something is
 * serving: a classifier that did not run has not shown N-1 keeps working, and
 * reading its silence as an expand is how a revert stops refusing the one
 * case that would serve a migrated database to code that cannot read it. A
 * first deploy crosses nothing — there is no earlier Release to revert to.
 *
 * A caller that KNOWS the verdict was never asked (a rollback, a row recorded
 * before the verdict was kept) passes no `fromReleaseId`, which is the one
 * spelling of *nothing to cross*.
 *
 * @param {{ pivot?: string|null, fromReleaseId?: string|null }} [terms]
 * @returns {boolean}
 */
export function crossesPivot({ pivot = null, fromReleaseId = null } = {}) {
  if (!fromReleaseId) return false
  return pivot !== 'unchanged' && pivot !== 'expand'
}
