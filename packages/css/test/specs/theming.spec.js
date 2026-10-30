/*
 * theming.spec.js — what a theme can reach without shipping a selector.
 *
 * A theme in this package is a class of inheriting tokens and nothing
 * else. That is the whole contract, and it is the contract that decides
 * what a look can be: if a design needs a rule of its own, the token that
 * would have carried it is missing. press.css exists to probe exactly
 * that, and it found four gaps at once — space SHAPE, border weight,
 * resting elevation and the frame's grounds (FJS-158, -159, -160, -161).
 *
 * Every assertion here is written the way a theme is: set tokens on an
 * ancestor, measure a DESCENDANT. That distinction is the substance —
 * three of the four gaps were not "no token" but "a token that stops at
 * the element it is written on", which looks identical in a demo where
 * everything is one element deep.
 */

/*
 * A themed wrapper carrying arbitrary tokens, plus the subject inside it.
 * Returns the subject, so every test measures a descendant and never the
 * element the tokens were declared on.
 */
function themedBy(tokens, html, selector) {
  var wrap = document.createElement('div');
  wrap.setAttribute('style', tokens);
  wrap.innerHTML = html.trim();
  /* el() mounts and returns; reuse its container rather than finding one. */
  el('<div hidden></div>').replaceWith(wrap);
  var node = wrap.firstElementChild;
  return selector ? node.querySelector(selector) : node;
}

var px = function (v) { return Math.round(parseFloat(v) * 100) / 100; };

/*
 * An unregistered custom property computes to its TOKEN STREAM, not to a
 * length: `getComputedStyle(el).getPropertyValue('--space-2xl')` answers
 * `calc(3rem * 1)`, and reading a number off that measures the source
 * text rather than the result. Every rung here is therefore read through
 * a use site — an inline `padding-top: var(--rung)` on the element being
 * asked about — which is the only thing that forces the substitution.
 */
function rung(node, name) {
  node.style.paddingTop = 'var(' + name + ')';
  return px(getComputedStyle(node).paddingTop);
}

/* ── FJS-158 — the space ladder's shape ──────────────────────────── */

test('theming: a theme retunes a space rung and it reaches a descendant', function () {
  /*
   * The rung is `base × density` and the BASE is what a theme sets. Both
   * halves inherit and neither is resolved early, so an element three
   * levels down recomputes from what it inherited.
   */
  var deep = themedBy(
    '--space-2xl-base: 3rem',
    '<div><div><span id="deep">x</span></div></div>',
    '#deep'
  );
  assert.equal(rung(deep, '--space-2xl'), 48, 'a retuned rung did not reach a descendant');
  cleanup();
});

test('theming: a rung declared directly still stops at its own element', function () {
  /*
   * The mechanism, pinned so nobody "simplifies" the base indirection
   * away. Declaring `--space-2xl` on an ancestor is (0,1,0) and wins on
   * that element alone — every descendant matches the `*` rule in
   * tokens.css and recomputes the package's rung. That is not a bug to
   * fix (the `*` rule is what makes --density work at all); it is the
   * reason the base token has to exist.
   */
  var child = themedBy('--space-2xl: 3rem', '<span id="child">x</span>', null);
  var wrap = child.parentNode;

  assert.equal(rung(wrap, '--space-2xl'), 48, 'the declaration did not land on its own element');
  assert.equal(
    rung(child, '--space-2xl'), 16,
    'a directly-declared rung reached a descendant — the * rule in tokens.css has changed shape, ' +
    'and --density no longer follows a .dense region if so'
  );
  cleanup();
});

test('theming: density still multiplies a retuned base, and .dense still wins', function () {
  var deep = themedBy(
    '--space-2xl-base: 2rem; --density: 1.5',
    '<div><span id="deep">x</span></div>',
    '#deep'
  );
  assert.equal(rung(deep, '--space-2xl'), 48, 'density stopped multiplying the base');
  cleanup();

  var dense = themedBy(
    '--space-2xl-base: 2rem',
    '<div class="dense"><span id="deep">x</span></div>',
    '#deep'
  );
  assert.equal(rung(dense, '--space-2xl'), 25.6, '.dense no longer applies over a retuned ladder');
  cleanup();
});

/* ── FJS-159 — border weight ─────────────────────────────────────── */

