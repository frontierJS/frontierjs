// release.js — `fli`'s side of a Release: its configuration shape and the printout.
//
// The id itself is minted in `@frontierjs/outpost/release`, the one rule both
// deploy paths import (`FJS-D2171`), so `fli deploy` and Basecamp name the same
// bytes and configuration with the same id. What stays here reads
// `frontier.config.js`'s `deploy` block, which Basecamp never sees.

import { configurationHash } from '@frontierjs/outpost/release'

export { RELEASE_FORMAT, ConfigurationError, configurationHash, schemaSurfaceHash, mintRelease } from '@frontierjs/outpost/release'

const short = (hex) => hex.slice(0, 12)

// ─── the app term ────────────────────────────────────────────────────────────

/**
 * The `app` a Release id hashes. Basecamp mints with its App id, so a project
 * `fli basecamp:app` anchored hashes that and both doors name one release alike
 * (`FJS-D2230`). `deploy.app_id` still names the container and the box paths,
 * which is why it is not rewritten to the App id.
 */
export const releaseAppOf = (deployConf, env = process.env) =>
  env.BASECAMP_APP_ID || deployConf?.app_id || null

// ─── the configuration ───────────────────────────────────────────────────────
//
// **`values` are what the process runs on; `secretRefs` are named, not applied.**
// `06-swap` passes `values` to `docker run` as `--env K=V` after `--env-file`
// (FJS-D1029), so no file is written on the target (FJS-D1186). A secret
// reference stays in the operator's env file, graded present by key in
// `01b-env-check`, so the hash fixes which secrets a Release names and cannot say
// which value the file holds.

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
  const { hash, count } = configurationHash(values, refs)
  return { values, secretRefs: refs, hash, count }
}

// ─── the printout ────────────────────────────────────────────────────────────

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
  row('configuration', short(rel.configurationHash) +
                       (configuration ? `  · ${configuration.count} key(s), ${Object.keys(configuration.secretRefs).length} secret ref(s)` : ''))
  row('schema',     rel.schemaHash ? short(rel.schemaHash) : '— no release.snapshot.md (run fli release:check)')
  return lines.join('\n')
}
