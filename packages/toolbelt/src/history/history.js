/*
 * history.js — the key that identifies one occurrence of change.
 *
 * Four mechanisms in this repo answer the same question — *has this exact unit
 * of work already happened?* — and each built its own key to do it: junction's
 * idempotency claim, junction's outbox relay, caravan's cron fire, and the id a
 * caller states on a dispatch. Every one of them was a template literal at its
 * call site, so there was no place to ask what an occurrence key IS and no way
 * to see that one of them interpolated a caller-supplied name without escaping
 * it.
 *
 * That matters because these keys are not internal: a stated dispatch id is the
 * jobs table's PRIMARY KEY, which is what makes a replayed dispatch a no-op
 * rather than a second row. A key that can collide is two units of work
 * silently becoming one, and a key format that changes under a queue with rows
 * in it is one unit of work becoming two — across a deploy, on the mechanism
 * whose whole job is to run something once.
 *
 * The one property required of this function is INJECTIVITY: different parts
 * must produce different keys, always. Everything below exists for that.
 */

/**
 * Build the key naming one occurrence of change.
 *
 * The `kind` is the namespace — `idem`, `cron`, `outbox` — and it is separate
 * from the parts so that two mechanisms writing into one table cannot collide
 * by arithmetic: an outbox row with id 7 and a caller who states `7` are not
 * the same unit of work, and nothing but a namespace can say so.
 *
 * @param {string} kind        the mechanism this key belongs to
 * @param {...(string|number)} parts  what distinguishes this occurrence within it
 * @returns {string}
 */
export function occurrenceKey(kind, ...parts) {
  if (typeof kind !== 'string' || kind === '') {
    throw new TypeError('occurrenceKey: kind must be a non-empty string')
  }
  if (kind.includes(':')) {
    throw new TypeError(`occurrenceKey: kind must not contain ':' (got '${kind}')`)
  }
  if (parts.length === 0) {
    throw new TypeError(`occurrenceKey(${kind}): at least one part is required — a kind alone names every occurrence of it`)
  }

  return `${kind}:${parts.map((p, i) => encodePart(p, kind, i)).join(':')}`
}

/**
 * A part, escaped so the join is reversible.
 *
 * `%` is escaped BEFORE `:`, and that order is the whole of the correctness
 * argument: escaping only the separator is not injective, because a part that
 * already reads `%3A` and a part containing a real colon would encode to the
 * same bytes and two different occurrences would share one key.
 *
 * `null` and `undefined` are refused rather than stringified. They are what a
 * missing id looks like, and `cron:daily-report:undefined` is a key that every
 * fire of that job shares — the exact failure the key exists to prevent, made
 * permanent by the primary key it becomes.
 */
function encodePart(part, kind, index) {
  if (part === null || part === undefined) {
    throw new TypeError(
      `occurrenceKey(${kind}): part ${index} is ${part === null ? 'null' : 'undefined'} — ` +
      `a missing part makes every occurrence share one key`
    )
  }
  if (typeof part === 'number') {
    // NaN stringifies to 'NaN' and every NaN is a different computation with
    // the same spelling; Infinity is not an id either.
    if (!Number.isFinite(part)) {
      throw new TypeError(`occurrenceKey(${kind}): part ${index} is ${part}, which names no occurrence`)
    }
    return String(part)
  }
  if (typeof part !== 'string') {
    throw new TypeError(
      `occurrenceKey(${kind}): part ${index} is a ${typeof part} — ` +
      `only strings and finite numbers have one spelling`
    )
  }
  return part.replaceAll('%', '%25').replaceAll(':', '%3A')
}
