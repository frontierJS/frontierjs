/*
 * history.spec.js
 *
 * The property under test is injectivity: two different occurrences must never
 * produce one key. Everything else this module does is in service of that, and
 * every refusal below is a shape that would otherwise become a jobs-table
 * primary key and silently swallow a unit of work.
 */

import { occurrenceKey } from '../../src/history/history.js'

test('history: the four callers in this repo', function () {
  // The first two are byte-for-byte what those sites built by hand, so adopting
  // this changes nothing for a queue that already has rows in it.
  assert.equal(occurrenceKey('idem', 'orders', 'create', 'user-7', 'abc'), 'idem:orders:create:user-7:abc')
  assert.equal(occurrenceKey('cron', 'daily-report', 29174400), 'cron:daily-report:29174400')

  // The outbox is the one that MOVES: it dispatched under the bare row id, so
  // it shared a namespace with every id a caller states. Gaining a namespace is
  // the fix and it is also a format change — undelivered rows written under the
  // old key redispatch under the new one, which is once-only running twice. It
  // costs nothing while no queue has rows in it and cannot be done free later.
  assert.equal(occurrenceKey('outbox', 42), 'outbox:42')
})

test('history: the namespace keeps two mechanisms apart', function () {
  // An outbox row with id 7 and a caller stating 7 are two units of work in one
  // jobs table. Without the kind they are one row and one of them never runs.
  const [row, stated] = [occurrenceKey('outbox', 7), occurrenceKey('manual', 7)]
  assert.ok(row !== stated, `both occurrences collapsed onto ${row}`)
})

test('history: a colon in a part cannot forge a boundary', function () {
  // A job name is caller-supplied and the old cron key interpolated it raw, so
  // a job called `report:daily` fired at minute 5 and a job called `report`
  // fired at minute... `daily:5` produced the same string.
  const [named, split] = [occurrenceKey('cron', 'report:daily', 5), occurrenceKey('cron', 'report', 'daily:5')]
  assert.ok(named !== split, `both occurrences collapsed onto ${named}`)
})

test('history: escaping is injective, so a part that looks escaped stays distinct', function () {
  // The reason `%` is escaped before `:`. Escape only the separator and these
  // two collapse onto one key.
  const [raw, looksEscaped] = [occurrenceKey('idem', 'a:b'), occurrenceKey('idem', 'a%3Ab')]
  assert.ok(raw !== looksEscaped, `both occurrences collapsed onto ${raw}`)
  assert.equal(occurrenceKey('idem', 'a:b'),   'idem:a%3Ab')
  assert.equal(occurrenceKey('idem', 'a%3Ab'), 'idem:a%253Ab')
})

test('history: a missing part is refused, not stringified', function () {
  // `cron:daily:undefined` is one key shared by every fire of that job, made
  // permanent by the primary key it becomes.
  assert.throws(() => occurrenceKey('cron', 'daily', undefined), /part 1 is undefined/)
  assert.throws(() => occurrenceKey('cron', 'daily', null),      /part 1 is null/)
  assert.throws(() => occurrenceKey('idem'),                     /at least one part/)
})

test('history: only values with one spelling are parts', function () {
  assert.throws(() => occurrenceKey('idem', {}),       /is a object/)
  assert.throws(() => occurrenceKey('idem', NaN),      /names no occurrence/)
  assert.throws(() => occurrenceKey('idem', Infinity), /names no occurrence/)
  assert.equal(occurrenceKey('idem', 0), 'idem:0')     // 0 and '' are real ids
  assert.equal(occurrenceKey('idem', ''), 'idem:')
})

test('history: the kind is a namespace and cannot contain the separator', function () {
  assert.throws(() => occurrenceKey('a:b', 1), /must not contain/)
  assert.throws(() => occurrenceKey('', 1),    /non-empty string/)
  assert.throws(() => occurrenceKey(null, 1),  /non-empty string/)
})
