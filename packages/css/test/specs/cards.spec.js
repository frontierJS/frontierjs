/*
 * cards.spec.js — a Card owns the space between its children.
 *
 * The failure this holds was invisible to every rule check: a Card set
 * padding and nothing else, so its children sat flush, and the gap a reader
 * saw was a UA `<p>` margin. A card whose heading led into a paragraph looked
 * right; one whose heading led into a table did not, and nothing in the
 * stylesheet was doing anything other than what it said. So these read
 * GEOMETRY — where the second child actually starts.
 */

/* Where the second child starts, measured from where the first ends. */
function childGap(cls) {
  var card = el(
    '<article class="card ' + cls + '">' +
      '<h2 class="h4">Title</h2>' +
      '<div style="block-size:20px">body</div>' +
    '</article>'
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

test('cards: a term that arranges children adds no flow margin on a Card', function () {
  /*
   * The exclusion list in cards.css is hand-written, so the probe is not: every
   * Layout and Region term with a class is put on a Card, and where that makes
   * the Card a flex or grid container the flow margin must be off. A new
   * arranging term missing from the list lands its second child out of line.
   */
  var bad = [];
  VOCAB.forEach(function (tier) {
    if (tier[0] !== 'Layout' && tier[0] !== 'Region') return;
    tier[2].forEach(function (row) {
      var cls = vocabClass(row);
      if (!cls) return;
      var card = el(
        '<article class="card ' + cls + '"><span>a</span><span>b</span></article>'
      );
      var display = style(card, 'display');
      var margin = style(card.children[1], 'margin-block-start');
      cleanup();
      if (/flex|grid/.test(display) && margin !== '0px') {
        bad.push('.' + cls + ' (' + display + ', margin ' + margin + ')');
      }
    });
  });
  assert.equal(
    bad.length,
    0,
    'arranging term not excluded from the Card flow in cards.css:\n        ' + bad.join('\n        ')
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
