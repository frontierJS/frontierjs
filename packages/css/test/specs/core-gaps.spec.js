/*
 * core-gaps.spec.js — the things the demo app had to write for itself,
 * now in the package.
 *
 * Every test here corresponds to a rule that used to live in
 * demo/demo.css. That file is the measurement: anything in it is
 * something a real consumer has to hand-write, and the ones worth moving
 * moved in v0.10. These tests are what stops them drifting back out.
 */

var THEMES = ['default', 'sunset', 'forest', 'midnight', 'dark', 'elite', 'basecamp'];

/* ── Icon ────────────────────────────────────────────────────────────
 *
 * An unsized <svg> defaults to 300x150, so an icon the package fails to
 * size does not look slightly wrong — it destroys the layout it is in.
 * That is why these assert a real box, not just a declaration.
 */

var SVG = '<svg viewBox="0 0 24 24"><path d="M4 4h16v16H4z"/></svg>';

/* Every component that holds an icon. Adding one means adding it here. */
var ICON_CONTEXTS = [
  { name: '.btn', html: '<button class="btn">Save ' + SVG + '</button>' },
  { name: '.btn.square', html: '<button class="btn square" aria-label="Delete">' + SVG + '</button>' },
  { name: '.navlink', html: '<ul class="navlist"><li><a class="navlink" href="#x">' + SVG + ' Dashboard</a></li></ul>' },
  { name: '.alert-icon', html: '<article class="alert info"><span class="alert-icon">' + SVG + '</span><div class="alert-content">Hi</div></article>' },
  { name: '.field-addon', html: '<div class="field-row"><span class="field-addon">' + SVG + '</span><input class="field"></div>' },
  { name: '.page', html: '<nav class="pagination"><a class="page" href="#x" aria-label="Next">' + SVG + '</a></nav>' },
  { name: '.tab', html: '<div class="tablist" role="tablist"><button class="tab" role="tab" aria-selected="true">' + SVG + ' One</button></div>' },
  { name: '.pill-close', html: '<span class="pill removable">tag<button class="pill-close" aria-label="Remove">' + SVG + '</button></span>' },
  { name: '.empty-icon', html: '<div class="empty"><div class="empty-icon">' + SVG + '</div></div>' },
  { name: '.list-row', html: '<ul class="rows"><li class="list-row">' + SVG + ' Acme</li></ul>' },
  { name: '.link', html: '<a class="link" href="#x">' + SVG + ' Read</a>' },
];

ICON_CONTEXTS.forEach(function (ctx) {
  test('icon: an svg inside ' + ctx.name + ' is sized', function () {
    var icon = el(ctx.html, 'svg');
    var box = icon.getBoundingClientRect();

    /*
     * The failure mode is 300x150, not zero — so assert an upper bound.
     * Anything above ~40px here means the icon is unsized and the layout
     * around it is already wrong.
     */
    assert.ok(
      box.width > 0 && box.width < 40,
      'an svg in ' + ctx.name + ' rendered ' + Math.round(box.width) + 'x' + Math.round(box.height) +
        ' — it is unsized (an unsized <svg> defaults to 300x150)'
    );
    assert.ok(Math.abs(box.width - box.height) < 1, 'the icon is not square in ' + ctx.name);
  });
});

test('icon: the i-heroicons naming is sized too', function () {
  /*
   * The package ships no icons; it sizes what it finds. `i-heroicons:*` is
   * what Uno's preset-icons produces and what the docs tell consumers to
   * write, so both the `^=` and the `*=" "` forms have to match — a
   * multi-class icon is the common case and feedback.css used to miss it.
   */
  var first = el('<button class="btn square" aria-label="x"><span class="i-heroicons:check"></span></button>', 'span');
  assert.ok(parseFloat(style(first, 'inline-size')) < 40, 'i-heroicons as the first class was not sized');
  cleanup();

  var later = el('<button class="btn square" aria-label="x"><span class="shrink-0 i-heroicons:check"></span></button>', 'span');
  assert.ok(
    parseFloat(style(later, 'inline-size')) < 40,
    'i-heroicons as a later class was not sized — the [class*=" …"] branch is missing'
  );
});

