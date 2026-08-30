// core/attachments.ts
// The attached service — a third-party dependency this app needs and does not own.
//
// An n8n, a mail server, a search cluster. The app DECLARES what it needs; the
// Environment BINDS it, as ordinary environment variables that `fli deploy`'s
// binding set already supplies per target. A missing or mismatched binding is a
// refusal at startup, which is the whole product: without it the app boots,
// answers health, and fails at 3am on the first request that reaches the
// service — by which time the deploy is long finished and nothing connects the
// two events.
//
// **We never manage the service.** Not install, not upgrade, not health-check,
// not back up. Provisioning is easy and *de*-provisioning is where integrated
// platforms die, so the boundary is drawn at the declaration and the binding.
//
// ─── why this is not just `defineEnv` ────────────────────────────────────────
//
// Every per-key question here — present, non-empty, a URL, long enough — is
// already answered by `checkEnvField`, and this module calls it rather than
// asking again. What an attachment adds is the three things a flat spec cannot
// say:
//
//   1. THESE KEYS ARE ONE SERVICE, so the refusal names the service rather than
//      a variable. `N8N_API_KEY is required but not set` tells you a string is
//      missing; `n8n is half-bound` tells you what is broken.
//
//   2. ALL OR NOTHING. Three keys of which two are set is not a service that is
//      optional here — it is a half-configured one, and it is the shape that
//      actually reaches production, because somebody bound the URL and forgot
//      the key. So `optional: true` forgives an attachment nobody bound and
//      still refuses one bound halfway.
//
//   3. A DEFAULTED KEY IS NOT EVIDENCE. `timeout` with a default is satisfied
//      whether or not anybody bound it, so it cannot count toward *is this
//      service bound here* — otherwise an app that defaults one key of four
//      makes every unbound attachment look partial.

import { checkEnvField } from './env.ts'
import type { EnvSpec } from './env.ts'

export interface Attachment {
  /**
   * What this service is, in the operator's words. It goes into the refusal,
   * which is the one place somebody reads it — `n8n (workflow automation)`.
   */
  describe?: string

  /**
   * Absent bindings are a warning rather than a refusal.
   *
   * It forgives NOTHING BOUND, never something bound halfway: a half-bound
   * service is a mistake in every environment, and an app that declared the
   * service optional was saying it can run without it, not that it can run
   * against half of it.
   */
  optional?: boolean

  /**
   * The environment variables this service is reached through, as
   * `defineEnv` field specs — so `{ required: true, type: 'url' }` means here
   * exactly what it means there.
   */
  env: EnvSpec
}

export type Attachments = Record<string, Attachment>

/** Why one declared key is not satisfied. */
export interface AttachmentKeyProblem {
  key:     string
  /** Already worded for a person; comes from `checkEnvField`. */
  message: string
}

export type AttachmentState =
  /** Every declared key is satisfied. */
  | 'bound'
  /** No signal key is set. A refusal unless the attachment is optional. */
  | 'unbound'
  /** Some signal keys are set and some are not. Always a refusal. */
  | 'partial'
  /** A key is set and does not satisfy its own spec. Always a refusal. */
  | 'invalid'

export interface AttachmentResult {
  name:      string
  describe?: string
  optional:  boolean
  state:     AttachmentState
  /** Declared keys carrying no default — the ones that answer *is this bound*. */
  signals:   string[]
  /** Signal keys actually set in this environment. */
  present:   string[]
  problems:  AttachmentKeyProblem[]
  /** Does this state stop the app from starting? */
  fatal:     boolean
  /** Non-fatal notes from the field checks. */
  warnings:  string[]
}

export interface AttachmentReport {
  results: AttachmentResult[]
  /** The results that refuse, in declaration order. */
  fatal:   AttachmentResult[]
  /** Optional attachments nobody bound — worth saying once, not worth refusing. */
  skipped: AttachmentResult[]
}

/**
 * Grade one attachment against an environment.
 *
 * `env` is passed rather than read so an attachment can be graded against an
 * environment that is not this process's — which is what makes it testable, and
 * what would let a deploy grade a target before shipping to it.
 */
