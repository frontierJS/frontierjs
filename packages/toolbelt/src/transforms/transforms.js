/**
 * transforms — what `@trim`, `@lower`, `@upper` and `@slug` do to a value.
 *
 * `@frontierjs/toolbelt/transforms`. Litestone applies them at the Data
 * boundary, Junction before it grades a service payload, Sierra before it
 * grades a form field, and all three read this one table. Two copies would
 * disagree about what a stored value can be, and the disagreement shows up as
 * a field that is valid in one realm and refused in the next (`FJS-401`).
 *
 * They run BEFORE the validators, in the order declared: `@trim @length(3, 12)`
 * on `'  ab  '` is two characters wherever it is asked.
 */

import { slug } from '../inflect/inflect.js'

const TRANSFORMS = {
  trim:  (v) => String(v).trim(),
  lower: (v) => String(v).toLowerCase(),
  upper: (v) => String(v).toUpperCase(),
  slug:  (v) => slug(v),
}

/** The names a field can declare, as they appear in `x-transforms`. */
export const TRANSFORM_NAMES = Object.keys(TRANSFORMS)

/** Whether `name` is a transform. */
export function isTransform(name) {
  return Object.hasOwn(TRANSFORMS, name)
}

/**
 * One value through an ordered list of transforms. A name this kit does not
 * know is skipped: a newer schema read by an older reader must not throw.
 *
 * @param {readonly string[]|null|undefined} names
 * @param {unknown} value
 * @returns {unknown}
 */
export function transform(names, value) {
  if (!names?.length) return value
  let v = value
  for (const name of names) if (isTransform(name)) v = TRANSFORMS[name](v)
  return v
}
