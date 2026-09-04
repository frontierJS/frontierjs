/*
 * core-gaps.spec.js — the things the demo app had to write for itself,
 * now in the package.
 *
 * Every test here corresponds to a rule that used to live in
 * demo/demo.css. That file is the measurement: anything in it is
 * something a real consumer has to hand-write, and the ones worth moving
 * moved in v0.10. These tests are what stops them drifting back out.
 */

var THEMES = ['default', 'sunset', 'forest', 'midnight', 'dark', 'elite', 'basecamp', 'field'];

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
  { name: '.pagination-link', html: '<nav class="pagination"><a class="pagination-link" href="#x" aria-label="Next">' + SVG + '</a></nav>' },
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
   * favor. --ink-mute at .text-xs is the tightest real pairing in the
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

/* ── The reset ─────────────────────────────────────────────────────── */

/*
 * foundation/reset.css is one rule, and both halves of it are load-bearing
 * in opposite directions — which is exactly the shape that rots quietly.
 *
 * The package is not classless and has always refused to style a host app's
 * un-classed markup. A reset is the one place that rule bends, so the bend
 * is held here: a link that has been given a component class loses the UA
 * underline, and a bare one in a paragraph keeps it.
 */

test('reset: a link carrying a component class is not underlined', function () {
  /*
   * chip.css already did this for the inline lineage — added after the
   * Sierra example rendered every `<a class="btn">` with a line through its
   * label — and the surface lineage never got it, so `<a class="card">`
   * shipped underlined and each consumer wrote the reset by hand.
   */
  ['card', 'tile', 'list-row', 'item', 'btn', 'surface'].forEach(function (cls) {
    var a = el('<a class="' + cls + '" href="#x">Go</a>');
    assert.equal(
      style(a, 'text-decoration-line'),
      'none',
      '<a class="' + cls + '"> is underlined by the UA default'
    );
  });
});

test('reset: a bare link in prose keeps its underline', function () {
  /*
   * The half a wider selector would break. `text-decoration: none` on `a`
   * or on `*` would strip the underline from prose links too, and colour
   * alone is not an accessible link affordance — so the reset is scoped to
   * `a:where([class])` and this is what says so.
   */
  var a = el('<p>text <a href="#x">a link</a> more</p>', 'a');
  assert.equal(
    style(a, 'text-decoration-line'),
    'underline',
    'the reset stripped the underline from an un-classed link — colour alone is not an affordance'
  );
});

test('reset: the Link term still underlines on hover', function () {
  /*
   * `.link` is the Inline tier and turns the underline back on for :hover.
   * The reset must not outrank it — it is in the first layer for that
   * reason. Read the RULE rather than hovering: computed style goes stale
   * after a state change in this harness.
   */
  var found = allSelectors().filter(function (sel) {
    return sel.replace(/\s+/g, '') === '.link:hover';
  });
  assert.ok(found.length > 0, '.link:hover is gone — a Link no longer signals itself on hover');
});

/* ── A Surface that navigates ──────────────────────────────────────── */

/*
 * `<a class="card">` and `<button class="tile">` — a card that opens a
 * detail view, a stat tile that drills into a report. surface.css gives
 * them a hover; these hold the four things that were wrong on the way to
 * writing it, each of which rendered plausibly.
 *
 * Read the RULES rather than hovering: computed style goes stale after a
 * state change in this harness, and :hover cannot be forced at all.
 */

function hoverRule() {
  var found = null;
  allRules().forEach(function (rule) {
    if (!(window.CSSStyleRule && rule instanceof CSSStyleRule)) return;
    var sel = (rule.selectorText || '').replace(/\s+/g, '');
    if (sel.indexOf(':where(a,button)') === 0 && sel.indexOf(':hover') !== -1) found = rule;
  });
  return found;
}

test('surface: only an <a> or <button> gets the interactive state', function () {
  /*
   * The reason it keys on the element instead of a `.hover` class. An <li>
   * or a bare <article> is not focusable and not operable by keyboard, so
   * an unconditional hover would advertise an interaction the markup
   * cannot deliver — the argument lists.css makes for `.items.menu`. An
   * <a href> IS the interaction, so the affordance cannot be attached to
   * something that does not have it, or forgotten on something that does.
   */
  var sel = ':where(a, button):where(.surface, .card, .tile)';
  assert.ok(el('<a class="card" href="#x">Go</a>').matches(sel), 'a card link is not interactive');
  assert.ok(el('<button class="tile">Go</button>').matches(sel), 'a tile button is not interactive');
  assert.ok(!el('<article class="card">Static</article>').matches(sel), 'a plain card became interactive');
  assert.ok(!el('<a class="alert" href="#x">Note</a>').matches(sel),
    'an Alert is not a navigation target — it should not carry the state');
});

test('surface: the hover does not fill the background', function () {
  /*
   * The first version moved --surface-bg to --surface-raised. Wrong twice,
   * both measured: in the default theme --surface-raised IS --surface
   * (#ffffff), so the hover did nothing at all and the affordance existed
   * only in the themes that separate them; and `.outlined` is defined by
   * `--surface-bg: transparent`, so filling it erased the variant — an
   * outlined card turned solid white under the pointer.
   */
  var rule = hoverRule();
  assert.ok(rule, 'the interactive-surface hover rule is gone');
  assert.equal(
    rule.style.getPropertyValue('--surface-bg').trim(),
    '',
    'the hover sets --surface-bg, which erases .outlined and .ghost'
  );
});