export function checkAttachment(
  name: string,
  att: Attachment,
  env: Record<string, string | undefined>,
): AttachmentResult {
  const spec     = att.env ?? {}
  const optional = att.optional === true
  const entries  = Object.entries(spec)

  const signals:  string[] = []
  const present:  string[] = []
  const warnings: string[] = []
  // Set and unusable — always a fault, in every state.
  const unusable: AttachmentKeyProblem[] = []
  // Absent and required — a fault only once something else bound this service,
  // because otherwise an unbound attachment reports one problem per key and
  // reads like four faults instead of one service nobody bound.
  const absent:   AttachmentKeyProblem[] = []

  for (const [key, field] of entries) {
    // A key with a default is satisfied whether or not anybody bound it, so it
    // says nothing about whether the service is bound here.
    const isSignal = field.default === undefined
    if (isSignal) signals.push(key)

    const r = checkEnvField(key, field, env[key])
    for (const w of r.warnings) warnings.push(w)
    if (r.present && isSignal) present.push(key)
    if (r.error) (r.present ? unusable : absent).push({ key, message: r.error })
  }

  const state: AttachmentState =
    unusable.length            ? 'invalid'
    : signals.length === 0     ? 'bound'
    : present.length === 0     ? 'unbound'
    : present.length < signals.length ? 'partial'
    :                            'bound'

  const fatal =
    state === 'bound'   ? false :
    state === 'unbound' ? !optional :
                          true

  const problems = state === 'unbound' ? unusable : [...unusable, ...absent]

  return { name, describe: att.describe, optional, state, signals, present, problems, fatal, warnings }
}

/** Grade every declared attachment. Declaration order is preserved. */
export function checkAttachments(
  declared: Attachments | undefined,
  env: Record<string, string | undefined> = process.env,
): AttachmentReport {
  const results = Object.entries(declared ?? {}).map(([name, att]) => checkAttachment(name, att, env))
  return {
    results,
    fatal:   results.filter(r => r.fatal),
    skipped: results.filter(r => !r.fatal && r.state === 'unbound'),
  }
}

/**
 * The refusal, as the operator will read it.
 *
 * It says which service, which state, which keys — and the fix. The state
 * matters more than the key list: *n8n is bound halfway* and *n8n is not bound
 * here* have different causes and different fixes, and a list of missing
 * variables reads the same either way.
 */
export function formatAttachmentRefusal(fatal: AttachmentResult[]): string {
  const lines: string[] = ['', '[Junction] This environment does not bind every attached service.', '']

  for (const r of fatal) {
    const what    = r.describe ? `${r.name} (${r.describe})` : r.name
    const missing = r.signals.filter(k => !r.present.includes(k))

    if (r.state === 'unbound') {
      lines.push(`  ${what} — not bound here`)
      lines.push(`    needs: ${r.signals.join(', ')}`)
    } else if (r.state === 'partial') {
      lines.push(`  ${what} — bound halfway`)
      lines.push(`    set:     ${r.present.join(', ')}`)
      lines.push(`    missing: ${missing.join(', ')}`)
      // The sharpest thing this check knows: somebody was here and stopped.
      lines.push(`    Something bound part of this service, so this is a gap rather than a choice.`)
    } else {
      lines.push(`  ${what} — bound, but a value is not usable`)
    }

    // A key already named on the `missing` line is not restated — `SEARCH_INDEX`
    // followed by `SEARCH_INDEX is required but not set` is one fact twice, and
    // it pushes the message that DOES add something further down the screen.
    for (const p of r.problems)
      if (!missing.includes(p.key)) lines.push(`    ${p.message}`)
    lines.push('')
  }

  lines.push('An attached service is declared in `attachments` and bound per environment.')
  lines.push('Set the variables above, or declare the service `optional: true` if this')
  lines.push('app can run without it.')
  lines.push('')
  return lines.join('\n')
}

/** One line per optional attachment nobody bound. Said once, at boot. */
export function formatAttachmentSkips(skipped: AttachmentResult[]): string[] {
  return skipped.map(r => {
    const what = r.describe ? `${r.name} (${r.describe})` : r.name
    return `[Junction] attachment ${what} is not bound here — declared optional, so continuing`
  })
}
