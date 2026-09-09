/**
 * controls.js — control name → component.
 *
 * The other half of a contributed control. Sierra's `field-rules.js` decides
 * WHICH control a column gets and answers a name; this decides what that name
 * renders as. Two registrations rather than one because the boundary between
 * them is a dependency rule: Sierra's table is a leaf that runs in plain Node
 * (a test, a prerender, a snapshot) and cannot hold a component, and this kit
 * peers only on mesa and css and cannot import Sierra to learn what a `Float`
 * is. A name is the one thing that crosses.
 *
 *   // one place in the app, at startup
 *   import { registerControl }     from '@frontierjs/sierra/junction'
 *   import { registerFormControl } from '@frontierjs/ui/controls'
 *   import Money from './Money.mesa'
 *
 *   registerControl('money', (rule) => rule['x-money'] ? 'money' : null)
 *   registerFormControl('money', Money)
 *
 * A registered name REPLACES a built-in of the same name, so swapping the
 * kit's `select` for a combobox everywhere is one line and not a fork. The
 * kit's own five are in `components/forms/FormField.mesa` in this same shape —
 * a contributed control takes the identical path, which is what stops the
 * extension route being a second-class one that rots.
 *
 * ── What a control is handed ────────────────────────────────────────────────
 *
 * With no `props` builder, the component is called with:
 *
 *   name     the column name — put it on the element that emits input, or the
 *            form's dirty tracking and its blur-reveal cannot see this field
 *   field    the whole descriptor from formFields() — `rule` is the schema
 *   value    the current value
 *   onvalue  (v) => void — hand back the new value
 *   options  a foreign key's rows, once they arrive; [] until then
 *
 * A control that wraps an existing component instead supplies `props`, which
 * receives the same object and returns whatever that component takes.
 */

/** name → { component, props? }. */
const _controls = new Map()

/**
 * Bind a control name to a component.
 *
 * @param {string} name        the name a resolver answers in `registerControl`
 * @param {Function} component a Mesa component
 * @param {{props?: (ctx: object) => object}} [options]
 * @returns {() => void} the undo, for a test teardown or an HMR dispose
 */
export function registerFormControl(name, component, options = {}) {
  if (typeof name !== 'string' || !name) {
    throw new TypeError('registerFormControl(name, component) — name must be a non-empty string')
  }
  if (typeof component !== 'function') {
    throw new TypeError(`registerFormControl('${name}') — component must be a Mesa component`)
  }
  if (options.props !== undefined && typeof options.props !== 'function') {
    throw new TypeError(`registerFormControl('${name}') — props must be a function (ctx) => object`)
  }

  const entry = { component, props: options.props }
  _controls.set(name, entry)

  return () => { if (_controls.get(name) === entry) _controls.delete(name) }
}

/** Remove a binding by name. Answers whether there was one. */
export function unregisterFormControl(name) {
  return _controls.delete(name)
}

/** The entry for a name, or null. Consulted by `FormField.mesa` before its own table. */
export function formControl(name) {
  return _controls.get(name) ?? null
}

/** Every bound name. Diagnostics — a control that renders nothing is usually a name that was never bound. */
export function registeredFormControls() {
  return [..._controls.keys()]
}

// ── Displays ──────────────────────────────────────────────────────────────────
//
// The other half of a contributed DISPLAY, on the same terms as a control and
// for the same dependency reason: sierra's `displayFor` answers a name and
// cannot hold a component, this kit binds the name and cannot import sierra.
//
//   import { registerDisplay }          from '@frontierjs/sierra/junction'
//   import { registerDisplayComponent } from '@frontierjs/ui/controls'
//   import Duration from './Duration.mesa'
//
//   registerDisplay('duration', (rule) =>
//     rule['x-litestone-kind'] === 'duration' ? 'duration' : null)
//   registerDisplayComponent('duration', Duration)
//
// ── What a display is handed ─────────────────────────────────────────────────
//
//   value    the value from the record — which may be null, and a display is
//            the one thing that must render that rather than skipping it
//   column   the whole entry from `resource.columns()`: `name`, `rule`, the
//            `tier` it ranked in, and the descriptor `displayFor` answered,
//            so `currency` and `options` are on it
//   record   the whole row, for a display that needs a sibling column — a
//            currency held in a second column is the case this exists for
//
// A display that wraps an existing component supplies `props` instead, which
// receives the same object and returns whatever that component takes.

/** name → { component, props? }. */
const _displays = new Map()

