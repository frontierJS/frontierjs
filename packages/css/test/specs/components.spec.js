/*
 * components.spec.js — the v0.8 additions: Steps, Avatar, Facts, Kbd, Code,
 * Divider, and the vertical Tabs variant.
 *
 * Each of these is a place where the system's existing rules had to be
 * applied rather than restated, so most of what is tested here is whether
 * the new piece actually joined the machinery it claims to: does the
 * avatar really get chip's auto-contrast, does a tone really reach a step
 * marker across the element-scoping boundary, does a code block really
 * scroll in its own box instead of taking the page with it.
 */

var TONES = ['primary', 'secondary', 'muted', 'info', 'success', 'warning', 'danger'];
var THEMES = ['default', 'sunset', 'forest', 'midnight', 'dark', 'elite', 'basecamp'];

var STEPS =
  '<ol class="steps" aria-label="Progress">' +
  '<li class="step complete" id="s1"><span class="step-marker"></span><span class="step-label">Cart</span></li>' +
  '<li class="step" aria-current="step" id="s2"><span class="step-marker"></span><span class="step-label">Shipping</span></li>' +
  '<li class="step" id="s3"><span class="step-marker"></span><span class="step-label">Payment</span></li>' +
  '</ol>';

/* ── Found by building the demo app ──────────────────────────────────*/

test('overlay: a closed <dialog> stays closed', function () {
  /*
   * Regression, and the demo app is what found it — every closed dialog
   * and drawer in the package rendered as though it were open, on load,
   * on every page that had one.
   *
   * The UA stylesheet hides a dialog with `dialog:not([open])
   * { display: none }`, and an *author* `display` beats a UA one at any
   * specificity. The surface base sets `display: block` on every
   * composite, .dialog and .drawer included, so it silently unhid them.
   *
   * frame.css already documents this exact trap for `.view[hidden]` and
   * restates the rule there. The lesson had just never been carried
   * across to the two composites that are actual <dialog> elements.
   */
  var d = el('<dialog class="dialog"><p>Confirm?</p></dialog>');
  assert.equal(style(d, 'display'), 'none', 'a closed .dialog is rendering');

  var drawer = el('<dialog class="drawer"><p>Filters</p></dialog>');
  assert.equal(style(drawer, 'display'), 'none', 'a closed .drawer is rendering');
});

test('overlay: an open <dialog> still renders', function () {
  var d = el('<dialog class="dialog" open><p>Confirm?</p></dialog>');
  assert.notEqual(style(d, 'display'), 'none', 'an open .dialog is hidden');

  var drawer = el('<dialog class="drawer" open><p>Filters</p></dialog>');
  assert.notEqual(style(drawer, 'display'), 'none', 'an open .drawer is hidden');
});

test('overlay: an open drawer is a column, and a closed one is still closed', function () {
  /*
   * The rule that lets a .surface-body between a header and a footer take
   * the remaining height instead of only its content's. It moved here from
   * a local <style> in @frontierjs/ui's Drawer.mesa, which is the file that
   * owns .drawer having the rule about .drawer.
   *
   * Both halves are the test, and the second is the one that matters: the
   * rule has to key off [open], because an author `display: flex` beats
   * the UA's `display: none` and the drawer would be on screen shut. That
   * is the same trap `a closed <dialog> stays closed` above records, and
   * it is one word away from being made again.
   */
  var open = el('<dialog class="drawer" open><p>Filters</p></dialog>');
  assert.equal(style(open, 'display'), 'flex', 'an open .drawer is not a flex box');
  assert.equal(style(open, 'flex-direction'), 'column', 'an open .drawer is not a column');

  var shut = el('<dialog class="drawer"><p>Filters</p></dialog>');
  assert.equal(style(shut, 'display'), 'none', 'the column rule unhid a closed drawer');
});

test('overlay: the guard does not hide a non-dialog .dialog', function () {
  /*
   * Scoped to the element, not the class: `[open]` means nothing on a
   * <div>, so an unscoped `:not([open])` would hide any element that
   * borrowed the class.
   */
  var div = el('<div class="dialog"><p>Confirm?</p></div>');
  assert.notEqual(style(div, 'display'), 'none', 'a non-dialog .dialog was hidden');
});

