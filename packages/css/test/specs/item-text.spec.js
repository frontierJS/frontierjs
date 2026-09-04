/*
 * item-text.spec.js — the stacked Item, and the reason it is shipped
 * rather than written twice.
 *
 * `.item` was one line of text, which covered the entries it was written
 * for and nothing else. A search result, a command-palette row and a
 * picker option all want a title with a category under it, and two
 * packages hand-rolled the same four classes to get there: this guide's
 * ⌘K wrote `.sg-search-text/-title/-sub`, and @frontierjs/ui's
 * CommandPalette wrote `.cp-row-text/-label/-sub` inside a local <style>
 * where no token and no `.dense` could reach them.
 *
 * `anatomy.spec.js` already checks that each part ships CSS and appears in
 * its own markup block. What it cannot check is the three behaviors the
 * parts exist FOR — each of which is one declaration, and each of which
 * fails by looking almost right:
 *
 *   the text block SHRINKS      or a long title pushes the row wider
 *                               instead of ellipsing
 *
 *   the row goes BASELINE       but only when there is a gutter to align
 *                               to, or an ordinary one-line Item moves
 *
 *   a rung, not a literal       or `.dense` reaches the list and stops at
 *                               the entries in it
 */

/* ── The text block has to be able to shrink ──────────────────────── */

test('item: the text block can shrink below its content', function () {
  /*
   * `min-inline-size: 0` is the whole rule, and it is invisible until the
   * content is too long: a flex child's automatic minimum size is its
   * content, so without it a long title makes the ROW wider rather than
   * ellipsing inside it — and the trailing controls go off the end. Both
   * hand-rolled copies carried this line, which is how it earned a test.
   *
   * The title has to be `nowrap` for the question to exist at all. Wrapping
   * text never exceeds its container, so with a wrapping title the row
   * measures 200px whether or not `min-inline-size` is there — the first
   * version of this test passed against a build with the declaration
   * deleted. A palette row and a search hit both ellipse their title, so
   * `nowrap` is also what the real callers do.
   */
  var box = el(
    '<div style="width: 200px">' +
      '<ul class="items"><li class="item">' +
      '<span class="item-text">' +
      '<span class="item-title" style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis">' +
      'a title far longer than two hundred pixels of anybody’s viewport' +
      '</span></span>' +
      '</li></ul>' +
      '</div>'
  );

  /*
   * Measured on the TEXT BLOCK, not on the row. An <li> is block-level and
   * takes its container's width regardless, so the row reports 200px in
   * both the working and the broken build — measured, with the declaration
   * deleted the row was still 200px while `.item-text` was 408px, spilling
   * out of it. The overflowing child is where the failure is visible.
   */
  var row = Math.round(box.querySelector('.item').getBoundingClientRect().width);
  var text = Math.round(box.querySelector('.item-text').getBoundingClientRect().width);

  cleanup();
  assert.ok(
    text <= row,
    '.item-text did not shrink: it is ' + text + 'px inside a ' + row + 'px row, ' +
      'so a long title spills past the row instead of ellipsing (min-inline-size)'
  );
});

test('item: the text block stacks', function () {
  /*
   * A column, not a row. Trivial to state and the reason the part exists
   * at all — a title and its subtitle side by side is a different
   * component.
   */
  var box = el('<div>' + ANATOMY.Item.markup + '</div>');
  var dir = getComputedStyle(box.querySelector('.item-text')).flexDirection;

  cleanup();
  assert.equal(dir, 'column', '.item-text is not stacking its lines');
});

/* ── The gutter changes the row, and only when it is there ────────── */

test('item: a lead switches the row to baseline, and nothing else does', function () {
  /*
   * Both directions, because each is a real failure.
   *
   * `.item` is `align-items: center`, which is right for one line of text
   * beside a control and wrong the moment the text stacks: a gutter
   * centered against a three-line block sits opposite the SUBTITLE, not
   * the title it labels. So `.item:has(.item-lead)` goes baseline.
   *
   * The reverse is what stops that being a silent regression for every
   * ordinary Item in the package — a bare `.item { align-items: baseline }`
   * would fix the palette and quietly misalign every badge-and-text row
   * on the Items page.
   */
  var withLead = el(
    '<div><ul class="items"><li class="item">' +
      '<span class="item-lead">kind</span>' +
      '<span class="item-text"><span class="item-title">Title</span>' +
      '<span class="item-sub">Sub</span></span>' +
      '</li></ul></div>'
  );
  var plain = el('<div><ul class="items"><li class="item">One line</li></ul></div>');

  var led = getComputedStyle(withLead.querySelector('.item')).alignItems;
  var bare = getComputedStyle(plain.querySelector('.item')).alignItems;

  cleanup();
  assert.equal(led, 'baseline', 'an .item with a .item-lead did not align to the baseline');
  assert.equal(bare, 'center', 'a plain .item was moved off center by the lead rule');
});