test('surface: the hover border is mixed, so a toned card still responds', function () {
  /*
   * The other near-miss. Written as `var(--surface-tint-border, <brand>)`
   * the fallback fires only when the tint is guaranteed-invalid — never on
   * a toned card — so `.card.danger` hovered to exactly the red it already
   * had and got no feedback but the 1px lift. A mix moves whichever border
   * the card actually has, so both cases change: measured, untoned goes
   * brand-blue and danger goes a deeper red.
   */
  var rule = hoverRule();
  var border = rule.style.getPropertyValue('--surface-border');
  assert.ok(
    border.indexOf('color-mix') !== -1,
    'the hover border is not a mix — a toned card will hover to its own resting colour'
  );
  assert.ok(
    border.indexOf('--bg-mix') !== -1,
    'the hover border ignores --bg-mix, so it cannot follow the tone'
  );
});

test('surface: the lift is behind (hover: hover)', function () {
  /*
   * Without the query a tap leaves the card lifted until something else is
   * touched, which reads as a stuck selection rather than a press.
   */
  var rule = hoverRule();
  var media = rule.parentRule;
  assert.ok(
    media && media.media && /hover/.test(media.media.mediaText),
    'the hover state is not inside a (hover: hover) query — it will stick after a tap'
  );
});

/* ── Prose ─────────────────────────────────────────────────────────── */

test('prose: a bare <p> is untouched outside a Prose', function () {
  /*
   * The position the package states twice — it styles no bare `p` and is
   * not classless. Prose is a scoped exception, so the exception has to be
   * scoped: a paragraph in a host app that never opted in must be whatever
   * that app says it is.
   */
  var loose = el('<div><p>a</p></div>');
  var para = loose.querySelector('p');

  assert.equal(
    style(para, 'max-inline-size'),
    'none',
    'a <p> outside a Prose got a measure — the term is not scoped'
  );
});

test('prose: a Prose sets measure and ink on the region', function () {
  var box = el('<div class="prose"><p>a</p></div>');

  assert.ok(
    parseFloat(style(box, 'max-inline-size')) > 0,
    'a Prose has no measure'
  );
  /*
   * On the Prose, not on each child. Two blocks that set their own wrap at
   * different columns, which shows as a ragged edge between a paragraph and
   * the list under it.
   */
  assert.equal(
    style(box.querySelector('p'), 'max-inline-size'),
    'none',
    'the measure is on the paragraph — it belongs on the region'
  );
  /*
   * Against the token, not a literal — the ramp is themed and a hardcoded
   * rgb() here would fail on every theme but the default.
   */
  var soft = el('<p style="color: var(--ink-soft)">a</p>');
  assert.equal(style(box, 'color'), style(soft, 'color'), 'Prose ink is not --ink-soft');
});

test('prose: the thin rule — it sets nothing a term already owns', function () {
  /*
   * The constraint that makes over-reach harmless. A Prose reaches every
   * descendant, including a Heading or a Code the region demonstrates, so
   * it must contribute only what no term claims: measure, ink, list indent.
   * A face, size or weight here would be a second owner for one property.
   *
   * Measured as equality with the same element outside a Prose rather than
   * against a literal, so retuning the heading rung does not fail this.
   */
  var inside = el('<div class="prose"><h2>a</h2></div>').querySelector('h2');
  var outside = el('<div><h2>a</h2></div>').querySelector('h2');

  ['font-family', 'font-size', 'font-weight'].forEach(function (prop) {
    assert.equal(
      style(inside, prop),
      style(outside, prop),
      'Prose changed a heading\'s ' + prop + ' — Heading owns that'
    );
  });
});

test('prose: its rules are zero-specificity, so a term inside wins', function () {
  /*
   * :where() throughout. A `p` inside a Prose that also carries a term
   * class — .alert-content, .field-hint — must keep what its own term says,
   * and at (0,1,1) a descendant rule would beat a single-class rule in the
   * same layer. This is what lets the guide put Prose on a whole section
   * that also demonstrates live components.
   */
  var box = el('<div class="prose"><ul class="items menu"><li>a</li></ul></div>');
  var list = box.querySelector('ul');
  var plain = el('<ul class="items menu"><li>a</li></ul>');

  assert.equal(
    style(list, 'padding-inline-start'),
    style(plain, 'padding-inline-start'),
    'Prose overrode a list that carries its own term — the rules are not :where()'
  );
});

test('prose: spacing between blocks is the parent, not the term', function () {
  /*
   * The half other prose implementations own and this one does not. A
   * margin here would add to a Stack's gap, and being an element rule it
   * would be unreachable by --density. `class="prose stack"` is the answer.
   */
  var box = el('<div class="prose"><p>a</p><p>b</p></div>');
  var paras = box.querySelectorAll('p');

  assert.equal(style(paras[1], 'margin-block-start'), '0px', 'Prose put a margin between blocks');

  var stacked = el('<div class="prose stack"><p>a</p><p>b</p></div>');
  assert.ok(parseFloat(style(stacked, 'row-gap')) > 0, 'prose + stack has no gap');
});