test('overlay: .raised, .outlined and .ghost all do something on a .btn', function () {
  /*
   * Found by the demo, which reached for `.btn.ghost` for every toolbar
   * and row-action button — the obvious thing to reach for, since the
   * README lists raised/outlined/ghost as Treatments, "composes onto
   * anything".
   *
   * Only .outlined was implemented on .btn. `.ghost` and `.raised` were
   * silent no-ops, so a row of ghost icon buttons rendered as a row of
   * solid primary-blue buttons. This is the same failure the v0.6 tone
   * work fixed for tones: a Treatment that only some components honour is
   * not a Treatment.
   */
  var plain = el('<button class="btn">Save</button>');
  var base = {
    bg: style(plain, 'background-color'),
    shadow: style(plain, 'box-shadow'),
  };
  cleanup();

  ['raised', 'outlined', 'ghost'].forEach(function (variant) {
    var b = el('<button class="btn ' + variant + '">Save</button>');
    var changed =
      toRGB(style(b, 'background-color')).join() !== toRGB(base.bg).join() ||
      style(b, 'box-shadow') !== base.shadow;
    assert.ok(changed, '.btn.' + variant + ' is a silent no-op');
    cleanup();
  });
});

test('overlay: a ghost button reads its tone', function () {
  var plain = el('<button class="btn ghost">Delete</button>');
  var plainColor = style(plain, 'color');
  cleanup();

  var toned = el('<button class="btn ghost danger">Delete</button>');
  assert.differentColor(style(toned, 'color'), plainColor, '.btn.ghost.danger is not red');
});

test('form: a .switch keeps its switch shape inside a .field-check', function () {
  /*
   * Found by the demo. form-core.css documents the switch as
   *
   *   <label class="field-check"><input class="switch" role="switch">
   *
   * and then sizes every input in a .field-check to 16x16 at (0,1,1),
   * which out-specifies `.switch` at (0,1,0). So the package's own
   * documented markup rendered the switch as a small round checkbox —
   * the one control whose entire affordance is its shape.
   */
  var sw = el('<label class="field-check"><input class="switch" type="checkbox" role="switch"><span>On</span></label>', '.switch');
  var box = sw.getBoundingClientRect();
  assert.ok(box.width > box.height * 1.4, 'the switch is not a track — it rendered ' + box.width + 'x' + box.height);
  assert.ok(box.width >= 30, 'the switch was squashed to checkbox size');
});

test('form: a tone on the label reaches the switch track', function () {
  /*
   * --bg-mix is element-scoped, so a tone on the .field-check label cannot
   * be read by the input. The label derives --check-accent and the switch
   * reads that — the same crossing the checkbox already made, which the
   * switch had never been wired into.
   */
  var plain = el('<label class="field-check"><input class="switch" type="checkbox" role="switch" checked><span>On</span></label>', '.switch');
  var plainTrack = style(plain, 'background-color');
  cleanup();

  var toned = el('<label class="field-check danger"><input class="switch" type="checkbox" role="switch" checked><span>On</span></label>', '.switch');
  assert.differentColor(style(toned, 'background-color'), plainTrack, 'a tone on .field-check did not reach the switch');
});

test('form: a standalone switch still tints when checked', function () {
  /*
   * The other end of that chain: outside a .field-check there is no
   * --check-accent, so the fallback has to bottom out at a real color
   * rather than resolving to nothing.
   */
  var sw = el('<input class="switch" type="checkbox" role="switch" checked>');
  assert.differentColor(
    style(sw, 'background-color'),
    'rgba(0, 0, 0, 0)',
    'a standalone checked switch has no track color'
  );
});

test('form: a plain checkbox in a .field-check is still checkbox-sized', function () {
  var cb = el('<label class="field-check"><input type="checkbox"><span>On</span></label>', 'input');
  var box = cb.getBoundingClientRect();
  assert.equal(Math.round(box.width), 16, 'a plain checkbox lost its sizing');
});

test('a11y: a resting skip link paints nothing', function () {
  /*
   * Found by the demo, by zooming into a screenshot. The link is moved
   * off the top of the viewport with a transform, but a box-shadow paints
   * outside its box — --shadow-lg reaches 16px past the bottom edge,
   * which was enough to smear a faint grey band across the top of every
   * page that had a skip link.
   *
   * Off-screen has to mean nothing paints, not just that the box is gone.
   */
  var link = el('<a class="skip-link" href="#m">Skip to content</a>');
  assert.equal(style(link, 'box-shadow'), 'none', 'a resting skip link still casts a shadow');

  link.focus();
  assert.notEqual(style(link, 'box-shadow'), 'none', 'a focused skip link lost its elevation');
});