var STRUCTURAL = [
  { name: '.card', html: '<article class="card">x</article>' },
  { name: '.tile', html: '<article class="tile">x</article>' },
  { name: '.field', html: '<input class="field">' },
  { name: '.table', html: '<table class="table"><tbody><tr><td>x</td></tr></tbody></table>' },
  { name: '.topbar', html: '<header class="topbar">x</header>', edge: 'borderBottomWidth' },
  { name: '.sidebar', html: '<nav class="sidebar">x</nav>', edge: 'borderRightWidth' },
  { name: '.code', html: '<pre class="code"><code>x</code></pre>' },
  { name: '.popover', html: '<div class="popover" popover>x</div>' },
  { name: '.disclosure', html: '<details class="disclosure"><summary>x</summary></details>' },
  { name: '.tablist', html: '<div class="tablist" role="tablist">x</div>', edge: 'borderBottomWidth' },
  { name: '.btn', html: '<button class="btn">x</button>' },
  { name: 'kbd', html: '<kbd>K</kbd>' },
];

STRUCTURAL.forEach(function (subject) {
  test('theming: --border-width reaches ' + subject.name, function () {
    var edge = subject.edge || 'borderTopWidth';

    var at1 = themedBy('', subject.html);
    assert.equal(px(getComputedStyle(at1)[edge]), 1, subject.name + ' does not start at the 1px default');
    cleanup();

    var at3 = themedBy('--border-width: 3px', subject.html);
    assert.equal(
      px(getComputedStyle(at3)[edge]), 3,
      subject.name + ' ignored --border-width — it is still a literal, so every theme is a 1px theme'
    );
    cleanup();
  });
});

test('theming: a heavy theme keeps the tab indicator above the strip it sits on', function () {
  /*
   * The one place where two of these widths have to stay related. The
   * indicator is drawn over the tablist's rule, so at 3px structural the
   * old literal 2px underline would have read as a GAP in the line on the
   * selected tab — the failure a single token would have introduced.
   */
  var strip = themedBy(
    '--border-width: 3px',
    '<div class="tabs"><div class="tablist" role="tablist">' +
    '<button class="tab" role="tab" aria-selected="true">One</button></div></div>',
    '.tablist'
  );
  var tab = strip.querySelector('.tab');

  var rule = px(getComputedStyle(strip).borderBottomWidth);
  var indicator = px(getComputedStyle(tab).borderBottomWidth);
  var bleed = px(getComputedStyle(tab).marginBottom);

  assert.ok(indicator > rule, 'the tab indicator (' + indicator + ') is not thicker than the strip (' + rule + ')');
  assert.equal(bleed, -rule, 'the tab bleeds ' + bleed + ' onto a ' + rule + ' rule');
  cleanup();
});

var GEOMETRY = [
  {
    name: 'the button spinner',
    html: '<button class="btn" aria-busy="true">x</button>',
    read: function (n) { return getComputedStyle(n, '::after').borderTopWidth; },
    at: 2,
  },
  {
    name: 'the tooltip arrow',
    html: '<span class="tooltip-anchor"><span class="tooltip">x</span></span>',
    read: function (n) { return getComputedStyle(n.querySelector('.tooltip'), '::after').borderTopWidth; },
    at: 4,
  },
  {
    name: 'the step marker',
    html: '<ol class="steps"><li class="step"><span class="step-marker">1</span></li></ol>',
    read: function (n) { return getComputedStyle(n.querySelector('.step-marker')).borderTopWidth; },
    at: 2,
  },
];

GEOMETRY.forEach(function (subject) {
  test('theming: --border-width does not scale ' + subject.name, function () {
    /*
     * These are drawn WITH the border property and are shapes, not
     * borders: a disc, an arrow, a ring that spins. Scaling them with the
     * theme's hairline distorts the shape instead of thickening a line,
     * which is why --border-width is deliberately not a blanket sweep of
     * every `border:` in the package.
     */
    var node = themedBy('--border-width: 4px', subject.html);
    assert.equal(
      px(subject.read(node)), subject.at,
      subject.name + ' scaled with --border-width — it is geometry, not a border'
    );
    cleanup();
  });
});

