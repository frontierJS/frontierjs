/*
 * meta.spec.js — tests for the harness, not for the CSS.
 *
 * PROJECT_STATE.md records that roughly a third of the v0.6 failures were
 * bugs in the assertions rather than in the stylesheet, and that when a
 * result contradicts the spec you should suspect the ruler first. These
 * tests are the ruler's calibration marks: if the CSS specs go green while
 * these go red, the green means nothing.
 */

test('meta: the stylesheet actually loaded', function () {
  assert.atLeast(document.styleSheets.length, 1, 'no stylesheet linked');
  var rules = allRules();
  assert.atLeast(rules.length, 200, 'index.css resolved too few rules — check @import paths');
});

test('meta: every @import in index.css resolved', function () {
  var sheet = document.styleSheets[0];
  var imports = [];
  for (var i = 0; i < sheet.cssRules.length; i++) {
    var r = sheet.cssRules[i];
    if (window.CSSImportRule && r instanceof CSSImportRule) imports.push(r);
  }
  assert.atLeast(imports.length, 30, 'expected the full import list');
  imports.forEach(function (r) {
    /*
     * A failed @import leaves the rule in place with a null styleSheet, so
     * a missing file is silent unless you check for exactly this.
     */
    assert.ok(r.styleSheet, 'unresolved @import: ' + r.href);
    assert.atLeast(r.styleSheet.cssRules.length, 1, 'empty stylesheet: ' + r.href);
  });
});

test('meta: every shipped stylesheet is reachable from index.css', function () {
  /*
   * The other direction from the test above. That one catches an @import
   * pointing at a file that is not there; this one catches a file that is
   * there and nothing imports — which is what a directory move makes easy,
   * and which breaks nothing loudly: the rules simply never load.
   *
   * The list comes from the runner, which walks the package on disk using
   * the same boundary as package.json's "files".
   */
  var shipped = window.__FJS_SHIPPED_CSS__;
  assert.ok(shipped && shipped.length, 'the runner injected no file list');
  assert.atLeast(shipped.length, 30, 'expected the full package');

  var sheet = document.styleSheets[0];
  var imported = {};
  for (var i = 0; i < sheet.cssRules.length; i++) {
    var r = sheet.cssRules[i];
    if (!(window.CSSImportRule && r instanceof CSSImportRule)) continue;
    /* href is authored relative: './components/buttons.css' */
    imported[r.href.replace(/^\.\//, '')] = true;
  }

  var orphans = shipped.filter(function (f) {
    return f !== 'index.css' && !imported[f];
  });

  assert.equal(
    orphans.length,
    0,
    'shipped but never imported by index.css:\n        ' + orphans.join('\n        ')
  );
});

test('meta: assertions fail when they should', function () {
  assert.throws(function () { assert.ok(false); }, 'assert.ok accepted false');
  assert.throws(function () { assert.equal(1, 2); }, 'assert.equal accepted a mismatch');
  assert.throws(function () { assert.atLeast(1, 5); }, 'assert.atLeast accepted a low value');
  assert.throws(function () { assert.sameColor('#fff', '#000'); }, 'sameColor accepted a mismatch');
  assert.throws(function () { assert.differentColor('#fff', '#fff'); }, 'differentColor accepted a match');
});

test('meta: toRGB normalises every color syntax to sRGB', function () {
  assert.equal(toRGB('#ff0000').slice(0, 3).join(','), '255,0,0', 'hex');
  assert.equal(toRGB('rgb(255, 0, 0)').slice(0, 3).join(','), '255,0,0', 'rgb()');
  assert.equal(toRGB('red').slice(0, 3).join(','), '255,0,0', 'named');

  /*
   * The one that matters: color-mix() computes to color(xyz-d65 …) in
   * Chrome, so a string comparison against "rgb(…)" fails on colors that
   * are pixel-identical. Every color assertion goes through here for this
   * reason.
   */
  var probe = el('<div style="background: color-mix(in srgb, red 100%, blue)"></div>');
  var computed = style(probe, 'background-color');
  assert.ok(/xyz|color\(/.test(computed), 'expected color-mix to compute to a color() form, got ' + computed);
  assert.sameColor(computed, 'red', 'color-mix(red 100%, blue) should resolve to red');
});

test('meta: toRGB refuses to guess at an unparseable value', function () {
  /*
   * Canvas leaves fillStyle untouched when handed something it cannot
   * parse, so a typo would silently return the previous color. The sentinel
   * turns that into a throw.
   */
  assert.throws(function () { toRGB('not-a-color'); }, 'toRGB invented a value');
});

test('meta: contrast() matches known WCAG ratios', function () {
  var bw = contrast('#ffffff', '#000000');
  assert.ok(Math.abs(bw - 21) < 0.01, 'black on white should be 21:1, got ' + bw);
  var same = contrast('#777777', '#777777');
  assert.ok(Math.abs(same - 1) < 0.01, 'a color against itself should be 1:1, got ' + same);
});

test('meta: mounted nodes are laid out, not merely styled', function () {
  /*
   * A display:none container still computes styles but never lays out, so
   * anything geometric silently reads zero. The container is off-screen
   * rather than hidden; this asserts that stayed true.
   */
  var box = el('<div style="inline-size: 120px; block-size: 40px"></div>');
  assert.equal(box.getBoundingClientRect().width, 120, 'mounted node has no layout box');
});

test('meta: rule walking does not descend into phantom groups', function () {
  /*
   * Every CSSStyleRule exposes a truthy-but-empty .cssRules, so walking by
   * duck-typing invents nested groups and can loop. allRules() keys off the
   * rule's constructor instead; this asserts the count is sane rather than
   * exploded.
   */
  var rules = allRules();
  var styleRules = rules.filter(function (r) {
    return window.CSSStyleRule && r instanceof CSSStyleRule;
  });
  assert.atLeast(styleRules.length, 150, 'suspiciously few style rules');
  assert.ok(rules.length < 5000, 'rule walk exploded — probably descending into phantom groups');
});