test('icon: .icon works somewhere the package has never heard of', function () {
  /*
   * The context list covers the components the package owns. `.icon` is
   * the Icon vocabulary term proper, and the escape hatch for everywhere
   * else — a paragraph, a consumer's own component, a table cell.
   */
  var loose = el('<p>Status: <svg class="icon" viewBox="0 0 24 24"><path d="M4 4h16v16H4z"/></svg> ok</p>', 'svg');
  var box = loose.getBoundingClientRect();
  assert.ok(box.width > 0 && box.width < 40, '.icon did not size a loose svg');
});

test('icon: an unsized svg outside any context really is broken', function () {
  /*
   * The control. If this ever starts passing, the rule has become a blanket
   * `svg { … }` and is now sizing charts, logos and illustrations too.
   */
  var loose = el('<p><svg viewBox="0 0 24 24"><path d="M4 4h16v16H4z"/></svg></p>', 'svg');
  assert.ok(
    loose.getBoundingClientRect().width > 100,
    'every svg on the page is being sized, including ones that are not icons'
  );
});

test('icon: a component varies size through --icon-size, not a new rule', function () {
  var inBtn = el('<button class="btn square" aria-label="x">' + SVG + '</button>', 'svg');
  var btnSize = inBtn.getBoundingClientRect().width;
  cleanup();

  var inPill = el('<span class="pill removable">t<button class="pill-close" aria-label="x">' + SVG + '</button></span>', 'svg');
  assert.ok(
    inPill.getBoundingClientRect().width < btnSize,
    '.pill-close should carry a smaller --icon-size than .btn'
  );
});

test('icon: --icon-size overrides per instance', function () {
  var big = el('<button class="btn square" aria-label="x" style="--icon-size: 2rem">' + SVG + '</button>', 'svg');
  assert.equal(Math.round(big.getBoundingClientRect().width), 32, '--icon-size was ignored');
});

test('icon: sizing is in em, so it tracks its text', function () {
  var small = el('<span class="link" style="font-size: 10px">' + SVG + '</span>', 'svg');
  var smallW = small.getBoundingClientRect().width;
  cleanup();

  var big = el('<span class="link" style="font-size: 30px">' + SVG + '</span>', 'svg');
  assert.ok(
    big.getBoundingClientRect().width > smallW * 2,
    'icon size does not scale with font-size — --icon-size is not in em'
  );
});

test('icon: .btn.square is the icon-only button', function () {
  var sq = el('<button class="btn square" aria-label="Delete">' + SVG + '</button>');
  var box = sq.getBoundingClientRect();
  assert.ok(Math.abs(box.width - box.height) < 1, '.btn.square is not square');
  assert.ok(box.width > 24, '.btn.square collapsed — it should be a button, not an icon');
});

test('icon: the old .btn.icon markup no longer gets the square treatment', function () {
  /*
   * The migration signal, and it is quieter than you would want.
   *
   * `.icon` now means "this element IS an icon", so it cannot also mean
   * "a button shaped to hold one" — v0.10 renamed the modifier to
   * `.square`. Leftover `<button class="btn icon">` does get hit by the
   * icon sizing, but it does NOT collapse into a dot: with border-box, a
   * width below padding+border clamps to padding+border, so the button
   * floors at 30x30 with a zero-width content box and the icon overflowing
   * it.
   *
   * The result looks approximately like an icon button and is subtly
   * wrong — no aspect-ratio, no padding control, content overflowing. So
   * the thing to assert is the real regression: it is no longer the
   * square-button recipe.
   */
  var old = el('<button class="btn icon" aria-label="Delete">' + SVG + '</button>');
  assert.equal(
    style(old, 'aspect-ratio'),
    'auto',
    '.btn.icon still applies the square-button recipe — the rename has been undone'
  );

  var square = el('<button class="btn square" aria-label="Delete">' + SVG + '</button>');
  /* Chrome serialises `aspect-ratio: 1` as "1 / 1". */
  assert.equal(style(square, 'aspect-ratio'), '1 / 1', '.btn.square lost the square recipe');
});

/* ── Text sizes ──────────────────────────────────────────────────────*/