var STROKES = [
  {
    name: 'the step connector',
    html: '<ol class="steps"><li class="step">a</li><li class="step">b</li></ol>',
    read: function (n) { return getComputedStyle(n.children[1], '::before').blockSize; },
  },
  {
    name: 'the step marker',
    html: '<ol class="steps"><li class="step"><span class="step-marker">1</span></li></ol>',
    read: function (n) { return getComputedStyle(n.querySelector('.step-marker')).borderTopWidth; },
  },
  {
    name: 'the disclosure chevron',
    html: '<details class="disclosure"><summary class="disclosure-summary">x</summary></details>',
    read: function (n) { return getComputedStyle(n.querySelector('summary'), '::after').borderRightWidth; },
  },
  {
    name: 'the navlist chevron',
    html: '<details><summary class="navlist-label">x</summary></details>',
    read: function (n) { return getComputedStyle(n.querySelector('summary'), '::after').borderRightWidth; },
  },
  {
    name: 'the spinner',
    html: '<span class="spinner"></span>',
    read: function (n) { return getComputedStyle(n).borderTopWidth; },
  },
  {
    name: 'the button spinner',
    html: '<button class="btn" aria-busy="true">x</button>',
    read: function (n) { return getComputedStyle(n, '::after').borderTopWidth; },
  },
  {
    name: 'the changed-line rule',
    html: '<pre class="code"><code language="js"><ins>x</ins></code></pre>',
    read: function (n) { return getComputedStyle(n.querySelector('ins')).borderLeftWidth; },
  },
];

STROKES.forEach(function (subject) {
  test('theming: --stroke-width reaches ' + subject.name + ', and --border-width does not', function () {
    var at2 = themedBy('--border-width: 4px', subject.html);
    assert.equal(px(subject.read(at2)), 2, subject.name + ' is not a 2px stroke under a 4px hairline');
    cleanup();

    var at5 = themedBy('--stroke-width: 5px', subject.html);
    assert.equal(
      px(subject.read(at5)), 5,
      subject.name + ' ignored --stroke-width — it is still a literal, so press.css cannot reach it'
    );
    cleanup();
  });
});

['progress', 'meter'].forEach(function (tag) {
  test('theming: --track-size reaches .' + tag + ', and --stroke-width does not', function () {
    var html = '<' + tag + ' class="' + tag + '" value="1" max="2"></' + tag + '>';

    var at8 = themedBy('--stroke-width: 5px', html);
    assert.equal(px(getComputedStyle(at8).blockSize), 8, '.' + tag + ' moved with --stroke-width');
    cleanup();

    var at12 = themedBy('--track-size: 12px', html);
    assert.equal(px(getComputedStyle(at12).blockSize), 12, '.' + tag + ' ignored --track-size');
    cleanup();
  });
});

test('theming: a field and a table divider can diverge from the structural weight', function () {
  var field = themedBy('--border-width: 3px; --field-border-width: 1px', '<input class="field">');
  assert.equal(px(getComputedStyle(field).borderTopWidth), 1, '--field-border-width did not override');
  cleanup();

  var cell = themedBy(
    '--border-width: 3px; --table-border-width: 1px',
    '<table class="table"><tbody><tr><td>a</td></tr><tr><td id="second">b</td></tr></tbody></table>',
    '#second'
  );
  assert.equal(px(getComputedStyle(cell).borderTopWidth), 1, '--table-border-width did not reach the divider');
  cleanup();
});

/* ── FJS-160 — resting elevation ─────────────────────────────────── */

test('theming: a resting Card is flat by default and a theme can stamp it', function () {
  var flat = themedBy('', '<article class="card">x</article>');
  assert.equal(style(flat, 'box-shadow'), 'none', 'a resting card is no longer flat by default');
  cleanup();

  var stamped = themedBy('--surface-shadow: 3px 3px 0 rgb(0, 0, 0)', '<article class="card">x</article>');
  assert.ok(
    /3px 3px/.test(style(stamped, 'box-shadow')),
    'the Block tier ignored --surface-shadow, so a theme can shape every overlay shadow and no card'
  );
  cleanup();
});

test('theming: --surface-shadow reaches the Block tier and .raised is still the ladder', function () {
  var tile = themedBy('--surface-shadow: 3px 3px 0 rgb(0, 0, 0)', '<article class="tile">x</article>');
  assert.ok(/3px 3px/.test(style(tile, 'box-shadow')), 'a Tile ignored --surface-shadow');
  cleanup();

  /*
   * .raised is elevation, which --shadow-md already themes. It must keep
   * winning over the resting ground, or the variant stops meaning
   * anything in a theme that sets both.
   */
  var raised = themedBy(
    '--surface-shadow: 3px 3px 0 rgb(0, 0, 0); --shadow-md: 0px 8px 9px rgb(1, 2, 3)',
    '<article class="card raised">x</article>'
  );
  assert.ok(
    /8px 9px/.test(style(raised, 'box-shadow')),
    '.raised no longer beats the resting shadow — the elevation ladder is gone'
  );
  cleanup();
});

