/*
 * rows.spec.js — a Row takes its current state from [aria-current].
 *
 * Tabs, steps, breadcrumbs, pagination and navlinks all paint the active
 * item from `aria-current`, so the announced state and the painted state
 * cannot drift. A Row did not: an app marking the selected message styled
 * it locally, with a selector of its own.
 */

var LIST =
  '<ul class="rows">' +
  '<li class="list-row" id="r1">One</li>' +
  '<li class="list-row" id="r2">Two</li>' +
  '</ul>';

function rowBg(list, id) {
  return style(list.querySelector('#' + id), 'background-color');
}

test('row: aria-current="true" paints the selected row', function () {
  var l = el(LIST.replace('id="r2"', 'id="r2" aria-current="true"'));
  assert.differentColor(rowBg(l, 'r2'), rowBg(l, 'r1'), 'the current row looks like any other');
});

test('row: aria-current="page" paints the current row too', function () {
  var l = el(LIST.replace('id="r2"', 'id="r2" aria-current="page"'));
  assert.differentColor(rowBg(l, 'r2'), rowBg(l, 'r1'), 'a page-current row is unpainted');
});

test('row: aria-current="false" is not current', function () {
  var l = el(LIST.replace('id="r2"', 'id="r2" aria-current="false"'));
  assert.sameColor(rowBg(l, 'r2'), rowBg(l, 'r1'), 'aria-current="false" painted a row');
});