test('item: the lead is a fixed column', function () {
  /*
   * `flex: 0 0 auto` plus a width. A gutter that shrinks is not a gutter
   * — the kinds stop lining up down the list, which is the only thing it
   * is for.
   */
  var box = el('<div>' + ANATOMY.Item.markup + '</div>');
  var lead = box.querySelector('.item-lead');
  var cs = getComputedStyle(lead);

  var grow = cs.flexGrow;
  var shrink = cs.flexShrink;

  cleanup();
  assert.equal(grow, '0', '.item-lead grows, so the gutter is not a fixed column');
  assert.equal(shrink, '0', '.item-lead shrinks, so long kinds would misalign the column');
});

/* ── It reads the ladders, so density and theme reach it ──────────── */

test('item: the parts read rungs and tokens, never literals', function () {
  /*
   * The failure that made this worth shipping in the first place. The two
   * hand-rolled copies wrote `gap: 1px`, `font-size: 11px`,
   * `margin-top: 1px` — good values that `.dense` cannot move and a theme
   * cannot retune, which is `FJS-129` in one line.
   *
   * Asked of the authored `cssText`, not of `rule.style`: the CSSOM
   * expands a shorthand into longhands that each answer `""`, which is
   * the trap `space.spec.js` documents at length.
   */
  var WANT = {
    'item-text': '--space-',
    'item-sub': '--text-',
    'item-lead': '--text-',
  };

  var missing = [];

  Object.keys(WANT).forEach(function (cls) {
    var token = WANT[cls];
    var needle = new RegExp('\\.' + cls + '\\b');

    var rules = allRules().filter(function (r) {
      return r.selectorText && needle.test(r.selectorText);
    });

    if (!rules.length) {
      missing.push('.' + cls + ' ships no rule at all');
      return;
    }

    var reads = rules.some(function (r) { return r.cssText.indexOf(token) !== -1; });
    if (!reads) {
      missing.push('.' + cls + ' names no ' + token + '* — a literal there stops at .dense');
    }
  });

  assert.equal(missing.length, 0, missing.join('\n        '));
});

/* ── The clamp utility, which is why the snippet is not a part ────── */

/*
 * Long enough to overflow two lines at 120px, with margin. The first
 * attempt used ten short words, which wrapped to exactly two lines — so
 * the clamp had nothing to cut and the control measured the same height.
 * A clamp test whose control does not overflow passes no matter what.
 */
var LONG =
  'one two three four five six seven eight nine ten eleven twelve ' +
  'thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty';

test('item: clamp-2 actually clamps to two lines', function () {
  /*
   * A utility rather than anatomy on Item, because the need is orthogonal
   * to what the text sits in — a card description and a table cell want
   * it too, and none of them wants it always.
   *
   * Measured against an unclamped twin rather than read off the computed
   * style, because the two spellings compute differently: this engine
   * supports standalone `line-clamp` and reports `display: flow-root`,
   * while the prefixed fallback would report `-webkit-box`. Height is the
   * question either way.
   */
  var box = el(
    '<div style="width: 120px; font-size: 12px; line-height: 20px">' +
      '<p class="clamp-2" style="margin: 0">' + LONG + '</p>' +
      '<p style="margin: 0">' + LONG + '</p>' +
      '</div>'
  );

  var clamped = box.querySelector('.clamp-2').getBoundingClientRect().height;
  var free = box.querySelectorAll('p')[1].getBoundingClientRect().height;

  cleanup();
  assert.ok(free > clamped, 'the control paragraph did not overflow, so this proves nothing');
  assert.equal(Math.round(clamped), 40, '.clamp-2 is not two 20px lines (got ' + clamped + 'px)');
});

test('item: the prefixed clamp is the floor, not the winner', function () {
  /*
   * Order, and it is load-bearing. `display: -webkit-box` is a whole box
   * model — a child of one does not lay out the way its author wrote it —
   * so the modern pair overrides `display` back to `flow-root` wherever
   * `line-clamp` is understood, and an engine that understands neither
   * drops the @supports block and keeps the -webkit-box above.
   *
   * Reversing the two blocks still clamps in this browser, which is
   * exactly what would make the lost fallback silent.
   */
  /* The prefixed declaration must exist somewhere, or there is no floor. */
  var hasPrefixed = allRules().some(function (r) {
    return r.selectorText &&
      /\.clamp-2\b/.test(r.selectorText) &&
      r.cssText.indexOf('-webkit-box') !== -1;
  });

  assert.ok(
    hasPrefixed,
    '.clamp-* ships no -webkit-box fallback, so an engine without ' +
      'line-clamp renders the full text with no sign anything was meant to clamp'
  );
});
