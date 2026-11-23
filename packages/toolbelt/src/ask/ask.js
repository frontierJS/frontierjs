/*
 * ask.js — one question to a model, one reply, whichever door answered it.
 *
 * A DOOR is a way into a model: the local `claude` program signed in as the
 * developer (`@frontierjs/claude`), the Messages API with a key
 * (`@frontierjs/conduit-anthropic`), a recording, a test's stub. Each is built
 * with a model and answers `door(question, { model, signal })` with a `Reply`;
 * `model` there moves one question to another model, as Lathe's picker moves a
 * chat, and `Reply.model` names what answered.
 * Nothing above a door knows which one ran, so an app moves between a
 * subscription and a deployed key without changing a line (FJS-D2327).
 *
 * The contract is three rules, and this kit holds what can be checked of them:
 *
 *   A door never throws. An unanswered question is a reply, with a REASON from
 *   the closed set below, so a caller branches on one vocabulary and two doors
 *   cannot name one lost answer `lost` and `exited`.
 *
 *   A door never retries on the caller's behalf. A completion is a bill, and
 *   spending again is the caller's decision. The one exception is inside the
 *   API door: a 429 or 529 is refused before anything runs, so it is sent once
 *   more (FJS-D2326) and reaches the caller only if that fails too.
 *
 *   `retryable` belongs to the reason, never to the door, so two doors cannot
 *   disagree about whether one failure is worth asking again.
 *
 * Session resume, budgets, temperature and token caps are not here: the local
 * program honors no token cap and the API keeps no session, so a field for
 * either would be a lie on one door. They are each door's own options.
 */

/**
 * Every reason a question can go unanswered. `retryable` says whether asking
 * the same question again could work with nothing changed; it does NOT say a
 * retry is free — `lost` and `timeout` may already have been billed.
 */
export const REASONS = Object.freeze({
  not_set_up:   Object.freeze({ retryable: false, means: 'This door cannot run here: no program, no key, or no recording for this question.' }),
  signed_out:   Object.freeze({ retryable: false, means: 'The door is not signed in, or its key was refused.' }),
  forbidden:    Object.freeze({ retryable: false, means: 'The account may not use this model.' }),
  model_gone:   Object.freeze({ retryable: false, means: 'That model does not exist, or no longer does.' }),
  too_long:     Object.freeze({ retryable: false, means: 'The question is too long for one request.' }),
  refused:      Object.freeze({ retryable: false, means: 'The request was malformed and was refused.' }),
  rate_limited: Object.freeze({ retryable: true,  means: 'The model is rate limited or over its usage limit right now.' }),
  timeout:      Object.freeze({ retryable: true,  means: 'The model did not answer in time. It may still have been billed.' }),
  lost:         Object.freeze({ retryable: true,  means: 'The answer never arrived. It may still have been billed.' }),
  model_error:  Object.freeze({ retryable: true,  means: 'The model reported an error instead of an answer.' }),
  no_answer:    Object.freeze({ retryable: true,  means: 'The model answered in prose instead of the structure it was asked for.' }),
  cut_off:      Object.freeze({ retryable: false, means: 'The answer was longer than the reply allows and was cut off.' }),
  aborted:      Object.freeze({ retryable: false, means: 'The caller stopped the question.' }),
})

/** How much of a door's raw output a failure keeps: enough to diagnose, not a transcript. */
export const DETAIL_LIMIT = 2000

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k)

/**
 * The failure for `reason`, with `retryable` read from the table. `message` is
 * the door's words for its host (a missing key is `ANTHROPIC_API_KEY` on one
 * door and `claude /login` on the other); it defaults to the table's. A reason
 * outside the set throws — it is the door's bug, and returning it would hand the
 * caller a name nothing branches on.
 */
export function unanswered(reason, message, detail) {
  if (typeof reason !== 'string' || !own(REASONS, reason)) {
    throw new TypeError(`ask: "${reason}" is not a reason a question can go unanswered. It is one of: ${Object.keys(REASONS).join(', ')}`)
  }
  const failure = { reason, message: message || REASONS[reason].means, retryable: REASONS[reason].retryable }
  if (detail != null && detail !== '') failure.detail = String(detail).slice(0, DETAIL_LIMIT)
  return failure
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isCount = (v) => v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0)

/**
 * What is wrong with `reply` as a door's answer to `question`, one sentence per
 * problem; empty when it keeps the contract. Each door's own tests run every
 * reply they can produce through this, and a reply read back from disk (a
 * recording) is foreign and goes through it before anything trusts it.
 */
export function checkReply(reply, question) {
  if (!isPlainObject(reply)) return ['a reply is an object']
  const problems = []
  if (typeof reply.ok !== 'boolean') problems.push('`ok` is true or false')
  if (typeof reply.door !== 'string' || !reply.door) problems.push('`door` names the door that answered')
  if (typeof reply.model !== 'string' || !reply.model) problems.push('`model` names the model that answered')
  if (typeof reply.ms !== 'number' || !Number.isFinite(reply.ms) || reply.ms < 0) problems.push('`ms` is a duration in milliseconds')

  if (reply.ok === true) {
    if (own(reply, 'failure')) problems.push('an answered reply carries no `failure`')
    const schema = question && question.schema
    if (schema) {
      if (!isPlainObject(reply.answer)) problems.push('a question with a schema is answered with an object')
    } else if (question && typeof reply.answer !== 'string') {
      problems.push('a question without a schema is answered with text')
    } else if (typeof reply.answer !== 'string' && !isPlainObject(reply.answer)) {
      problems.push('`answer` is text or an object')
    }
    if (reply.usage !== null) {
      if (!isPlainObject(reply.usage)) problems.push('`usage` is null or { inputTokens, outputTokens }')
      else if (!isCount(reply.usage.inputTokens) || !isCount(reply.usage.outputTokens)) problems.push('`usage` counts are numbers or null')
    }
    if (reply.costUsd !== null && !(typeof reply.costUsd === 'number' && Number.isFinite(reply.costUsd) && reply.costUsd >= 0)) {
      problems.push('`costUsd` is a number or null')
    }
  } else if (reply.ok === false) {
    if (own(reply, 'answer')) problems.push('an unanswered reply carries no `answer`')
    const f = reply.failure
    if (!isPlainObject(f)) {
      problems.push('an unanswered reply carries a `failure`')
    } else {
      if (!own(REASONS, f.reason)) problems.push(`\`${f.reason}\` is not one of the reasons: ${Object.keys(REASONS).join(', ')}`)
      else if (f.retryable !== REASONS[f.reason].retryable) problems.push(`\`${f.reason}\` is ${REASONS[f.reason].retryable ? '' : 'not '}retryable`)
      if (typeof f.message !== 'string' || !f.message) problems.push('a failure has a message')
      if (own(f, 'detail') && (typeof f.detail !== 'string' || f.detail.length > DETAIL_LIMIT)) problems.push(`a failure's detail is text of at most ${DETAIL_LIMIT} characters`)
    }
  }
  return problems
}
