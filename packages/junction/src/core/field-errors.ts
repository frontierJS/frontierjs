// core/field-errors.ts
//
// A thrown value carrying one message PER FIELD — built, not hand-rolled.
//
// The shape has had a reader and no writer. Sierra's `toFieldErrors`
// (junction/field-rules.js) knows how to pull `[{ field, message }]` off a
// thrown value, through the three wrappings each hop adds, and `<Form>` renders
// the result under the right control. What produced that shape was junction's
// own validator and nothing else — so a DECLARED rule reported every field at
// once and rendered in place, while a hand-written business rule threw one
// sentence with no field and rendered as a banner or not at all. Same service,
// same request, two grades of error.
//
// So this is the writer, and it is not a second definition of the shape: the
// validator's own `parse()` throws through `fieldError()` below, which is the
// one place a list of field errors becomes an error object.
//
// ─── Which one to reach for ───────────────────────────────────────────────
//
// `validateFields(fn)` unless there is a reason not to. Its whole argument is
// that a recorded error cannot be forgotten — the throw is the end of the call,
// not a line you have to remember to write. A builder held by hand can be
// written to and never thrown, and that reads as validation which quietly does
// nothing, which is worse than no validation at all.
//
// `fieldErrors()` is for checks spread across helpers, where one function
// records and another decides. Then the throw is yours.

import { BadRequest, FrameworkError } from './errors.ts'

/** One field, one sentence. `'_'` is the payload itself — see `payload()`. */
export interface FieldError {
  field:   string
  message: string
}

/**
 * A list of field errors → the thrown value. The ONE place that translation
 * happens (Invariant 4).
 *
 * `.data` is the list, which is what every reader downstream is looking for,
 * and `.message` is the same content joined — because a caller that is not a
 * form (a job, a log line, a curl) still has to be told something true.
 *
 * The status is 400 rather than 422 deliberately. A schema violation and a
 * refused business rule are arguably different kinds of wrong, but they render
 * identically and a client that has to tell them apart to show a message has
 * been handed a distinction it cannot use. `status` is there for an app that
 * wants the difference on the wire anyway.
 */
export function fieldError(
  errors:  readonly FieldError[],
  message?: string,
  status:   number = 400,
): FrameworkError {
  const err = new BadRequest(
    message ?? errors.map(e => `${e.field}: ${e.message}`).join(', ')
  )
  err.data = [...errors]
  err.code = status
  return err
}

export interface FieldErrorBuilder {
  /** Record a message against a field. Repeatable, and the point. */
  invalid(field: string, message: string): FieldErrorBuilder
  /**
   * Record a message against the payload rather than a field — "an order needs
   * at least one line". Stored under `'_'`, which is the slot junction's own
   * validator uses for "Expected an object" and which a form renders as its
   * one overall message.
   */
  payload(message: string): FieldErrorBuilder
  /** Has anything been recorded? */
  readonly any: boolean
  /** What has been recorded, in the order it was recorded. */
  list(): FieldError[]
  /**
   * Throw if anything was recorded, otherwise return.
   *
   * A no-op when nothing was recorded, so it is safe to call unconditionally —
   * which is how it should be called.
   */
  throwIfAny(message?: string): void
}

/**
 * A builder to record field errors into.
 *
 * Nothing ambient: it holds its own state and the caller holds it. That is
 * deliberate — `$` is the call you are inside and the whole of what makes it
 * safe is that no one can keep state on it (see core/context.ts), and an
 * accumulator is state.
 */
export function fieldErrors(): FieldErrorBuilder {
  const errors: FieldError[] = []

  const builder: FieldErrorBuilder = {
    invalid(field, message) {
      // Both are required and neither is checked at a type boundary a plain-JS
      // app crosses, so an empty one is refused here rather than becoming a
      // blank message under a control.
      if (typeof field !== 'string' || !field.trim())
        throw new TypeError(`[Junction] invalid() needs a field name, got ${JSON.stringify(field)}`)
      if (typeof message !== 'string' || !message.trim())
        throw new TypeError(`[Junction] invalid('${field}') needs a message, got ${JSON.stringify(message)}`)
      errors.push({ field, message })
      return builder
    },

    payload(message) {
      if (typeof message !== 'string' || !message.trim())
        throw new TypeError(`[Junction] payload() needs a message, got ${JSON.stringify(message)}`)
      errors.push({ field: '_', message })
      return builder
    },

    get any() { return errors.length > 0 },

    list() { return [...errors] },

    throwIfAny(message) {
      if (errors.length) throw fieldError(errors, message)
    },
  }

  return builder
}

/**
 * Run the checks, and throw everything they found at once.
 *
 * The form to reach for, because the throw is the end of the call rather than a
 * line to remember. `fn` may be async — a rule that has to ask the database is
 * an ordinary rule.
 *
 *   await validateFields(e => {
 *     if (!inStock)      e.invalid('items', 'Out of stock')
 *     if (card.expired)  e.invalid('card',  'This card has expired')
 *     if (!lines.length) e.payload('An order needs at least one line')
 *   })
 */
export async function validateFields(
  fn: (e: FieldErrorBuilder) => void | Promise<void>,
  message?: string,
): Promise<void> {
  const e = fieldErrors()
  await fn(e)
  e.throwIfAny(message)
}
