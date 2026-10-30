/*
 * cards.spec.js — a box that holds blocks owns the space between them: a
 * Card, the page body (Screen and Container) and a Pane. One rule in
 * cards.css.
 *
 * The failure this holds was invisible to every rule check: a Card set
 * padding and nothing else, so its children sat flush, and the gap a reader
 * saw was a UA `<p>` margin. A card whose heading led into a paragraph looked
 * right; one whose heading led into a table did not, and nothing in the
 * stylesheet was doing anything other than what it said. So these read
 * GEOMETRY — where the second child actually starts.
 */

/*
 * The three owners, each as the element the vocabulary names. A page body was
 * the second place this hole was found: a routed page's Section Header, its
 * filters and its Tiles sat touching in every page that left out a `.stack`.
 */
var FLOW_OWNERS = [['card', 'article'], ['screen', 'main'], ['container', 'div'], ['pane', 'section']];

function flowOpen(owner) {
  var o = FLOW_OWNERS.filter(function (x) { return x[0] === owner; })[0];
  return '<' + o[1] + ' class="' + owner + ' ';
}
function flowClose(owner) {
  return '</' + FLOW_OWNERS.filter(function (x) { return x[0] === owner; })[0][1] + '>';
}

/* Where the second child starts, measured from where the first ends. */
function childGap(cls, owner) {
  owner = owner || 'card';
  var card = el(
    flowOpen(owner) + cls + '">' +
      '<h2 class="h4">Title</h2>' +
      '<div style="block-size:20px">body</div>' +
    flowClose(owner)
  );
  var a = card.children[0].getBoundingClientRect();
  var b = card.children[1].getBoundingClientRect();
  var gap = { block: Math.round(b.top - a.bottom), top: Math.round(b.top - a.top), display: style(card, 'display') };
  cleanup();
  return gap;
}

function rungPx(name) {
  var probe = el('<div style="block-size:var(' + name + ')"></div>');
  var px = Math.round(probe.getBoundingClientRect().height);
  cleanup();
  return px;
}

test('cards: a heading followed by a non-paragraph is spaced at the Stack rung', function () {
  var want = rungPx('--space-2xl');
  assert.ok(want > 0, '--space-2xl did not resolve');
  assert.equal(childGap('').block, want, 'a bare .card left its children flush');
});

test('cards: a Card is spaced the same with or without .stack', function () {
  /*
   * `card stack` was the hand-written fix, forty-odd times. The two must
   * agree, or removing the redundant class moves a screen.
   */
  assert.equal(childGap('stack').block, childGap('').block);
});

test('cards: a Screen, a Container and a Pane space their children as a Card does', function () {
  /*
   * A page whose blocks sit straight in the body, and one that wraps them in
   * `.stack`, must draw alike — or the `.stack` a page forgot is a visible
   * bug again, and the one it remembered is a moved screen.
   */
  var want = childGap('').block;
  FLOW_OWNERS.forEach(function (o) {
    assert.equal(childGap('', o[0]).block, want, 'a bare .' + o[0] + ' left its children flush');
    assert.equal(childGap('stack', o[0]).block, want, '.' + o[0] + '.stack and .' + o[0] + ' disagree');
  });
});

test('cards: a term that arranges children adds no flow margin on a Card, Screen, Container or Pane', function () {
  /*
   * The exclusion list in cards.css is hand-written, so the probe is not: every
   * Layout and Region term with a class is put on a Card, and where that makes
   * the Card a flex or grid container the flow margin must be off. A new
   * arranging term missing from the list lands its second child out of line.
   */
  var bad = [];
  FLOW_OWNERS.forEach(function (o) {
    VOCAB.forEach(function (tier) {
      if (tier[0] !== 'Layout' && tier[0] !== 'Region') return;
      tier[2].forEach(function (row) {
        var cls = vocabClass(row);
        if (!cls) return;
        var card = el(flowOpen(o[0]) + cls + '"><span>a</span><span>b</span>' + flowClose(o[0]));
        var display = style(card, 'display');
        var margin = style(card.children[1], 'margin-block-start');
        cleanup();
        if (/flex|grid/.test(display) && margin !== '0px') {
          bad.push('.' + o[0] + '.' + cls + ' (' + display + ', margin ' + margin + ')');
        }
      });
    });
  });
  assert.equal(
    bad.length,
    0,
    'arranging term not excluded from the flow in cards.css:\n        ' + bad.join('\n        ')
  );
});

test('cards: every Block term inside a Card takes the flow margin', function () {
  /*
   * A term that zeroes its own UA margin does it in a layer AFTER components,
   * so the zero beats the Card's rule outright and that one term sits flush —
   * Facts did, under every heading in basecamp. The element is the one the
   * vocabulary names, built with createElement so the parser cannot drop a
   * table part, and the parent's rung is what it must land at.
   */
  var want = rungPx('--space-2xl') + 'px';
  var bad = [];
  VOCAB.forEach(function (tier) {
    if (tier[0] !== 'Block') return;
    tier[2].forEach(function (row) {
      var cls = vocabClass(row);
      var tag = /<([a-z0-9]+)/.exec(row[1])[1];
      if (!cls || tag === 'tr' || tag === 'li') return; /* a list or table part is never a Card's child */
      var card = el('<article class="card"><h2 class="h4">t</h2></article>');
      var child = document.createElement(tag);
      child.className = cls;
      child.textContent = 'x';
      card.appendChild(child);
      var got = style(child, 'margin-block-start');
      cleanup();
      if (got !== want) bad.push(row[0] + ' <' + tag + ' class="' + cls + '"> — ' + got);
    });
  });
  assert.equal(bad.length, 0, 'Block term sits flush inside a Card (want ' + want + '):\n        ' + bad.join('\n        '));
});

