/*
 * decisions.spec.js — the Learn wizard and the vocabulary cannot drift.
 *
 * The wizard names terms. vocabulary.js defines them. Neither file imports
 * the other and neither one announces a change, so both directions are
 * failures nobody would notice:
 *
 *   a term is renamed          → the wizard emits a class that is not
 *                                shipped, and the markup it teaches is dead
 *   a component ships          → the teacher never mentions it, and the one
 *                                page whose job is completeness is silently
 *                                incomplete
 *
 * The second is the reason this file exists. The first would eventually be
 * noticed by somebody copying the markup; the second never would.
 *
 * The wizard is guide chrome and does not ship, which is why these tests
 * check its relationship to the package rather than its behavior. What it
 * DOES — every path reaching a rendered outcome — is driven in a browser
 * against the real guide, not from here.
 */

/* ── Every term the wizard names exists ───────────────────────────── */

var TERM_CLASS = (function () {
  var out = {};
  VOCAB.forEach(function (tier) {
    tier[2].forEach(function (row) {
      out[row[0]] = row.length > 3 ? row[3] : row[0].toLowerCase();
    });
  });
  return out;
})();

function termIndex() {
  var out = {};
  VOCAB.forEach(function (tier) {
    tier[2].forEach(function (row) {
      out[row[0]] = {
        cls: row.length > 3 ? row[3] : row[0].toLowerCase(),
        tier: tier[0],
      };
    });
  });
  return out;
}

test('decisions: every outcome names a real vocabulary term', function () {
  var terms = termIndex();
  var unknown = Object.keys(DECIDE.outcomes).filter(function (t) {
    return !terms[t];
  });

  assert.equal(unknown.length, 0, 'outcome for a term that does not exist: ' + unknown.join(', '));
});

test('decisions: every near miss names a real vocabulary term', function () {
  /*
   * `instead` is the half of the wizard that does the actual teaching —
   * Pill/Badge, Bar/Toolbar, Alert/Toast. A dangling name there is a dead
   * jump link, and the wizard offers it as a button.
   */
  var terms = termIndex();
  var bad = [];

  Object.keys(DECIDE.outcomes).forEach(function (name) {
    (DECIDE.outcomes[name].instead || []).forEach(function (i) {
      if (!terms[i.term]) bad.push(name + ' → ' + i.term);
    });
  });

  assert.equal(bad.length, 0, 'near miss naming an unknown term:\n        ' + bad.join('\n        '));
});

test('decisions: a near miss is a different term', function () {
  var bad = [];
  Object.keys(DECIDE.outcomes).forEach(function (name) {
    (DECIDE.outcomes[name].instead || []).forEach(function (i) {
      if (i.term === name) bad.push(name);
    });
  });
  assert.equal(bad.length, 0, 'term listed as its own alternative: ' + bad.join(', '));
});

/* ── Every term the package ships is reachable ────────────────────── */

function reachable() {
  var seen = {};
  var found = {};

  (function walk(id) {
    if (seen[id]) return;
    seen[id] = true;
    var q = DECIDE.questions[id];
    if (!q) throw new Error('option points at a question that does not exist: ' + id);
    q.options.forEach(function (o) {
      if (o.on) found[o.on] = true;
      if (o.to) walk(o.to);
    });
  })(DECIDE.start);

  return found;
}

test('decisions: every vocabulary term is reachable, or excluded with a reason', function () {
  var found = reachable();
  var missing = Object.keys(termIndex()).filter(function (t) {
    return !found[t] && !DECIDE.excluded[t];
  });

  assert.equal(
    missing.length,
    0,
    'the package ships this and the wizard cannot route to it — add a path\n' +
      '        in guide/decisions.js, or exclude it with a reason:\n        ' +
      missing.join(', ')
  );
});

test('decisions: nothing is excluded that is not a real term', function () {
  /* An exclusion is a decision about a real term. Left behind after a
     rename it silently pre-approves the name coming back meaning something
     else — the same reason vocabulary.spec.js checks NOT_A_TERM. */
  var terms = termIndex();
  var stale = Object.keys(DECIDE.excluded).filter(function (t) {
    return !terms[t];
  });
  assert.equal(stale.length, 0, 'excluded term no longer in the vocabulary: ' + stale.join(', '));
});

