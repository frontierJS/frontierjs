/*
 * search.spec.js — the guide's search, held to the two things that make one
 * useful: everything is findable, and the first row is the right one.
 *
 * What is under test is guide/search.js — the tokeniser, the ranker and the
 * term entries built from VOCAB. The other half of the corpus is harvested
 * from the rendered pages by guide.js and cannot be reached from here; that
 * half is self-correcting, because it is read out of the same markup the
 * reader sees. This half is not: it is a rule about vocabulary.js applied at
 * a distance, and it fails silently. A term that stops being findable looks
 * exactly like a term nobody searches for.
 *
 * The corpus every ranking test runs against is the real 54 terms plus one
 * deliberate decoy — a body-text entry that mentions every term by name.
 * That is the guide's actual shape: the prose says "card" on nine pages, and
 * a ranker that lets weight of mentions beat a title is one where the answer
 * to "card" is whichever page happens to talk about cards the most.
 */

/* ── The corpus under test ─────────────────────────────────────────── */

function searchCorpus() {
  var entries = searchVocabEntries(VOCAB);

  /*
   * The decoy. Its title matches nothing and its body matches everything —
   * which is what a long guide page is.
   */
  var everyTerm = entries
    .map(function (e) { return e.title + ' ' + (e.keys[0] || ''); })
    .join(' ');

  entries.push({
    kind: 'section',
    title: 'Common patterns',
    sub: 'Cheat sheet',
    page: 'cheatsheet',
    section: 'common-patterns',
    /* Three times over, so frequency alone would win if it could. */
    text: everyTerm + ' ' + everyTerm + ' ' + everyTerm
  });

  return entries;
}

function searchTop(entries, q) {
  var hits = searchRank(entries, q, 5);
  return hits.length ? hits[0].entry : null;
}

/* ── Tokens ────────────────────────────────────────────────────────── */

test('search: a class name is one token, not two words', function () {
  /*
   * The single most likely query in a CSS guide is a class name, and `-` is
   * in most of them. Split on the hyphen, `surface-header` matches every
   * section that mentions a surface AND every section that mentions a
   * header — which is most of the guide, ranked by coincidence.
   */
  assert.equal(searchTokens('surface-header').join('|'), 'surface-header');
  assert.equal(searchTokens('text-2xs').join('|'), 'text-2xs');

  /* A leading dot is how a CSS author says "the class". */
  assert.equal(searchTokens('.card').join('|'), 'card');
  assert.equal(searchTokens('#app').join('|'), 'app');

  assert.equal(searchTokens('Section Header').join('|'), 'section|header');
  assert.equal(searchTokens('').length, 0);
  assert.equal(searchTokens(null).length, 0);
  /* Punctuation alone is not a query. It must answer nothing rather than
     throw — the box is typed into one character at a time. */
  assert.equal(searchTokens('  ·  ').length, 0);
  assert.equal(searchRank(searchCorpus(), '···', 5).length, 0);
});

/* ── Findability ───────────────────────────────────────────────────── */

test('search: every vocabulary term is the first hit for its own name', function () {
  /*
   * The forward direction. It is not free: the terms compete with each
   * other, and with a body-text entry that names all 54.
   */
  var corpus = searchCorpus();
  var missed = [];

  searchVocabEntries(VOCAB).forEach(function (e) {
    var top = searchTop(corpus, e.title);
    if (!top) missed.push(e.title + ' → nothing');
    else if (top.title !== e.title) missed.push(e.title + ' → ' + top.title);
  });

  assert.equal(
    missed.length,
    0,
    'a term is not the answer to its own name:\n        ' + missed.join('\n        ')
  );
});

test('search: every term with a class is the first hit for that class', function () {
  /*
   * The direction that matters more. Somebody reading an app's markup has
   * `list-row` in front of them, not the word "Row" — and the class name is
   * nowhere in the term for eleven of the 54.
   *
   * This is also what holds vocabulary.js's own convention: the class is
   * absent from a row when it is the lowercased term, so a change to that
   * rule silently strands every class-name query. `vocabClass` is the one
   * reading of it and this is what checks the reading still works.
   */
  var corpus = searchCorpus();
  var missed = [];

  VOCAB.forEach(function (tier) {
    tier[2].forEach(function (row) {
      var cls = vocabClass(row);
      if (!cls) return;
      var top = searchTop(corpus, cls);
      if (!top) missed.push('.' + cls + ' → nothing');
      else if (top.title !== row[0]) missed.push('.' + cls + ' → ' + top.title + ', wanted ' + row[0]);
    });
  });

  assert.equal(
    missed.length,
    0,
    'a class name does not find its own term:\n        ' + missed.join('\n        ')
  );
});

