/*
 * tokens.spec.js — tokens.css is the sole declaration site.
 *
 * A value that answers a question no single component can answer belongs in
 * tokens.css, and the guard is that nothing else may write it as a literal.
 * type.spec.js already does this for the type scale; this file does it for
 * the values where the same argument holds and nothing was watching.
 *
 * The test to apply before adding one: could a component pick this number
 * on its own and be right? A radius can. A stacking rung cannot — it is a
 * claim about what sits above what, and the other half of the claim is in
 * a file the author is not reading.
 */

/* ── Stacking order ───────────────────────────────────────────────── */

/*
 * The documented ladder, bottom to top. Read from tokens.css at runtime,
 * so a rung renamed or deleted there fails here rather than in an app.
 */
var LADDER = ['--z-topbar', '--z-popover', '--z-tooltip', '--z-toast', '--z-skip-link'];

test('tokens: no component or pattern declares a literal stacking rung', function () {
  /*
   * 0 and 1 stay legal, and they are the reason this reads the value
   * rather than counting declarations. A component that makes its own
   * stacking context and orders two of its own parts inside it — the
   * connector behind a .step-marker, the focused .field lifted clear of
   * its neighbor's border — is not on the global ladder and gains nothing
   * from a token. Anything above 1 is a claim about the rest of the
   * interface.
   */
  var allowed = /^(var\(|auto$|inherit$|0$|1$)/;
  var offenders = [];

  allRules().forEach(function (rule) {
    if (!(window.CSSStyleRule && rule instanceof CSSStyleRule)) return;

    var href = (rule.parentStyleSheet && rule.parentStyleSheet.href) || '';
    if (/tokens\.css$/.test(href) || /\/themes\//.test(href)) return;

    var v = (rule.style.getPropertyValue('z-index') || '').trim();
    if (!v) return;

    if (!allowed.test(v)) {
      offenders.push(href.split('/').pop() + ': ' + rule.selectorText + ' { z-index: ' + v + ' }');
    }
  });

  assert.equal(
    offenders.length,
    0,
    'literal z-index outside tokens.css:\n        ' + offenders.join('\n        ')
  );
});

test('tokens: no component or pattern declares a literal pixel radius', function () {
  /*
   * A px corner does not move when a theme retunes --btn-radius, so a
   * square theme keeps rounded code chips beside square buttons (FJS-1572).
   * Shapes stay legal: 0 is a flush edge, 50% a dot, 999px a pill.
   */
  var allowed = /^(0|0px|50%|999px|9999px|inherit)$|var\(/;
  var offenders = [];

  allRules().forEach(function (rule) {
    if (!(window.CSSStyleRule && rule instanceof CSSStyleRule)) return;

    var href = (rule.parentStyleSheet && rule.parentStyleSheet.href) || '';
    if (/tokens\.css$/.test(href) || /\/themes\//.test(href)) return;

    for (var i = 0; i < rule.style.length; i++) {
      var name = rule.style[i];
      if (!/radius$/.test(name)) continue;
      var v = rule.style.getPropertyValue(name).trim();
      // A longhand expanded from a var() shorthand reads back empty.
      if (v && !allowed.test(v)) {
        offenders.push(href.split('/').pop() + ': ' + rule.selectorText + ' { ' + name + ': ' + v + ' }');
      }
    }
  });

  assert.equal(
    offenders.length,
    0,
    'literal radius outside tokens.css:\n        ' + offenders.join('\n        ')
  );
});

test('tokens: every rung on the stacking ladder is declared', function () {
  var root = document.documentElement;

  LADDER.forEach(function (name) {
    var v = prop(root, name);
    assert.ok(v !== '', name + ' is not declared in tokens.css');
    assert.ok(/^\d+$/.test(v), name + ' is not an integer: ' + v);
  });
});

test('tokens: the ladder ascends in the documented order', function () {
  /*
   * The numbers are the design decision and the ORDER is what the decision
   * was. Without this, editing one rung to fix a local overlap silently
   * reorders the interface — a popover over a toast renders, looks
   * plausible, and is wrong in the one case the ladder exists for.
   */
  var root = document.documentElement;
  var values = LADDER.map(function (name) { return parseInt(prop(root, name), 10); });

  for (var i = 1; i < values.length; i++) {
    assert.ok(
      values[i] > values[i - 1],
      'stacking ladder out of order: ' + LADDER[i - 1] + ' (' + values[i - 1] + ') ' +
      'should sit below ' + LADDER[i] + ' (' + values[i] + ')'
    );
  }
});

test('tokens: every rung is actually used by a component', function () {
  /*
   * The other direction. A rung nothing reads is a number in a file
   * claiming to describe the interface and describing nothing — the same
   * defect as a documented component that does not render, which
   * vocabulary.spec.js catches for classes.
   */
  var read = {};

  allRules().forEach(function (rule) {
    if (!(window.CSSStyleRule && rule instanceof CSSStyleRule)) return;
    var v = (rule.style.getPropertyValue('z-index') || '').trim();
    var m = v.match(/var\((--z-[a-z-]+)/);
    if (m) read[m[1]] = true;
  });

  var unread = LADDER.filter(function (name) { return !read[name]; });

  assert.equal(
    unread.length,
    0,
    'declared on the ladder and read by nothing:\n        ' + unread.join('\n        ')
  );
});

/* ── The variable namespace ───────────────────────────────────────── */

/*
 * Three tiers, and until v0.12 the name carried none of them:
 *
 *   knob      a caller SETS it to steer a derivation — --bg-mix,
 *             --on-bg-mix, --tone-fill, --surface-ground, --overlay-from
 *   published a caller READS it and gets what the components got —
 *             --tone-ink (README), --tint-surface / --tint-rule /
 *             --tint-ink (the spec below this one)
 *   private   the package derives it and nothing outside reads or sets
 *             it — marked --_
 *
 * Why a private tier exists at all: --_fill is the background a .btn
 * paints and --_on-fill is the text color derived from the same
 * luminance, so setting one output alone repaints half an answer and
 * leaves the other deriving from a color that is no longer there. Yellow
 * that way is white text at 1.07:1 — rendering correctly, failing
 * nothing, saying nothing. The knob one step up, --tone-fill, does both
 * halves.
 *
 * CSS cannot forbid an app from setting --_fill, and these tests do not
 * pretend to. The name is what warns; what is testable is that the
 * package keeps its own half of the bargain, which is one owner per
 * derivation.
 */

function privateProps() {
  var owners = {};
  allRules().forEach(function (rule) {
    if (!(window.CSSStyleRule && rule instanceof CSSStyleRule)) return;
    var href = (rule.parentStyleSheet && rule.parentStyleSheet.href) || '';
    var file = href.split('/').pop();
    for (var i = 0; i < rule.style.length; i++) {
      var name = rule.style[i];
      if (name.indexOf('--_') !== 0) continue;
      (owners[name] = owners[name] || {})[file] = true;
    }
  });
  return owners;
}

test('tokens: a private property is derived in exactly one file', function () {
  /*
   * Invariant 4's shape inside a stylesheet. Two files deriving one value
   * is the state the cascade resolves by source order, which means the
   * answer changes when the import list is reordered for an unrelated
   * reason — and both derivations look correct in isolation.
   */
  var owners = privateProps();
  var shared = [];

  Object.keys(owners).forEach(function (name) {
    var files = Object.keys(owners[name]);
    if (files.length > 1) shared.push(name + ' derived in ' + files.join(' and '));
  });

  assert.equal(
    shared.length,
    0,
    'more than one owner:\n        ' + shared.join('\n        ')
  );
});

test('tokens: every private property is read by something', function () {
  var owners = privateProps();
  var names = Object.keys(owners);
  assert.atLeast(names.length, 1, 'no --_ properties found — did the convention get renamed away?');

  var readCount = {};
  allRules().forEach(function (rule) {
    if (!(window.CSSStyleRule && rule instanceof CSSStyleRule)) return;
    var css = rule.cssText || '';
    names.forEach(function (name) {
      if (css.indexOf('var(' + name) !== -1) readCount[name] = true;
    });
  });

  var dead = names.filter(function (n) { return !readCount[n]; });

  assert.equal(
    dead.length,
    0,
    'derived and read by nothing:\n        ' + dead.join('\n        ')
  );
});

test('tokens: no published variable has been marked private', function () {
  /*
   * The tiering, written down where a rename fails rather than in prose
   * that goes quietly stale. These six are named in README.md or asserted
   * by tones.spec.js as things an app may set or read; marking one private
   * keeps every other test in this package green — the components would
   * agree with each other perfectly — and breaks the documented affordance
   * in every app that took the README at its word.
   *
   * It asks for the private TWIN rather than for the public name, because
   * the public name surviving somewhere is not the question: --tone-fill
   * is set in seven files, so renaming one of them leaves it declared and
   * the interesting half is the --_tone-fill that appeared.
   */
  var PUBLIC = ['--bg-mix', '--on-bg-mix', '--tone-fill', '--tone-ink', '--tint-surface', '--tint-ink'];
  var twins = PUBLIC.map(function (n) { return '--_' + n.slice(2); });
  var found = {};

  allRules().forEach(function (rule) {
    if (!(window.CSSStyleRule && rule instanceof CSSStyleRule)) return;
    var href = (rule.parentStyleSheet && rule.parentStyleSheet.href) || '';
    var file = href.split('/').pop();
    var css = rule.cssText || '';
    twins.forEach(function (t) {
      /* Either half counts: a declaration is the rename, a read is the caller it broke. */
      if (css.indexOf(t) !== -1) found[t] = file;
    });
  });

  var offenders = Object.keys(found).map(function (t) {
    return t + ' in ' + found[t] + ' — ' + t.replace('--_', '--') + ' is published';
  });

  assert.equal(
    offenders.length,
    0,
    'a published variable was marked private:\n        ' + offenders.join('\n        ')
  );
});