test('decisions: an excluded term is not also reachable', function () {
  var found = reachable();
  var both = Object.keys(DECIDE.excluded).filter(function (t) {
    return found[t];
  });
  assert.equal(both.length, 0, 'excluded and reachable at once: ' + both.join(', '));
});

/* ── The tree is answerable ───────────────────────────────────────── */

test('decisions: every question is reachable and every option leads somewhere', function () {
  var dangling = [];
  var unreached = [];
  var seen = {};

  (function walk(id) {
    if (seen[id]) return;
    seen[id] = true;
    DECIDE.questions[id].options.forEach(function (o) {
      if (!o.on && !o.to) dangling.push(id + ' → "' + o.label + '"');
      if (o.on && !DECIDE.outcomes[o.on]) dangling.push(id + ' → outcome ' + o.on + ' is not defined');
      if (o.to) walk(o.to);
    });
  })(DECIDE.start);

  Object.keys(DECIDE.questions).forEach(function (id) {
    if (!seen[id]) unreached.push(id);
  });

  assert.equal(dangling.length, 0, 'option that goes nowhere:\n        ' + dangling.join('\n        '));
  assert.equal(unreached.length, 0, 'question no path reaches: ' + unreached.join(', '));
});

/* ── What the wizard writes has to be real CSS ────────────────────── */

test('decisions: every class the wizard can emit is shipped', function () {
  /*
   * The markup is the whole product — somebody is going to copy it. The
   * outcome's own class comes from the vocabulary and is covered there, but
   * these templates also hand-write supporting classes (`alert-icon`,
   * `table-wrap`, `step-label`, `tile-value`, treatments), and those are
   * typed by hand into a file the stylesheet never reads.
   */
  var declared = {};
  allRules().forEach(function (rule) {
    if (!(window.CSSStyleRule && rule instanceof CSSStyleRule)) return;
    ((rule.selectorText || '').match(/\.[a-zA-Z][a-zA-Z0-9_-]*/g) || []).forEach(function (c) {
      declared[c.slice(1)] = true;
    });
  });

  /* Classes that belong to the guide's own chrome or to the demo copy, not
     to the package. `from-right` is a drawer direction and IS shipped. */
  var missing = [];

  Object.keys(DECIDE.outcomes).forEach(function (name) {
    var o = DECIDE.outcomes[name];
    var html = o.markup(['x'].join(''));

    (html.match(/class="([^"]+)"/g) || []).forEach(function (attr) {
      attr
        .slice(7, -1)
        .split(/\s+/)
        .forEach(function (c) {
          if (!c || c === 'x') return;
          if (!declared[c]) missing.push(name + ': .' + c);
        });
    });

    (o.treatments || []).forEach(function (t) {
      if (!declared[t]) missing.push(name + ' treatment: .' + t);
    });
  });

  assert.equal(
    missing.length,
    0,
    'the wizard teaches a class the stylesheet does not ship:\n        ' + missing.join('\n        ')
  );
});

test('decisions: an outcome that offers a tone belongs to a lineage that has one', function () {
  /*
   * A tone chip that changes nothing teaches that tones are decorative.
   * Only the two lineages read --bg-mix, so a Layout or Frame term offering
   * a tone is a bug in the data rather than a matter of taste.
   */
  var terms = termIndex();
  var TONELESS = { Layout: 1, Frame: 1, Page: 1, Region: 1 };
  var bad = [];

  Object.keys(DECIDE.outcomes).forEach(function (name) {
    if (!DECIDE.outcomes[name].tones) return;
    var tier = terms[name].tier;
    if (TONELESS[tier]) bad.push(name + ' (' + tier + ' tier)');
  });

  assert.equal(bad.length, 0, 'offers a tone but cannot render one: ' + bad.join(', '));
});

