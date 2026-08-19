/*
 * frame.spec.js — the shell chrome, and the one measurement that catches it.
 *
 * `.topbar` and `.cluster` are paired in this package's own frame
 * documentation and in the guide's shell demo, and the pairing was broken:
 * a cluster is `flex-wrap: wrap`, a topbar was a fixed `block-size` with
 * `align-items: center`, so a bar holding more than fits laid a SECOND ROW
 * inside a fixed box and centred both — drawing half its contents above the
 * bar and half below it, over the page.
 *
 * Nothing overflowed horizontally at any width, so the usual smell test —
 * does the page scroll sideways — missed it entirely, and it was found by
 * reading coordinates in a real browser rather than by looking (`FJS-338`).
 *
 * So these assert GEOMETRY, not declarations. A rule check would have passed
 * against the broken version: every property in it was doing what it said.
 */

/* A bar with more in it than a narrow viewport can fit on one line. */
function overfullBar(inlineSize) {
  return el(
    '<div class="shell" style="inline-size:' + inlineSize + '">' +
      '<header class="topbar">' +
        '<div class="cluster">' +
          '<button class="btn">Menu</button>' +
          '<span>a-workspace-with-a-long-name</span>' +
        '</div>' +
        '<div class="cluster">' +
          '<span>somebody@an-organisation.example</span>' +
          '<button class="btn">Sign out</button>' +
        '</div>' +
      '</header>' +
    '</div>',
    '.topbar'
  );
}

/* ── The bar contains what is in it ───────────────────────────────── */

test('frame: an overfull topbar grows rather than spilling over the page', function () {
  var bar  = overfullBar('320px');
  var box  = bar.getBoundingClientRect();
  var kids = bar.querySelectorAll('.cluster > *');

  assert.ok(kids.length === 4, 'fixture should have four items, got ' + kids.length);

  for (var i = 0; i < kids.length; i++) {
    var r = kids[i].getBoundingClientRect();
    assert.ok(
      r.top >= box.top - 0.5 && r.bottom <= box.bottom + 0.5,
      'item ' + i + ' (' + kids[i].textContent.trim().slice(0, 20) + ') is outside the bar — ' +
      'bar ' + Math.round(box.top) + '–' + Math.round(box.bottom) + ', ' +
      'item ' + Math.round(r.top) + '–' + Math.round(r.bottom)
    );
  }

  cleanup();
});

test('frame: --topbar-height is a floor, so a bar that fits keeps it', function () {
  /*
   * The other half of the same change. Making the height a minimum must not
   * make every ordinary topbar taller: box-sizing is border-box package-wide,
   * so the padding that gives a wrapped row breathing room sits inside the
   * floor rather than adding to it.
   */
  var bar = el(
    '<div class="shell" style="inline-size:1200px">' +
      '<header class="topbar"><div class="cluster"><span>x</span></div></header>' +
    '</div>',
    '.topbar'
  );

  var want = parseFloat(style(bar, '--topbar-height')) * 16;
  var got  = bar.getBoundingClientRect().height;

  assert.ok(Math.abs(got - want) < 1.5,
    'a topbar that fits should be --topbar-height (' + want + 'px), got ' + got + 'px');

  cleanup();
});

test('frame: and it is still a floor, not a ceiling', function () {
  var narrow = overfullBar('320px').getBoundingClientRect().height;
  var floor  = parseFloat(style(document.body, '--topbar-height')) * 16;

  assert.ok(narrow > floor,
    'an overfull bar should be taller than the floor — floor ' + floor + 'px, got ' + narrow + 'px');

  cleanup();
});

/* ── A button and a control on one row ────────────────────────────── */

test('controls: a .btn and a .field on one row are the same height', function () {
  /*
   * Measured, not declared. The two rules had the same font-size, the same
   * line-height and the same border and DIFFERENT vertical padding — a button
   * at --space-xs, a control at --space-sm — so nothing about either rule read
   * as wrong on its own. In basecamp's filter bar that was three controls at
   * 38px and a submit at 34px, and .cluster centres, so the button sat 2px
   * below the row it belonged to (`FJS-347`).
   */
  var row = el(
    '<div class="cluster">' +
      '<input class="field" style="--field-inline-size:auto">' +
      '<select class="field" style="--field-inline-size:auto"><option>a</option></select>' +
      '<button class="btn">Search</button>' +
    '</div>'
  );

  var input  = row.querySelector('input.field').getBoundingClientRect();
  var select = row.querySelector('select.field').getBoundingClientRect();
  var button = row.querySelector('button.btn').getBoundingClientRect();

  assert.ok(Math.abs(button.height - input.height) < 1,
    'a .btn and an <input class="field"> should be one height — ' +
    'input ' + input.height + 'px, button ' + button.height + 'px');
  assert.ok(Math.abs(button.height - select.height) < 1,
    'and a <select class="field"> too — ' +
    'select ' + select.height + 'px, button ' + button.height + 'px');

  cleanup();
});

test('controls: and .cluster therefore lines their edges up', function () {
  /*
   * The height is the cause; this is the thing anybody actually sees. Equal
   * heights inside a centring row means equal tops and equal bottoms.
   */
  var row = el(
    '<div class="cluster">' +
      '<input class="field" style="--field-inline-size:auto">' +
      '<button class="btn">Search</button>' +
    '</div>'
  );

  var a = row.querySelector('.field').getBoundingClientRect();
  var b = row.querySelector('.btn').getBoundingClientRect();

  assert.ok(Math.abs(a.top - b.top) < 1,
    'tops disagree by ' + Math.abs(a.top - b.top).toFixed(1) + 'px');
  assert.ok(Math.abs(a.bottom - b.bottom) < 1,
    'bottoms disagree by ' + Math.abs(a.bottom - b.bottom).toFixed(1) + 'px');

  cleanup();
});

test('controls: one token moves both, so they cannot drift apart again', function () {
  /*
   * The point of a shared token rather than two rules that happen to agree:
   * an app retuning control height retunes both, and nothing can move one.
   */
  var row = el(
    '<div class="cluster" style="--control-padding-block: 1rem">' +
      '<input class="field" style="--field-inline-size:auto">' +
      '<button class="btn">Search</button>' +
    '</div>'
  );

  var a = row.querySelector('.field').getBoundingClientRect();
  var b = row.querySelector('.btn').getBoundingClientRect();

  assert.ok(Math.abs(a.height - b.height) < 1,
    'retuned, they still agree — field ' + a.height + 'px, button ' + b.height + 'px');
  assert.ok(a.height > 48,
    'and the retune actually moved them — got ' + a.height + 'px');

  cleanup();
});
