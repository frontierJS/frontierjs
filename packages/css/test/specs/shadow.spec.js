/*
 * shadow.spec.js — the kit inside a shadow root computes what it computes in
 * a page (FJS-1989).
 *
 * A Sierra widget folds this package into its script and adopts it into a
 * shadow root, on a page that never loaded it. Two things then differ from
 * the page this suite normally runs in, and neither shows up there:
 *
 *   an `@property` rule in a shadow root's stylesheet is ignored, so every
 *   registered token is an ordinary inheriting property with no initial
 *   value — measured, `--density` was empty and every padding and gap in
 *   the kit computed to 0
 *
 *   `*` does not match the host, so a token `:root, :host` builds from a
 *   rung resolved where no rung exists
 *
 * So the test needs a document with NO registrations: a registration is the
 * document's, and this page's own <link> would register them for any shadow
 * root on it. An about:blank iframe is a second document, available
 * synchronously. Its <html> carries hostile values for the same tokens,
 * because a host inherits the page's custom properties and a widget is
 * dropped onto pages nobody vetted.
 *
 * The sheet is this page's index.css, flattened: `replaceSync` refuses
 * @import, and an import's layer has to be kept as an `@layer` block or the
 * cascade inside the shadow root is a different one.
 */

/*
 * Two pages: a bare one, where an unregistered token has no value at all, and
 * a hostile one, whose <html> sets the same tokens — a host inherits the
 * page's custom properties, and the two fail differently (0px against 60px
 * for a card's padding, measured before the fix).
 */
var SHADOW_PAGES = {
  bare: '',
  hostile: '--density: 3; --space-sm: 40px; --control-padding-block: 40px; --bg-mix: red; --ring-style: dotted',
};
var shadowFrames = {};

function shadowSheetText() {
  function flatten(list) {
    var out = '';
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      if (window.CSSImportRule && r instanceof CSSImportRule) {
        var inner = flatten(r.styleSheet.cssRules);
        out += r.layerName != null ? '@layer ' + r.layerName + ' {\n' + inner + '}\n' : inner;
      } else {
        out += r.cssText + '\n';
      }
    }
    return out;
  }
  for (var s = 0; s < document.styleSheets.length; s++) {
    var sheet = document.styleSheets[s];
    if (sheet.href && /\/index\.css$/.test(sheet.href)) return flatten(sheet.cssRules);
  }
  throw new Error('index.css is not on the page');
}

/* A shadow root inside a document with nothing registered. Built once per page. */
function shadowRoot(kind) {
  if (shadowFrames[kind]) return shadowFrames[kind];
  var frame = document.createElement('iframe');
  frame.style.cssText = 'position:absolute;inset-inline-start:-10000px;inline-size:1200px;block-size:800px;border:0';
  document.body.appendChild(frame);
  var doc = frame.contentDocument;
  doc.documentElement.style.cssText = SHADOW_PAGES[kind];
  var host = doc.body.appendChild(doc.createElement('div'));
  var root = host.attachShadow({ mode: 'open' });
  var sheet = new frame.contentWindow.CSSStyleSheet();
  sheet.replaceSync(shadowSheetText());
  root.adoptedStyleSheets = [sheet];
  shadowFrames[kind] = { doc: doc, root: root };
  return shadowFrames[kind];
}

/*
 * Mount the same markup in this page and in a shadow root on each of the
 * two pages. Returns { page, shadows: [{ kind, node }] }.
 */
function shadowPair(html, selector) {
  var page = el(html, selector);
  var shadows = Object.keys(SHADOW_PAGES).map(function (kind) {
    var f = shadowRoot(kind);
    var wrap = f.doc.createElement('div');
    wrap.innerHTML = html.trim();
    var node = f.root.appendChild(wrap.firstElementChild);
    return { kind: kind, node: selector ? node.querySelector(selector) : node };
  });
  return { page: page, shadows: shadows };
}

function shadowStyle(node, name) {
  return node.ownerDocument.defaultView.getComputedStyle(node).getPropertyValue(name).trim();
}

function shadowCleanup() {
  Object.keys(shadowFrames).forEach(function (k) { shadowFrames[k].root.replaceChildren(); });
  cleanup();
}

test('shadow: the iframes really have nothing registered', function () {
  /*
   * The premise. If an iframe ever inherited this page's registrations the
   * rest of this file would pass for the wrong reason: --bg-mix is
   * `inherits: false` here, so a hostile page's red reaching a child of its
   * <html> means it is unregistered there.
   */
  var f = shadowRoot('hostile');
  var p = f.doc.body.appendChild(f.doc.createElement('p'));
  assert.equal(shadowStyle(p, '--bg-mix'), 'red',
    '--bg-mix did not inherit in the iframe, so it is registered there');
  p.remove();
});

