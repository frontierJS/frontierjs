// @frontierjs/ui — shared utilities
// Plain JS — no Mesa, no store API

/**
 * Convert a camelCase or snake_case identifier to a Title Case label.
 * nameToLabel('firstName')   → 'First Name'
 * nameToLabel('postal_code') → 'Postal Code'
 */
export function nameToLabel(str = '') {
  return str
    .replace(/_/g, ' ')
    .replace(/^[a-z]|[A-Z]/g, (c, i) => (i ? ' ' : '') + c.toUpperCase())
    .trim()
}

/**
 * Generate a stable random id suffix for label/input association.
 * Not cryptographically secure — only used for DOM id attributes.
 */
export function uid(prefix = 'id') {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`
}

/*
 * ── Form context ─────────────────────────────────────────────────────
 *
 * A control under <Form> can learn two things from it without being handed
 * them: its own server error, and its own rules from db/schema.lite. Both
 * resolvers take the consumed `$context.form` — the read itself has to happen
 * in the component (Mesa RULE 25: provides and consumes are top level) — and
 * both treat an absent form as "nothing to add", so every control still works
 * standing on its own.
 *
 * An explicitly-passed prop always wins. That is what keeps the form context
 * an affordance rather than a thing you have to fight.
 */

/**
 * The message to show under a control.
 * Order: the `error` prop, then an `errors` map passed directly, then the
 * enclosing form's map. First hit wins; '' when there is nothing to say.
 */
export function resolveError(form, name, error, errors) {
  return error || errors?.[name] || (name ? form?.errors?.[name] : '') || ''
}

/**
 * The field's rule object from the schema — `{ type, required, maxLength,
 * title, enum, format, … }` as buildFieldRules() emits it — or null when there
 * is no form, no name, or no schema behind it.
 */
export function resolveRule(form, name) {
  if (!name) return null
  return form?.fields?.[name] ?? null
}

/**
 * Pick the first value that was actually stated.
 *
 * `undefined` means "not stated" and everything else is a real answer,
 * including `false` and `0` — so `required={false}` beats a schema that says
 * required, and `??` is the operator rather than `||`.
 */
export function stated(...values) {
  for (const v of values) if (v !== undefined && v !== null) return v
  return undefined
}

/*
 * ── Tones ────────────────────────────────────────────────────────────
 *
 * @frontierjs/css has exactly seven tones, and a tone is one free-standing
 * class that works on every element that takes one — a btn, a card, a <tr>,
 * a feed-dot. No component here keeps a colour list; they call tone().
 *
 * The aliases exist because component APIs in the wild say `type="error"`
 * or `color="red"`, and rewriting every call site is not the point. An
 * unrecognised name resolves to '' rather than guessing, so a typo renders
 * untoned (the component's own default) instead of silently wrong.
 */
export const TONES = [
  'primary', 'secondary', 'muted', 'info', 'success', 'warning', 'danger',
]

const TONE_ALIASES = {
  // semantic names other kits use
  error:   'danger',
  neutral: 'muted',
  gray:    'muted',
  grey:    'muted',
  default: '',
  none:    '',

  // raw hue names, from the Tailwind-era palette props
  red:     'danger',
  rose:    'danger',
  green:   'success',
  emerald: 'success',
  teal:    'success',
  yellow:  'warning',
  amber:   'warning',
  orange:  'warning',
  blue:    'primary',
  indigo:  'primary',
  cyan:    'info',
  sky:     'info',
  purple:  'secondary',
  violet:  'secondary',
  fuchsia: 'secondary',
  pink:    'secondary',
}

/**
 * Resolve a colour-ish prop to one of the seven @frontierjs/css tones.
 * Returns '' when there is no sensible mapping, which means "untoned" —
 * every component in the package falls back to its own default that way.
 *
 *   tone('error')   → 'danger'
 *   tone('success') → 'success'
 *   tone('teal')    → 'success'
 *   tone('mauve')   → ''
 */
export function tone(name) {
  if (!name) return ''
  const key = String(name).toLowerCase()
  if (TONES.includes(key)) return key
  return TONE_ALIASES[key] ?? ''
}

/**
 * Join class fragments, dropping anything falsy, and collapse whitespace.
 * Mesa interpolates `{a} {b}` literally, so an empty tone would otherwise
 * leave a double space in the attribute — harmless but noisy in the DOM
 * and in test assertions.
 *
 *   cx('btn', tone(variant), square && 'square')  → 'btn danger square'
 */
export function cx(...parts) {
  return parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
}
