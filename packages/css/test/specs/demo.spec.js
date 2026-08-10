/*
 * demo.spec.js — the flagship consumer has to speak the vocabulary.
 *
 * demo/ is tooling: its CSS is outside the package and the runner skips the
 * directory when it collects stylesheets. Its MARKUP is a different thing.
 * The demo is the one artefact that claims to use the whole vocabulary
 * fluently — README.md calls it "the structural half of the system,
 * followed strictly" — and nothing checked that claim.
 *
 * It wrote `class="page"` on every pagination control. `.page` is not
 * shipped, and nav.css documents by name why it is not: "the control is a
 * link, not a page. Shortening the class to `.page` puts one word on two
 * subjects" — Page is also a vocabulary TIER. So the demo's pagination
 * rendered as raw UA links, measured at `rgb(0,0,238)` with no padding and
 * no radius, for as long as it existed. Nothing failed, because nothing
 * looked.
 *
 * The same hole as the Learn wizard's (decisions.spec.js): markup that no
 * spec owns is markup that can name anything at all.
 */

/* ── Every class the demo writes is one the package ships ─────────── */

test('demo: every class in index.html is shipped, vocabulary or documented', function () {
  /*
   * Asked against the real CSSOM rather than a list, so a class that stops
   * being shipped fails here the same day it is deleted.
   */
  var declared = {};
  allRules().forEach(function (rule) {
    if (!(window.CSSStyleRule && rule instanceof CSSStyleRule)) return;
    ((rule.selectorText || '').match(/\.[a-zA-Z][a-zA-Z0-9_-]*/g) || []).forEach(function (c) {
      declared[c.slice(1)] = true;
    });
  });

  /*
   * The demo's own classes, which are IN demo.css by design — that file is
   * a measurement of what the package makes a consumer write, so a name
   * here is a finding rather than an error. `demo-` is the prefix; `sprite`
   * predates it and is named in demo.css's header.
   */
  function isDemoOwn(cls) {
    return cls.indexOf('demo-') === 0 || cls === 'sprite';
  }

  var missing = {};
  (window.__FJS_DEMO_HTML__.match(/class="([^"]*)"/g) || []).forEach(function (attr) {
    attr
      .slice(7, -1)
      .split(/\s+/)
      .forEach(function (c) {
        if (!c || declared[c] || isDemoOwn(c)) return;
        missing[c] = true;
      });
  });

  var names = Object.keys(missing).sort();
  assert.equal(
    names.length,
    0,
    'the demo writes a class the stylesheet does not ship:\n        ' +
      names.map(function (c) { return '.' + c; }).join('\n        ')
  );
});

/* ── And it demonstrates all of them ──────────────────────────────── */

test('demo: every vocabulary term appears somewhere in the demo', function () {
  /*
   * The claim demo/README.md makes out loud — "all 54 vocabulary terms
   * appear across the five routes". A demo that quietly stops covering a
   * term is how a component becomes invisible to the one artefact a reader
   * is most likely to copy from.
   *
   * Class-carried terms are asked of the markup. The rest are carried by an
   * ELEMENT and have no class to find; those are exercised by the demo's
   * own runtime legend, which is driven in a browser rather than here, so
   * they are excluded by name with the element that carries them.
   */
  var ELEMENT_CARRIED = {
    Section: '<section>',
    Group: '<div>',
    Heading: '<h1>-<h6>',
    Text: '<p>',
  };

  var html = window.__FJS_DEMO_HTML__;
  var absent = [];

  VOCAB.forEach(function (tier) {
    tier[2].forEach(function (row) {
      var term = row[0];
      if (ELEMENT_CARRIED[term]) return;

      var cls = vocabClass(row);
      if (!cls) return;

      /* Word-boundary inside a class attribute, so `.page` does not match
         `.pagination-link` and `.item` does not match `.items`. */
      var re = new RegExp('class="[^"]*\\b' + cls + '\\b[^"]*"');
      if (!re.test(html)) absent.push(term + ' (.' + cls + ')');
    });
  });

  assert.equal(
    absent.length,
    0,
    'a vocabulary term the demo never demonstrates:\n        ' + absent.join('\n        ')
  );
});