/* ── Steps ───────────────────────────────────────────────────────────*/

test('steps: the strip lays out horizontally, and .vertical turns it', function () {
  var h = el(STEPS);
  assert.equal(style(h, 'display'), 'flex', '.steps is not a flex strip');
  assert.equal(style(h, 'flex-direction'), 'row', '.steps should default to horizontal');
  cleanup();

  var v = el(STEPS.replace('class="steps"', 'class="steps vertical"'));
  assert.equal(style(v, 'flex-direction'), 'column', '.steps.vertical did not turn');
});

test('steps: an empty marker numbers itself, a filled one does not', function () {
  /*
   * The markup should not carry indices — inserting a step in the middle
   * would silently renumber everything after it by hand. A CSS counter
   * does it, and anything the author puts in the marker wins instead.
   */
  var auto = el(STEPS, '#s3 .step-marker');
  assert.ok(
    /counter/.test(getComputedStyle(auto, '::before').content),
    'an empty .step-marker does not self-number'
  );
  cleanup();

  var manual = el(
    STEPS.replace('<span class="step-marker"></span><span class="step-label">Payment', '<span class="step-marker">!</span><span class="step-label">Payment'),
    '#s3 .step-marker'
  );
  assert.equal(
    getComputedStyle(manual, '::before').content,
    'none',
    'a .step-marker with its own content still added a counter on top of it'
  );
});

test('steps: a hand-written marker still advances the numbering', function () {
  /*
   * Regression, and one that only a rendered page showed: the increment
   * used to live on .step-marker::before. A marker with its own content
   * sets `content: none`, so the pseudo-element is never generated and the
   * increment never runs — a single hand-written checkmark silently
   * renumbered every step after it, giving ✓, 1, 2 instead of ✓, 2, 3.
   *
   * The computed-style suite could not see it: every assertion about the
   * counter was about `content`, and `content` was correct. Only the
   * numbers on screen were wrong. Hence testing where the increment lives.
   */
  var s = el(STEPS.replace('<span class="step-marker"></span><span class="step-label">Cart', '<span class="step-marker">✓</span><span class="step-label">Cart'));

  ['#s1', '#s2', '#s3'].forEach(function (id) {
    assert.ok(
      /fjs-step/.test(style(s.querySelector(id + ' .step-marker'), 'counter-increment')),
      'the marker in ' + id + ' does not advance the counter, so later steps renumber'
    );
  });
});

test('steps: only steps after the first draw a connector', function () {
  var s = el(STEPS);
  assert.equal(
    getComputedStyle(s.querySelector('#s1'), '::before').content,
    'none',
    'the first step drew a connector reaching back to nothing'
  );
  assert.notEqual(
    getComputedStyle(s.querySelector('#s2'), '::before').content,
    'none',
    'the second step has no connector'
  );
});

test('steps: the current step is keyed off aria-current, not a class', function () {
  /*
   * Same discipline as tabs, breadcrumbs and pagination: a .current class
   * must not be able to fake the state, or the highlighted step and the
   * announced step can drift.
   */
  var real = el(STEPS, '#s2 .step-marker');
  var realBorder = style(real, 'border-top-color');
  cleanup();

  var faked = el(STEPS.replace('aria-current="step" id="s2"', 'class="current active selected" id="s2"'), '#s2 .step-marker');
  assert.differentColor(
    style(faked, 'border-top-color'),
    realBorder,
    'a .current / .active / .selected class faked the current step'
  );
});

test('steps: a completed step reads differently from an upcoming one', function () {
  var s = el(STEPS);
  var done = style(s.querySelector('#s1 .step-marker'), 'background-color');
  var todo = style(s.querySelector('#s3 .step-marker'), 'background-color');
  assert.differentColor(done, todo, 'complete and upcoming steps render identically');
});

test('steps: a tone on .steps reaches the markers', function () {
  /*
   * --bg-mix is element-scoped, so the tone on the <ol> cannot be read by
   * a marker four levels down. .steps derives --step-accent, an ordinary
   * inheriting property, and passes that down — the same shape as
   * --tab-accent, --row-tint and --check-accent.
   */
  var base = el(STEPS, '#s1 .step-marker');
  var baseBg = style(base, 'background-color');
  cleanup();

  TONES.forEach(function (tone) {
    var toned = el(STEPS.replace('class="steps"', 'class="steps ' + tone + '"'), '#s1 .step-marker');
    var bg = style(toned, 'background-color');
    if (tone !== 'primary') {
      assert.differentColor(bg, baseBg, '.steps.' + tone + ' did not reach the marker');
    }
    cleanup();
  });
});

