/*
 * focus.spec.js — one focus ring, one recipe, on every focusable surface.
 *
 * Before v0.7 the package drew focus four different ways: a translucent
 * box-shadow halo at 30% on .btn, an 18% tone-aware one on .field, an inset
 * 25% one on .disclosure-summary, a hardcoded 2px currentColor one on
 * .pill-close — and a solid `outline` on everything added late in v0.6.
 * Only the box-shadow three honored --ring-width; the outline ones
 * hardcoded 2px, so the token themed some rings and not others.
 *
 * Two of those recipes were also load-bearing on a property another rule
 * owned, which is how .btn.outlined and .btn.link ended up with no focus
 * indicator at all — see the regression tests at the bottom.
 *
 * ── A note on :focus-visible under headless Chrome ────────────────────
 *
 * `:focus-visible` matches on programmatic .focus() here, because the
 * heuristic only suppresses the ring once it has seen a pointer
 * interaction, and this page never gets one. That is convenient rather
 * than principled: these tests confirm a ring is drawn and how, not that
 * the browser's keyboard-vs-mouse heuristic works.
 */

/*
 * Every focusable surface the package styles, with the markup each one
 * contracts for. Adding a focusable component means adding it here — the
 * same explicit cost the surface :where() list has.
 */
var FOCUSABLE = [
  { name: '.btn', html: '<button class="btn">Save</button>' },
  { name: '.btn.outlined', html: '<button class="btn outlined">Save</button>' },
  { name: '.btn.link', html: '<button class="btn link">Save</button>' },
  { name: '.field', html: '<input class="field" type="text">' },
  { name: 'select.field', html: '<select class="field"><option>a</option></select>' },
  { name: '.switch', html: '<input class="switch" type="checkbox" role="switch">' },
  {
    name: '.pill-close',
    html: '<span class="pill removable">tag<button class="pill-close" aria-label="Remove">x</button></span>',
    find: '.pill-close',
  },
  {
    name: '.disclosure-summary',
    html: '<details class="disclosure"><summary class="disclosure-summary">More</summary><div class="disclosure-body">b</div></details>',
    find: '.disclosure-summary',
  },
  {
    name: '.tab',
    html: '<div class="tablist" role="tablist"><button class="tab" role="tab" aria-selected="true">One</button></div>',
    find: '.tab',
  },
  {
    name: '.navlink',
    html: '<ul class="navlist"><li><a class="navlink" href="#x">Dashboard</a></li></ul>',
    find: '.navlink',
  },
  {
    name: '.pagination-link',
    html: '<nav class="pagination" aria-label="Pagination"><a class="pagination-link" href="#x">2</a></nav>',
    find: '.pagination-link',
  },
  { name: '.link', html: '<a class="link" href="#x">Read more</a>' },
  { name: '.view', html: '<article class="view" tabindex="0">panel</article>' },
  { name: '.skip-link', html: '<a class="skip-link" href="#m">Skip to content</a>' },
];

/*
 * The inset set: elements whose ring would be clipped by a scroll container
 * or would spill over an attached neighbor, so it is drawn inside the box.
 */
var INSET = ['.tab', '.navlink', '.disclosure-summary', '.pill-close'];

function mountFocused(spec) {
  var node = el(spec.html, spec.find);
  node.focus();
  return node;
}