/**
 * Bind a display name to a component.
 *
 * @param {string} name        the name a resolver answers in `registerDisplay`
 * @param {Function} component a Mesa component
 * @param {{props?: (ctx: object) => object}} [options]
 * @returns {() => void} the undo, for a test teardown or an HMR dispose
 */
export function registerDisplayComponent(name, component, options = {}) {
  if (typeof name !== 'string' || !name) {
    throw new TypeError('registerDisplayComponent(name, component) — name must be a non-empty string')
  }
  if (typeof component !== 'function') {
    throw new TypeError(`registerDisplayComponent('${name}') — component must be a Mesa component`)
  }
  if (options.props !== undefined && typeof options.props !== 'function') {
    throw new TypeError(`registerDisplayComponent('${name}') — props must be a function (ctx) => object`)
  }

  const entry = { component, props: options.props }
  _displays.set(name, entry)

  return () => { if (_displays.get(name) === entry) _displays.delete(name) }
}

/** Remove a binding by name. Answers whether there was one. */
export function unregisterDisplayComponent(name) {
  return _displays.delete(name)
}

/** The entry for a name, or null. Consulted by `Cell.mesa` before its own table. */
export function displayComponent(name) {
  return _displays.get(name) ?? null
}

/** Every bound name. Diagnostics. */
export function registeredDisplayComponents() {
  return [..._displays.keys()]
}

/**
 * The props a display gets when its entry supplied no builder.
 */
export function defaultDisplayProps({ value, column, record }) {
  return { value, column, record }
}

// ── Filters ───────────────────────────────────────────────────────────────────
//
// The third binding, and the reason it is a binding rather than a third
// registry: a column has ONE kind and `displayFor` named it. Sierra's
// `filterOpFor(display)` says what a filter over that kind ASKS — `contains`
// for text, a `gte`/`lte` range for money and time, `in` for a bound set — and
// this says what asking it looks like.
//
// So a name registered as a display can be given a filter too, and the two stay
// the same column:
//
//   registerDisplay('duration', (rule) => …)          // sierra
//   registerDisplayComponent('duration', DurationCell) // read
//   registerFilterComponent('duration', DurationRange) // filter
//
// A display name with no filter component bound simply offers no filter, which
// is the same answer `filterOpFor` gives for a Json column: correct, and said
// out loud rather than missing.
//
// ── What a filter is handed ──────────────────────────────────────────────────
//
//   value     the current filter value, or undefined when nothing is filtered.
//             `undefined` is the ONLY empty — a filter set to '' is a filter
//             FOR the empty string, and the bar deletes the key instead
//   onvalue   (v) => void — `undefined` clears
//   column    the entry from `resource.filters()`: `name`, `label`, `rule`,
//             the `display` it renders as, and the `op`/`kind` it asks with
//   options   a bound column's rows, once they arrive; [] until then

/** name → { component, props? }. */
const _filters = new Map()

/**
 * Bind a filter name to a component.
 *
 * @param {string} name        a display name from `displayFor`
 * @param {Function} component a Mesa component
 * @param {{props?: (ctx: object) => object}} [options]
 * @returns {() => void} the undo, for a test teardown or an HMR dispose
 */
export function registerFilterComponent(name, component, options = {}) {
  if (typeof name !== 'string' || !name) {
    throw new TypeError('registerFilterComponent(name, component) — name must be a non-empty string')
  }
  if (typeof component !== 'function') {
    throw new TypeError(`registerFilterComponent('${name}') — component must be a Mesa component`)
  }
  if (options.props !== undefined && typeof options.props !== 'function') {
    throw new TypeError(`registerFilterComponent('${name}') — props must be a function (ctx) => object`)
  }

  const entry = { component, props: options.props }
  _filters.set(name, entry)

  return () => { if (_filters.get(name) === entry) _filters.delete(name) }
}

/** Remove a binding by name. Answers whether there was one. */
export function unregisterFilterComponent(name) {
  return _filters.delete(name)
}

/** The entry for a name, or null. Consulted by `FilterBar.mesa` before its own table. */
export function filterComponent(name) {
  return _filters.get(name) ?? null
}

/** Every bound name. Diagnostics. */
export function registeredFilterComponents() {
  return [..._filters.keys()]
}

/** The props a filter gets when its entry supplied no builder. */
export function defaultFilterProps({ value, onvalue, column, options }) {
  return { value, onvalue, column, options }
}

/**
 * The props a control gets when its entry supplied no builder.
 *
 * Exported because `FormField.mesa` uses it and a `props` builder that only
 * wants to add one key should not have to restate it.
 */
export function defaultControlProps({ field, value, onvalue, options, total, optionsError }) {
  return { name: field.name, field, value, onvalue, options, total, optionsError }
}