test('steps: a completed marker keeps its text readable on every tone', function () {
  /*
   * A completed marker is a solid tone fill with a number on it — the same
   * contrast problem .btn has. It is not in the chip lineage (a marker is
   * not an inline chip), so it derives contrast itself, and that
   * derivation has to hold everywhere chip's does.
   */
  var failures = [];
  THEMES.forEach(function (theme) {
    TONES.forEach(function (tone) {
      var m = themed(theme, STEPS.replace('class="steps"', 'class="steps ' + tone + '"'), '#s1 .step-marker');
      var cs = getComputedStyle(m);
      var ratio = contrast(cs.color, cs.backgroundColor);
      if (ratio < 4.5) {
        failures.push('theme-' + theme + ' .' + tone + '  ' + ratio.toFixed(2) + ':1');
      }
      cleanup();
    });
  });
  assert.equal(
    failures.length,
    0,
    failures.length + ' completed step markers below AA:\n        ' + failures.join('\n        ')
  );
});

/* ── Avatar ──────────────────────────────────────────────────────────*/

test('avatar: initials clear AA on every tone in every theme', function () {
  /*
   * The whole reason .avatar was added to the chip :where() list rather
   * than given its own background rule. If this fails, it fell out of the
   * lineage.
   */
  var failures = [];
  THEMES.forEach(function (theme) {
    TONES.forEach(function (tone) {
      var a = themed(theme, '<span class="avatar ' + tone + '">DO</span>');
      var cs = getComputedStyle(a);
      var ratio = contrast(cs.color, cs.backgroundColor);
      if (ratio < 4.5) failures.push('theme-' + theme + ' .' + tone + '  ' + ratio.toFixed(2) + ':1');
      cleanup();
    });
  });
  assert.equal(
    failures.length,
    0,
    failures.length + ' avatar initials below AA:\n        ' + failures.join('\n        ')
  );
});

test('avatar: --avatar-size drives the box and the type together', function () {
  /*
   * One token, not a size class plus a matching font-size. If they ever
   * came apart, a large avatar would render tiny initials floating in it.
   */
  var small = el('<span class="avatar" style="--avatar-size: 1.5rem">DO</span>');
  var big = el('<span class="avatar" style="--avatar-size: 4rem">DO</span>');

  assert.equal(small.getBoundingClientRect().width, 24, 'small avatar is not 1.5rem wide');
  assert.equal(small.getBoundingClientRect().height, 24, 'small avatar is not square');
  assert.equal(big.getBoundingClientRect().width, 64, 'large avatar is not 4rem wide');

  var smallType = parseFloat(style(small, 'font-size'));
  var bigType = parseFloat(style(big, 'font-size'));
  assert.ok(bigType > smallType * 2, 'font-size did not scale with --avatar-size');
});

test('avatar: an image avatar crops rather than squashing', function () {
  var img = el('<img class="avatar" alt="Dana Ortiz" src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==">');
  assert.equal(style(img, 'object-fit'), 'cover', 'a non-square photo would be squashed');
  assert.equal(style(img, 'overflow'), 'hidden', 'the image would escape the avatar radius');
});

test('avatar: .avatars overlaps its members', function () {
  var group = el(
    '<div class="avatars" role="group" aria-label="Assignees">' +
    '<span class="avatar" id="a1">A</span><span class="avatar" id="a2">B</span></div>'
  );
  var second = group.querySelector('#a2');
  assert.ok(
    parseFloat(style(second, 'margin-inline-start')) < 0,
    '.avatars did not overlap its members'
  );
  assert.equal(
    parseFloat(style(group.querySelector('#a1'), 'margin-inline-start')),
    0,
    'the first avatar in a group should not be pulled left'
  );
});

test('avatar: the group ring does not shrink the avatar', function () {
  /*
   * The separator ring is an inset box-shadow rather than a border on
   * purpose: a border eats into the box, so a grouped avatar would come
   * out smaller than a lone one at the same --avatar-size.
   */
  var lone = el('<span class="avatar">A</span>');
  var loneWidth = lone.getBoundingClientRect().width;
  cleanup();

  var grouped = el('<div class="avatars"><span class="avatar">A</span></div>', '.avatar');
  assert.equal(
    grouped.getBoundingClientRect().width,
    loneWidth,
    'a grouped avatar is a different size from a lone one'
  );
});

