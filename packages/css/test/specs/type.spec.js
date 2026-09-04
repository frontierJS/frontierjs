/*
 * type.spec.js — the type scale is tokens, and it is ONE scale.
 *
 * A px size ignores a reader's raised base font, so a px and a rem spelling
 * of the same nominal size are accessible in one place and not the other —
 * inside one package, by accident.
 *
 * These tests are structural rather than visual: the pixel values are
 * asserted elsewhere, and repeating them here would only pin the current
 * numbers. What must not come back is a literal, which stays invisible
 * until someone themes the ladder and finds one element that did not move.
 */

/* ── The ladder is declared once ──────────────────────────────────── */

test('type: every rung is declared on :root', function () {
  var rungs = ['2xs', 'xs', 'sm', 'md', 'lg', 'xl', '2xl', '3xl', '4xl'];
  var root = getComputedStyle(document.documentElement);

  rungs.forEach(function (r) {
    var v = root.getPropertyValue('--text-' + r).trim();
    assert.ok(v, '--text-' + r + ' is not declared');
    /*
     * rem, not px. A px rung would ignore the reader's base font size,
     * which is the whole class of bug this ruling closed.
     */
    assert.ok(/rem$/.test(v), '--text-' + r + ' should be rem, got ' + v);
  });

  ['display', 'heading', 'snug', 'normal', 'body', 'relaxed'].forEach(function (l) {
    var v = root.getPropertyValue('--leading-' + l).trim();
    assert.ok(v, '--leading-' + l + ' is not declared');
    /*
     * Unitless, so a nested element multiplies its OWN font-size. A
     * `line-height: 22px` inherits the computed pixel value and a smaller
     * child then overlaps itself.
     */
    assert.ok(/^[\d.]+$/.test(v), '--leading-' + l + ' should be unitless, got ' + v);
  });
});

/* ── No literals below tokens.css ─────────────────────────────────── */

test('type: no component or pattern declares a literal font-size', function () {
  /*
   * The structural guard. Three forms stay legal and are why this reads
   * the value rather than counting declarations:
   *
   *   em     — deliberately relative to the parent (kbd, code, .btn.square)
   *   calc() — derived from another token (.avatar sizes from --avatar-size)
   *   inherit / a keyword — not a size at all
   *
   * Everything else is a rung and belongs in tokens.css.
   */
  var allowed = /^(var\(|calc\(|inherit$|[\d.]+em$)/;
  var offenders = [];

  allRules().forEach(function (rule) {
    if (!(window.CSSStyleRule && rule instanceof CSSStyleRule)) return;

    var href = (rule.parentStyleSheet && rule.parentStyleSheet.href) || '';
    /* tokens.css IS the declaration site; themes may override a rung. */
    if (/tokens\.css$/.test(href) || /\/themes\//.test(href)) return;

    var v = (rule.style.getPropertyValue('font-size') || '').trim();
    if (!v) return;

    if (!allowed.test(v)) {
      offenders.push(href.split('/').pop() + ': ' + rule.selectorText + ' { font-size: ' + v + ' }');
    }
  });

  assert.equal(
    offenders.length,
    0,
    'literal font-size outside tokens.css:\n        ' + offenders.join('\n        ')
  );
});

/* ── Utilities and headings read the SAME rungs ───────────────────── */

test('type: .text-xl and <h4> are the same size, from the same rung', function () {
  /*
   * They were equal before this ruling too — by hand, in two files, with
   * nothing saying so. This asserts they are equal *because* they read one
   * token, by moving the token and watching both follow.
   */
  var box = el('<div style="--text-xl: 41px"><p class="text-xl">a</p><h4>b</h4></div>');
  var para = box.querySelector('.text-xl');
  var head = box.querySelector('h4');

  assert.equal(style(para, 'font-size'), '41px', '.text-xl did not read --text-xl');
  assert.equal(style(head, 'font-size'), '41px', 'h4 did not read --text-xl');
});

test('type: retuning a rung moves the components wearing it', function () {
  /*
   * The point of the whole change. --text-md is the body rung: a utility, a
   * button and a field label all wear it, in three different files and
   * three different layers. One override should move all three, which is
   * what makes the ladder themeable and what a stray literal would break
   * for exactly one element.
   */
  var box = el(
    '<div style="--text-md: 37px">' +
      '<p class="text-md">a</p>' +
      '<button class="btn">b</button>' +
      '<div class="field-group"><label>c</label></div>' +
      '</div>'
  );

  assert.equal(style(box.querySelector('.text-md'), 'font-size'), '37px', '.text-md utility');
  assert.equal(style(box.querySelector('.btn'), 'font-size'), '37px', '.btn');

  /* .field-group > label is --text-sm, so it must NOT have moved. */
  var label = box.querySelector('.field-group > label');
  assert.ok(
    style(label, 'font-size') !== '37px',
    'a --text-sm element followed --text-md — the rungs are aliased somewhere'
  );
});

test('type: a rung is not an alias of another rung', function () {
  /*
   * `--text-sm: var(--text-md)` at :root looks like it makes sm follow md
   * and silently does not — the var() resolves once against :root's own
   * value and the result inherits past every theme. Ruled 2026-08-02 for
   * --ring and --badge-radius; the ladder is the third place it would bite.
   *
   * Overriding one rung on an element must leave its neighbors alone.
   */
  var box = el('<div style="--text-md: 43px"><p class="text-md">a</p><p class="text-sm">b</p><p class="text-lg">c</p></div>');

  assert.equal(style(box.querySelector('.text-md'), 'font-size'), '43px', 'the overridden rung');
  assert.ok(style(box.querySelector('.text-sm'), 'font-size') !== '43px', '.text-sm aliases --text-md');
  assert.ok(style(box.querySelector('.text-lg'), 'font-size') !== '43px', '.text-lg aliases --text-md');
});

/* ── The display face ─────────────────────────────────────────────── */

test('type: --font-display is unset by default and headings read --font-primary', function () {
  /*
   * The half that protects every app that never heard of this token. An
   * app sets one face; if --font-display were DECLARED at :root as
   * `var(--font-primary)` it would substitute once against :root and then
   * inherit past a scoped --font-primary — the alias trap tokens.css
   * forbids by name. Unset plus a use-site fallback is the form that
   * follows a scope, and this asserts the scope is followed.
   */
  assert.equal(
    getComputedStyle(document.documentElement).getPropertyValue('--font-display').trim(),
    '',
    '--font-display is declared at :root — it must be a use-site fallback, not an alias'
  );

  var box = el('<div style="--font-primary: Palatino"><h2>a</h2><p class="text-md">b</p></div>');
  assert.equal(
    style(box.querySelector('h2'), 'font-family'),
    'Palatino',
    'a heading did not fall back to a SCOPED --font-primary'
  );
});

test('type: --font-display moves the headings and nothing else', function () {
  /*
   * A serif over a sans body is why the token exists. Body copy must not
   * follow it, or the two faces are one again.
   */
  var box = el(
    '<div style="--font-primary: Palatino; --font-display: Courier">' +
      '<h2>a</h2><h5>b</h5><p class="text-md">c</p><button class="btn">d</button>' +
      '</div>'
  );

  assert.equal(style(box.querySelector('h2'), 'font-family'), 'Courier', 'h2 ignored --font-display');
  assert.equal(style(box.querySelector('h5'), 'font-family'), 'Courier', 'h5 ignored --font-display');
  assert.equal(
    style(box.querySelector('.btn'), 'font-family'),
    'Palatino',
    'a button followed the display face'
  );
});
