/*
 * space.spec.js — space is a ladder, and density is what climbs it.
 *
 * The package had a type scale in tokens and no space scale at all: every
 * padding was a literal rem in whichever file needed it. That is why size
 * leaked out as scoped modifiers — `table.compact`, `bar.narrow`,
 * `bar.wide` — each one a density decision wearing a component's name,
 * because there was nowhere else for it to live. Exactly the shape this
 * package criticises `btn-sm` for.
 *
 * These tests hold three things a reader cannot see:
 *
 *   the ladder is declared per ELEMENT, not on :root, or density stops
 *   at the first component that reads a rung
 *
 *   a rung is a length that MOVES with density, not a fixed one
 *
 *   no file below tokens.css re-invents a literal
 */

/* The rungs, smallest first. */
var RUNGS = ['3xs', '2xs', 'xs', 'sm', 'md', 'lg', 'xl', '2xl', '3xl', '4xl', '5xl', '6xl'];

/* ── The ladder is declared once, and reaches every element ───────── */

test('space: every rung resolves on an ordinary element', function () {
  /*
   * On the ELEMENT, not on :root. That distinction is the whole design:
   * `--space-sm: calc(0.5rem * var(--density))` written at :root
   * substitutes --density once, against :root, and inherits the resulting
   * fixed length straight past every .dense — the alias trap ruled on
   * 2026-08-02. It fails silently, because the token still holds a
   * perfectly good value; it is just the wrong one everywhere.
   */
  var node = el('<div>x</div>');

  RUNGS.forEach(function (r) {
    var v = prop(node, '--space-' + r);
    assert.ok(v, '--space-' + r + ' does not resolve on a plain <div>');
    assert.ok(
      v.indexOf('rem') !== -1,
      '--space-' + r + ' should be built from rem, got ' + v
    );
  });

  cleanup();
});

test('space: the ladder ascends', function () {
  /*
   * Cheap, and it catches the one edit nobody proof-reads: a rung pasted
   * in the wrong row. A ladder that goes 10px, 14px, 12px still passes
   * every other test in this file.
   */
  var node = el('<div style="width:1000px">x</div>');
  var last = -1;
  var bad = [];

  RUNGS.forEach(function (r) {
    /* Resolve the rung to a real pixel length by making it a width. */
    var probe = el('<div style="inline-size: var(--space-' + r + ')"></div>');
    node.appendChild(probe);
    var px = parseFloat(style(probe, 'inline-size'));
    if (!(px > last)) bad.push('--space-' + r + ' (' + px + 'px) is not larger than the rung below');
    last = px;
  });

  cleanup();
  assert.equal(bad.length, 0, bad.join('\n        '));
});

/* ── Density ─────────────────────────────────────────────────────── */

test('space: density inherits and every rung follows it', function () {
  /*
   * The property that makes this an axis rather than a class. A tone is
   * registered `inherits: false` so it cannot leak into a child; density is
   * the opposite claim — a fact about a region — and if it stopped at the
   * element that declares it, `dense` on a Pane would style the Pane and
   * nothing in it, which is indistinguishable from doing nothing.
   */
  var deep = el(
    '<div class="dense"><div><section><div class="card" id="probe">x</div></section></div></div>',
    '#probe'
  );

  assert.equal(prop(deep, '--density'), '0.8', 'density did not reach a nested element');

  var scaled = el('<div class="dense"><div style="inline-size: var(--space-2xl)"></div></div>').firstElementChild;
  var plain = el('<div><div style="inline-size: var(--space-2xl)"></div></div>').firstElementChild;

  assert.ok(
    parseFloat(style(scaled, 'inline-size')) < parseFloat(style(plain, 'inline-size')),
    'a rung inside .dense is not smaller than the same rung outside it'
  );

  cleanup();
});