/* ── Facts ───────────────────────────────────────────────────────────*/

var FACTS =
  '<dl class="facts">' +
  '<dt id="k1">Customer</dt><dd id="v1">Acme Corp</dd>' +
  '<dt id="k2">Status</dt><dd id="v2">Paid</dd>' +
  '</dl>';

test('facts: pairs lay out as a two-column grid', function () {
  var f = el(FACTS);
  assert.equal(style(f, 'display'), 'grid', '.facts is not a grid');
  assert.equal(
    style(f, 'grid-template-columns').split(' ').length,
    2,
    '.facts should have exactly two columns'
  );
});

test('facts: the UA indent on <dd> is removed', function () {
  /*
   * A <dd> ships with 40px of margin-inline-start from the UA stylesheet.
   * Left in place inside a grid it does not indent — it shoves the value
   * column sideways and misaligns every row. This is the single most
   * likely thing to be forgotten when styling a <dl>.
   */
  var f = el(FACTS);
  assert.equal(
    parseFloat(style(f.querySelector('#v1'), 'margin-inline-start')),
    0,
    'the UA <dd> indent is still there and is pushing the value column'
  );
});

test('facts: labels and values sit on the same baseline', function () {
  var f = el(FACTS);
  var dt = f.querySelector('#k1').getBoundingClientRect();
  var dd = f.querySelector('#v1').getBoundingClientRect();
  assert.ok(
    Math.abs(dt.top - dd.top) < 2,
    'a label and its value are on different rows — the grid flow is broken'
  );
});

test('facts: a .divided rule is continuous across both columns', function () {
  /*
   * Regression, also only visible on a rendered page. A border cannot span
   * a grid gap, so with the default column-gap the rule came out as two
   * segments with a hole between the label and value columns. `.divided`
   * drops the gap and the label carries it as padding instead.
   *
   * The existing divider test passed throughout — it asked whether a
   * border existed, and one did. It just had a hole in it.
   */
  var plain = el(FACTS);
  assert.ok(parseFloat(style(plain, 'column-gap')) > 0, 'an undivided .facts lost its column gap');
  cleanup();

  var divided = el(FACTS.replace('class="facts"', 'class="facts divided"'));
  assert.equal(
    parseFloat(style(divided, 'column-gap')),
    0,
    '.facts.divided keeps a column gap, so its rules have a hole in the middle'
  );
  assert.ok(
    parseFloat(style(divided.querySelector('#k1'), 'padding-inline-end')) > 0,
    'the gap was removed but the label has no padding to replace it'
  );
});

test('facts: .divided rules between pairs but not above the first', function () {
  var f = el(FACTS.replace('class="facts"', 'class="facts divided"'));
  assert.equal(
    style(f.querySelector('#k1'), 'border-top-style'),
    'none',
    'the first row has a rule above it, floating over nothing'
  );
  assert.notEqual(
    style(f.querySelector('#k2'), 'border-top-style'),
    'none',
    '.divided drew no rule between pairs'
  );
});

/* ── Kbd, Code, Divider ──────────────────────────────────────────────*/

test('kbd: the bare element is styled, not only the class', function () {
  var bare = el('<kbd>Esc</kbd>');
  var classed = el('<span class="kbd">Esc</span>');
  assert.sameColor(
    style(bare, 'background-color'),
    style(classed, 'background-color'),
    '<kbd> and .kbd render differently'
  );
  assert.differentColor(
    style(bare, 'background-color'),
    'rgba(0, 0, 0, 0)',
    '<kbd> is unstyled'
  );
});

test('code: a block scrolls in its own box', function () {
  /*
   * Without this a single long line pushes its grid track wider than the
   * viewport and the whole page scrolls sideways — the same failure
   * .table-wrap exists to prevent.
   */
  var pre = el('<pre class="code"><code>bun run test --with-a-very-long-flag</code></pre>');
  assert.equal(style(pre, 'overflow-x'), 'auto', 'a code block does not scroll itself');
  assert.equal(style(pre, 'white-space'), 'pre', 'a code block is wrapping instead of scrolling');
});