test('shadow: every registered token computes as it does in the document', function () {
  /*
   * Driven off the CSSOM, so a token registered tomorrow is covered without
   * an edit here. Each is read on an untoned element, on a toned one, on a
   * child of a toned one (where `inherits: false` is the whole point), and
   * inside `.dense`.
   */
  var names = allRules()
    .filter(function (r) { return window.CSSPropertyRule && r instanceof CSSPropertyRule; })
    .map(function (r) { return r.name; });
  assert.atLeast(names.length, 8, 'found too few @property rules to mean anything');

  var cases = [
    ['<div>x</div>', null, 'a plain element'],
    ['<div class="alert danger"><button class="btn">x</button></div>', null, 'a toned element'],
    ['<div class="alert danger"><button class="btn">x</button></div>', '.btn', 'the child of a toned element'],
    ['<div class="card danger"><span class="pill">3</span></div>', '.pill', 'a pill in a toned card'],
    ['<div class="dense"><div class="card">x</div></div>', '.card', 'a card inside .dense'],
    ['<input class="field">', null, 'a field'],
  ];

  var bad = [];
  cases.forEach(function (c) {
    var pair = shadowPair(c[0], c[1]);
    names.forEach(function (n) {
      var want = prop(pair.page, n);
      pair.shadows.forEach(function (sh) {
        var got = shadowStyle(sh.node, n);
        if (want !== got) {
          bad.push(n + ' on ' + c[2] + ', ' + sh.kind + ' page: ' + JSON.stringify(want) + ' in the page, ' + JSON.stringify(got) + ' in the shadow root');
        }
      });
    });
    shadowCleanup();
  });
  assert.equal(bad.join('\n'), '', 'registered tokens differ inside a shadow root');
});

test('shadow: cards, stacks, buttons and fields keep their space', function () {
  /*
   * The row as it was reported, measured where a reader sees it: every
   * padding and gap was 0 in a widget on a bare page, and on the hostile one
   * a button took the page's 40px through `--control-padding-block`.
   */
  var cases = [
    ['<article class="card">x</article>', null, ['padding-top', 'padding-left']],
    ['<div class="dense"><article class="card">x</article></div>', '.card', ['padding-top']],
    ['<div class="stack"><p>a</p><p>b</p></div>', null, ['row-gap']],
    ['<button class="btn">Go</button>', null, ['padding-top', 'padding-left']],
    ['<input class="field">', null, ['padding-top', 'padding-left']],
    ['<div class="cluster"><span>a</span><span>b</span></div>', null, ['column-gap']],
  ];
  var bad = [];
  cases.forEach(function (c) {
    var pair = shadowPair(c[0], c[1]);
    c[2].forEach(function (p) {
      var want = style(pair.page, p);
      assert.ok(want && want !== '0px' && want !== 'normal', c[0] + ' ' + p + ' is empty in the page itself: ' + want);
      pair.shadows.forEach(function (sh) {
        var got = shadowStyle(sh.node, p);
        if (got !== want) bad.push(c[0] + ' ' + p + ', ' + sh.kind + ' page: ' + want + ' in the page, ' + got + ' in the shadow root');
      });
    });
    shadowCleanup();
  });
  assert.equal(bad.join('\n'), '', 'the kit lost its space inside a shadow root');
});

test('shadow: a tone stays on the element that declares it', function () {
  /*
   * `inherits: false` is gone in a shadow tree, so without the reset the
   * button inside a danger Alert takes the Alert's red. Compared as colors
   * against the same markup in the page.
   */
  var pair = shadowPair('<div class="alert danger"><button class="btn">Undo</button></div>', '.btn');
  pair.shadows.forEach(function (sh) {
    ['background-color', 'color'].forEach(function (p) {
      assert.sameColor(shadowStyle(sh.node, p), style(pair.page, p),
        'a button inside a danger Alert, ' + sh.kind + ' page: ' + p);
    });
  });
  shadowCleanup();
});

test('shadow: a focus ring is drawn', function () {
  /*
   * --ring-style is registered with an initial value of solid. Unregistered
   * and unset, `outline: var(--ring-width) var(--ring-style) …` is invalid
   * and there is no ring at all. Read through a use site, since a focus
   * state cannot be held across two documents here.
   */
  var pair = shadowPair('<span style="outline: 2px var(--ring-style) red">x</span>');
  assert.equal(style(pair.page, 'outline-style'), 'solid', 'the page ring style');
  pair.shadows.forEach(function (sh) {
    assert.equal(shadowStyle(sh.node, 'outline-style'), 'solid', 'the ring style, ' + sh.kind + ' page');
  });
  shadowCleanup();
});
