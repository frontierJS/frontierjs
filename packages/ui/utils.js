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
 * Is this control locked by the form above it?
 *
 * Three reasons and one answer, because a control that spelled them out
 * separately would have to be told about the next one. The caller disabled the
 * form, a save is in flight, or the column is FROZEN for the row being edited —
 * an `@immutable` field on a model that seals, once the row has reached a
 * sealed state. That last one is in the row rather than the schema, so no
 * `readOnly` keyword can carry it and the form resolves it and passes the list.
 *
 * A stated `disabled` still wins over all three: the seal is an affordance
 * here, and the Data boundary refuses the write whatever this renders
 * (Invariant 6). What a `disabled={false}` cannot do is put the value back in
 * the payload — `<Form>` drops a frozen key on the way out.
 */
export function lockedBy(form, name) {
  if (!form) return false
  if (form.disabled || form.submitting) return true
  return Array.isArray(form.sealed) && form.sealed.includes(name)
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
 * ── Native validation, in a form the kit does not own ────────────────
 *
 * A kit control puts a REAL `required` (and `minlength`, `pattern`, `min`…)
 * on its element, deliberately: that attribute is what assistive tech
 * announces. The cost is that the browser then refuses to fire `submit` and
 * shows its own bubble instead — with a message that is not the schema's, in a
 * place the layout did not plan for. It reads as "the submit handler is
 * broken", and nothing anywhere says otherwise.
 *
 * `<Form>` is `novalidate` by default so this cannot happen there. A
 * hand-written `<form>` has no such default and is the whole of what remains
 * (`FJS-055`), so a control mounting into one says so — once per form, naming
 * a field that is currently blocking it.
 *
 * `data-native-validation` on the form is the way to say the browser's own UI
 * is what you want, and suppresses it.
 */
const _warnedForms = new WeakSet()

export function nativeValidationGuard(el) {
  const form = el?.form
  // No form: nothing submits, so nothing is blocked. Already novalidate, or
  // opted in to the browser's UI on purpose: both are answers.
  if (!form || form.noValidate || form.hasAttribute('data-native-validation')) return
  // `validity`, never `checkValidity()` — the method fires an `invalid` event,
  // which is a real event this kit's controls listen for.
  if (!el.willValidate || el.validity.valid) return
  if (_warnedForms.has(form)) return
  _warnedForms.add(form)

  const field = el.name || el.id || el.tagName.toLowerCase()
  console.warn(
    `[@frontierjs/ui] "${field}" carries a native constraint inside a <form> that is not ` +
    `novalidate, so the browser will refuse to fire submit and show its own message ` +
    `instead of the schema's. Use <Form>, which is novalidate by default, or put ` +
    `novalidate on the form. To keep the browser's validation UI on purpose, mark the ` +
    `form data-native-validation.`
  )
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
  gray:    'muted',
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

/*
 * ── A list that was cut ───────────────────────────────────────────────
 */

/**
 * What a control says when the server had more rows than it sent.
 *
 * `resource.options()` answers `{ options, total, truncated }` and a caller
 * that renders only the rows cannot tell a list of a hundred from the first
 * hundred of four hundred — the row somebody is looking for is simply absent,
 * with nothing on screen saying why (`FJS-391`).
 *
 * `total` is `null`/`undefined` where the service reported none, and *unknown*
 * is not *complete*: no number, no sentence, because a wrong count is worse
 * than none. One owner, so three controls cannot word it three ways.
 */
export function truncationNote(shown, total, { searchable = false } = {}) {
  if (!Number.isFinite(total) || !Number.isFinite(shown) || total <= shown) return ''
  return searchable
    ? `Showing ${shown} of ${total} — type to search the rest.`
    : `Showing ${shown} of ${total}.`
}

/**
 * A picker that could not ASK, said where the count goes.
 *
 * An empty list and a list nobody could fetch render identically, and a person
 * reads both as *there are none* — which is how a service no name resolved to
 * looked like a shop with no variants in it (`FJS-587`). `resource.options()`
 * answers `error` for exactly this; without a reader it was thrown away.
 *
 * A note and not a field error, deliberately: the value may be legitimately
 * absent, so marking the field invalid would refuse a submit on every optional
 * relation whose rows happened not to arrive.
 */
export function optionsNote(error) {
  return error ? `Options could not be loaded — ${String(error)}` : ''
}

/** The caller's hint and the count, in that order, as one line. */
export function withNote(hint, note) {
  return [hint, note].filter(Boolean).join(' ')
}
