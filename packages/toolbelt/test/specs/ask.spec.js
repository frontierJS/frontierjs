/*
 * ask.spec.js
 *
 * The contract exists so two doors cannot name one failure two ways, so what
 * is asserted is the set staying closed and `retryable` staying the table's.
 * Every refusal sits beside the acceptance one field away, because a check
 * that refuses the legitimate reply too proves nothing about the mistake.
 */

import { REASONS, DETAIL_LIMIT, unanswered, checkReply } from '../../src/ask/ask.js'

const answered = (answer, extra = {}) => ({ ok: true, answer, door: 'stub', model: 'm', usage: null, costUsd: null, ms: 3, ...extra })
const failed = (failure, extra = {}) => ({ ok: false, failure, door: 'stub', model: 'm', ms: 3, ...extra })

// ─── the reasons ──────────────────────────────────────────────────────────────

test('ask: the reasons are the closed set the two doors share', function () {
  assert.deepEqual(Object.keys(REASONS), [
    'not_set_up', 'signed_out', 'forbidden', 'model_gone', 'too_long', 'refused',
    'rate_limited', 'timeout', 'lost', 'model_error', 'no_answer', 'cut_off', 'aborted',
  ])
  assert.ok(Object.isFrozen(REASONS) && Object.isFrozen(REASONS.lost), 'a caller cannot add a reason or flip one')
})

test('ask: the reasons that may have been billed say so', function () {
  // `retryable` is not "free": a lost answer and a timeout may have run.
  assert.match(REASONS.lost.means, /billed/)
  assert.match(REASONS.timeout.means, /billed/)
  assert.equal(REASONS.lost.retryable, true)
  assert.equal(REASONS.aborted.retryable, false, 'the caller stopped it; asking again is a new decision')
})

// ─── unanswered ───────────────────────────────────────────────────────────────

test('ask: unanswered takes retryable from the table and the door\'s words when given', function () {
  assert.deepEqual(unanswered('rate_limited'), { reason: 'rate_limited', message: REASONS.rate_limited.means, retryable: true })
  assert.deepEqual(unanswered('signed_out', 'Run claude once and sign in.'), { reason: 'signed_out', message: 'Run claude once and sign in.', retryable: false })
})

test('ask: unanswered keeps at most DETAIL_LIMIT characters of detail, and none when empty', function () {
  assert.equal(unanswered('lost', null, 'x'.repeat(DETAIL_LIMIT + 50)).detail.length, DETAIL_LIMIT)
  assert.ok(!('detail' in unanswered('lost', null, '')))
  assert.equal(unanswered('lost', null, new Error('boom')).detail, 'Error: boom')
})

test('ask: a reason outside the set throws, naming the set', function () {
  // `exited` is the name the mechanic generator's copy gave `lost`.
  assert.throws(() => unanswered('exited'), /not a reason.*lost/)
  assert.throws(() => unanswered('toString'), /not a reason/, 'an inherited key is not a reason')
})

// ─── checkReply ───────────────────────────────────────────────────────────────

test('ask: an answer fits its question — an object for a schema, text without', function () {
  const schema = { type: 'object' }
  assert.deepEqual(checkReply(answered({ a: 1 }), { prompt: 'p', schema }), [])
  assert.deepEqual(checkReply(answered('hi'), { prompt: 'p' }), [])
  assert.deepEqual(checkReply(answered('{"a":1}'), { prompt: 'p', schema }), ['a question with a schema is answered with an object'])
  assert.deepEqual(checkReply(answered([1]), { prompt: 'p', schema }), ['a question with a schema is answered with an object'])
  assert.deepEqual(checkReply(answered({ a: 1 }), { prompt: 'p' }), ['a question without a schema is answered with text'])
  assert.deepEqual(checkReply(answered({ a: 1 })), [], 'without the question, text or an object will do')
  assert.deepEqual(checkReply(answered(7)), ['`answer` is text or an object'])
})

test('ask: usage and cost are counts or null', function () {
  assert.deepEqual(checkReply(answered('t', { usage: { inputTokens: 10, outputTokens: null }, costUsd: 0.01 })), [])
  assert.deepEqual(checkReply(answered('t', { usage: { inputTokens: -1, outputTokens: 2 } })), ['`usage` counts are numbers or null'])
  assert.deepEqual(checkReply(answered('t', { usage: { input_tokens: 1, output_tokens: 2 } })), ['`usage` counts are numbers or null'], 'the vendor spelling is a door that forgot to translate')
  assert.deepEqual(checkReply(answered('t', { costUsd: '0.01' })), ['`costUsd` is a number or null'])
})

test('ask: an unanswered reply names a reason from the set with the table\'s retryable', function () {
  assert.deepEqual(checkReply(failed(unanswered('no_answer'))), [])
  assert.deepEqual(checkReply(failed({ reason: 'exited', message: 'm', retryable: true })), ['`exited` is not one of the reasons: ' + Object.keys(REASONS).join(', ')])
  assert.deepEqual(checkReply(failed({ reason: 'cut_off', message: 'm', retryable: true })), ['`cut_off` is not retryable'])
  assert.deepEqual(checkReply(failed({ reason: 'lost', message: 'm', retryable: false })), ['`lost` is retryable'])
  assert.deepEqual(checkReply(failed({ reason: 'lost', message: '', retryable: true })), ['a failure has a message'])
  assert.deepEqual(checkReply(failed(unanswered('lost'), { answer: 'x' })), ['an unanswered reply carries no `answer`'])
})

test('ask: every reply names its door, model and duration', function () {
  assert.deepEqual(checkReply(null), ['a reply is an object'])
  assert.deepEqual(checkReply(answered('t', { ok: 'yes', door: '', model: 3, ms: -1 })), [
    '`ok` is true or false', '`door` names the door that answered', '`model` names the model that answered', '`ms` is a duration in milliseconds',
  ])
})

test('ask: a stub door keeps the contract for every reason', async function () {
  // The shape 4.2's and 4.3's own tests take: each reply a door can give, through checkReply.
  const door = async (question) => question.prompt === 'ok'
    ? answered('fine')
    : failed(unanswered(question.prompt))
  assert.deepEqual(checkReply(await door({ prompt: 'ok' }), { prompt: 'ok' }), [])
  for (const reason of Object.keys(REASONS)) {
    assert.deepEqual(checkReply(await door({ prompt: reason })), [], reason)
  }
})
