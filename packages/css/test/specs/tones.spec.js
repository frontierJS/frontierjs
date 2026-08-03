/*
 * tones.spec.js — a tone is a Treatment class, so it works everywhere.
 *
 * This is the invariant the v0.6 tone work was for, and the one most
 * likely to rot: before it, surface.css, form-core.css, tables.css and
 * dialogs.css each enumerated a *different subset* of the seven tones, so
 * `.muted` on a card and `.secondary` on a dialog were silent no-ops. The
 * class composed in the documentation and not in the browser.
 *
 * The rule these tests enforce: if a consumer reads --bg-mix, it takes all
 * seven tones or it is a bug. Adding a tone must stay a one-line change in
 * tones.css with zero component edits — which is only true as long as no
 * component names a tone.
 */

var TONES = ['primary', 'secondary', 'muted', 'info', 'success', 'warning', 'danger'];

/*
 * Every consumer that reads a tone, with the markup it contracts for and
 * the property the tone is supposed to move. A component that starts
 * reading --bg-mix belongs in this list.
 */
var CONSUMERS = [
  { name: '.card', html: '<article class="card TONE">body</article>', prop: 'background-color' },
  { name: '.tile', html: '<article class="tile TONE">body</article>', prop: 'background-color' },
  { name: '.alert', html: '<article class="alert TONE">body</article>', prop: 'background-color' },
  { name: '.toast', html: '<article class="toast TONE">body</article>', prop: 'background-color' },
  { name: '.popover', html: '<article class="popover TONE">body</article>', prop: 'background-color' },
  { name: '.btn', html: '<button class="btn TONE">Save</button>', prop: 'background-color' },
  { name: '.pill', html: '<span class="pill TONE">3</span>', prop: 'background-color' },
  { name: '.badge', html: '<span class="badge TONE">New</span>', prop: 'background-color' },
  { name: '.avatar', html: '<span class="avatar TONE">DO</span>', prop: 'background-color' },
  { name: '.link', html: '<a class="link TONE" href="#x">Read</a>', prop: 'color' },
  { name: '.field', html: '<input class="field TONE" type="text">', prop: 'border-top-color' },
  { name: '.field-hint', html: '<p class="field-hint TONE">Hint</p>', prop: 'color' },
  {
    name: '.btn.outlined',
    html: '<button class="btn outlined TONE">Save</button>',
    prop: 'border-top-color',
  },
];

CONSUMERS.forEach(function (consumer) {
  test('tone: ' + consumer.name + ' honours all seven tones', function () {
    var untoned = el(consumer.html.replace(' TONE', ''));
    var base = style(untoned, consumer.prop);
    cleanup();

    /*
     * Distinctness is the real invariant, not "differs from untoned". Most
     * consumers have a tone as their own default — an untoned .btn is
     * already primary, an untoned .pill is already muted — so exactly one
     * tone is allowed to coincide with the base. Two tones rendering
     * identically is the failure, whether or not either matches the
     * default: two tones the user cannot tell apart are one tone.
     */
    var seen = {};
    var matchedBase = [];

    TONES.forEach(function (tone) {
      var node = el(consumer.html.replace('TONE', tone));
      var value = style(node, consumer.prop);

      var key = toRGB(value).join(',');
      assert.notOk(
        seen[key],
        '.' + tone + ' and .' + seen[key] + ' render identically on ' + consumer.name +
          ' — one of them is a silent no-op'
      );
      seen[key] = tone;

      if (key === toRGB(base).join(',')) matchedBase.push(tone);
      cleanup();
    });

    assert.equal(Object.keys(seen).length, TONES.length, 'expected seven distinct renderings');
    assert.ok(
      matchedBase.length <= 1,
      consumer.name + ' renders untoned identically to more than one tone: ' + matchedBase.join(', ')
    );
  });
});

