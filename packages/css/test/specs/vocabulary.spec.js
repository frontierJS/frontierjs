/*
 * vocabulary.spec.js — the stylesheet may not ship a class the vocabulary
 * does not name.
 *
 * Both directions matter and only one of them is obvious. A term with no
 * CSS is a documented component that does not render. A class with no term
 * is a component two people will call two things, which is the failure the
 * vocabulary exists to prevent — and it is the direction nothing asked
 * about until this file existed.
 *
 * The check reads the real CSSOM rather than the source files, because the
 * two disagree: `.chip` and `.surface` never appear as their own rule, only
 * inside the `:where()` group in chip.css / surface.css, so a grep for
 * `^\.chip` finds nothing and concludes the class is not shipped.
 *
 * ── How a class is judged ─────────────────────────────────────────────
 *
 * A class containing `-` is Anatomy — a position inside an Element —
 * and is skipped here because it is not vocabulary. It is not skipped
 * anywhere: `anatomy.spec.js` requires every one of them to be a declared
 * part of some term or named in NOT_ANATOMY with a reason. Until that file
 * existed the hyphen was the whole rule, and it would have waved through
 * `.alert-anything`.
 *
 * Everything else must be either a term in ../vocabulary.js, or listed below
 * with a reason. Adding CSS for something unnamed fails the suite, and the
 * fix is a decision — name it, or classify it — not an edit to make the red
 * go away.
 */

/* NOT_A_TERM moved to ../vocabulary.js — the guide reads it too. */

/* ── Helpers ───────────────────────────────────────────────────────── */

function vocabTerms() {
  var out = [];
  VOCAB.forEach(function (tier) {
    tier[2].forEach(function (row) {
      /* vocabulary.js owns the rule — [Term, element, meaning, class?],
         where an absent class means the lowercased term and an explicit
         null means the term has none. Asked, not restated. */
      out.push({ term: row[0], element: row[1], cls: vocabClass(row) });
    });
  });
  return out;
}

/* declaredClasses() is a harness ruler — anatomy.spec.js asks it the
   same question from the other end. */

/* ── Both directions ───────────────────────────────────────────────── */

test('vocabulary: every term that claims a class has one', function () {
  /*
   * The forward direction — the half the guide already claimed. A term whose
   * class does not exist is a documented component that does not render.
   */
  var declared = declaredClasses();
  var missing = [];

  vocabTerms().forEach(function (t) {
    if (t.cls === null) return; /* carried by an element; nothing to find */
    if (!declared[t.cls]) missing.push(t.term + ' (expected .' + t.cls + ')');
  });

  assert.equal(
    missing.length,
    0,
    'vocabulary term with no CSS:\n        ' + missing.join('\n        ')
  );
});

test('vocabulary: every class the stylesheet ships has a term', function () {
  /* The direction nothing asked about, and the reason this file exists. */
  var classified = {};
  Object.keys(NOT_A_TERM).forEach(function (kind) {
    NOT_A_TERM[kind].forEach(function (c) {
      classified[c] = kind;
    });
  });

  var termClass = {};
  vocabTerms().forEach(function (t) {
    if (t.cls) termClass[t.cls] = t.term;
  });

  var orphans = Object.keys(declaredClasses()).filter(function (c) {
    if (c.indexOf('-') !== -1) return false; /* Anatomy, by convention */
    return !termClass[c] && !classified[c];
  });

  assert.equal(
    orphans.length,
    0,
    'ships CSS but the vocabulary does not name it — add a term to\n' +
      '        vocabulary.js, or classify it in NOT_A_TERM with a reason:\n        ' +
      orphans.sort().join(' ')
  );
});

test('vocabulary: no class is both a term and classified as not one', function () {
  /*
   * The two lists above are edited by different people at different times.
   * Without this, naming a term while leaving it in NOT_A_TERM makes the
   * reverse test pass for the wrong reason — the orphan check would never
   * see it again, and a later rename would go unnoticed.
   */
  var classified = {};
  Object.keys(NOT_A_TERM).forEach(function (kind) {
    NOT_A_TERM[kind].forEach(function (c) {
      classified[c] = kind;
    });
  });

  var both = [];
  vocabTerms().forEach(function (t) {
    if (t.cls && classified[t.cls]) {
      both.push(t.term + ' (.' + t.cls + ') is also listed as ' + classified[t.cls]);
    }
  });

  assert.equal(both.length, 0, 'term and non-term at once:\n        ' + both.join('\n        '));
});

test('vocabulary: NOT_A_TERM lists nothing the stylesheet stopped shipping', function () {
  /*
   * The list is a record of decisions about real classes. An entry for a
   * class that no longer exists is a decision about nothing, and it silently
   * pre-approves the name if it ever comes back meaning something else.
   */
  var declared = declaredClasses();
  var stale = [];

  Object.keys(NOT_A_TERM).forEach(function (kind) {
    NOT_A_TERM[kind].forEach(function (c) {
      if (!declared[c]) stale.push(c + ' (listed as ' + kind + ')');
    });
  });

  assert.equal(
    stale.length,
    0,
    'NOT_A_TERM names a class that is no longer shipped:\n        ' + stale.join('\n        ')
  );
});

/* ── The element column has to be true ─────────────────────────────── */

test('vocabulary: every term names an element', function () {
  /*
   * "Each term fixes one answer: which element, what ARIA, how it nests."
   * A term with no element is half a term, and the element column is the
   * half that the CSS cannot enforce on its own.
   */
  var bad = [];
  vocabTerms().forEach(function (t) {
    if (!t.element || t.element.indexOf('<') !== 0) {
      bad.push(t.term + ' → ' + JSON.stringify(t.element));
    }
  });
  assert.equal(bad.length, 0, 'term without an element:\n        ' + bad.join('\n        '));
});

test('vocabulary: term names are unique', function () {
  var seen = {};
  var dupes = [];
  vocabTerms().forEach(function (t) {
    if (seen[t.term]) dupes.push(t.term);
    seen[t.term] = true;
  });
  assert.equal(dupes.length, 0, 'duplicate term: ' + dupes.join(', '));
});

/* ── The published JSON is the same vocabulary ─────────────────────── */

test('vocabulary: vocabulary.json is present and current', function () {
  /*
   * vocabulary.js is the source and is a classic script by necessity, so it
   * exports nothing and no consumer can read it. vocabulary.json is generated
   * from it for that audience, and it is committed — dist/ is wiped on every
   * build, so a generated file there would not survive an install from git.
   *
   * Committed and generated is the combination that goes stale quietly: the
   * guide and every spec in this suite read the .js and see a new term at
   * once, while the .json that ships keeps describing the vocabulary as it
   * was. The runner regenerates the payload and compares; this asserts the
   * verdict. Fix with `bun run build:vocabulary`.
   */
  var state = window.__FJS_VOCAB_JSON__;
  assert.ok(state, 'the runner injected no vocabulary.json state');
  assert.ok(state.present, 'vocabulary.json is missing — run `bun run build:vocabulary`');
  assert.ok(
    state.fresh,
    'vocabulary.json is stale' + (state.error ? ' (' + state.error + ')' : '') +
      ' — run `bun run build:vocabulary`'
  );
});
