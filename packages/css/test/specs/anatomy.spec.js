/*
 * anatomy.spec.js — which children a term expects, held to the same
 * both-directions standard as the vocabulary itself.
 *
 * vocabulary.spec.js answers "which element and which class" for all 54
 * terms and has since v0.12. It never answered "which children" — and it
 * could not, because it treats any hyphenated class as Anatomy and skips
 * it. That convention accepts `.alert-anything` and mislabels five real
 * classes: `.code-inline` is an alias for the element, `.sidebar-first` is
 * a modifier on Shell, `.skip-link` and `.visually-hidden` are a11y
 * utilities, `.list-row` is the Row term's own class.
 *
 * `ANATOMY` in ../vocabulary.js is the answer as data; this is what stops
 * it drifting from the stylesheet it describes. The directions:
 *
 *   every part declared     ships CSS, and does something on the element
 *                           the markup puts it on
 *   every anatomy class     is claimed by exactly one term, or named in
 *   the stylesheet ships    NOT_ANATOMY with a reason
 *   every markup block      renders every part it claims, and its root
 *                           agrees with VOCAB about the element
 *
 * The last one is the one nothing else could catch. A markup block is
 * documentation with no reader but a person, so a part deleted from it
 * stays listed, and a part listed but never written stays believed.
 */

/* ── Helpers ───────────────────────────────────────────────────────── */

/* [selector, meaning, 'optional'?] — flattened, with the owner attached. */
function anatomyParts() {
  var out = [];
  Object.keys(ANATOMY).forEach(function (term) {
    (ANATOMY[term].parts || []).forEach(function (p) {
      out.push({
        term: term,
        selector: p[0],
        meaning: p[1],
        optional: p[2] === 'optional',
        /* A part is a class or an element. `dt` is Facts' whole point. */
        cls: p[0].charAt(0) === '.' ? p[0].slice(1) : null
      });
    });
  });
  return out;
}

function anatomyTermClass() {
  var out = {};
  VOCAB.forEach(function (tier) {
    tier[2].forEach(function (row) {
      var c = vocabClass(row);
      if (c) out[c] = row[0];
    });
  });
  return out;
}

/* The tags a VOCAB element column mentions: "<li> / <tr>" → li, tr. */
function anatomyTags(term) {
  var found = null;
  VOCAB.forEach(function (tier) {
    tier[2].forEach(function (row) {
      if (row[0] === term) found = row[1];
    });
  });
  if (!found) return null;
  return (String(found).match(/<([a-z][a-z0-9]*)/g) || []).map(function (t) {
    return t.slice(1);
  });
}

/* ── The entries describe things that exist ────────────────────────── */

test('anatomy: every entry names a real vocabulary term', function () {
  /*
   * A typo here is invisible: the entry renders nowhere, the guide falls
   * back to the term having no anatomy, and the parts it claims go
   * unclaimed — which the coverage test below then reports as a class
   * nobody owns, one file away from the actual mistake.
   */
  var terms = {};
  VOCAB.forEach(function (tier) {
    tier[2].forEach(function (row) { terms[row[0]] = true; });
  });

  var unknown = Object.keys(ANATOMY).filter(function (t) { return !terms[t]; });
  assert.equal(unknown.length, 0, 'ANATOMY names no such term: ' + unknown.join(', '));
});

test('anatomy: every part it declares ships CSS', function () {
  /*
   * The forward direction. A part with no rule is a documented slot that
   * does nothing — the same failure `vocabulary: every term that claims a
   * class has one` catches one level up.
   */
  var declared = declaredClasses();
  var missing = [];

  anatomyParts().forEach(function (p) {
    if (p.cls && !declared[p.cls]) missing.push(p.term + ' → ' + p.selector);
  });

  assert.equal(
    missing.length,
    0,
    'declared as a part, no CSS anywhere:\n        ' + missing.join('\n        ')
  );
});

test('anatomy: every class it borrows is owned by some other term', function () {
  /*
   * `uses` is what makes ownership single. Card, Dialog, Drawer and Popover
   * all take the Surface sub-regions, and listing them as parts on all five
   * would say there are five headers with five meanings — the exact thing
   * the lineage claim denies. So they borrow, and a borrow has to resolve.
   */
  var owned = {};
  anatomyParts().forEach(function (p) { if (p.cls) owned[p.cls] = p.term; });

  var dangling = [];
  Object.keys(ANATOMY).forEach(function (term) {
    (ANATOMY[term].uses || []).forEach(function (c) {
      if (!owned[c]) dangling.push(term + ' borrows .' + c + ', which no term owns');
      else if (owned[c] === term) dangling.push(term + ' borrows .' + c + ' from itself');
    });
  });

  assert.equal(dangling.length, 0, dangling.join('\n        '));
});

