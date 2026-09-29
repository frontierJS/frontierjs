/*
 * layout.spec.js — the composition helpers, graded by geometry.
 *
 * A Cluster centers its items, and a `.field-group` is a label stacked over
 * a control, so a button beside a labeled input sat halfway down the label.
 * Every declaration was doing what it said; only coordinates show it.
 */

function fieldRow(extra) {
  return el(
    '<div class="cluster"' + (extra || '') + '>' +
      '<div class="field-group">' +
        '<label for="lay-a">Lines</label>' +
        '<input class="field" id="lay-a">' +
      '</div>' +
      '<button class="btn">Read log</button>' +
    '</div>'
  );
}

test('layout: a button beside a labeled field lines up with the control', function () {
  var row = fieldRow();
  var input  = row.querySelector('input').getBoundingClientRect();
  var button = row.querySelector('button').getBoundingClientRect();

  assert.ok(
    Math.abs(input.top - button.top) < 1 && Math.abs(input.bottom - button.bottom) < 1,
    'button ' + Math.round(button.top) + '–' + Math.round(button.bottom) +
    ' should match the input ' + Math.round(input.top) + '–' + Math.round(input.bottom)
  );

  cleanup();
});

test('layout: a Cluster with no field still centers', function () {
  var row = el(
    '<div class="cluster"><span class="badge">x</span><button class="btn">Go</button></div>'
  );
  assert.equal(style(row, 'align-items'), 'center');
  cleanup();
});

test('layout: an app override on a field Cluster still wins', function () {
  var row = fieldRow(' style="align-items: flex-start"');
  assert.equal(style(row, 'align-items'), 'flex-start');
  cleanup();
});
