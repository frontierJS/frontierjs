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

/* ── Switcher ─────────────────────────────────────────────────────── */

function switcherBoxes(width, attrs, kids) {
  var host = el('<div style="inline-size: ' + width + 'px"><div class="switcher"' + attrs + '>' +
    kids + '</div></div>', '.switcher');
  return Array.prototype.map.call(host.children, function (c) { return c.getBoundingClientRect(); });
}

function switcherSideBySide(r) { return r[0].top === r[1].top && r[1].left > r[0].right }
function switcherStacked(r, width) {
  return r[1].top >= r[0].bottom && Math.round(r[0].width) === width && Math.round(r[1].width) === width
}

test('layout: a Switcher sits side by side above --switch-at and stacks below it', function () {
  var kids = '<div>a</div><div>b</div>';
  var wide = switcherBoxes(900, ' style="--switch-at: 48rem"', kids);
  var narrow = switcherBoxes(500, ' style="--switch-at: 48rem"', kids);
  assert.ok(switcherSideBySide(wide), 'two children share a row in 900px');
  assert.ok(switcherStacked(narrow, 500), 'two children stack in 500px at ' +
    Math.round(narrow[0].width) + 'px and ' + Math.round(narrow[1].width) + 'px');
  assert.ok(switcherSideBySide(switcherBoxes(500, ' style="--switch-at: 20rem"', kids)),
    'a lower --switch-at keeps the same 500px side by side');
  cleanup();
});

test('layout: a Switcher measures its container, not the viewport', function () {
  assert.ok(window.innerWidth > 500, 'the viewport is wider than the wrapper (' + window.innerWidth + 'px)');
  var r = switcherBoxes(500, ' style="--switch-at: 40rem"', '<div>a</div><div>b</div>');
  assert.ok(switcherStacked(r, 500), 'a 500px wrapper stacks at 40rem in a ' + window.innerWidth + 'px viewport');
  cleanup();
});

test('layout: --fr weights a Switcher child', function () {
  var r = switcherBoxes(900, '', '<div style="--fr: 2">a</div><div style="--fr: 1">b</div>');
  var gap = r[1].left - r[0].right;
  var ratio = r[0].width / r[1].width;
  assert.ok(switcherSideBySide(r) && Math.abs(ratio - 2) < 0.05,
    'widths ' + Math.round(r[0].width) + ' : ' + Math.round(r[1].width) + ' (gap ' + Math.round(gap) + ')');
  cleanup();
});

test('layout: --side makes a Switcher child a rail and the other fills the rest', function () {
  var kids = '<div style="--side: 16rem">rail</div><div>main</div>';
  var wide = switcherBoxes(900, '', kids);
  var gap = wide[1].left - wide[0].right;
  assert.ok(switcherSideBySide(wide) && Math.round(wide[0].width) === 256, 'rail is ' + Math.round(wide[0].width) + 'px');
  assert.equal(Math.round(wide[1].width), 900 - 256 - Math.round(gap), 'main takes the remainder');
  var narrow = switcherBoxes(500, '', kids);
  assert.ok(switcherStacked(narrow, 500), 'rail and main stack full width in 500px: ' +
    Math.round(narrow[0].width) + ', ' + Math.round(narrow[1].width));
  cleanup();
});

test('layout: a rail is a child with an inline --side:, so a --sidebar-width or a class does not make one', function () {
  var style = el('<style>.switcher-rail-by-class { --side: 16rem }</style>');
  var r = switcherBoxes(900, '', '<div style="--sidebar-width: 16rem">a</div><div>b</div>');
  assert.ok(switcherSideBySide(r) && Math.abs(r[0].width - r[1].width) < 1,
    'an inline --sidebar-width is not a --side: both children grow, measured ' +
    Math.round(r[0].width) + ' and ' + Math.round(r[1].width));
  var c = switcherBoxes(900, '', '<div class="switcher-rail-by-class">a</div><div>b</div>');
  assert.ok(switcherSideBySide(c) && c[0].width > 256 + 1,
    'a --side set from a stylesheet is the floor, and the child still grows: ' + Math.round(c[0].width) + 'px');
  style.remove();
  cleanup();
});

test('layout: a Switcher inside a centered Stack keeps the full width and stays side by side', function () {
  var stack = el('<div class="stack align-center" style="inline-size: 900px">' +
    '<div class="switcher" style="--switch-at: 48rem"><div>a</div><div>b</div></div></div>');
  var sw = stack.querySelector('.switcher');
  var r = Array.prototype.map.call(sw.children, function (c) { return c.getBoundingClientRect(); });
  assert.equal(Math.round(sw.getBoundingClientRect().width), 900,
    'a centered Stack shrinks its children to content, and 100% in the basis then measures the shrunken box');
  assert.ok(switcherSideBySide(r), 'two children share a row in a 900px centered Stack');
  cleanup();
});

