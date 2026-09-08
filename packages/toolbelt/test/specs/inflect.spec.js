/*
 * inflect.spec.js
 *
 * The property that matters is agreement: five copies of these rules used to
 * resolve one invariant and each answered differently. So the cases below are
 * not a wishlist — every one of them is a spelling some caller in the repo
 * feeds in, and the failures named are the ones a copy actually had.
 */

import { pluralize, singularize, IRREGULAR, words, pascal, camel, kebab, snake, modelName, slug, humanize } from '../../src/inflect/inflect.js'

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
    ['waltz', 'waltzes'],         // a real -z stem; `quiz` doubles and is in the table
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
  /*
   * The table is READ from the module rather than restated. A copy here grades
   * nothing — one find/replace rewrote the entry and this assertion together,
   * so both sides agreed on `analyzes` and the suite stayed green. Reading it
   * also means an entry added later is round-tripped without touching a test.
   */
  Object.entries(IRREGULAR).forEach(function ([one, many]) {
    assert.equal(pluralize(one), many, 'pluralize(' + one + ')')
    assert.equal(singularize(many), one, 'singularize(' + many + ')')
  })
})

test('inflect: the table says what English says', function () {
  /*
   * The other half, and the one the round trip cannot make: a table full of
   * invented plurals round-trips perfectly. These are hand-written because they
   * ARE the oracle — the assertion is that the module agrees with English, so
   * anything derived from the module would be the module agreeing with itself.
   */
  ;[['analysis', 'analyses'], ['basis', 'bases'], ['crisis', 'crises'],
    ['half', 'halves'], ['shelf', 'shelves'], ['wife', 'wives'],
    ['thief', 'thieves'], ['self', 'selves'], ['quiz', 'quizzes'],
    ['person', 'people'], ['child', 'children'], ['criterion', 'criteria'],
  ].forEach(function (pair) {
    assert.equal(pluralize(pair[0]), pair[1], 'pluralize(' + pair[0] + ')')
  })

  // The control: an `-f` that does NOT take `-ves`, so the list stayed a list.
  // A rule over the ending would answer `rooves` and `chieves` and pass every
  // assertion above.
  ;['roof', 'chief', 'belief', 'proof', 'chef'].forEach(function (w) {
    assert.equal(pluralize(w), w + 's', 'pluralize(' + w + ') took -ves')
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
   * `model Status` is the case FJS-192 was filed for. sierra singularized it
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
   * `lens` singularizes to `len`, and no rule can prevent it: `pens` and
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
  assert.equal(singularize('analyses'), 'analysis')
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

/* ── The -ie stems ─────────────────────────────────────────────────── */

test('inflect: a singular ending -ie survives the -y rule', function () {
  // `movies` and `bodies` are identical in shape, so this is a list and not a
  // rule (`FJS-959`). Every case is PAIRED with the `-y` word one letter apart,
  // because a fix that sent both to `-ie` would look exactly like a fix that
  // sent neither: the failing behavior and its correction differ only on which
  // side of the list a word falls.
  const pairs = [
    ['movies',   'movie'],   ['bodies',     'body'],
    ['cookies',  'cookie'],  ['categories', 'category'],
    ['pies',     'pie'],     ['policies',   'policy'],
    ['ties',     'tie'],     ['cities',     'city'],
    ['calories', 'calorie'], ['companies',  'company'],
    ['zombies',  'zombie'],  ['proxies',    'proxy'],
  ]
  for (const [plural, singular] of pairs)
    assert.equal(singularize(plural), singular, plural)
})

test('inflect: the -ie stems round-trip, which the broken pair also did', function () {
  // The reason nothing caught this for so long: `pluralize('movy') === 'movies'`,
  // so the wrong answer was self-consistent and every symmetry check passed
  // while both halves named a word that does not exist. Round-tripping is
  // necessary and is not sufficient — the table above is what makes it true of
  // real words.
  for (const w of ['movie', 'cookie', 'pie', 'tie', 'calorie', 'body', 'category', 'city'])
    assert.equal(singularize(pluralize(w)), w, w)
})

test('inflect: case and compounds, since a model name is neither lowercase nor one word', function () {
  assert.equal(singularize('Movies'), 'Movie')
  assert.equal(singularize('Cookies'), 'Cookie')
  // `headOf` splits the compound and the list is asked about the HEAD, so a
  // prefix cannot smuggle a word past it in either direction.
  assert.equal(singularize('OrderCookies'), 'OrderCookie')
  assert.equal(singularize('AuditPolicies'), 'AuditPolicy')
  // And not inside a snake_case word, for IRREGULAR's reason: reaching in would
  // rename a table.
  assert.equal(singularize('http_cookies'), 'http_cookie')
})

test('inflect: what this protects — a service resolves to its model or fails OPEN', function () {
  // Junction derives a model name from a service name with `singularize`, and a
  // service that resolves to no model has no @@gate and no validation. This is
  // the assertion that names the cost rather than the spelling: `model Cookie`
  // with a `cookies` service resolved to `Cooky`, which is nothing.
  assert.equal(singularize('cookies'), 'cookie')
  assert.ok(singularize('cookies') !== 'cooky', 'cookies must not singularize to cooky')
})

/* ── Shape ─────────────────────────────────────────────────────────── */

test('inflect: the three spellings of one name split into the same words', function () {
  // Six hand copies split four different ways, so this is the row that makes
  // the rest of the shape functions agree by construction rather than by
  // coincidence.
  // A word keeps its OWN capitals: `words('product_variants')` is
  // `['product','variants']` and `words('productVariants')` is
  // `['product','Variants']`. What has to agree is where the SPLIT falls, and
  // the shapes built on it.
  const same = ['product_variants', 'product-variants', 'productVariants', 'Product Variants']
  same.forEach(function (spelling) {
    assert.equal(words(spelling).map(w => w.toLowerCase()).join('|'), 'product|variants', 'words(' + spelling + ')')
    assert.equal(pascal(spelling), 'ProductVariants', 'pascal(' + spelling + ')')
    assert.equal(snake(spelling),  'product_variants', 'snake(' + spelling + ')')
  })
})

test('inflect: a run of capitals is one word, and a digit does not start one', function () {
  // Splitting on every capital gives `o r d e r I D`. This is the same rule
  // `/humanize` has and the reason both kits need their own tests for it.
  assert.equal(words('orderID').join('|'), 'order|ID')
  assert.equal(words('HTTPStatus').join('|'), 'HTTP|Status')
  // …and the deliberate DIFFERENCE from humanize, which reads `line1` as
  // `Line 1`. Splitting the digit here renames a column.
  assert.equal(words('address1').join('|'), 'address1')
  assert.equal(kebab('address1'), 'address1')
})

test('inflect: a separator that is not one stays inside the word', function () {
  // A dump qualifies every table with its schema. If `.` split, `partman.template_x`
  // would come back as a plausible `PartmanTemplateX` and be used as a model
  // name; left in, it is visibly not an identifier and the caller's own guard
  // still sees it.
  assert.equal(pascal('partman.template_x'), 'Partman.templateX')
  assert.ok(!/^[A-Za-z][A-Za-z0-9]*$/.test(pascal('partman.template_x')))
})

test('inflect: the four shapes', function () {
  const cases = [
    ['product_variants', 'ProductVariants', 'productVariants', 'product-variants', 'product_variants'],
    ['ProductVariant',   'ProductVariant',  'productVariant',  'product-variant',  'product_variant'],
    ['order-item',       'OrderItem',       'orderItem',       'order-item',       'order_item'],
  ]
  cases.forEach(function ([raw, wantP, wantC, wantK, wantS]) {
    assert.equal(pascal(raw), wantP, 'pascal(' + raw + ')')
    assert.equal(camel(raw),  wantC, 'camel(' + raw + ')')
    assert.equal(kebab(raw),  wantK, 'kebab(' + raw + ')')
    assert.equal(snake(raw),  wantS, 'snake(' + raw + ')')
  })
})

test('inflect: a word keeps its own tail, where lodash lowercases it', function () {
  // `upperFirst(camelCase('SKU'))` is `Sku`. A column named SKU is not Sku.
  assert.equal(pascal('SKU'), 'SKU')
  assert.equal(pascal('orderID'), 'OrderID')
})

test('inflect: camel lowers a leading initialism WHOLE', function () {
  // The copies lowered the first character only, which gives `hTTPStatus`.
  assert.equal(camel('HTTPStatus'), 'httpStatus')
  assert.equal(camel('SKU'), 'sku')
  assert.ok(camel('HTTPStatus') !== 'hTTPStatus')
  // A leading word that is not an initialism keeps its tail, so the trailing
  // one still does too.
  assert.equal(camel('orderID'), 'orderID')
})

test('inflect: modelName is Invariant 2, and the six copies did not agree about it', function () {
  // `product-variants` was `ProductVariant` to the cli rule that GRADES model
  // names and `Product-variant` to two of the readers that PRODUCE them.
  const spellings = ['product_variants', 'product-variants', 'productVariants']
  spellings.forEach(function (s) {
    assert.equal(modelName(s), 'ProductVariant', 'modelName(' + s + ')')
  })
  // The composition is the point: singular first, because `singularize` reads
  // the compound's head and the head is what loses its `s`.
  assert.equal(modelName('cookies'), 'Cookie')
  assert.equal(modelName('statuses'), 'Status')
  assert.equal(modelName('people'), 'Person')
})

test('inflect: slug is one rule — every run of non-alphanumerics is one separator', function () {
  assert.equal(slug('Hello, World!'), 'hello-world')
  assert.equal(slug('  spaced   out  '), 'spaced-out')
  assert.equal(slug('already-a-slug'), 'already-a-slug')
  assert.equal(slug('under_score'), 'under-score')
  // The divergence the copies had: the `@slug` transform stripped the dot and
  // answered `v12`, everything else converted it.
  assert.equal(slug('v1.2'), 'v1-2')
})

test('inflect: an apostrophe is the one mark that is deleted, not separated', function () {
  // It sits INSIDE a word where every other mark sits between two. Separating
  // it gives `it-s`, which is a word that is not there — and this is the case
  // litestone's own `@slug` test already pinned, so the rule follows the code.
  assert.equal(slug("It's a C++ thing"), 'its-a-c-thing')
  assert.equal(slug('Don\u2019t Panic'), 'dont-panic')
  assert.ok(slug("It's").indexOf('-') === -1)
})

test('inflect: slug folds an accent rather than dropping the letter', function () {
  // Dropping it is silent and this runs over names a person typed: `Café` came
  // back `caf` from all five copies.
  assert.equal(slug('Café Zoë'), 'cafe-zoe')
  assert.ok(slug('Café') !== 'caf')
})

test('inflect: slug takes its separator, because a filename segment wants _', function () {
  // Litestone names a migration file with this and uses `_`; the count of
  // separators is a fact about the caller, not about slugs.
  assert.equal(slug('add product variants', { sep: '_' }), 'add_product_variants')
  assert.equal(slug('add-product-variants', { sep: '_' }), 'add_product_variants')
})

test('inflect: slug re-trims after truncating, or the cut leaves a separator', function () {
  // `.slice(0, 64)` at a call site is the version that stores `strategy-and-`.
  assert.equal(slug('strategy and execution', { max: 13 }), 'strategy-and')
  assert.ok(!slug('strategy and execution', { max: 13 }).endsWith('-'))
  // Under the cap it is untouched.
  assert.equal(slug('short one', { max: 64 }), 'short-one')
})

test('inflect: shape answers empty for what is not a name, never [object Object]', function () {
  // These land in generated source. `undefined` in a model name compiles to a
  // file nobody can parse, and the failure names a line rather than the input.
  assert.deepEqual(words(null), [])
  assert.equal(pascal(undefined), '')
  assert.equal(camel(null), '')
  assert.equal(kebab({}), '')
  assert.equal(slug(null), '')
})

/* ── Reader ────────────────────────────────────────────────────────── */

test('inflect: humanize is a machine name as a person reads it', function () {
  // The spellings the two callers actually meet: a schema field name (a
  // control labeling a field that declared no `@label`) and a stored code (a
  // picker showing a value whose row it could not read, `FJS-D225`).
  const cases = [
    ['firstName',   'First Name'],
    ['postal_code', 'Postal Code'],
    ['postal-code', 'Postal Code'],
    ['sku',         'Sku'],
    ['dark_blue',   'Dark Blue'],
    ['title',       'Title'],
  ]
  cases.forEach(function ([raw, want]) {
    assert.equal(humanize(raw), want, 'humanize(' + raw + ')')
  })
})

test('inflect: humanize keeps an initialism whole', function () {
  // `S K U` reads as three letters somebody typed; the whole point of the run
  // is that it was already a word. This is `words()`, unchanged — the row
  // exists because title-casing is where the tail gets broken.
  assert.equal(humanize('SKU'), 'SKU')
  assert.equal(humanize('orderID'), 'Order ID')
  assert.equal(humanize('HTTPStatus'), 'HTTP Status')
})

test('inflect: a digit starts a word for the READER and not for the name', function () {
  // The one rule that separates the two halves of this kit, asserted as a PAIR
  // in one row. Deriving humanize from `words()` without the added split reds
  // the first two; lifting the split into `words()` reds the last three by
  // renaming a column.
  assert.equal(humanize('line1'), 'Line 1')
  assert.equal(humanize('address_line_2'), 'Address Line 2')

  assert.equal(kebab('address1'), 'address1')
  assert.equal(snake('line1'), 'line1')
  assert.equal(modelName('address1s'), 'Address1')
})

test('inflect: humanize answers empty for what is not a string, never [object Object]', function () {
  // This lands in a LABEL. A wrong word is bad and `[object Object]` on screen
  // is worse than nothing there.
  ;[null, undefined, 42, {}, [], true].forEach(function (v) {
    assert.equal(humanize(v), '')
  })
  assert.equal(humanize(''), '')
  assert.equal(humanize('   '), '')
})
