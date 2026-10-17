/*
 * lanes.spec.js — a Lane is the vertical counterpart of a Bar (FJS-D524, FJS-1977).
 *
 * A kanban was written with an 18rem literal on every screen that held one
 * because no term named the column: Pane, Section and Group take no tone and
 * none of them fixes a width. These read GEOMETRY, since the failure was a
 * width an app had to invent.
 */

function laneWidth(attrs) {
  var board = el(
    '<div class="lanes">' +
      '<section class="lane" ' + (attrs || '') + '>' +
        '<h3 class="lane-title">Todo</h3>' +
      '</section>' +
      '<section class="lane"><h3 class="lane-title">Done</h3></section>' +
    '</div>'
  );
  var w = board.children[0].getBoundingClientRect().width;
  cleanup();
  return w;
}

test('lanes: a Lane has a width of its own, so an app states none', function () {
  var probe = el('<div style="inline-size:18rem"></div>');
  var want = Math.round(probe.getBoundingClientRect().width);
  cleanup();
  assert.equal(Math.round(laneWidth()), want, 'a bare .lane did not hold 18rem');
});

test('lanes: --lane-size retunes the width', function () {
  assert.equal(Math.round(laneWidth('style="--lane-size: 10rem"')), 160, '--lane-size was ignored');
});

test('lanes: a row of Lanes scrolls instead of wrapping or squeezing', function () {
  var board = el(
    '<div class="lanes" style="inline-size:300px">' +
      '<section class="lane">a</section><section class="lane">b</section><section class="lane">c</section>' +
    '</div>'
  );
  var tops = [].map.call(board.children, function (c) { return Math.round(c.getBoundingClientRect().top); });
  var overflow = style(board, 'overflow-x');
  var scrolls = board.scrollWidth > board.clientWidth;
  cleanup();
  assert.equal(tops[0], tops[2], 'the lanes wrapped onto a second line');
  assert.ok(overflow === 'auto' || overflow === 'scroll', '.lanes did not scroll sideways: ' + overflow);
  assert.ok(scrolls, 'the lanes were squeezed into 300px rather than overflowing');
});

test('lanes: a Lane takes a tone like any surface', function () {
  var plain = el('<section class="lane">x</section>');
  var bg = style(plain, 'background-color');
  cleanup();
  var danger = el('<section class="lane danger">x</section>');
  var toned = style(danger, 'background-color');
  cleanup();
  assert.notEqual(toned, bg, '.lane ignored the danger tone');
});
