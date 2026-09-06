/*
 * code.spec.js — the syntax highlighting theme, against real glow output.
 *
 * The markup under test is not written here. test/run.js imports glow from
 * @frontierjs/toolbelt, renders three samples and hands them to the page on
 * `window.__FJS_GLOW__`, so what these tests style is exactly what a consumer
 * gets. Markup written by hand to look like glow's would pass this file while
 * glow emitted something else, which is the stand-in failure this repo has
 * paid for before.
 *
 * The theme uses no classes at all — `code[language] em`, not `.token-string`
 * — so there is nothing here for vocabulary.spec.js to object to and nothing
 * for a consumer to import. That is a property worth keeping: the first test
 * below fails if a class appears.
 */

var GLOW = window.__FJS_GLOW__ || {};

function block(which) {
  var box = el('<div>' + GLOW[which] + '</div>');
  return box.querySelector('code[language]');
}

/* ── The samples arrived ───────────────────────────────────────────── */

test('code: the glow samples are present and shaped as expected', function () {
  /*
   * Every test below reads window.__FJS_GLOW__. If run.js ever stops
   * injecting it, `block()` returns null and each test fails with a null
   * dereference rather than saying what went wrong — so say it once, here.
   */
  ['css', 'marked', 'numbered'].forEach(function (k) {
    assert.ok(GLOW[k], 'run.js did not inject the ' + k + ' sample');
    assert.ok(/^<code language="/.test(GLOW[k]), k + ' is not a <code language> block');
  });
});

test('code: glow emits no classes for the theme to depend on', function () {
  Object.keys(GLOW).forEach(function (k) {
    assert.ok(!/<[a-z]+ class=/.test(GLOW[k]), k + ' emitted a class attribute');
  });
});

/* ── The block itself ──────────────────────────────────────────────── */

test('code: a highlighted block is a block and preserves whitespace', function () {
  /*
   * `<code language>` has to stand on its own — glow's output is often
   * inserted without a <pre> around it, and `code` is inline by default with
   * whitespace collapsed, so without this every sample renders as one line.
   */
  var c = block('css');
  assert.equal(style(c, 'display'), 'block');
  assert.equal(style(c, 'white-space'), 'pre');
  assert.equal(style(c, 'overflow-x'), 'auto');
});

test('code: a highlighted block drops the inline-code treatment', function () {
  /* `code` is styled by element for inline use — background and padding.
     Carried into a block those paint one box per wrapped fragment. */
  var c = block('css');
  assert.equal(style(c, 'padding-top'), '0px');
  assert.equal(style(c, 'background-color'), 'rgba(0, 0, 0, 0)');
});

test('code: inside a <pre> the container owns the type', function () {
  /*
   * A code block inside small print must not jump back to the default rung.
   * The <pre> sets the size; the <code> follows it.
   */
  var box = el('<pre style="font-size: 29px">' + GLOW.css + '</pre>');
  assert.equal(style(box.querySelector('code[language]'), 'font-size'), '29px');
});

/* ── Neutralisation ────────────────────────────────────────────────── */

test('code: token elements carry color, not emphasis', function () {
  /*
   * glow uses <em>, <strong> and <sup> as color carriers rather than for
   * emphasis. Left alone they render italic strings, bold keywords and
   * superscript comments — in a monospace block that reads as a rendering
   * fault, and the raised baseline breaks the grid outright.
   */
  var c = block('css');

  var em = c.querySelector('em');
  assert.ok(em, 'the sample has no <em>');
  assert.equal(style(em, 'font-style'), 'normal', '<em> is still italic');

  var sup = c.querySelector('sup');
  assert.ok(sup, 'the sample has no <sup>');
  assert.equal(style(sup, 'vertical-align'), 'baseline', '<sup> is still raised');
  assert.equal(style(sup, 'font-size'), style(c, 'font-size'), '<sup> is still smaller');

  var strong = c.querySelector('strong');
  assert.ok(strong, 'the sample has no <strong>');
  assert.equal(style(strong, 'font-weight'), style(c, 'font-weight'), '<strong> is still bold');
});

test('code: a diff line is not struck through or underlined', function () {
  var c = block('marked');
  assert.equal(style(c.querySelector('del'), 'text-decoration-line'), 'none');
  assert.equal(style(c.querySelector('ins'), 'text-decoration-line'), 'none');
});

/* ── The palette ───────────────────────────────────────────────────── */

test('code: the six token roles are six different colors', function () {
  /*
   * A highlighter whose tokens all resolve to the same value is indis-
   * tinguishable from no highlighter, and every one of these reads through a
   * `var(--code-*, tone)` fallback — one typo in a variable name collapses a
   * role onto the inherited color with nothing to see in the CSS.
   */
  var c = block('css');
  var seen = {};

  ['sup', 'i', 'b', 'em', 'strong', 'label'].forEach(function (tag) {
    var node = c.querySelector(tag);
    assert.ok(node, 'the sample has no <' + tag + '>');
    var color = style(node, 'color');
    assert.ok(!seen[color], '<' + tag + '> and <' + seen[color] + '> are both ' + color);
    seen[color] = tag;
  });
});

test('code: the palette follows the theme, it is not pinned to :root', function () {
  /*
   * The whole reason the colors are written `var(--code-name, <derived from
   * --color-primary>)` rather than aliased at :root. An alias resolves once
   * against :root's own value and inherits past every .theme-* — ruled
   * 2026-08-02 for --ring — so highlighted code would stay in the default
   * palette in every theme but one, and nothing would say so.
   *
   * Both tones are already inside the lightness window, so the clamp is a
   * no-op and the identifier color is the tone exactly. Compared through
   * toRGB because a relative-color result serializes as oklch().
   */
  var box = el('<div style="--color-primary: rgb(1, 2, 3)">' + GLOW.css + '</div>');
  var got = toRGB(style(box.querySelector('code[language] b'), 'color'));
  assert.equal(got.slice(0, 3).join(','), '1,2,3');
});

test('code: the lightness clamp only acts when the tone needs it', function () {
  /*
   * The point of clamping rather than blending toward the ink: a tone that
   * already reads on this surface must come through untouched, or every
   * carefully-tuned theme gets flattened to the same muddy palette.
   *
   * rgb(1,2,3) is far below the cap and must survive; a bright tone is above
   * it and must be pulled down.
   */
  var dark = el('<div style="--color-success: rgb(1, 2, 3)">' + GLOW.css + '</div>');
  assert.equal(
    toRGB(style(dark.querySelector('code[language] em'), 'color')).slice(0, 3).join(','),
    '1,2,3',
    'a tone inside the window was altered'
  );

  var bright = el('<div style="--color-success: rgb(120, 255, 120)">' + GLOW.css + '</div>');
  var out = toRGB(style(bright.querySelector('code[language] em'), 'color'));
  assert.ok(out[1] < 255, 'a tone above the cap came through unclamped: ' + out.join(','));
});

test('code: a --code-* override beats the tone it falls back to', function () {
  /* An override is taken as given — no clamp, no derivation. Someone who
     names a color has already decided. */
  var box = el('<div style="--code-name: rgb(4, 5, 6)">' + GLOW.css + '</div>');
  assert.equal(style(box.querySelector('code[language] b'), 'color'), 'rgb(4, 5, 6)');
});

/* ── Contrast ──────────────────────────────────────────────────────── */

/*
 * Syntax highlighting is the one place a design system is tempted to spend
 * its contrast budget on prettiness: six colors on one background, all of
 * them small monospace text. A palette derived from the tones inherits
 * whatever those tones were tuned for — a fill behind white text — which is
 * not the same job, so it has to be checked rather than assumed.
 *
 * 4.5:1 is AA for body text, and code is body text.
 */
['default', 'sunset', 'forest', 'midnight', 'dark', 'elite', 'basecamp', 'notebook', 'press'].forEach(
  function (theme) {
    test('code: every token clears AA in theme-' + theme, function () {
      var pre = themed(theme, '<pre class="code">' + GLOW.css + '</pre>');
      var bg = getComputedStyle(pre).backgroundColor;
      var thin = [];

      /*
       * The four tone-derived roles. <sup> and <i> are excluded on purpose:
       * they are the theme's own --ink-mute and --ink-soft verbatim, so
       * their contrast is the theme's to answer for, not this file's — and
       * notebook's --ink-mute is 2.67:1 against --surface-sunken, which
       * fails for every one of the nine files that use it as muted text.
       * Logged as a theme defect rather than compensated for here; the test
       * below is what pins code.css to inventing no color of its own.
       */
      ['b', 'em', 'strong', 'label'].forEach(function (tag) {
        var node = pre.querySelector('code[language] ' + tag);
        var ratio = contrast(getComputedStyle(node).color, bg);
        if (ratio < 4.5) thin.push('<' + tag + '> ' + ratio.toFixed(2) + ':1');
      });

      cleanup();
      assert.equal(thin.length, 0, 'below AA on --surface-sunken: ' + thin.join(', '));
    });
  }
);

test('code: comment and punctuation are the theme ink ramp, not new greys', function () {
  /*
   * The counterpart to the AA tests above. Those cover the four colors this
   * file derives; these two it must NOT derive — inventing a gray here would
   * mean a theme could retune its ink ramp and have code blocks ignore it,
   * and would hide a theme whose muted ink does not read.
   */
  var pre = themed('default', '<pre class="code">' + GLOW.css + '</pre>');
  var ramp = getComputedStyle(pre);

  /* Through toRGB both ways: a computed color serializes as rgb(), the
     token as the hex the theme wrote. */
  function same(tag, token) {
    assert.equal(
      toRGB(style(pre.querySelector('code[language] ' + tag), 'color')).join(','),
      toRGB(ramp.getPropertyValue(token).trim()).join(','),
      'the <' + tag + '> color is not ' + token
    );
  }
  same('sup', '--ink-mute');
  same('i', '--ink-soft');
  cleanup();
});

/* ── The author's own markers ──────────────────────────────────────── */

test('code: an error mark is a wavy underline, not a color', function () {
  /*
   * `••text••` means wrong, and color alone cannot say that inside a block
   * where five other colors already mean something else.
   */
  var u = block('marked').querySelector('u');
  assert.ok(u, 'the sample has no <u>');
  assert.equal(style(u, 'text-decoration-style'), 'wavy');
  assert.equal(style(u, 'text-decoration-line'), 'underline');
});

test('code: a highlight mark paints a background', function () {
  var mark = block('marked').querySelector('mark');
  assert.ok(mark, 'the sample has no <mark>');
  assert.ok(
    style(mark, 'background-color') !== 'rgba(0, 0, 0, 0)',
    'the •mark• has no background — it is invisible'
  );
});

test('code: the three line callouts are told apart', function () {
  var c = block('marked');
  var seen = {};

  ['ins', 'del', 'dfn'].forEach(function (tag) {
    var node = c.querySelector(tag);
    assert.ok(node, 'the sample has no <' + tag + '>');
    assert.equal(style(node, 'display'), 'block', '<' + tag + '> is not a whole line');

    var bg = style(node, 'background-color');
    assert.ok(bg !== 'rgba(0, 0, 0, 0)', '<' + tag + '> has no tint');
    assert.ok(!seen[bg], '<' + tag + '> and <' + seen[bg] + '> are the same color');
    seen[bg] = tag;
  });
});

test('code: a line callout reaches past the visible edge', function () {
  /*
   * A block child of a scrolling box is only as wide as the box, so a
   * highlighted line loses its background the moment you scroll right —
   * `inline-size: max-content` with `min-inline-size: 100%` is what fixes it,
   * and both halves are needed. Read the used width against a narrow box
   * holding a line far wider than it.
   */
  var box = el(
    '<pre class="code" style="inline-size: 120px">' +
      GLOW.marked.replace('gone', 'gone ' + new Array(60).join('x ')) +
      '</pre>'
  );
  var del = box.querySelector('del');
  assert.ok(
    del.getBoundingClientRect().width > 300,
    'the stripe stopped at the visible edge (' + Math.round(del.getBoundingClientRect().width) + 'px)'
  );
});

/* ── Line numbers ──────────────────────────────────────────────────── */

test('code: numbered mode gutters the lines and the gutter is not selectable', function () {
  /*
   * The numbers are a counter rather than content precisely so that copying
   * the block gives you the code. If they became selectable text the feature
   * would be actively harmful — every paste would need hand-cleaning.
   */
  var c = block('numbered');
  var lines = c.querySelectorAll(':scope > span');
  assert.equal(lines.length, 3, 'expected three numbered lines');
  assert.equal(getComputedStyle(lines[0], '::before').userSelect, 'none');
  assert.equal(getComputedStyle(lines[0], '::before').content, 'counter(code-line)');
});