test('cards: a Section Header sits at the rung from its content, in a Stack and in every owner', function () {
  /*
   * The header carried its own `margin-bottom`. In an owner's block flow it
   * collapsed into the flow margin and went unseen; in a Stack it ADDED to the
   * gap, so the heading sat further from its own content than the sections
   * sat from each other. The parent owns the space, so both must land at the
   * rung.
   */
  var want = rungPx('--space-2xl');
  var hosts = FLOW_OWNERS.map(function (o) { return [o[0], flowOpen(o[0]), flowClose(o[0])]; })
    .concat([['stack', '<div class="stack ', '</div>']]);
  var bad = [];
  hosts.forEach(function (h) {
    var box = el(
      h[1] + '"><div class="section-header"><h2>Title</h2></div>' +
      '<div style="block-size:20px">body</div>' + h[2]
    );
    var got = Math.round(box.children[1].getBoundingClientRect().top - box.children[0].getBoundingClientRect().bottom);
    cleanup();
    if (got !== want) bad.push('.' + h[0] + ': ' + got + 'px');
  });
  assert.equal(bad.length, 0, 'Section Header not at the rung (' + want + 'px) from its content:\n        ' + bad.join('\n        '));
});

test('cards: a Section Header wraps its action under the title when the row is too narrow', function () {
  /*
   * FJS-3664: a long title plus an action at phone width squeezed the title to
   * a sliver (or overflowed) because the row never wrapped. Wrapping only
   * changes a header whose content overflows, so one that fits stays on a line.
   */
  var title = 'A very long section title that cannot share a phone-width row with its action';
  var narrow = el(
    '<div style="inline-size:320px"><div class="section-header"><h3>' + title + '</h3>' +
    '<button class="btn">Add something</button></div></div>'
  );
  var h = narrow.querySelector('h3').getBoundingClientRect();
  var b = narrow.querySelector('button').getBoundingClientRect();
  var below = b.top >= h.bottom - 1;
  cleanup();
  assert.ok(below, 'action wraps under the title (title bottom ' + h.bottom + ', action top ' + b.top + ')');

  var wide = el(
    '<div style="inline-size:800px"><div class="section-header"><h3>Tags</h3>' +
    '<button class="btn">Add</button></div></div>'
  );
  var h2 = wide.querySelector('h3').getBoundingClientRect();
  var b2 = wide.querySelector('button').getBoundingClientRect();
  var sameLine = b2.top < h2.bottom;
  cleanup();
  assert.ok(sameLine, 'a header that fits keeps its action on the title line');
});

test('cards: a Section spaces its header from its body, the body\'s blocks from each other, and a nested Section from what is above it', function () {
  /*
   * FJS-3620: SectionHeader drew a header and nothing around it, so every
   * detail page wrote the same column by hand. `.section` owns the space
   * (header to body at the 2xl rung, body blocks at xl) and `.section .section`
   * is the sub-section: more room above it unless it leads, a quieter heading.
   */
  var box = el(
    '<section class="section">' +
      '<div class="section-header"><h2>Outer</h2></div>' +
      '<div class="section-body">' +
        '<div style="block-size:20px">a</div>' +
        '<div style="block-size:20px">b</div>' +
        '<section class="section">' +
          '<div class="section-header"><h3>Inner</h3></div>' +
          '<div class="section-body"><div style="block-size:20px">c</div></div>' +
        '</section>' +
      '</div>' +
    '</section>'
  );
  var head = box.children[0].getBoundingClientRect();
  var body = box.children[1];
  var kids = Array.prototype.map.call(body.children, function (c) { return c.getBoundingClientRect(); });
  var inner = body.children[2];
  var h3 = inner.querySelector('h3');
  var got = {
    display: style(box, 'display'),
    headToBody: Math.round(body.getBoundingClientRect().top - head.bottom),
    between: Math.round(kids[1].top - kids[0].bottom),
    nestedAbove: Math.round(kids[2].top - kids[1].bottom),
    innerHeadToBody: Math.round(inner.children[1].getBoundingClientRect().top - inner.children[0].getBoundingClientRect().bottom),
    innerSize: style(h3, 'font-size'),
    outerSize: style(box.querySelector('h2'), 'font-size'),
  };
  var xl = rungPx('--space-xl'), x2 = rungPx('--space-2xl');
  cleanup();
  assert.equal(got.display, 'flex');
  assert.equal(got.headToBody, x2, 'header to body at the 2xl rung');
  assert.equal(got.between, xl, 'body blocks at the xl rung');
  assert.equal(got.nestedAbove, xl + x2, 'a nested Section takes one more 2xl above it');
  assert.equal(got.innerHeadToBody, xl, 'a nested Section is tighter inside');
  assert.notEqual(got.innerSize, got.outerSize, 'a nested heading is drawn smaller than the outer one');

  var lead = el(
    '<div class="section-body"><section class="section"><div class="section-body"><div>x</div></div></section></div>'
  );
  var top = Math.round(lead.children[0].getBoundingClientRect().top - lead.getBoundingClientRect().top);
  cleanup();
  assert.equal(top, 0, 'a Section that leads its body takes no space above');
});