function rootProp(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/*
 * The ring color an element should resolve to, read on the element itself.
 *
 * --ring is deliberately not declared at :root — it follows --color-primary
 * through a use-site fallback, because the `--ring: var(--color-primary)`
 * alias form resolves once against :root and inherits past every theme
 * override. Reading the expectation on the element rather than on :root is
 * the same discipline: it is the only place the theme is visible.
 */
function expectedRing(node) {
  var cs = getComputedStyle(node);
  return cs.getPropertyValue('--ring').trim() ||
    cs.getPropertyValue('--color-primary').trim();
}

FOCUSABLE.forEach(function (spec) {
  test('focus: ' + spec.name + ' paints a visible ring', function () {
    var node = mountFocused(spec);
    assert.ok(
      node.matches(':focus'),
      spec.name + ' did not take focus — check the test markup, not the CSS'
    );
    assert.ok(hasVisibleRing(node), spec.name + ' has no focus indicator at all');
  });

  test('focus: ' + spec.name + ' uses outline, not box-shadow', function () {
    var node = mountFocused(spec);
    var cs = getComputedStyle(node);

    /*
     * outline is the unified medium because it follows border-radius, takes
     * no space in layout, and — unlike box-shadow — is not a property any
     * component already uses for its resting elevation. .btn.outlined sets
     * `box-shadow: none` for its flat look and silently erased its own
     * focus ring when the ring lived in box-shadow.
     */
    assert.notEqual(cs.outlineStyle, 'none', spec.name + ' draws no outline on focus');
    assert.ok(parseFloat(cs.outlineWidth) > 0, spec.name + ' outline has zero width');
  });

  test('focus: ' + spec.name + ' honors --ring-width', function () {
    var node = mountFocused(spec);
    assert.equal(
      getComputedStyle(node).outlineWidth,
      rootProp('--ring-width'),
      spec.name + ' hardcodes its ring width instead of reading the token'
    );
  });

  test('focus: ' + spec.name + ' offsets the ring ' + (INSET.indexOf(spec.name) > -1 ? 'inward' : 'outward'), function () {
    var node = mountFocused(spec);
    var offset = parseFloat(getComputedStyle(node).outlineOffset);
    var token = parseFloat(rootProp('--ring-offset'));
    var expected = INSET.indexOf(spec.name) > -1 ? -token : token;
    assert.equal(offset, expected, spec.name + ' ring offset is not derived from --ring-offset');
  });
});

/* ── Color: the ring follows --ring, except where documented ─────────*/

var TONE_AWARE = ['.field', 'select.field'];
var CURRENT_COLOR = ['.pill-close'];

FOCUSABLE.forEach(function (spec) {
  if (TONE_AWARE.indexOf(spec.name) > -1 || CURRENT_COLOR.indexOf(spec.name) > -1) return;

  test('focus: ' + spec.name + ' rings in the ring color', function () {
    var node = mountFocused(spec);
    assert.sameColor(
      getComputedStyle(node).outlineColor,
      expectedRing(node),
      spec.name + ' ring color is not the resolved ring token'
    );
  });
});

test('focus: every theme retints the ring', function () {
  /*
   * Regression, and the reason --ring is not declared at :root.
   *
   * Every theme overrides --color-primary; no theme sets --ring. With
   * `--ring: var(--color-primary)` in :root, that var() resolved once
   * against :root's own --color-primary and the resulting color inherited
   * straight past the theme class — so every ring in every theme was the
   * default blue, and the Elite theme's lime brand focused in blue.
   *
   * Reading it at the use site is what makes the theme visible.
   */
  var themes = ['sunset', 'forest', 'midnight', 'dark', 'elite'];
  var defaultPrimary = rootProp('--color-primary');
  var ringed = 0;

  themes.forEach(function (name) {
    var node = themed(name, '<button class="btn">Save</button>');
    node.focus();
    var ring = getComputedStyle(node).outlineColor;
    assert.sameColor(
      ring,
      expectedRing(node),
      'the ' + name + ' theme ringed in something other than its own ring color'
    );
    if (toRGB(ring).join() !== toRGB(defaultPrimary).join()) ringed++;
    cleanup();
  });

  assert.atLeast(ringed, 4, 'the themes all ringed in the default blue');
});

test('focus: .field rings in its tone when it has one', function () {
  var toned = el('<input class="field danger" type="text">');
  toned.focus();
  assert.sameColor(
    getComputedStyle(toned).outlineColor,
    rootProp('--color-danger'),
    'a .field.danger should ring in danger, not in --ring'
  );
});

test('focus: an untoned .field rings in the ring color', function () {
  var plain = el('<input class="field" type="text">');
  plain.focus();
  assert.sameColor(
    getComputedStyle(plain).outlineColor,
    expectedRing(plain),
    'an untoned field lost the ring fallback'
  );
});

test('focus: a .field border and its ring never disagree', function () {
  /*
   * Both derive from --bg-mix, in two different files. If they ever drift
   * apart, an invalid field focuses with a red border and a blue ring.
   */
  ['', 'danger', 'success', 'warning'].forEach(function (tone) {
    var f = el('<input class="field ' + tone + '" type="text">');
    f.focus();
    var cs = getComputedStyle(f);
    assert.sameColor(
      cs.outlineColor,
      cs.borderTopColor,
      'field ring and border disagree with tone "' + (tone || 'none') + '"'
    );
    cleanup();
  });
});

test('focus: .pill-close rings in currentColor so it works on any tone', function () {
  /*
   * The close button sits on top of a filled pill, where a blue --ring is
   * invisible against a blue pill and illegible on a red one. It rings in
   * the text color the pill already derived for contrast instead.
   */
  var close = el(
    '<span class="pill danger removable">tag<button class="pill-close" aria-label="Remove">x</button></span>',
    '.pill-close'
  );
  close.focus();
  var cs = getComputedStyle(close);
  assert.sameColor(cs.outlineColor, cs.color, '.pill-close ring should track currentColor');
});

/* ── Regressions ─────────────────────────────────────────────────────*/

test('focus: .btn.outlined keeps its focus ring', function () {
  /*
   * Regression. `.btn.outlined { box-shadow: none }` and
   * `.btn:focus-visible { box-shadow: <ring> }` are both (0,2,0) and sat in
   * the same layer, with .outlined declared later — so it won, and an
   * outlined button announced focus to nobody. A WCAG 2.4.7 failure that
   * looked like a styling preference.
   */
  var node = el('<button class="btn outlined">Save</button>');
  node.focus();
  assert.ok(hasVisibleRing(node), '.btn.outlined has no focus indicator');
});

test('focus: .btn.link keeps its focus ring', function () {
  var node = el('<button class="btn link">Save</button>');
  node.focus();
  assert.ok(hasVisibleRing(node), '.btn.link has no focus indicator');
});

test('focus: focusing a .btn does not strip its resting shadow', function () {
  /*
   * Regression. The ring used to be written into box-shadow, which is a
   * single property — so it replaced `box-shadow: var(--shadow-sm)` and the
   * button visibly flattened the moment it was focused.
   */
  var resting = el('<button class="btn">Save</button>');
  var restingShadow = getComputedStyle(resting).boxShadow;

  var focused = el('<button class="btn">Save</button>');
  focused.focus();
  assert.equal(
    getComputedStyle(focused).boxShadow,
    restingShadow,
    'focus changed the button box-shadow — the ring is still living in that property'
  );
});