test('layout: a Switcher inside a rail does not hand its children the rail width', function () {
  var host = el('<div style="inline-size: 900px"><div class="switcher">' +
    '<div style="--side: 16rem"><div class="switcher" style="--switch-at: 1rem"><div>x</div><div>y</div></div></div>' +
    '<div>main</div></div></div>');
  var inner = host.querySelectorAll('.switcher .switcher > div');
  var a = inner[0].getBoundingClientRect(), b = inner[1].getBoundingClientRect();
  assert.ok(a.top === b.top && a.width < 256 / 2 + 1, 'inner children measure ' +
    Math.round(a.width) + 'px and ' + Math.round(b.width) + 'px inside a 256px rail');
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

/* ── The page holds still ─────────────────────────────────────────── */

test('layout: the root reserves its scrollbar gutter, so a short page does not shift', function () {
  assert.equal(style(document.documentElement, 'scrollbar-gutter'), 'stable');
});

test('layout: a chip holding a sentence wraps with .wrap and widens its box without', function () {
  var sentence = 'Should invoices go out on the first of the month or on each order?';
  var box = el(
    '<div style="inline-size: 200px">' +
      '<button class="btn">' + sentence + '</button>' +
      '<button class="btn wrap">' + sentence + '</button>' +
      '<span class="badge wrap">' + sentence + '</span>' +
    '</div>'
  );
  var b = box.querySelectorAll('button, .badge');
  assert.ok(b[0].getBoundingClientRect().width > 200,
    'a plain .btn keeps one line, ' + Math.round(b[0].getBoundingClientRect().width) + 'px');
  assert.ok(b[1].getBoundingClientRect().width <= 200,
    '.btn.wrap fits its box, ' + Math.round(b[1].getBoundingClientRect().width) + 'px');
  assert.ok(b[2].getBoundingClientRect().width <= 200,
    '.badge.wrap fits its box, ' + Math.round(b[2].getBoundingClientRect().width) + 'px');
  cleanup();
});

/* ── [hidden] ─────────────────────────────────────────────────────── */

test('layout: a hidden Stack, Cluster, Group, Center, Split, Grid or Switcher is not displayed', function () {
  ['stack', 'cluster', 'group', 'center', 'split', 'grid', 'switcher'].forEach(function (term) {
    var node = el('<div class="' + term + '" hidden><span>x</span></div>');
    assert.equal(style(node, 'display'), 'none',
      '.' + term + ' states a display, which beats the UA rule behind [hidden]');
    cleanup();
  });
});

/* ── Spare ────────────────────────────────────────────────────────── */

/*
 * `.spare` drops below sm or inside a narrow `fjs` container. The test page
 * is wide, so the viewport branch is read from the rule text and the
 * container branch is measured, in a box of each width.
 */
function spareIn(width, cls) {
  var tag = cls === 'btn' ? 'button' : 'div';
  return el(
    '<div style="container: fjs / inline-size; inline-size: ' + width + 'px">' +
      '<' + tag + ' class="' + cls + ' spare">x</' + tag + '>' +
    '</div>',
    '.spare'
  );
}

test('spare: a Cluster and a Button vanish inside a narrow fjs container', function () {
  ['cluster', 'btn'].forEach(function (cls) {
    assert.equal(style(spareIn(400, cls), 'display'), 'none',
      '.' + cls + '.spare still draws in a 400px container, which .cluster/.btn display beats');
    cleanup();
  });
});

test('spare: the same two stay in a wide fjs container', function () {
  ['cluster', 'btn'].forEach(function (cls) {
    assert.notEqual(style(spareIn(600, cls), 'display'), 'none', '.' + cls + '.spare is gone from a 600px container');
    cleanup();
  });
});

test('spare: the viewport branch is the sm step', function () {
  assert.ok(innerWidth >= 640, 'this page is a wide viewport, so the branch is read rather than measured');
  var media = allRules().filter(function (r) {
    return window.CSSMediaRule && r instanceof CSSMediaRule &&
      /max-width:\s*639px/.test(r.conditionText || r.media.mediaText) &&
      Array.prototype.some.call(r.cssRules, function (c) {
        return c.selectorText === '.spare' && /display:\s*none/.test(c.cssText);
      });
  });
  assert.equal(media.length, 1, 'expected one `@media (max-width: 639px) { .spare { display: none } }`, found ' + media.length);
});
