// @frontierjs/ui — shared utilities
// Plain JS — no Mesa, no store API

// A field name as a person reads it. The kit owns it because sierra needs the
// same answer for a different reason — a stored value whose row it could not
// read still has to render (`FJS-D225`) — and two copies of *what does this
// identifier say* drift the moment one of them learns about initialisms.
export { humanize } from '@frontierjs/toolbelt/inflect'

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
  const rule = form?.fields?.[name] ?? null
  if (!rule) return null

  // `@required(where: …)` is required in the rows a predicate admits, so
  // `rule.required` is *not unconditionally required* and the answer for THIS
  // row is in the record. `<Form>` resolves it — the evaluator is
  // `@frontierjs/toolbelt/predicate`, which is litestone's own, so the
  // affordance and the boundary read the rule the same way — and passes the
  // names, the way it already passes `sealed` for the frozen ones.
  //
  // Folded in HERE rather than given a `requiredBy()` of its own, which is what
  // `lockedBy` is: twelve controls read `rule?.required` and a thirteenth will,
  // so the choice is one line here or twelve edits and a rule for the next
  // control to remember. A rule resolved for the row IS the rule this control
  // is under.
  //
  // The copy is only made for a field the form actually named, so a form with
  // no conditional column allocates nothing.
  if (rule.required || !Array.isArray(form.required)) return rule
  return form.required.includes(name) ? { ...rule, required: true } : rule
}

/**
 * Is this control locked by the form above it?
 *
 * Four reasons and one answer, because a control that spelled them out
 * separately would have to be told about the next one. The caller disabled the
 * form, a save is in flight, the column is FROZEN for the row being edited —
 * an `@immutable` field on a model that seals, once the row has reached a
 * sealed state — or the column was WITHHELD from the read. The last two are in
 * the row rather than the schema, so no `readOnly` keyword can carry either and
 * the form resolves them and passes the lists.
 *
 * Withheld is the one that is not about permission to WRITE. A field
 * `@allow('read', …)` strips the key, so the form holds no value for it, and an
 * editable empty box would save that emptiness over whatever is stored — which
 * the boundary accepts, because a read policy is not a write policy. Locking it
 * is not an affordance stricter than the rule: there is no value here to send.
 *
 * A stated `disabled` still wins over all three: the seal is an affordance
 * here, and the Data boundary refuses the write whatever this renders
 * (Invariant 6). What a `disabled={false}` cannot do is put the value back in
 * the payload — `<Form>` drops a frozen key on the way out.
 */
export function lockedBy(form, name) {
  if (!form) return false
  if (form.disabled || form.submitting) return true
  if (Array.isArray(form.sealed) && form.sealed.includes(name)) return true
  return withheldBy(form, name)
}

/**
 * Was this column kept back by the server rather than empty?
 *
 * Its own predicate and not folded into `lockedBy` alone, because the two
 * answers are read by different things: a control asks whether it is locked, and
 * the field around it asks whether to SAY why. An empty disabled box and a
 * withheld one look identical, which is the whole defect.
 */
export function withheldBy(form, name) {
  return Array.isArray(form?.withheld) && form.withheld.includes(name)
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
 * a feed-dot. No component here keeps a color list; they call tone().
 *
 * The aliases exist because component APIs in the wild say `type="error"`
 * or `color="red"`, and rewriting every call site is not the point. An
 * unrecognized name resolves to '' rather than guessing, so a typo renders
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
 * Resolve a color-ish prop to one of the seven @frontierjs/css tones.
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

/**
 * A picker's list, split into the three things it can hold.
 *
 * `resource.options()` answers one array with two flags on it: `unavailable`
 * pins the value in the box back onto a list that no longer contains it
 * (`FJS-D225`), and `recent` marks the head — the values this caller reached
 * for last (`FJS-D121`). Both are pinned at the FRONT, so a control that
 * renders the array as it arrives shows entries at the top that are neither
 * alphabetical nor whatever the set declared, with nothing saying why they are
 * there — which reads as a broken sort (`FJS-973`).
 *
 * Three buckets rather than two, because the pinned value is not part of the
 * head and must not be captioned as one: it is the value the field is holding,
 * and the reason it is at the top is that it is selected.
 *
 * A list with no head comes back with `recent: []`, which is every list a set
 * declaring no `recent(…)` produces — so a control checks that and renders
 * exactly what it rendered before.
 */
export function splitRecent(options = []) {
  const pinned = [], recent = [], rest = []
  for (const o of options) {
    if (o?.unavailable)  pinned.push(o)
    else if (o?.recent)  recent.push(o)
    else                 rest.push(o)
  }
  return { pinned, recent, rest }
}

/** What a head is called on screen. One spelling, read by every control. */
export const RECENT_GROUP = 'Recently used'
/** …and the rest of the list. NOT "All": the head is not in it. */
export const REST_GROUP   = 'Everything else'