/* ── The stylesheet has nothing the entries do not explain ─────────── */

test('anatomy: every anatomy class the stylesheet ships is claimed', function () {
  /*
   * The reverse direction, and the reason this file exists. Until it did,
   * a hyphenated class was waved through by convention — so a new
   * `.alert-footer` would ship, style nothing anybody knew about, and pass
   * every test in the suite.
   *
   * A class is exempt only by being a term's own class, or by being named
   * in NOT_ANATOMY with a reason. Both are decisions written down, which
   * is the whole difference from a convention.
   */
  var owned = {};
  anatomyParts().forEach(function (p) { if (p.cls) owned[p.cls] = p.term; });

  var termClass = anatomyTermClass();
  var unclaimed = Object.keys(declaredClasses()).filter(function (c) {
    if (c.indexOf('-') === -1) return false;
    return !owned[c] && !termClass[c] && !NOT_ANATOMY[c];
  });

  assert.equal(
    unclaimed.length,
    0,
    'ships CSS and no term claims it — add it to a term\'s parts in\n' +
      '        vocabulary.js, or to NOT_ANATOMY with a reason:\n        ' +
      unclaimed.sort().join(' ')
  );
});

test('anatomy: no class is owned by two terms', function () {
  /*
   * Two owners means two meanings, and the guide would print whichever it
   * reached first. `uses` exists so that sharing a part is stated rather
   * than achieved by writing it down twice.
   */
  var seen = {};
  var clashes = [];

  anatomyParts().forEach(function (p) {
    if (!p.cls) return;
    if (seen[p.cls]) clashes.push('.' + p.cls + ': ' + seen[p.cls] + ' and ' + p.term);
    else seen[p.cls] = p.term;
  });

  assert.equal(clashes.length, 0, 'owned twice — one of them wants `uses`:\n        ' + clashes.join('\n        '));
});

test('anatomy: NOT_ANATOMY lists nothing the stylesheet stopped shipping', function () {
  /*
   * Same reasoning as NOT_A_TERM's own staleness check. An entry excusing
   * a class that no longer exists is a decision about nothing, and it
   * pre-approves the name if it comes back meaning something else.
   */
  var declared = declaredClasses();
  var stale = Object.keys(NOT_ANATOMY).filter(function (c) { return !declared[c]; });

  assert.equal(
    stale.length,
    0,
    'NOT_ANATOMY excuses a class that is no longer shipped:\n        ' + stale.join(' ')
  );
});

/* ── The markup is the answer, so the markup has to be true ────────── */

test('anatomy: every markup block renders every part it claims', function () {
  /*
   * The check that makes the markup data rather than prose. Nine guide
   * pages carried these blocks by hand, and nothing compared them to the
   * part lists beside them — so a part deleted from a block stayed listed,
   * and a part listed but never written stayed believed.
   *
   * Optional parts are exempt from being present, not from being right:
   * if the block does write one, the selector still has to find it.
   */
  var missing = [];

  Object.keys(ANATOMY).forEach(function (term) {
    var entry = ANATOMY[term];
    var box = el('<div>' + entry.markup + '</div>');

    (entry.parts || []).forEach(function (p) {
      if (p[2] === 'optional') return;
      if (!box.querySelector(p[0])) missing.push(term + ': ' + p[0] + ' is not in its own markup');
    });

    (entry.uses || []).forEach(function (c) {
      if (!box.querySelector('.' + c)) missing.push(term + ': borrows .' + c + ' and never writes it');
    });
  });

  cleanup();
  assert.equal(missing.length, 0, missing.join('\n        '));
});