test('text: the size scale exists and is monotonic', function () {
  /*
   * Principle 3 promises "visual size via utility classes". .h1-.h6 were
   * half of it; the demo hand-wrote `font-size: .8125rem` fourteen times
   * before this landed.
   */
  var steps = ['text-xs', 'text-sm', 'text-md', 'text-lg', 'text-xl'];
  var last = 0;
  steps.forEach(function (cls) {
    var p = el('<p class="' + cls + '">Text</p>');
    var size = parseFloat(style(p, 'font-size'));
    assert.ok(size > 0, '.' + cls + ' sets no font-size');
    assert.ok(size > last, '.' + cls + ' is not larger than the step below it');
    last = size;
    cleanup();
  });
});

test('text: size and colour utilities chain', function () {
  /*
   * They are separate axes on purpose — `.text-sm` is a size, `.text-muted`
   * is a colour, and the demo needed both together on every meta line.
   */
  var both = el('<p class="text-sm text-muted">2 hours ago</p>');
  var sizeOnly = el('<p class="text-sm">2 hours ago</p>');
  var colourOnly = el('<p class="text-muted">2 hours ago</p>');

  assert.equal(style(both, 'font-size'), style(sizeOnly, 'font-size'), 'the colour class changed the size');
  assert.sameColor(style(both, 'color'), style(colourOnly, 'color'), 'the size class changed the colour');
});

test('text: the small steps still clear AA on every theme', function () {
  /*
   * A size scale that bottoms out below the readable threshold is not a
   * favour. --ink-mute at .text-xs is the tightest real pairing in the
   * package, and it is exactly what a meta line uses.
   */
  var failures = [];
  THEMES.forEach(function (theme) {
    var p = themed(theme, '<p class="text-xs text-muted">2 hours ago</p>');
    var probe = themed(theme, '<div>x</div>');
    var bg = getComputedStyle(probe).getPropertyValue('--surface').trim();
    var ratio = contrast(style(p, 'color'), bg);
    if (ratio < 4.5) failures.push('theme-' + theme + '  ' + ratio.toFixed(2) + ':1');
    cleanup();
  });
  assert.equal(failures.length, 0, 'muted small text below AA:\n        ' + failures.join('\n        '));
});

/* ── Field width ─────────────────────────────────────────────────────*/

test('field: defaults to full width, and --field-inline-size overrides it', function () {
  var wrap = el('<div style="inline-size: 400px"><input class="field"></div>', '.field');
  assert.equal(Math.round(wrap.getBoundingClientRect().width), 400, '.field is not full width by default');
  cleanup();

  var auto = el('<div style="inline-size: 400px"><select class="field" style="--field-inline-size: auto"><option>Any</option></select></div>', '.field');
  assert.ok(
    auto.getBoundingClientRect().width < 400,
    '--field-inline-size: auto did not shrink the control to its content'
  );
});

/* ── Sidebar toggle ──────────────────────────────────────────────────*/

test('frame: the sidebar toggle is hidden at desktop width', function () {
  /*
   * frame.css hides the Sidebar below md and hands its contents to a
   * drawer — which needs a trigger, which has to be hidden above md. The
   * package created that need and had no way to express it, so the demo
   * wrote the media query by hand.
   *
   * The test page is wide, so this is the desktop case.
   */
  assert.ok(window.innerWidth >= 768, 'this assertion assumes a viewport at or above md');
  var btn = el('<button class="btn ghost square sidebar-toggle" aria-label="Open navigation"></button>');
  assert.equal(style(btn, 'display'), 'none', 'the sidebar toggle is showing next to a visible sidebar');
});

test('frame: the toggle does not hardcode a display value', function () {
  /*
   * The narrow-viewport rule uses `revert`, so the control keeps whatever
   * display its own classes give it. Asserted structurally, since the test
   * viewport cannot be resized.
   */
  var found = allRules().some(function (rule) {
    return window.CSSStyleRule && rule instanceof CSSStyleRule &&
      /\.sidebar-toggle/.test(rule.selectorText || '') &&
      /revert/.test(rule.cssText || '');
  });
  assert.ok(found, 'the sidebar toggle re-shows with a hardcoded display instead of revert');
});