/* ── FJS-161 — the frame's own grounds ───────────────────────────── */

var GROUNDS = [
  /*
   * `.app` belongs on <body> and is measured on a <div>: innerHTML drops a
   * <body> tag entirely, so the subject would be the text node. The class
   * carries the ground either way, which is what is being asked.
   */
  { name: '.app', html: '<div class="app">x</div>', token: '--app-bg', fallback: '--surface-sunken' },
  { name: '.topbar', html: '<header class="topbar">x</header>', token: '--topbar-bg', fallback: '--surface' },
  { name: '.sidebar', html: '<nav class="sidebar">x</nav>', token: '--sidebar-bg', fallback: '--surface' },
  { name: '.dialog', html: '<div class="dialog">x</div>', token: '--dialog-bg', fallback: '--surface' },
  { name: '.drawer', html: '<div class="drawer">x</div>', token: '--dialog-bg', fallback: '--surface' },
  { name: '.toast', html: '<div class="toast">x</div>', token: '--toast-bg', fallback: '--surface' },
];

GROUNDS.forEach(function (subject) {
  test('theming: ' + subject.name + ' takes ' + subject.token + ' and defaults to ' + subject.fallback, function () {
    var plain = themedBy('', subject.html);
    assert.sameColor(
      style(plain, 'background-color'), style(plain, subject.fallback),
      subject.name + ' no longer falls back to ' + subject.fallback
    );
    cleanup();

    var themed_ = themedBy(subject.token + ': rgb(9, 8, 7)', subject.html);
    assert.sameColor(
      style(themed_, 'background-color'), 'rgb(9, 8, 7)',
      subject.name + ' ignored ' + subject.token + ', so the shell cannot be themed apart from the content'
    );
    cleanup();
  });
});

test('theming: --toast-bg does not break .outlined, and --toast-radius corners a toast apart from a card', function () {
  /* FJS-1948. A pill toast in a rounded-card theme needs its own corner. */
  var node = themedBy('--toast-bg: rgb(9, 8, 7)', '<div class="toast outlined">x</div>');
  assert.sameColor(style(node, 'background-color'), 'rgba(0, 0, 0, 0)', '.outlined lost to --toast-bg');
  cleanup();

  var plain = themedBy('--card-radius: 5px', '<div class="toast">x</div>');
  assert.equal(style(plain, 'border-top-left-radius'), '5px', 'a toast stopped following --card-radius');
  cleanup();

  var pill = themedBy('--card-radius: 5px; --toast-radius: 999px', '<div class="toast">x</div>');
  assert.equal(style(pill, 'border-top-left-radius'), '999px', 'a toast ignored --toast-radius');
  cleanup();
});

test('theming: --dialog-bg does not break .outlined on a dialog', function () {
  /*
   * Why the ground is assigned to --surface-ground and not to
   * --surface-bg. The treatments set --surface-bg in surface.css's base
   * layer; dialogs.css is a later layer, so writing the ground there
   * would beat .outlined and .ghost on every dialog — silently, since a
   * dialog with a background looks perfectly fine.
   */
  var node = themedBy('--dialog-bg: rgb(9, 8, 7)', '<div class="dialog outlined">x</div>');
  assert.sameColor(style(node, 'background-color'), 'rgba(0, 0, 0, 0)', '.outlined lost to --dialog-bg');
  cleanup();
});

test('theming: a dark Surface inside a Dialog or Drawer draws its own ground, not the dialog\'s', function () {
  /*
   * FJS-2635. The dialog sets --surface-ground on itself, the property
   * inherited, and .surface reads it before --surface, so the theme's own
   * --surface lost inside every overlay: white text on the dialog's white.
   */
  ['dialog', 'drawer'].forEach(function (host) {
    var node = themedBy(
      '--dialog-bg: rgb(250, 250, 250)',
      '<div class="' + host + '"><div class="surface theme-dark" id="in">x</div></div>',
      '#in'
    );
    assert.sameColor(style(node, 'background-color'), 'rgb(26, 26, 26)', 'a dark Surface in a .' + host + ' drew the overlay ground');
    cleanup();
  });
});