test('code: an inline <code> inside a block does not double its background', function () {
  var inline = el('<p>an <code id="c">identifier</code></p>', '#c');
  assert.differentColor(
    style(inline, 'background-color'),
    'rgba(0, 0, 0, 0)',
    'inline code has no background'
  );
  cleanup();

  var nested = el('<pre class="code"><code id="c">bun run test</code></pre>', '#c');
  assert.sameColor(
    style(nested, 'background-color'),
    'rgba(0, 0, 0, 0)',
    'a <code> inside a .code block kept the inline background, doubling it'
  );
});

test('divider: <hr> loses the UA bevel', function () {
  /*
   * The UA default for <hr> is a beveled inset border, which is why an
   * unstyled rule looks like Windows 95. Removing the border and drawing
   * the line as a background is also what lets --rule retint it.
   */
  var hr = el('<hr>');
  assert.equal(style(hr, 'border-top-style'), 'none', '<hr> still has its UA border');
  assert.equal(parseFloat(style(hr, 'height')), 1, '<hr> is not a 1px line');
  assert.differentColor(style(hr, 'background-color'), 'rgba(0, 0, 0, 0)', '<hr> draws no line');
});

/* ── Pane composes with the layout primitives ────────────────────────*/

test('pane: a layout class on a Pane is not overridden', function () {
  /*
   * `components` is a later layer than `layout` and both selectors are
   * (0,1,0), so any `display` on .pane beats every layout primitive
   * outright — `class="pane stack"` laid out as a block with the gap
   * silently doing nothing. It is the collision layout.css documents for
   * `.bar.center`, and .pane is the case where the component must yield:
   * a Pane is a semantic subdivision, so it states no display at all.
   *
   * Both directions. A bare Pane must still be block — it is a <section>,
   * so the UA supplies that and nothing needs to restate it.
   */
  var bare = el('<section class="pane">body</section>');
  assert.equal(style(bare, 'display'), 'block', 'a bare Pane is not a block');
  cleanup();

  var stacked = el('<section class="pane stack">body</section>');
  assert.equal(style(stacked, 'display'), 'flex', '.pane beat .stack — the gap does nothing');
  assert.equal(
    style(stacked, 'flex-direction'),
    'column',
    'a stacked Pane is not laying its children out in a column'
  );
  assert.ok(
    parseFloat(style(stacked, 'row-gap')) > 0,
    'a stacked Pane has no gap between its children'
  );
  cleanup();

  var clustered = el('<section class="pane cluster">body</section>');
  assert.equal(style(clustered, 'display'), 'flex', '.pane beat .cluster');
});

/* ── Vertical tabs ───────────────────────────────────────────────────*/

var TABS =
  '<div class="tabs">' +
  '<div class="tablist" role="tablist">' +
  '<button class="tab" role="tab" aria-selected="true" id="t1">One</button>' +
  '<button class="tab" role="tab" aria-selected="false" id="t2">Two</button>' +
  '</div>' +
  '<article class="view" role="tabpanel" tabindex="0" id="v1">panel</article>' +
  '</div>';

test('tabs: .vertical turns the strip and moves the indicator', function () {
  var h = el(TABS, '#t1');
  var horizontalIndicator = style(h, 'border-bottom-color');
  cleanup();

  var v = el(TABS.replace('class="tabs"', 'class="tabs vertical"'));
  assert.equal(style(v, 'flex-direction'), 'row', '.tabs.vertical should put strip and panel side by side');
  assert.equal(
    style(v.querySelector('.tablist'), 'flex-direction'),
    'column',
    'the vertical tablist is still a row'
  );

  var selected = v.querySelector('#t1');
  assert.sameColor(
    style(selected, 'border-right-color'),
    horizontalIndicator,
    'the selected indicator did not move to the inline end'
  );
  assert.equal(
    style(selected, 'border-bottom-style'),
    'none',
    'the vertical tab kept its horizontal underline as well'
  );
});

test('tabs: a vertical panel cannot blow the layout out sideways', function () {
  /*
   * A flex item defaults to min-inline-size: auto, so a wide table inside
   * the panel widens the track instead of scrolling. Same one line, same
   * reason, as .screen in frame.css.
   */
  var v = el(TABS.replace('class="tabs"', 'class="tabs vertical"'), '.view');
  assert.equal(
    parseFloat(style(v, 'min-inline-size')),
    0,
    'a vertical tab panel will push the page sideways on wide content'
  );
});

