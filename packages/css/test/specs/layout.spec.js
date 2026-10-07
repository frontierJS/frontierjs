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

/* ── Grid ─────────────────────────────────────────────────────────── */

function gridColumns(grid) {
  var tops = {};
  Array.prototype.forEach.call(grid.children, function (c) {
    var top = Math.round(c.getBoundingClientRect().top);
    tops[top] = (tops[top] || 0) + 1;
  });
  return Math.max.apply(null, Object.keys(tops).map(function (k) { return tops[k]; }));
}

test('layout: a Grid derives its column count from the width', function () {
  var cards = '<article class="card">a</article><article class="card">b</article>' +
    '<article class="card">c</article><article class="card">d</article>';
  var wide = el('<div style="inline-size: 900px"><div class="grid" style="--grid-min: 12rem">' + cards + '</div></div>', '.grid');
  var narrow = el('<div style="inline-size: 420px"><div class="grid" style="--grid-min: 12rem">' + cards + '</div></div>', '.grid');

  assert.equal(gridColumns(wide), 4, 'four 12rem columns fit in 900px');
  assert.equal(gridColumns(narrow), 2, 'two 12rem columns fit in 420px');
  cleanup();
});

test('layout: a Grid narrower than its floor is one column and does not overflow', function () {
  var box = el('<div style="inline-size: 200px"><div class="grid">' +
    '<article class="card">a</article><article class="card">b</article></div></div>');
  var grid = box.querySelector('.grid');

  assert.equal(gridColumns(grid), 1);
  assert.ok(grid.scrollWidth <= 200, 'a 16rem floor in a 200px box measured ' + grid.scrollWidth + 'px');
  cleanup();
});

test('layout: a Grid inside a centered Stack keeps the full width', function () {
  var stack = el('<div class="stack align-center" style="inline-size: 900px">' +
    '<div class="grid"><article class="card">a</article><article class="card">b</article></div></div>');
  var grid = stack.querySelector('.grid');
  assert.equal(Math.round(grid.getBoundingClientRect().width), 900,
    'a centered Stack shrinks its children to content, and an auto-fit grid shrinks to one column');
  cleanup();
});

/* ── The align axis ───────────────────────────────────────────────── */

test('align: a centered region centers its text, a Stack child and a Cluster', function () {
  var region = el('<div class="align-center" style="inline-size: 600px">' +
    '<div class="stack"><p>Some text</p><button class="btn">Go</button>' +
    '<div class="cluster"><span class="badge">a</span></div></div></div>');
  var box = region.getBoundingClientRect();
  var btn = region.querySelector('.btn').getBoundingClientRect();
  var badge = region.querySelector('.badge').getBoundingClientRect();

  assert.equal(style(region.querySelector('p'), 'text-align'), 'center', 'text-align inherits');
  assert.ok(btn.width < box.width / 2, 'a Stack child shrinks to its content rather than stretching');
  assert.ok(Math.abs((btn.left - box.left) - (box.right - btn.right)) < 1,
    'a Stack child sits centered: ' + Math.round(btn.left - box.left) + ' vs ' + Math.round(box.right - btn.right));
  assert.ok(Math.abs((badge.left - box.left) - (box.right - badge.right)) < 1, 'a Cluster packs to the center');
  cleanup();
});

test('align: with no axis set, a Stack stretches, a Bar splits and a Toolbar packs to the start', function () {
  var stack = el('<div class="stack" style="inline-size: 600px"><button class="btn">Go</button></div>');
  assert.equal(Math.round(stack.querySelector('.btn').getBoundingClientRect().width), 600);
  assert.equal(style(el('<div class="bar"></div>'), 'justify-content'), 'space-between');
  assert.equal(style(el('<div class="toolbar" role="toolbar"></div>'), 'justify-content'), 'flex-start');
  cleanup();
});

test('align: a Bar inside a centered region is centered, and on itself takes the axis', function () {
  var inherited = el('<div class="align-center"><div class="bar"><button class="btn">A</button></div></div>', '.bar');
  assert.equal(style(inherited, 'justify-content'), 'center');
  assert.equal(style(el('<div class="bar align-end"></div>'), 'justify-content'), 'end');
  cleanup();
});

test('align: align-start undoes an ancestor, back to the default and not to a shrunk start', function () {
  var region = el('<div class="align-center" style="inline-size: 600px">' +
    '<div class="stack align-start"><button class="btn">Go</button></div>' +
    '<div class="bar align-start"><span>a</span></div></div>');
  assert.equal(Math.round(region.querySelector('.btn').getBoundingClientRect().width), 600,
    'a Stack under align-start stretches its children, as one nobody aligned does');
  assert.equal(style(region.querySelector('.stack'), 'text-align'), 'start');
  assert.equal(style(region.querySelector('.bar'), 'justify-content'), 'normal',
    'a one-group Bar under align-start packs to the start');
  cleanup();
});

test('align: an Overlay does not inherit the region it is declared in', function () {
  var region = el('<div class="align-center">' +
    '<span class="popover-anchor"><button class="btn">Menu</button>' +
    '<div class="popover align-end"><p>Item</p></div></span></div>');
  var pop = region.querySelector('.popover');
  assert.equal(style(pop.querySelector('p'), 'text-align'), 'start');
  assert.equal(prop(pop, '--align'), '', 'the axis is reset on the overlay');
  assert.ok(pop.matches('.popover-anchor > .popover.align-end:not([popover])'),
    'align-end on a Popover still places it against the end edge');
  cleanup();
});
