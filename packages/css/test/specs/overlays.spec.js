/*
 * overlays.spec.js — an Overlay must be able to leave, not only arrive.
 *
 * Every overlay here used to vanish on `display: none`. The exit is the
 * half that needed JavaScript, and the repo has already paid for that: the
 * kit animated overlays in from an attachment with `fill: 'forwards'`, and
 * for a while the command palette painted at keyframe 0 — invisible, with a
 * full-screen backdrop that swallowed every click (FJS-114). Three
 * properties replace all of it, and each one fails silently on its own.
 *
 * ── Why this reads rules and not computed styles ──────────────────
 *
 * Measured, not assumed: under `--virtual-time-budget` headless Chrome runs
 * almost none of the transition lifecycle for a top-layer element. Opening
 * a dialog reports opacity and transform through getAnimations(); closing
 * one reports only the discrete pair, and `transitionrun` / `transitionend`
 * never fire at all — not even for the entry that demonstrably runs. A
 * Toast, which is not in the top layer, reports the whole lifecycle both
 * ways. So a computed-style assertion here would be measuring the harness.
 *
 * What this file asserts instead is that the mechanism is DECLARED: the
 * right properties in the transition list, a closed state, an open state,
 * and an @starting-style for each. Whether the browser then honors it is
 * the browser's guarantee, and it is the same three properties every other
 * framework's JavaScript is emulating.
 */

/* The four the tier is made of. Tooltip is deliberately absent: it is a
   :hover affordance with no open state to transition on. */
var OVERLAYS = [
  { name: 'dialog',  closed: 'dialog.dialog',      open: 'dialog.dialog[open]' },
  { name: 'drawer',  closed: 'dialog.drawer',      open: 'dialog.drawer[open]' },
  { name: 'popover', closed: '[popover].popover',  open: '[popover].popover:popover-open' },
  { name: 'toast',   closed: '.toast[hidden]',     open: '.toast' }
];

/*
 * A local walk rather than allRules(), because parentage is the whole
 * question here: `dialog.dialog[open]` appears TWICE with two opposite
 * opacities — once as the open state and once inside @starting-style — and
 * a flat list cannot tell them apart.
 *
 * Computed style is not available for any of this either: test/run.js
 * turns every transition off globally with an unlayered `!important`, so
 * `transition-property` on a live node reads as the harness, not the
 * package.
 */
function walkRules(fn) {
  function walk(list, inStarting) {
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      var starting = inStarting ||
        (window.CSSStartingStyleRule && r instanceof CSSStartingStyleRule);
      if (window.CSSStyleRule && r instanceof CSSStyleRule) {
        (r.selectorText || '').split(',').forEach(function (sel) {
          fn(sel.trim(), r, starting);
        });
      }
      if (r.cssRules) walk(r.cssRules, starting);
      if (r.styleSheet && r.styleSheet.cssRules) walk(r.styleSheet.cssRules, starting);
    }
  }
  for (var s = 0; s < document.styleSheets.length; s++) {
    walk(document.styleSheets[s].cssRules, false);
  }
}

/* The value a selector ends up declaring, ignoring @starting-style. */
function declared(selector, prop) {
  var value = '';
  walkRules(function (sel, rule, starting) {
    if (starting || sel !== selector) return;
    var v = rule.style.getPropertyValue(prop);
    if (v) value = v.trim(); /* later wins, as the cascade would */
  });
  return value;
}

/* Every transition declaration that applies to this selector. */
function transitionFor(selector) {
  var out = '';
  walkRules(function (sel, rule, starting) {
    if (starting || sel !== selector) return;
    var v = rule.style.getPropertyValue('transition');
    if (v) out = v;
  });
  return out.replace(/\s+/g, ' ');
}

/* ── The transition list ──────────────────────────────────────────── */

test('overlays: the transition list carries display and overlay', function () {
  /*
   * `display` is what keeps the box alive long enough to animate out;
   * `overlay` is what keeps a modal or popover in the TOP LAYER while it
   * does. Without the second the exit plays behind the rest of the page,
   * which reads as a flicker rather than a bug.
   */
  var missing = [];

  OVERLAYS.forEach(function (o) {
    var t = transitionFor(o.closed === '.toast[hidden]' ? '.toast' : o.closed);
    if (!t) { missing.push(o.name + ': no transition at all'); return; }
    if (t.indexOf('display') === -1) missing.push(o.name + ': display');
    /* A Toast is never in the top layer, so `overlay` is meaningless there. */
    if (o.name !== 'toast' && t.indexOf('overlay') === -1) missing.push(o.name + ': overlay');
  });

  assert.equal(missing.length, 0, 'not in the transition list:\n        ' + missing.join('\n        '));
});

