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
 *   registerControl('money', (rule, { field }) => field.endsWith('Cents') ? 'money' : null)
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

/**
 * The props a control gets when its entry supplied no builder.
 *
 * Exported because `FormField.mesa` uses it and a `props` builder that only
 * wants to add one key should not have to restate it.
 */
export function defaultControlProps({ field, value, onvalue, options, total }) {
  return { name: field.name, field, value, onvalue, options, total }
}
