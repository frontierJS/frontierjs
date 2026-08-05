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
