/*
 * inflect.spec.js
 *
 * The property that matters is agreement: five copies of these rules used to
 * resolve one invariant and each answered differently. So the cases below are
 * not a wishlist — every one of them is a spelling some caller in the repo
 * feeds in, and the failures named are the ones a copy actually had.
 */

import { pluralize, singularize } from '../../src/inflect/inflect.js'

/* ── Regular rules ─────────────────────────────────────────────────── */

test('inflect: the regular rules, both directions', function () {
  const pairs = [
    ['post', 'posts'],
    ['customer', 'customers'],
    ['category', 'categories'],   // consonant + y
    ['company', 'companies'],
    ['box', 'boxes'],
    ['church', 'churches'],
    ['dish', 'dishes'],
    ['quiz', 'quizzes'.replace('zz', 'z')], // quizes — one z, English disagrees, the rule does not
  ]
  pairs.forEach(function ([one, many]) {
    assert.equal(pluralize(one), many, 'pluralize(' + one + ')')
    assert.equal(singularize(many), one, 'singularize(' + many + ')')
  })
})

test('inflect: a vowel before y just takes an s', function () {
  assert.equal(pluralize('day'), 'days')
  assert.equal(pluralize('key'), 'keys')
})

/* ── The irregular table ───────────────────────────────────────────── */

test('inflect: every irregular round-trips', function () {
  const table = {
    person: 'people', child: 'children', man: 'men', woman: 'women',
    tooth: 'teeth', foot: 'feet', mouse: 'mice', goose: 'geese',
    ox: 'oxen', leaf: 'leaves', life: 'lives', knife: 'knives',
    index: 'indices', matrix: 'matrices', vertex: 'vertices',
    analysis: 'analyses', basis: 'bases', crisis: 'crises',
    datum: 'data', medium: 'media', criterion: 'criteria',
  }
  Object.entries(table).forEach(function ([one, many]) {
    assert.equal(pluralize(one), many, 'pluralize(' + one + ')')
    assert.equal(singularize(many), one, 'singularize(' + many + ')')
  })
})

test('inflect: an irregular that a regular rule also matches still wins', function () {
  /*
   * litestone's pluralizer consulted the table LAST, so seven of its own
   * entries were unreachable: `index` was taken by the `x$` rule and came back
   * `indexes`, `analysis` and `crisis` by `s$`. The table is consulted first
   * here, which is the only reason those entries mean anything.
   */
  assert.equal(pluralize('index'), 'indices')
  assert.equal(pluralize('matrix'), 'matrices')
  assert.equal(pluralize('vertex'), 'vertices')
  assert.equal(pluralize('analysis'), 'analyses')
  assert.equal(pluralize('basis'), 'bases')
  assert.equal(pluralize('crisis'), 'crises')
  assert.equal(pluralize('ox'), 'oxen')
})

/* ── The guards ────────────────────────────────────────────────────── */

test('inflect: a singular that ends in s is left alone', function () {
  /*
   * `model Status` is the case FJS-192 was filed for. sierra singularised it
   * to `statuse`, `modelNameFor` missed, and the resource degraded to a bare
   * make() with a warning — the failure is silent, which is why the guards are
   * a test rather than a comment.
   */
  ;['status', 'bus', 'alias', 'atlas', 'axis', 'iris', 'address'].forEach(function (w) {
    assert.equal(singularize(w), w, 'singularize(' + w + ') moved')
  })
})

test('inflect: a singular ending in a bare s is NOT reachable', function () {
  /*
   * `lens` singularises to `len`, and no rule can prevent it: `pens` and
   * `plans` are real plurals with the same ending, so telling them apart needs
   * a dictionary rather than a rule. The guards cover the endings that are
   * reliably singular (`ss`, `us`, `is`, `as`) and stop there. A schema whose
   * model lands on this says so by hand — `@@map` in the Data realm,
   * `createResource('lenses', { model: 'Lens' })` in the UI.
   *
   * Asserted as-is: a fix that ever teaches this word turns the case red
   * rather than leaving a stale expectation nobody reruns.
   */
  assert.equal(singularize('lens'), 'len')
})

test('inflect: the plural of a word ending in s comes back to it', function () {
  ;['status', 'bus', 'address'].forEach(function (w) {
    assert.equal(singularize(pluralize(w)), w, w + ' did not survive the round trip')
  })
})

/* ── Case ──────────────────────────────────────────────────────────── */

test('inflect: the first character keeps its case', function () {
  assert.equal(pluralize('Person'), 'People')
  assert.equal(singularize('People'), 'Person')
  assert.equal(pluralize('Category'), 'Categories')
  assert.equal(singularize('Statuses'), 'Status')
})

test('inflect: a snake_case table name inflects on the whole word', function () {
  /*
   * What litestone feeds it. The irregular table is whole-word only, so a
   * compound takes the regular rule — `audit_index` is `audit_indexes`, not
   * `audit_indices`. Stated because it is a choice: making the table reach
   * inside a compound would rename tables in schemas that already exist.
   */
  assert.equal(pluralize('service_agreement'), 'service_agreements')
  assert.equal(pluralize('audit_index'), 'audit_indexes')
  assert.equal(singularize('service_agreements'), 'service_agreement')
})

/* ── Non-strings ───────────────────────────────────────────────────── */

test('inflect: a non-string comes back unchanged rather than throwing', function () {
  assert.equal(pluralize(''), '')
  assert.equal(singularize(''), '')
  assert.equal(pluralize(null), null)
  assert.equal(singularize(undefined), undefined)
})