test('decisions: every treatment it offers actually does something', function () {
  /*
   * The failure this catches is invisible from the data: a treatment listed
   * on the wrong term, or listed on the right term but written onto the
   * wrong ELEMENT. `.items.menu .item` puts `menu` on the container, so a
   * wizard that writes `<li class="item menu">` renders a chip that changes
   * nothing and teaches that treatments are decorative.
   *
   * Asked as "does adding this class make any element in the generated
   * markup match a rule it did not match before". Computed styles would be
   * the more obvious test and cannot answer it — half these treatments only
   * show on :hover, where a computed style never differs. Reading the rules
   * that match the element is the technique this package already relies on.
   */
  var PSEUDO = /:(hover|focus|focus-visible|focus-within|active|target|user-invalid|checked|disabled|first-child|last-child|not\([^)]*\))/g;

  function matchers(cls) {
    /* Rules that mention this class at all — everything else is noise.
       allSelectors() rather than allRules() because surface.css declares
       `.raised` and `.outlined` as NESTED rules, whose own selectorText is
       the relative `&.raised` and cannot be handed to matches(). */
    var needle = new RegExp('\\.' + cls + '\\b');
    return allSelectors()
      .filter(function (sel) { return needle.test(sel); })
      .map(function (sel) { return sel.replace(PSEUDO, ''); });
  }

  function anyMatch(html, selectors) {
    var box = el('<div>' + html + '</div>');
    var nodes = [box].concat(Array.prototype.slice.call(box.querySelectorAll('*')));
    return selectors.some(function (sel) {
      return sel.split(',').some(function (one) {
        try {
          return nodes.some(function (n) { return n.matches(one.trim()); });
        } catch (e) {
          return false; /* a selector this browser cannot parse is not evidence */
        }
      });
    });
  }

  var inert = [];

  Object.keys(DECIDE.outcomes).forEach(function (name) {
    var o = DECIDE.outcomes[name];
    var base = TERM_CLASS[name];

    (o.treatments || []).forEach(function (t) {
      var sels = matchers(t);
      if (!sels.length) {
        inert.push(name + '.' + t + ' — no rule anywhere uses .' + t);
        return;
      }
      /* The chain the wizard would write, exactly. */
      var html = o.markup([base, t].filter(Boolean).join(' '));
      if (!anyMatch(html, sels)) {
        inert.push(name + '.' + t + ' — nothing in the markup matches a .' + t + ' rule');
      }
    });
  });

  cleanup();
  assert.equal(
    inert.length,
    0,
    'a treatment chip that changes nothing:\n        ' + inert.join('\n        ')
  );
});

test('decisions: a wizard sample writes the parts its term cannot render without', function () {
  /*
   * The wizard's markup is the end of every path — it is what somebody
   * copies, and it is the only markup in the guide that no reference page
   * owns. The Feed sample wrote `<ol class="feed"><li><article>`, which is
   * a plain list: no `.feed-item` grid, so no dot column and no connecting
   * line, the two things that make a Feed a Feed rather than a stack of
   * Items. Nothing could see it. `anatomy.spec.js` renders ANATOMY's own
   * block, which is correct; this file only asked whether the classes the
   * sample DID write are shipped, and a class you never write is never
   * wrong.
   *
   * Required parts only, and that distinction is the whole design. A
   * wizard sample is the smallest thing that renders, not the exhaustive
   * reference ANATOMY's block is — a Card with no `.surface-header` is a
   * Card, and demanding one here would teach that the sub-regions are
   * mandatory.
   *
   * A borrowed part carries no flag of its own: `uses` is a bare class
   * list and the 'optional' marker lives on the term that OWNS the part.
   * Resolving through the owner is what keeps ownership single — reading
   * `uses` as required is what made this test's first run report all three
   * Surface sub-regions against four terms that are right.
   */
  var optional = {};
  Object.keys(ANATOMY).forEach(function (term) {
    (ANATOMY[term].parts || []).forEach(function (p) {
      if (p[2] === 'optional') optional[p[0]] = true;
    });
  });

  var missing = [];

  Object.keys(DECIDE.outcomes).forEach(function (name) {
    var entry = ANATOMY[name];
    if (!entry) return; /* most terms are a single element and have no anatomy */

    var box = el('<div>' + DECIDE.outcomes[name].markup(TERM_CLASS[name] || '') + '</div>');

    (entry.parts || []).forEach(function (p) {
      if (p[2] === 'optional') return;
      if (!box.querySelector(p[0])) missing.push(name + ': ' + p[0]);
    });

    (entry.uses || []).forEach(function (c) {
      if (optional['.' + c]) return;
      if (!box.querySelector('.' + c)) missing.push(name + ': .' + c + ' (borrowed)');
    });
  });

  cleanup();
  assert.equal(
    missing.length,
    0,
    'a wizard sample omits a part its term needs to render:\n        ' + missing.join('\n        ')
  );
});