test('search: every term links to a section id that its tier can produce', function () {
  /*
   * A term's href is `#vocabulary:<tier>`, built by slugifying the tier
   * name — the same function that stamps the id onto the rendered section.
   * Two tiers that slug the same would send half the terms to the other
   * one's table, and an empty slug would send them to the top of the page.
   * Both look like the link working.
   */
  var seen = {};
  var clashes = [];

  VOCAB.forEach(function (tier) {
    var id = slugify(tier[0]);
    if (!id) clashes.push(tier[0] + ' slugs to nothing');
    else if (seen[id]) clashes.push(tier[0] + ' and ' + seen[id] + ' both slug to "' + id + '"');
    else seen[id] = tier[0];
  });

  assert.equal(clashes.length, 0, clashes.join('\n        '));

  var wrong = searchVocabEntries(VOCAB).filter(function (e) {
    return e.page !== 'vocabulary' || !seen[e.section];
  });
  assert.equal(wrong.length, 0, wrong.length + ' term entries point at no tier section');
});

/* ── Ranking ───────────────────────────────────────────────────────── */

test('search: a second word narrows, it does not widen', function () {
  /*
   * Every token has to land somewhere on an entry or the entry is out. OR
   * semantics is the behavior that teaches people to type one word and
   * scroll: "card footer" would return everything about cards plus
   * everything about footers, with the thing they asked for somewhere in
   * the middle.
   */
  var corpus = searchCorpus();
  var one = searchRank(corpus, 'card', 0).length;
  var two = searchRank(corpus, 'card zzzznotaword', 0).length;

  assert.ok(one > 0, 'the one-word query found nothing');
  assert.equal(two, 0, 'a word that matches nothing did not narrow the result to nothing');
});

test('search: a title beats any weight of body text', function () {
  /*
   * The decoy names every term three times over. If mentions could
   * outweigh a title, the answer to every single-word query in this guide
   * would be the cheat sheet.
   */
  var corpus = searchCorpus();
  var buried = [];

  searchVocabEntries(VOCAB).forEach(function (e) {
    var top = searchTop(corpus, e.title);
    if (top && top.kind === 'section') buried.push(e.title);
  });

  assert.equal(
    buried.length,
    0,
    'body text outranked the term itself for: ' + buried.join(', ')
  );
});

/* ── Snippets ──────────────────────────────────────────────────────── */

test('search: a snippet is its source, never a rewriting of it', function () {
  /*
   * The parts are joined and rendered, so anything this drops the reader
   * reads as the guide's own prose. That is the failure glow shipped for a
   * while — a highlighter that silently ate the first character of a line —
   * and it is invisible unless something reassembles the output and
   * compares it to what went in.
   */
  var src =
    'The card is a surface with padding. A card inside a dense region ' +
    'keeps its bleed aligned because the negative margin is the same rung ' +
    'as the padding it escapes, and a card that used a literal would not.';

  [['card'], ['dense'], ['card', 'padding'], ['nothinghere']].forEach(function (tokens) {
    var parts = searchSnippet(src, tokens, 150);
    var joined = parts
      .map(function (p) { return p.text; })
      .join('')
      .replace(/^…/, '')
      .replace(/…$/, '');

    assert.ok(joined.length > 0, 'empty snippet for ' + tokens.join(' '));
    assert.ok(
      src.indexOf(joined) > -1,
      'the snippet is not a contiguous run of its source, for ' +
        tokens.join(' ') + ':\n        ' + joined
    );
  });
});

test('search: a snippet marks every hit inside its window, and only hits', function () {
  var src = 'A card, a card matrix, and one more card at the end of it all.';
  var parts = searchSnippet(src, ['card'], 200);

  var hits = parts.filter(function (p) { return p.hit; });
  assert.equal(hits.length, 3, 'expected three marks, got ' + hits.length);
  hits.forEach(function (p) {
    assert.equal(p.text.toLowerCase(), 'card', 'a mark covers text that is not the hit: ' + p.text);
  });

  /* Overlapping tokens must merge rather than nest — `card` and `car`
     marked separately would double the characters they share. */
  var merged = searchSnippet(src, ['card', 'car'], 200)
    .map(function (p) { return p.text; })
    .join('')
    .replace(/^…/, '')
    .replace(/…$/, '');
  assert.ok(src.indexOf(merged) > -1, 'overlapping tokens duplicated text');
});
