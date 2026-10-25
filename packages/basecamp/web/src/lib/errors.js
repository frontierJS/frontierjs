// src/errors.js — one sentence for a thrown value.
//
// `<Form>` already routes a failure through `resource.fieldErrors()` and renders
// the per-field half. A screen whose write is a toggle, an inline editor or a
// row action has no form to render into, so it shows one line — and reaching
// for `e.message` there loses the one translation that matters.
//
// A lost-update race is that case. Litestone's own message names a column and
// two integers, which is true and is not something a person can act on; the
// resource answers the sentence that is ("this record changed while you were
// editing it"). Everything else falls through to the raw message, because a
// framework that cannot say more should not invent less.

/**
 * @param {{ fieldErrors(err: unknown): { fields: Record<string,string>, message: string } }} resource
 * @param {unknown} err
 * @returns {string}
 */
export function messageFor(resource, err) {
  const { fields, message } = resource.fieldErrors(err)
  if (message) return message

  // A 400 with per-field detail and no form to put it in. Naming the fields is
  // still better than "Validation failed" — this is what the person has to fix.
  const named = Object.entries(fields).map(([field, text]) => `${field}: ${text}`)
  if (named.length) return named.join(' · ')

  return err?.message ?? String(err)
}