test('theming: a theme class on a region inverts the whole ramp, not just a ground', function () {
  /*
   * The documented answer to "dark shell, light content", and the reason
   * --sidebar-bg is not it: a ground is a background and carries no ink,
   * so a dark sidebar in a light app needs the ramp, which a theme class
   * already is. Pinned because frame.css tells people to write this.
   */
  var probe = themedBy('', '<nav class="sidebar theme-dark"><span id="label">x</span></nav>', '#label');
  var sidebar = probe.closest('.sidebar');

  var darkSurface = style(sidebar, '--surface');
  assert.sameColor(style(sidebar, 'background-color'), darkSurface, 'the region did not take the theme ground');
  assert.atLeast(
    contrast(style(probe, '--ink'), darkSurface), 4.5,
    'the ink ramp did not travel with the theme class — a region theme is not a theme'
  );
  cleanup();
});

/*
 * Every declaration of `prop` on a rule that MATCHES this node.
 *
 * Read off the rules rather than off the node, because `test/run.js` turns
 * every transition off globally with an unlayered `!important` — so
 * `getComputedStyle(node).transitionDuration` reads as the harness and a
 * motion assertion would be measuring the test setup. The package's own notes
 * record the same trap for post-click styles.
 *
 * `allSelectors()` resolves nesting so a selector can be handed to matches();
 * the rules come back in the same order, which is what pairs them.
 */
function matchedDeclarations(node, prop, pseudo) {
  var rules = allRules();
  var sels  = allSelectors();
  var out   = [];
  var at    = 0;

  for (var i = 0; i < rules.length; i++) {
    var r = rules[i];
    if (!(window.CSSStyleRule && r instanceof CSSStyleRule)) continue;

    var sel = sels[at++];
    if (!sel) continue;

    /* A pseudo-element selector cannot be matched, so it is stripped and the
       element is asked instead — `.btn[aria-busy="true"]::after` is a claim about the
       button, spelled as one about its pseudo. */
    var target = pseudo ? sel.split(pseudo)[0] : sel;
    if (pseudo && target === sel) continue;

    var ok = false;
    try { ok = node.matches(target); } catch (e) { ok = false; }
    if (!ok) continue;

    var v = r.style.getPropertyValue(prop);
    if (v) out.push(v.trim());
  }

  return out;
}

/* ── FJS-162 — motion ────────────────────────────────────────────── */

var MOVERS = [
  { name: '.btn', html: '<button class="btn">Save</button>', token: '--motion-base' },
  { name: '.field', html: '<input class="field">', token: '--motion-fast' },
  { name: '.card', html: '<article class="card">x</article>', token: '--motion-fast' },
  { name: '.tab', html: '<div class="tablist"><button class="tab">One</button></div>', token: '--motion-fast', find: '.tab' },
  { name: '.navlink', html: '<nav class="navlist"><a class="navlink" href="#">Home</a></nav>', token: '--motion-fast', find: '.navlink' },
  { name: '.switch', html: '<input type="checkbox" class="switch">', token: '--motion-base' },
  { name: '.progress', html: '<progress class="progress" value="70" max="100">70%</progress>', token: '--motion-slow', pseudo: '::-webkit-progress-value' },
  { name: '.tooltip', html: '<span class="tooltip-anchor"><span class="tooltip">x</span></span>', token: '--motion-fast', find: '.tooltip' },
  { name: '.step-marker', html: '<ol class="steps"><li class="step"><span class="step-marker">1</span></li></ol>', token: '--motion-fast', find: '.step-marker' },
];

MOVERS.forEach(function (subject) {
  test('theming: ' + subject.name + ' takes its duration from ' + subject.token, function () {
    /*
     * Every transition in the package was a literal, so nine themes moved
     * identically and a house style wanting no motion had nowhere to say so.
     *
     * Asked of the RULE and as a reference rather than as a resolved
     * duration, which is a limit of the harness rather than a weaker claim:
     * `test/run.js` turns every transition off with an unlayered
     * `!important`, and an inline `!important` — the only thing that beats it
     * — would be the test writing the value it then measures. What is
     * checkable here is the thing that was actually wrong: whether the
     * duration is a literal or the token.
     */
    var node = themedBy('', subject.html, subject.find || null);
    var seen = matchedDeclarations(node, 'transition', subject.pseudo);

    assert.ok(
      seen.some(function (v) { return v.indexOf(subject.token) !== -1; }),
      subject.name + ' does not read ' + subject.token + ' — it is still a literal, so a theme cannot ' +
        'say whether this product feels quick or considered.\n        saw: ' + (seen.join(' | ') || '(nothing)')
    );
    cleanup();
  });
});