test('space: density reaches real components, not just the tokens', function () {
  /*
   * The token test above passes even if no component reads a rung. This is
   * the one that says the feature exists: put .dense around a component and
   * its padding must actually move.
   */
  var flat = [];

  [
    ['card',  '<div class="card">x</div>', '.card'],
    ['alert', '<div class="alert info"><div class="alert-content">x</div></div>', '.alert'],
    ['table cell', '<table class="table"><tbody><tr><td>x</td></tr></tbody></table>', 'td']
  ].forEach(function (row) {
    var name = row[0], html = row[1], sel = row[2];
    var loose = el('<div>' + html + '</div>', sel);
    var tight = el('<div class="dense">' + html + '</div>', sel);
    var a = parseFloat(style(loose, 'padding-top'));
    var b = parseFloat(style(tight, 'padding-top'));
    if (!(b < a)) flat.push(name + ': ' + a + 'px → ' + b + 'px');
  });

  cleanup();
  assert.equal(
    flat.length,
    0,
    'density does not reach:\n        ' + flat.join('\n        ')
  );
});

test('space: roomy goes the other way', function () {
  var loose = el('<div class="roomy"><div class="card">x</div></div>', '.card');
  var plain = el('<div><div class="card">x</div></div>', '.card');

  assert.ok(
    parseFloat(style(loose, 'padding-top')) > parseFloat(style(plain, 'padding-top')),
    '.roomy did not increase padding'
  );

  cleanup();
});

/* ── No literals below tokens.css ────────────────────────────────── */