test('anatomy: a markup block agrees with VOCAB about its own element', function () {
  /*
   * The seam between the two halves, and the reason it is worth having
   * both. VOCAB says Alert is an <article>; if the block writes
   * `<div class="alert">`, one of them is teaching the wrong tag and a
   * reader has no way to tell which.
   *
   * It asks about the element CARRYING THE TERM CLASS, not the root — the
   * root is often a wrapper the term does not name. Table's canonical
   * markup opens `.table-wrap`, Field's opens `.field-group`, Row's opens
   * the `.rows` container. In every one of those the term itself is
   * further in, and a root check would report the wrapper as the failure.
   */
  var termClass = {};
  VOCAB.forEach(function (tier) {
    tier[2].forEach(function (row) {
      var c = vocabClass(row);
      if (c) termClass[row[0]] = c;
    });
  });

  var wrong = [];

  Object.keys(ANATOMY).forEach(function (term) {
    var tags = anatomyTags(term);
    if (!tags || !tags.length) return;

    var box = el('<div>' + ANATOMY[term].markup + '</div>');
    var cls = termClass[term];

    /* No class means the term is carried by its tag, so any root will do —
       Section is a <section>, and there is nothing to look it up by. */
    var nodes = cls
      ? Array.prototype.slice.call(box.querySelectorAll('.' + cls))
      : Array.prototype.slice.call(box.children);

    if (!nodes.length) return; /* the class test below owns that failure */

    var got = nodes.map(function (n) { return n.tagName.toLowerCase(); });
    var ok = got.some(function (t) { return tags.indexOf(t) !== -1; });
    if (!ok) {
      wrong.push(term + ': markup writes <' + got.join('>, <') + '>, VOCAB says <' + tags.join('> / <') + '>');
    }
  });

  cleanup();
  assert.equal(wrong.length, 0, wrong.join('\n        '));
});

test('anatomy: a markup block carries the term class VOCAB names', function () {
  /*
   * The other half of the same seam, and the one a tag check misses: an
   * <article> is an <article> whether or not it says `class="alert"`.
   */
  var termClass = {};
  VOCAB.forEach(function (tier) {
    tier[2].forEach(function (row) {
      var c = vocabClass(row);
      if (c) termClass[row[0]] = c;
    });
  });

  var missing = [];
  Object.keys(ANATOMY).forEach(function (term) {
    var cls = termClass[term];
    if (!cls) return; /* Section and Facts-style terms are carried by the tag */
    var box = el('<div>' + ANATOMY[term].markup + '</div>');
    if (!box.querySelector('.' + cls)) missing.push(term + ': markup never writes .' + cls);
  });

  cleanup();
  assert.equal(missing.length, 0, missing.join('\n        '));
});

test('anatomy: every part actually does something where the markup puts it', function () {
  /*
   * A part can be listed on the right term, ship CSS, appear in the block,
   * and still be inert — because the rule that styles it is scoped to a
   * parent the block does not have. `.items.menu .item` is the shape that
   * taught this package the lesson: the class on the wrong element renders
   * something that changes nothing.
   *
   * ── What this currently proves, and what it does not ────────────────
   *
   * Measured: all 42 parts carry at least one UNSCOPED rule, so none of
   * them can be inert wherever the markup puts them and this test passes
   * trivially today. It is a forward guard, not a live one, and saying so
   * is the difference between a guard and a decoration.
   *
   * It is worth keeping because the package has started scoping anatomy —
   * `.card > .surface-header` cancels the card's own padding, and only in
   * a card — and because the failure it names has happened here before.
   * The day a part's only rule needs an ancestor, a block that forgets the
   * ancestor renders something that changes nothing, and nothing else in
   * the suite would notice.
   *
   * Asked as "does the node this selector finds match any rule that
   * mentions it". Computed styles cannot answer it — several of these only
   * differ on :hover or [aria-current], where a resting computed style is
   * identical either way. Reading the rules that match the element is the
   * technique the rest of this suite already uses.
   */
  var PSEUDO = /:(hover|focus|focus-visible|focus-within|active|target|user-invalid|checked|disabled|first-child|last-child|not\([^)]*\))/g;

  function rulesMentioning(sel) {
    var needle = sel.charAt(0) === '.'
      ? new RegExp('\\.' + sel.slice(1) + '\\b')
      : new RegExp('(^|[\\s>+~,(])' + sel + '\\b');
    return allSelectors()
      .filter(function (s) { return needle.test(s); })
      .map(function (s) { return s.replace(PSEUDO, ''); });
  }

  var inert = [];

  Object.keys(ANATOMY).forEach(function (term) {
    var box = el('<div>' + ANATOMY[term].markup + '</div>');

    (ANATOMY[term].parts || []).forEach(function (p) {
      var node = box.querySelector(p[0]);
      if (!node) return; /* an absent optional part; the render test owns that */

      var hit = rulesMentioning(p[0]).some(function (sel) {
        return sel.split(',').some(function (one) {
          try {
            return node.matches(one.trim());
          } catch (e) {
            return false; /* a selector this browser cannot parse is not evidence */
          }
        });
      });

      if (!hit) inert.push(term + ': ' + p[0] + ' matches no rule where the markup puts it');
    });
  });

  cleanup();
  assert.equal(inert.length, 0, inert.join('\n        '));
});