test('tabs: vertical selection still comes from aria-selected', function () {
  var v = el(TABS.replace('class="tabs"', 'class="tabs vertical"'));
  var real = style(v.querySelector('#t1'), 'border-right-color');
  var unselected = style(v.querySelector('#t2'), 'border-right-color');
  assert.differentColor(real, unselected, 'selected and unselected vertical tabs look identical');
  cleanup();

  var faked = el(
    TABS.replace('class="tabs"', 'class="tabs vertical"')
      .replace('aria-selected="false" id="t2"', 'class="active" id="t2"'),
    '#t2'
  );
  assert.sameColor(
    style(faked, 'border-right-color'),
    unselected,
    'an .active class faked selection on a vertical tab'
  );
});

test('code: a <code> inside any <pre> drops the inline treatment', function () {
  /*
   * `code` is styled by element, so the inline background reached
   * `<pre><code>` — the markup every markdown renderer emits — whenever the
   * <pre> carried a class other than `.code`. An inline box that wraps
   * paints one fragment per line, so a code block came out with a darker
   * stripe behind each line and read as a rendering fault.
   */
  ['highlight', 'code', ''].forEach(function (cls) {
    var pre = el('<pre' + (cls ? ' class="' + cls + '"' : '') + '><code id="k">a\nb</code></pre>');
    var k = pre.querySelector('#k');
    assert.equal(style(k, 'background-color'), 'rgba(0, 0, 0, 0)', 'pre.' + cls + ' > code kept a background');
    assert.equal(style(k, 'padding-left'), '0px', 'pre.' + cls + ' > code kept padding');
    cleanup();
  });
});

test('code: inline <code> still carries its own box', function () {
  /* The other side of the rule above — the reset must not be global. */
  var p = el('<p>an inline <code id="k">identifier</code> here</p>');
  var k = p.querySelector('#k');
  assert.differentColor(style(k, 'background-color'), 'rgba(0, 0, 0, 0)', 'inline code lost its background');
  assert.ok(parseFloat(style(k, 'padding-left')) > 0, 'inline code lost its padding');
});

/* ── An Item that is itself the control ────────────────────────────── */

test('items: a <button class="item"> is reset to the row, not to a button', function () {
  /*
   * `.items.menu` styles a row to look clickable, and an <li> is not
   * focusable and takes no keyboard — so the documented way to build a menu
   * is to put a real control INSIDE the row. Then the control arrives with a
   * UA background, border, font-size and shrink-to-fit width that the row's
   * own look cannot override, and everyone who followed the advice wrote the
   * same reset by hand. @frontierjs/ui's DropdownItem carried eight lines of
   * it, and drifted the row's gap while it was there.
   */
  var box = el(
    '<ul class="items menu" style="inline-size: 300px; font-size: 20px">' +
      '<li><button class="item" type="button">Rename</button></li>' +
      '</ul>'
  );
  var btn = box.querySelector('button.item');

  assert.equal(style(btn, 'background-color'), 'rgba(0, 0, 0, 0)', 'the UA background survived');
  assert.equal(style(btn, 'border-top-style'), 'none', 'the UA border survived');
  assert.equal(style(btn, 'font-size'), '20px', 'the button did not inherit the list type');
  assert.equal(style(btn, 'text-align'), 'start', 'a button centres its text by default');
  assert.equal(style(btn, 'cursor'), 'pointer');

  /* Full width, so the hover background covers the row rather than the word. */
  assert.ok(
    btn.getBoundingClientRect().width > 250,
    'the control did not fill the row (' + Math.round(btn.getBoundingClientRect().width) + 'px of 300)'
  );
});

test('items: the row keeps its own layout — the reset does not restate it', function () {
  /*
   * The reset is deliberately only the control parts. `.item` already owns
   * display/align/gap, and a second copy is what drifted in the kit.
   */
  var box = el('<ul class="items"><li class="item">a</li></ul>');
  var li = box.querySelector('.item');
  var gap = style(li, 'gap');

  var box2 = el('<ul class="items"><li><button class="item" type="button">a</button></li></ul>');
  assert.equal(style(box2.querySelector('button.item'), 'gap'), gap, 'a control row has a different gap');
});

test('items: a disabled control row reads as disabled', function () {
  var box = el('<ul class="items menu"><li><button class="item" type="button" disabled>x</button></li></ul>');
  var btn = box.querySelector('button.item');
  assert.equal(style(btn, 'cursor'), 'not-allowed');
  assert.ok(Number(style(btn, 'opacity')) < 1, 'a disabled row is not dimmed');
});