test('space: no component or pattern declares a literal padding or gap', function () {
  /*
   * The structural guard, same shape as type.spec.js. A literal is invisible
   * until someone sets a density and finds the one element that did not
   * move — and one such element is worse than none, because it reads as the
   * feature being broken rather than as a missed conversion.
   *
   * `em` stays legal and is not an oversight: a Button's padding is em so
   * that its font-size carries the whole control, which already responds to
   * the type scale. Same for code and kbd.
   *
   * The four exceptions are named rather than counted. A number would let
   * a fifth in as long as a fourth left.
   */
  var EXCEPT = {
    'form-core.css': ['36px'],   /* room for the select chevron — an icon, not a rhythm */
    'nav.css':       ['0.4375rem'], /* 7px, off the 2px grid; a rung for it would be a rung for one caller */
    'steps.css':     ['0.3125rem'], /* 5px, same */
    'pills.css':     ['3px']     /* an optical nudge on the remove button, not spacing */
  };

  /*
   * Read the AUTHORED declaration, not rule.style.
   *
   * The CSSOM expands `padding: var(--space-lg)` into four longhands and
   * then answers "" for each of them, because a shorthand carrying a var()
   * cannot be split until it is resolved. Iterating rule.style therefore
   * reports every converted declaration as empty and every `padding: 0` as
   * `0px` — 287 false positives, all of them the test being wrong.
   */
  var DECL = /(^|[{;\s])(padding[a-z-]*|gap|row-gap|column-gap)\s*:\s*([^;}]+)/g;
  /* The CSSOM serialises `padding: 0` as `0px`. Zero has no density. */
  var allowed = /^(var\(|calc\(|0(px)?$|auto$|inherit$|[\d.]+em$)/;
  var offenders = [];

  allRules().forEach(function (rule) {
    if (!(window.CSSStyleRule && rule instanceof CSSStyleRule)) return;

    var href = (rule.parentStyleSheet && rule.parentStyleSheet.href) || '';
    var file = href.split('/').pop();
    /* tokens.css IS the declaration site. */
    if (file === 'tokens.css') return;

    var text = rule.cssText || '';
    var m;
    DECL.lastIndex = 0;
    while ((m = DECL.exec(text))) {
      var name = m[2];
      var whole = m[3].trim();
      /* A value built from a token is judged whole: splitting it on spaces
         turns `var(--code-pad, 0px)` into a fragment `0px)` that looks like
         a literal and is not one. */
      if (whole.indexOf('var(') !== -1 || whole.indexOf('calc(') !== -1) continue;
      whole.split(/\s+/).forEach(function (part) {
        if (allowed.test(part)) return;
        if ((EXCEPT[file] || []).indexOf(part) !== -1) return;
        offenders.push(file + ': ' + rule.selectorText + ' { ' + name + ': ' + part + ' }');
      });
    }
  });

  assert.equal(
    offenders.length,
    0,
    'a literal where a rung belongs:\n        ' + offenders.join('\n        ')
  );
});

test('space: every named exception is still there', function () {
  /*
   * The reverse direction, and the one nothing else catches. An exception
   * left behind after the literal it excuses has gone silently pre-approves
   * the next one — same reasoning as vocabulary.spec.js's NOT_A_TERM check.
   */
  var EXPECTED = ['36px', '0.4375rem', '0.3125rem', '3px'];
  var DECL = /(padding[a-z-]*|gap|row-gap|column-gap)\s*:\s*([^;}]+)/g;
  var seen = {};

  allRules().forEach(function (rule) {
    if (!(window.CSSStyleRule && rule instanceof CSSStyleRule)) return;
    var text = rule.cssText || '';
    var m;
    DECL.lastIndex = 0;
    while ((m = DECL.exec(text))) {
      m[2].trim().split(/\s+/).forEach(function (p) { seen[p] = true; });
    }
  });

  var stale = EXPECTED.filter(function (v) { return !seen[v]; });
  assert.equal(stale.length, 0, 'exception no longer needed, remove it: ' + stale.join(', '));
});

/* ── Derived density ─────────────────────────────────────────────── */

test('space: a narrow named container tightens what is inside it', function () {
  /*
   * The opt-in is `container: fjs / inline-size` on the app's own box, and
   * the NAME is the point: an unnamed query would react to any container an
   * app happened to create somewhere else for its own reasons.
   */
  var wide = el('<div style="container: fjs / inline-size; inline-size: 600px"><div class="card">x</div></div>', '.card');
  var mid = el('<div style="container: fjs / inline-size; inline-size: 440px"><div class="card">x</div></div>', '.card');
  var narrow = el('<div style="container: fjs / inline-size; inline-size: 280px"><div class="card">x</div></div>', '.card');

  assert.equal(prop(wide, '--density'), '1', 'a roomy container should not change density');
  assert.equal(prop(mid, '--density'), '0.9', 'the first step did not fire');
  assert.equal(prop(narrow, '--density'), '0.8', 'the second step did not fire');

  cleanup();
});

test('space: an unnamed container does not tighten anything', function () {
  /*
   * An app makes a box a container for its own layout reasons. If that
   * silently changed the padding of everything inside it, the package would
   * be reacting to a decision that was never about density.
   */
  var node = el('<div style="container-type: inline-size; inline-size: 200px"><div class="card">x</div></div>', '.card');
  assert.equal(prop(node, '--density'), '1', 'an unnamed container changed density');
  cleanup();
});

test('space: declared beats derived', function () {
  /*
   * The one rule worth remembering. The container rules are on `*` —
   * (0,0,0) — so a stated .dense or .roomy inside a narrow box still wins.
   * The reverse would make the axis untrustworthy: you would write .roomy,
   * see nothing happen, and have no way to find out why.
   */
  var stated = el(
    '<div style="container: fjs / inline-size; inline-size: 260px"><div class="card roomy">x</div></div>',
    '.card'
  );
  assert.equal(prop(stated, '--density'), '1.25', 'a narrow container overrode a stated .roomy');

  var plain = el('<div><div class="card">x</div></div>', '.card');
  assert.ok(
    parseFloat(style(stated, 'padding-top')) > parseFloat(style(plain, 'padding-top')),
    '.roomy inside a narrow container did not stay roomy'
  );

  cleanup();
});

/* ── The gap utilities ─────────────────────────────────────────────── */

test('space: a gap utility beats the component gap it lands on', function () {
  /*
   * The whole reason the utility can replace a one-off rule beside a
   * component. `.stack` sets `gap` in the `layout` layer and `.gap-3xs`
   * sets it in `utilities`; both are single-class selectors, so
   * specificity cannot separate them and only the layer order can — the
   * same collision `.bar.center` documents in layout.css, decided the
   * other way. If `utilities` ever moves before `layout` in index.css
   * every one of these silently stops working, and the markup that reads
   * `class="stack gap-3xs"` still says it should.
   */
  var tight = el('<div class="stack gap-3xs"><span>a</span><span>b</span></div>');
  var plain = el('<div class="stack"><span>a</span><span>b</span></div>');

  assert.equal(
    style(tight, 'row-gap'),
    style(el('<div style="block-size:var(--space-3xs)"></div>'), 'block-size'),
    '.gap-3xs did not override .stack — check the layer order in index.css'
  );
  assert.ok(
    parseFloat(style(tight, 'row-gap')) < parseFloat(style(plain, 'row-gap')),
    '.gap-3xs is not tighter than the .stack it overrode'
  );

  cleanup();
});

test('space: a gap utility rides density', function () {
  /*
   * The reason to prefer one of these over a literal `gap: 4px` in a
   * one-off rule. A rung is multiplied by --density, so the utility
   * follows a .dense or .roomy region; a literal stays put and the
   * region misaligns around it, which is the failure a hand-written
   * `.thing { gap: … }` beside a component reintroduces every time.
   */
  var dense = el('<div class="dense"><div class="stack gap-2xl">x</div></div>', '.stack');
  var roomy = el('<div class="roomy"><div class="stack gap-2xl">x</div></div>', '.stack');

  assert.ok(
    parseFloat(style(dense, 'row-gap')) < parseFloat(style(roomy, 'row-gap')),
    '.gap-2xl did not move with density — the rung was flattened to a fixed length'
  );

  cleanup();
});

test('space: every rung ships a gap utility, and every gap utility is a rung', function () {
  /*
   * Both directions, for the reason vocabulary.spec.js checks both: a
   * missing rung is invisible (you write `.gap-4xl`, nothing happens, and
   * the markup looks right), and a utility naming a rung that no longer
   * exists resolves to nothing at all rather than to a wrong number.
   */
  var shipped = {};

  allRules().forEach(function (rule) {
    if (!(window.CSSStyleRule && rule instanceof CSSStyleRule)) return;
    (rule.selectorText || '').split(',').forEach(function (sel) {
      var m = /^\s*\.gap-([a-z0-9]+)\s*$/.exec(sel);
      if (m) shipped[m[1]] = rule.cssText || '';
    });
  });

  var missing = RUNGS.filter(function (r) { return !(r in shipped); });
  assert.equal(missing.length, 0, 'a rung with no gap utility: ' + missing.join(', '));

  var stray = Object.keys(shipped).filter(function (k) {
    return k !== '0' && RUNGS.indexOf(k) === -1;
  });
  assert.equal(stray.length, 0, 'a gap utility naming no rung: ' + stray.join(', '));

  Object.keys(shipped).forEach(function (k) {
    if (k === '0') return;
    assert.ok(
      shipped[k].indexOf('var(--space-' + k + ')') !== -1,
      '.gap-' + k + ' does not read --space-' + k
    );
  });
});

test('space: the package ships no container-type of its own', function () {
  /*
   * Measured, and the reason the opt-in exists: inline-size containment
   * means the box can no longer be sized by its contents. A .card in a
   * .cluster went from 83px to 42px — the width of its own padding — and
   * the same in an auto-sized grid track. It also becomes the containing
   * block for `position: fixed` descendants, so an app's toast inside one
   * drifts. None of that is visible from the declaration that caused it.
   */
  var offenders = [];

  allRules().forEach(function (rule) {
    if (!(window.CSSStyleRule && rule instanceof CSSStyleRule)) return;
    var text = rule.cssText || '';
    if (/container-type\s*:|container\s*:\s*[\w-]+\s*\//.test(text)) {
      offenders.push(rule.selectorText);
    }
  });

  assert.equal(
    offenders.length,
    0,
    'a shipped rule makes an element a container — that changes how it is sized:\n        ' +
      offenders.join('\n        ')
  );
});