function inReducedMotion(rule) {
  for (var r = rule.parentRule; r; r = r.parentRule) {
    if (window.CSSMediaRule && r instanceof CSSMediaRule &&
        (r.conditionText || r.media.mediaText || '').indexOf('prefers-reduced-motion') !== -1) return true;
  }
  return false;
}

test('theming: no transition in the package states a literal duration', function () {
  /*
   * The list above names what exists today; this is the one that fails when
   * something NEW arrives with 120ms typed into it. A literal is invisible —
   * it looks exactly like a token from the outside and only stops moving with
   * the theme.
   */
  var bad = [];

  allRules().forEach(function (r) {
    if (!(window.CSSStyleRule && r instanceof CSSStyleRule)) return;

    /*
     * Two exclusions, and both are the point rather than housekeeping.
     *
     * `prefers-reduced-motion` is the READER's setting, not the design's:
     * tokens.css crushes every duration to 0.01ms there and then hands the
     * spinner back a slower 1.6s, and a theme must not be able to move
     * either. A literal is correct inside that query.
     *
     * The harness's own `transition: none !important` lives in an inline
     * <style>, which is the only stylesheet on this page with no href —
     * every package sheet is @imported from index.css.
     */
    if (inReducedMotion(r)) return;
    if (r.parentStyleSheet && !r.parentStyleSheet.href) return;

    ['transition', 'transition-duration', 'animation', 'animation-duration'].forEach(function (prop) {
      var v = r.style.getPropertyValue(prop);
      if (v && /[0-9.]+m?s/.test(v) && v.indexOf('var(--motion') === -1 &&
          v.indexOf('var(--overlay-time') === -1) {
        bad.push(r.selectorText + '  {' + prop + ': ' + v.trim() + '}');
      }
    });
  });

  assert.equal(bad.length, 0, bad.length + ' literal duration(s):\n        ' + bad.join('\n        '));
});

test('theming: an overlay reads the ladder without being aliased at :root', function () {
  /*
   * `--overlay-time: var(--motion-enter)` at :root resolves ONCE, against
   * :root's own value, and inherits the result past every .theme-* — so a
   * theme retuning the ladder would move everything except the overlays.
   * The alias lives in the fallback arm at each use site instead, which is
   * only observable from a descendant of the element carrying the token.
   */
  var dialog = themedBy('', '<div><dialog class="dialog" open>x</dialog></div>', '.dialog');
  var seen = matchedDeclarations(dialog, 'transition');

  assert.ok(
    seen.some(function (v) { return v.indexOf('var(--overlay-time, var(--motion-enter))') !== -1; }),
    'the overlay tier does not read the ladder at its use site\n        saw: ' + (seen.join(' | ') || '(nothing)')
  );
  cleanup();
});

test('theming: the spinner keeps a linear timing function', function () {
  /*
   * --motion-spin is a duration and its easing is deliberately not a
   * token: a spinner that eases reads as broken hardware rather than as a
   * slower spinner.
   */
  /*
   * Measured rather than read, because `test/run.js` leaves ANIMATIONS alone
   * — only transitions are crushed — so the pseudo-element's computed style
   * is the real answer here.
   */
  var node = themedBy('--motion-spin: 42ms', '<button class="btn" aria-busy="true">Save</button>');
  var after = getComputedStyle(node, '::after');

  assert.equal(after.animationDuration, '0.042s', 'the spinner ignored --motion-spin');
  assert.equal(after.animationTimingFunction, 'linear', 'the spinner is no longer linear');
  cleanup();
});

/* ── FJS-163 — typography treatment ──────────────────────────────── */

var LABELS = [
  { name: '.table th', html: '<table class="table"><thead><tr><th>Name</th></tr></thead></table>', find: 'th' },
  { name: '.tile-label', html: '<article class="tile"><div class="tile-label">Revenue</div></article>', find: '.tile-label' },
  { name: '.navlist-label', html: '<nav class="navlist"><div class="navlist-label">Section</div></nav>', find: '.navlist-label' },
];

