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
    analysis: 'analyzes', basis: 'bases', crisis: 'crises',
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
  assert.equal(pluralize('analysis'), 'analyzes')
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

test('inflect: -ses splits by a list, because no ending can split it', function () {
  /*
   * `statuses` is `status` and `cases` is `case`, and the two differ only by
   * whether the stem before `es` is itself a word — `status` and `cas` both
   * end in a vowel plus `s`. Stripping `es` for both was the wrong way round:
   * a singular ending in a bare `s` is a closed list, a singular ending in
   * `-se` is thousands of ordinary nouns, and every one of them resolved to a
   * word that is not one.
   *
   * The stakes are what make this a correctness case rather than a spelling
   * one. Junction derives a model name from a service name with this function,
   * and a service resolving to no model has NO @@gate and NO validation — so a
   * service named `purchases` over `model Purchase` served anonymous reads of
   * a gated model, silently, for as long as the rule stood.
   */
  ;[['cases', 'case'], ['purchases', 'purchase'], ['releases', 'release'],
    ['licenses', 'license'], ['expenses', 'expense'], ['responses', 'response'],
    ['databases', 'database'], ['warehouses', 'warehouse'], ['leases', 'lease'],
    ['houses', 'house'], ['phases', 'phase'], ['courses', 'course'],
  ].forEach(function (pair) {
    assert.equal(singularize(pair[0]), pair[1])
    assert.equal(pluralize(pair[1]), pair[0], pair[1] + ' did not survive the round trip')
  })

  ;[['statuses', 'status'], ['buses', 'bus'], ['gases', 'gas'], ['lenses', 'lens'],
    ['biases', 'bias'], ['atlases', 'atlas'], ['viruses', 'virus'],
    ['classes', 'class'], ['addresses', 'address'], ['processes', 'process'],
  ].forEach(function (pair) {
    assert.equal(singularize(pair[0]), pair[1])
    assert.equal(pluralize(pair[1]), pair[0], pair[1] + ' did not survive the round trip')
  })

  // The irregular table is consulted first and still wins.
  assert.equal(singularize('bases'), 'basis')
  assert.equal(singularize('crises'), 'crisis')
  assert.equal(singularize('analyzes'), 'analysis')
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

test('inflect: a compound survives the round trip its own rules produce', function () {
  /*
   * The asymmetry: `pluralize` must not reach inside a compound (the test below
   * says why — it renames tables that already exist), so the table a model gets
   * comes from the REGULAR rules. Reading it back therefore has to use those
   * same rules on the head, or the trip does not close. It did not: `UserStatus`
   * is `user_statuses` and came back `user_statuse`, `UserAlias` came back
   * `user_aliase`. Junction derives a model name from a service name with this,
   * and a service resolving to no model has no @@gate and no validation, so the
   * miss fails OPEN.
   */
  ;['UserAlias', 'UserStatus', 'AuditIndex', 'SalesPerson', 'Category', 'Status', 'Address']
    .forEach(function (m) {
      assert.equal(singularize(pluralize(m)), m, m + ' did not survive the round trip')
    })

  // The same rules read a foreign snake_case name, which is what a schema
  // converted from Rails or from raw DDL arrives as.
  assert.equal(singularize('user_aliases'), 'user_alias')
  assert.equal(singularize('account_statuses'), 'account_status')
  assert.equal(singularize('media_attachments'), 'media_attachment')

  // The irregular table stays whole-word in BOTH directions.
  assert.equal(singularize('people'), 'person')
  assert.equal(singularize('sales_people'), 'sales_people')
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
