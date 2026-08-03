/*
 * tables.spec.js — row tones survive every table variant.
 *
 * A tone is a Treatment class: it is supposed to mean the same thing
 * wherever it lands, and nothing else in the system gets to silently
 * cancel it. `.table.striped` did exactly that. The stripe painted
 * `background` directly on the <td>:
 *
 *   .table.striped tbody tr:nth-child(odd) td   (0,3,3)
 *   .table tbody td                             (0,1,2)   ← the tone tint
 *
 * Same layer, so specificity decided, and a striped table lost its tint on
 * every odd row — the failed row of a striped list rendered exactly like a
 * successful one.
 *
 * The fix is not a specificity bump. Stripe and hover now set the row's
 * *base* color and the tone mixes on top of it, so the two compose instead
 * of competing: one background declaration on the cell, one place that
 * decides what is underneath it.
 */

var ROWS =
  '<table class="table">' +
  '<tbody>' +
  '<tr id="r1"><td>1</td></tr>' +
  '<tr id="r2"><td>2</td></tr>' +
  '<tr id="r3"><td>3</td></tr>' +
  '<tr id="r4"><td>4</td></tr>' +
  '</tbody></table>';

function cellBg(table, rowId) {
  return style(table.querySelector('#' + rowId + ' td'), 'background-color');
}

function rootProp(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

test('table: an untoned row paints the table background', function () {
  var t = el(ROWS);
  assert.sameColor(cellBg(t, 'r1'), rootProp('--surface'), 'plain row is not the surface color');
});

test('table: a tone on a <tr> tints its cells', function () {
  var t = el(ROWS.replace('id="r2"', 'id="r2" class="danger"'));
  assert.differentColor(
    cellBg(t, 'r2'),
    rootProp('--surface'),
    'a .danger row was not tinted at all'
  );
});

test('table: all seven tones tint a row', function () {
  /*
   * The tint derives from --bg-mix with no tone-name list, so this is
   * really asserting that no consumer has re-introduced one. Before v0.6
   * tables supported four of the seven and .muted/.secondary were silent
   * no-ops.
   */
  var tones = ['primary', 'secondary', 'muted', 'info', 'success', 'warning', 'danger'];
  var seen = {};
  tones.forEach(function (tone) {
    var t = el(ROWS.replace('id="r2"', 'id="r2" class="' + tone + '"'));
    var bg = cellBg(t, 'r2');
    assert.differentColor(bg, rootProp('--surface'), '.' + tone + ' row was not tinted');
    var key = toRGB(bg).join(',');
    assert.notOk(seen[key], '.' + tone + ' tinted identically to .' + seen[key]);
    seen[key] = tone;
    cleanup();
  });
});

/* ── The regression ──────────────────────────────────────────────────*/

test('table: .striped stripes the odd rows', function () {
  var t = el(ROWS.replace('class="table"', 'class="table striped"'));
  assert.sameColor(cellBg(t, 'r1'), rootProp('--surface-sunken'), 'odd row is not striped');
  assert.sameColor(cellBg(t, 'r2'), rootProp('--surface'), 'even row should not be striped');
});

test('table: a tone survives .striped on an odd row', function () {
  /*
   * The regression. r1 and r3 are the odd rows — the ones the stripe used
   * to overwrite. A toned row must read as toned in a striped table, or the
   * tone is not a Treatment class.
   */
  var t = el(
    ROWS.replace('class="table"', 'class="table striped"').replace('id="r1"', 'id="r1" class="danger"')
  );
  var toned = cellBg(t, 'r1');
  var plainStripe = cellBg(t, 'r3');

  assert.differentColor(
    toned,
    plainStripe,
    'a .danger row on an odd stripe is indistinguishable from an untoned striped row'
  );
});

test('table: a tone survives .striped on an even row too', function () {
  var t = el(
    ROWS.replace('class="table"', 'class="table striped"').replace('id="r2"', 'id="r2" class="danger"')
  );
  assert.differentColor(
    cellBg(t, 'r2'),
    cellBg(t, 'r4'),
    'a .danger row on an even stripe was not tinted'
  );
});

test('table: the stripe still shows through beneath a tone', function () {
  /*
   * Composition, not override: the tone mixes into whatever the row's base
   * is, so the same tone lands on a slightly different color on a striped
   * row than on a plain one. If these came out identical the stripe would
   * have been discarded rather than mixed with.
   */
  var striped = el(
    ROWS.replace('class="table"', 'class="table striped"').replace('id="r1"', 'id="r1" class="danger"')
  );
  var onStripe = cellBg(striped, 'r1');
  cleanup();

  var plain = el(ROWS.replace('id="r1"', 'id="r1" class="danger"'));
  var onPlain = cellBg(plain, 'r1');

  assert.differentColor(
    onStripe,
    onPlain,
    'the tone ignored the stripe underneath it instead of mixing with it'
  );
});

test('table: all seven tones survive .striped', function () {
  var tones = ['primary', 'secondary', 'muted', 'info', 'success', 'warning', 'danger'];
  tones.forEach(function (tone) {
    var t = el(
      ROWS.replace('class="table"', 'class="table striped"').replace('id="r1"', 'id="r1" class="' + tone + '"')
    );
    assert.differentColor(
      cellBg(t, 'r1'),
      cellBg(t, 'r3'),
      '.' + tone + ' is invisible on a striped odd row'
    );
    cleanup();
  });
});

test('table: .compact and .hover do not disturb row tones', function () {
  var t = el(
    ROWS.replace('class="table"', 'class="table compact hover striped"')
      .replace('id="r1"', 'id="r1" class="success"')
  );
  assert.differentColor(
    cellBg(t, 'r1'),
    cellBg(t, 'r3'),
    'a tone was lost once .compact and .hover joined .striped'
  );
});