LABELS.forEach(function (subject) {
  test('theming: ' + subject.name + ' reads the shared label triple', function () {
    /*
     * A table head, a tile's label and a nav group's heading are one
     * typographic role and had three undocumented answers to it —
     * 600/0.04em, 500/0.04em, 700/0.06em — none reachable from a theme.
     * So a theme could stamp its buttons uppercase and could not touch the
     * three places a house voice shows next.
     */
    var node = themedBy(
      '--label-font-weight: 300; --label-text-transform: lowercase; --label-letter-spacing: 0.5em',
      subject.html,
      subject.find
    );

    assert.equal(style(node, 'font-weight'), '300', subject.name + ' ignored --label-font-weight');
    assert.equal(style(node, 'text-transform'), 'lowercase', subject.name + ' ignored --label-text-transform');
    assert.ok(
      parseFloat(style(node, 'letter-spacing')) > 3,
      subject.name + ' ignored --label-letter-spacing'
    );
    cleanup();
  });
});

test('theming: the three labels agree when nothing is set', function () {
  /*
   * The point of unifying them: one role, one answer. Three different
   * weights for the same small-caps label was the defect, not a
   * constraint to preserve behind three escape tokens.
   */
  /*
   * Weight and transform only. The tracking token is an em and the three sit
   * at three type rungs, so they resolve to three pixel values from one
   * declaration — which is what an em is for, not a disagreement.
   */
  var seen = LABELS.map(function (subject) {
    var node = themedBy('', subject.html, subject.find);
    var read = [style(node, 'font-weight'), style(node, 'text-transform')].join(' ');
    cleanup();
    return subject.name + ' → ' + read;
  });

  var answers = new Set(seen.map(function (s) { return s.split(' → ')[1]; }));
  assert.equal(answers.size, 1, 'one role, ' + answers.size + ' answers:\n        ' + seen.join('\n        '));
});

test('theming: --tab-font-weight moves a tab and defaults to 600', function () {
  /*
   * FJS-2689: a tab's weight was a literal 600, so a theme whose tabs are
   * regular weight had no token to say so.
   */
  var html = '<div class="tablist" role="tablist"><button class="tab" role="tab">One</button></div>';
  var plain = themedBy('', html, '.tab');
  assert.equal(style(plain, 'font-weight'), '600', 'the default tab weight moved');
  cleanup();

  var themed_ = themedBy('--tab-font-weight: 400', html, '.tab');
  assert.equal(style(themed_, 'font-weight'), '400', '--tab-font-weight did not reach .tab');
  cleanup();
});

test('theming: --heading-font-weight moves all six and is unset by default', function () {
  /*
   * The SIZE ladder was themable through --text-* and the treatment was
   * not, so a theme could restate the whole scale and still not say
   * whether its headings are heavy. Written as the fallback arm, exactly
   * like --heading-letter-spacing, so unset keeps 700/600.
   */
  var plain = themedBy('', '<div><h1>One</h1><h3>Three</h3></div>');
  assert.equal(style(plain.querySelector('h1'), 'font-weight'), '700', 'h1 no longer defaults to 700');
  assert.equal(style(plain.querySelector('h3'), 'font-weight'), '600', 'h3 no longer defaults to 600');
  cleanup();

  var themed_ = themedBy('--heading-font-weight: 400', '<div><h1>One</h1><h3>Three</h3></div>');
  assert.equal(style(themed_.querySelector('h1'), 'font-weight'), '400', '--heading-font-weight did not reach h1');
  assert.equal(style(themed_.querySelector('h3'), 'font-weight'), '400', '--heading-font-weight did not reach h3');
  cleanup();
});

test('theming: --h1-size … --h6-size size a heading without moving .text-*', function () {
  /*
   * FJS-2705. h1–h6 read the shared --text-* ladder, so a theme wanting a
   * 22px h1 over a 15px body had to retune --text-4xl and drag every
   * .text-4xl with it. The fallback arm keeps the ladder when unset.
   */
  var html = '<div><h1>One</h1><h5>Five</h5><span class="text-lg">Big</span></div>';
  var plain = themedBy('--text-4xl: 40px', html);
  assert.equal(style(plain.querySelector('h1'), 'font-size'), '40px', 'unset, h1 no longer follows --text-4xl');
  cleanup();

  var themed_ = themedBy('--h1-size: 22px; --h5-size: 11px; --text-lg: 17px', html);
  assert.equal(style(themed_.querySelector('h1'), 'font-size'), '22px', '--h1-size did not reach h1');
  assert.equal(style(themed_.querySelector('h5'), 'font-size'), '11px', '--h5-size did not reach h5');
  assert.equal(style(themed_.querySelector('.text-lg'), 'font-size'), '17px', '--h5-size moved the .text-lg utility');
  cleanup();
});