/*
 * A transition list splits on TOP-LEVEL commas only.
 *
 * `transition: opacity var(--overlay-time, var(--motion-enter)) …` carries a
 * comma inside the fallback arm, so `t.split(',')` cuts a segment in half and
 * every property reports as missing its behavior — a red test against CSS
 * that is exactly right. The nesting is not incidental either: the fallback
 * arm is what stops --overlay-time being an alias resolved once at :root
 * (overlays.css says why), so this shape is here to stay.
 */
function segments(list) {
  var out = [];
  var depth = 0;
  var at = 0;

  for (var i = 0; i < list.length; i++) {
    var c = list[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) { out.push(list.slice(at, i)); at = i + 1; }
  }
  out.push(list.slice(at));

  return out.map(function (s) { return s.trim(); });
}

test('overlays: display and overlay are allow-discrete', function () {
  /*
   * The property in the list does nothing without the behavior. This is
   * the failure worth a test of its own: `transition: display 160ms` on its
   * own is valid CSS, changes nothing, and looks exactly like the fix.
   */
  var bad = [];

  OVERLAYS.forEach(function (o) {
    var t = transitionFor(o.closed === '.toast[hidden]' ? '.toast' : o.closed);
    (o.name === 'toast' ? ['display'] : ['display', 'overlay']).forEach(function (prop) {
      var seg = segments(t).filter(function (part) {
        return part.indexOf(prop) === 0;
      })[0];
      if (!seg || seg.indexOf('allow-discrete') === -1) {
        bad.push(o.name + ': ' + prop + ' is not allow-discrete');
      }
    });
  });

  assert.equal(bad.length, 0, bad.join('\n        '));
});

/* ── Both ends of the animation exist ─────────────────────────────── */

test('overlays: every overlay declares a closed state and an open state', function () {
  var bad = [];

  OVERLAYS.forEach(function (o) {
    if (declared(o.closed, 'opacity') !== '0') {
      bad.push(o.name + ': `' + o.closed + '` does not declare opacity: 0');
    }
    if (declared(o.open, 'opacity') !== '1') {
      bad.push(o.name + ': `' + o.open + '` does not declare opacity: 1');
    }
  });

  assert.equal(bad.length, 0, bad.join('\n        '));
});

test('overlays: every overlay has an @starting-style', function () {
  /*
   * Without it the entry has nothing to animate FROM — the element is
   * rendered for the first time already at its open value, so it appears
   * instantly while the exit still animates. Half-working is the shape of
   * this bug, and the half that works is the one you notice.
   */
  var found = {};
  walkRules(function (sel, rule, starting) {
    if (starting) found[sel] = true;
  });

  var missing = OVERLAYS.filter(function (o) {
    /* A Toast has no open state of its own — it is inserted and removed —
       so its starting style keys on the element rather than an open one. */
    return !found[o.name === 'toast' ? '.toast' : o.open];
  }).map(function (o) { return o.name; });

  assert.equal(missing.length, 0, 'no @starting-style for: ' + missing.join(', '));
});

/* ── The states the platform already owns ─────────────────────────── */

test('overlays: no overlay invents a state class', function () {
  /*
   * `.is-open`, `.show`, `.fade`, `.closing` — every one of these is a
   * second source of truth for something the element already knows.
   * Bootstrap needs `.fade.show` because it predates all of this; here the
   * state is `[open]`, `:popover-open` and `[hidden]`.
   */
  var invented = /\.(is-open|is-closing|show|showing|fade|closing|entering|leaving|opened)\b/;
  var offenders = [];

  allSelectors().forEach(function (sel) {
    if (!/\.(dialog|drawer|popover|toast|tooltip)\b/.test(sel)) return;
    if (invented.test(sel)) offenders.push(sel);
  });

  assert.equal(offenders.length, 0, 'state class on an overlay: ' + offenders.join(', '));
});

/* ── The static previews the guide renders ────────────────────────── */

test('overlays: a non-dialog .dialog and a non-[popover] .popover stay visible', function () {
  /*
   * The closed state is `opacity: 0`, so the selectors name the ELEMENT and
   * the ATTRIBUTE. `<div class="dialog">` is how the guide renders a dialog
   * as a static preview, and `.popover` is documented as usable on a plain
   * element the app shows and hides itself. Matching either would blank the
   * documentation and every app doing it the documented way.
   */
  var box = el('<div class="dialog">a</div>');
  assert.equal(style(box, 'opacity'), '1', 'a plain .dialog is invisible');

  var pop = el('<div class="popover">b</div>');
  assert.notEqual(declared('.popover', 'opacity'), '0', '.popover is blanked without the attribute');
  assert.ok(pop, 'popover rendered');

  cleanup();
});
