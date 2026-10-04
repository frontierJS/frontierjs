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