test('theming: --h1-ink … --h6-ink give a heading level its own ink and leave --ink alone', function () {
  /*
   * FJS-2704. Every level read --ink, so a theme whose h1/h2, h3/h4 and
   * body text are three different greys had no way to say so. The
   * fallback arm keeps --ink when unset.
   */
  var html = '<div><h1>One</h1><h3>Three</h3><h4>Four</h4></div>';
  var plain = themedBy('--ink: rgb(10, 20, 30)', html);
  assert.equal(style(plain.querySelector('h1'), 'color'), 'rgb(10, 20, 30)', 'unset, h1 no longer follows --ink');
  cleanup();

  var themed_ = themedBy('--ink: rgb(10, 20, 30); --h1-ink: rgb(1, 2, 3); --h3-ink: rgb(4, 5, 6)', html);
  assert.equal(style(themed_.querySelector('h1'), 'color'), 'rgb(1, 2, 3)', '--h1-ink did not reach h1');
  assert.equal(style(themed_.querySelector('h3'), 'color'), 'rgb(4, 5, 6)', '--h3-ink did not reach h3');
  assert.equal(style(themed_.querySelector('h4'), 'color'), 'rgb(10, 20, 30)', '--h3-ink moved h4');
  cleanup();
});

/* ── FJS-164 — the focus ring's style ────────────────────────────── */

test('theming: --ring-style restyles the ring', function () {
  var node = themedBy('--ring-style: dashed', '<button class="btn">Save</button>');
  node.focus();
  assert.equal(style(node, 'outline-style'), 'dashed', 'the ring style is still a literal');
  cleanup();
});

test('theming: a theme cannot turn the ring off, and the list is what enforces it', function () {
  /*
   * The counter-argument in FJS-164 is real: the ring is an accessibility
   * guarantee in the last layer, and a token a theme can write is a token
   * a theme can weaken. @property is what makes "a keyword from a fixed
   * list" enforceable rather than advisory — a value outside the syntax is
   * invalid at computed-value time and falls back to the initial value.
   *
   * So `none` does not disable the ring, it draws a solid one. There is
   * deliberately no spelling of "off".
   */
  ['none', 'hidden', 'dotted', 'nonsense'].forEach(function (attempt) {
    var node = themedBy('--ring-style: ' + attempt, '<button class="btn">Save</button>');
    node.focus();
    assert.equal(
      style(node, 'outline-style'), 'solid',
      '--ring-style: ' + attempt + ' was accepted — the ring can now be weakened from a theme'
    );
    assert.notEqual(style(node, 'outline-width'), '0px', 'the ring has no width after --ring-style: ' + attempt);
    cleanup();
  });
});

/* ── FJS-1946 — the current navlink's own fill ───────────────────── */

test('theming: --navlink-current-bg and --navlink-current-ink draw the current navlink apart from the tint', function () {
  var html = '<ul class="navlist"><li><a class="navlink" href="#a" aria-current="page">x</a></li></ul>';

  var plain = themedBy('', html, '.navlink');
  var tinted = style(plain, 'background-color');
  assert.ok(tinted !== 'rgba(0, 0, 0, 0)', 'the current navlink lost its default tint');
  cleanup();

  var solid = themedBy('--navlink-current-bg: rgb(9, 8, 7); --navlink-current-ink: rgb(250, 249, 248)', html, '.navlink');
  assert.sameColor(style(solid, 'background-color'), 'rgb(9, 8, 7)', 'the current navlink ignored --navlink-current-bg');
  assert.sameColor(style(solid, 'color'), 'rgb(250, 249, 248)', 'the current navlink ignored --navlink-current-ink');
  cleanup();

  /* The fill alone must not strand the label on the primary ink. */
  var fillOnly = themedBy('--navlink-current-bg: rgb(9, 8, 7)', html, '.navlink');
  assert.sameColor(style(fillOnly, 'background-color'), 'rgb(9, 8, 7)', 'a fill without an ink was dropped');
  cleanup();
});