test('tone: no component file names a tone', function () {
  /*
   * The structural version of the tests above. A selector mentioning a tone
   * class outside tones.css means some component decided which tones it
   * accepts — component thinking in a utility system, and the exact shape
   * of the v0.6 bug. Adding a tone would then require finding every one of
   * these lists.
   *
   * tones.css itself is where the names belong. Everything else derives
   * from --bg-mix.
   */
  var offenders = [];
  allRules().forEach(function (rule) {
    if (!(window.CSSStyleRule && rule instanceof CSSStyleRule)) return;
    var sheetHref = (rule.parentStyleSheet && rule.parentStyleSheet.href) || '';
    if (/tones\.css$/.test(sheetHref)) return;

    TONES.forEach(function (tone) {
      /* Word-boundary match so `.primary` does not also match `.primary-x`. */
      if (new RegExp('\\.' + tone + '(?![\\w-])').test(rule.selectorText || '')) {
        offenders.push(sheetHref.split('/').pop() + ': ' + rule.selectorText);
      }
    });
  });
  assert.equal(
    offenders.length,
    0,
    'tone names leaked out of tones.css:\n        ' + offenders.join('\n        ')
  );
});

/* ── Element scoping ─────────────────────────────────────────────────*/

test('tone: a tone does not bleed into untoned descendants', function () {
  /*
   * --bg-mix is registered `inherits: false` for this. Unregistered, a
   * var(--bg-mix, fallback) in a descendant only reaches its fallback when
   * the property is unset on the element *and* every ancestor — so an
   * untoned button inside a danger alert rendered red on red.
   */
  var plainBtn = el('<button class="btn">Undo</button>');
  var plainBg = style(plainBtn, 'background-color');
  cleanup();

  var nested = el(
    '<article class="alert danger"><button class="btn">Undo</button></article>',
    '.btn'
  );
  assert.sameColor(
    style(nested, 'background-color'),
    plainBg,
    'an untoned .btn inside .alert.danger inherited the alert tone'
  );
});

test('tone: an untoned pill inside a toned alert stays muted', function () {
  var plain = el('<span class="pill">3</span>');
  var plainBg = style(plain, 'background-color');
  cleanup();

  var nested = el(
    '<article class="alert success"><span class="pill">3</span></article>',
    '.pill'
  );
  assert.sameColor(style(nested, 'background-color'), plainBg, 'the pill picked up the alert tone');
});

test('tone: a descendant that needs its parent tone gets it deliberately', function () {
  /*
   * The other half of the contract. Scoping means a child cannot read its
   * ancestor's tone, so the places that need it derive the value on the
   * toned element and pass it down as a normal inheriting property. Three
   * do: the <td> via --row-tint, the dialog header, and the checkbox via
   * --check-accent. This is the checkbox one — the tone sits on the label
   * and has to cross into the input.
   */
  var plain = el('<label class="field-check"><input type="checkbox"><span>x</span></label>', 'input');
  var plainAccent = style(plain, 'accent-color');
  cleanup();

  var toned = el(
    '<label class="field-check danger"><input type="checkbox"><span>x</span></label>',
    'input'
  );
  assert.differentColor(
    style(toned, 'accent-color'),
    plainAccent,
    'a tone on .field-check did not reach its input via --check-accent'
  );
});

/* ── Adding a tone stays a one-line change ───────────────────────────*/

test('tone: an unknown tone works on every consumer with no component edit', function () {
  /*
   * The real test of "one line in tones.css, zero component edits": invent
   * a tone the package has never heard of by setting --bg-mix directly,
   * and check every consumer picks it up. If a consumer enumerates tone
   * names, it will ignore this and the test fails.
   */
  var invented = 'rgb(255, 0, 255)';

  CONSUMERS.forEach(function (consumer) {
    var untoned = el(consumer.html.replace(' TONE', ''));
    var base = style(untoned, consumer.prop);
    cleanup();

    var node = el(
      consumer.html.replace(' TONE', '').replace('class="', 'style="--bg-mix: ' + invented + '" class="')
    );
    assert.differentColor(
      style(node, consumer.prop),
      base,
      consumer.name + ' ignored an arbitrary --bg-mix — it is enumerating tone names'
    );
    cleanup();
  });
});
