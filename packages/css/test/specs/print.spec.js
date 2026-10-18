/*
 * print.spec.js — what the browser's own Print draws (`FJS-2677`).
 *
 * Page JS cannot switch a document to print media, so the `@media print`
 * rules are lifted out of their wrapper and applied to the screen, in the
 * layer they ship in. What is asserted is the computed result of the paper's
 * rules on a real shell, not that a declaration is present.
 */

function applyPrint() {
  var inner = [];
  allRules().forEach(function (r) {
    if (window.CSSMediaRule && r instanceof CSSMediaRule && r.media.mediaText === 'print') {
      for (var i = 0; i < r.cssRules.length; i++) inner.push(r.cssRules[i].cssText);
    }
  });
  assert.ok(inner.length > 0, 'the package ships no @media print rule');
  var style = document.createElement('style');
  style.setAttribute('data-print', '');
  style.textContent = '@layer utilities {' + inner.join('\n') + '}';
  document.head.appendChild(style);
  return style;
}

test('print: the shell chrome is not printed, the page is', function () {
  var host = el(
    '<div class="app"><div class="shell viewport" style="inline-size:1000px">' +
      '<header class="topbar"><button class="btn sidebar-toggle">Menu</button></header>' +
      '<nav class="sidebar">nav</nav>' +
      '<main class="screen">' +
        '<div class="toolbar" role="toolbar"><input class="field"></div>' +
        '<h1>Surveys</h1>' +
        '<div class="table-wrap"><table class="table"><tbody><tr><td>one</td></tr></tbody></table></div>' +
        '<nav class="pagination" aria-label="Pagination"></nav>' +
      '</main></div></div>',
    '.shell'
  );
  var q = function (s) { return host.querySelector(s); };
  var style = applyPrint();
  try {

  ['.topbar', '.sidebar', '.sidebar-toggle', '.toolbar', '.pagination'].forEach(function (s) {
    assert.equal(getComputedStyle(q(s)).display, 'none', s + ' prints');
  });
  assert.notEqual(getComputedStyle(q('.screen')).display, 'none', 'the Screen must print');
  assert.notEqual(getComputedStyle(q('table')).display, 'none', 'the Table must print');

  /* The Screen is the page: no viewport-high box, no inner scroller. */
  assert.equal(getComputedStyle(host).overflow, 'visible', 'the viewport shell clips the print');
  assert.equal(getComputedStyle(q('.screen')).overflowY, 'visible', 'the Screen scrolls instead of flowing');
  assert.equal(getComputedStyle(q('.screen')).paddingTop, '0px', 'the Screen keeps its screen padding');
  } finally {
    style.remove();
    cleanup();
  }
});

test('print: a row and a card are not cut across pages', function () {
  var host = el(
    '<div><article class="card">c</article><table><tbody><tr><td>r</td></tr></tbody></table></div>'
  );
  var style = applyPrint();
  try {
    assert.equal(getComputedStyle(host.querySelector('.card')).breakInside, 'avoid');
    assert.equal(getComputedStyle(host.querySelector('tr')).breakInside, 'avoid');
  } finally {
    style.remove();
    cleanup();
  }
});
