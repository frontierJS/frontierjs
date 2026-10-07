/*
 * band.spec.js — Band, and the `.bleed` escape it shares one rule with.
 *
 * Graded by geometry and by arithmetic. The test root is 1200px wide and
 * parked off-screen, so "reaches the viewport edge" is asked as "is as wide
 * as the viewport and starts where centering inside its parent puts it".
 * The harness hides scrollbars, so the half-scrollbar overflow reset.css
 * guards against cannot be produced here; the rule is asserted declared.
 */

function bandViewport() { return document.documentElement.clientWidth; }

test('band: a Band inside a held-width parent reaches both viewport edges', function () {
  var parent = el('<div style="inline-size: 400px; margin-inline: auto">' +
    '<section class="band"><div class="container">x</div></section></div>');
  var band = parent.querySelector('.band').getBoundingClientRect();
  var box = parent.getBoundingClientRect();

  assert.equal(Math.round(band.width), bandViewport(), 'the Band is as wide as the viewport');
  assert.ok(Math.abs((band.left - box.left) - (box.width - bandViewport()) / 2) < 1,
    'and centered on its parent, so its edges are the screen’s');
  cleanup();
});

test('band: .bleed escapes the same way, an <img> included', function () {
  var parent = el('<div class="prose" style="inline-size: 300px">' +
    '<img class="bleed" alt="" src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2210%22 height=%2210%22/%3E"></div>');
  assert.equal(Math.round(parent.querySelector('img').getBoundingClientRect().width), bandViewport(),
    'an image’s auto width is its intrinsic one, so the escape states inline-size');
  cleanup();
});

test('band: the escape is ONE rule, shared', function () {
  var shared = allSelectors().filter(function (sel) {
    return /(^|,)\s*\.bleed\s*(,|$)/.test(sel) && /(^|,)\s*\.band\s*(,|$)/.test(sel);
  });
  assert.equal(shared.length, 1, 'expected one `.bleed, .band` rule, found ' + shared.length);
});

test('band: a page holding a Band clips sideways overflow at the root', function () {
  el('<section class="band"></section>');
  assert.equal(style(document.documentElement, 'overflow-x'), 'clip');
  cleanup();
  assert.notEqual(style(document.documentElement, 'overflow-x'), 'clip',
    'a page with no escape keeps the UA default');
});

test('band: a Band is a Surface — a tone tints it, and it has no corners or side edges', function () {
  var plain = el('<section class="band"></section>');
  var toned = el('<section class="band primary"></section>');
  assert.differentColor(style(toned, 'background-color'), style(plain, 'background-color'));
  assert.equal(style(plain, 'border-top-left-radius'), '0px');
  assert.equal(style(plain, 'border-left-width'), '0px');
  var outlined = el('<section class="band outlined"></section>');
  assert.notEqual(style(outlined, 'border-top-width'), '0px', '.outlined brings the block rules back');
  assert.equal(style(outlined, 'border-left-width'), '0px');
  cleanup();
});

test('band: block padding moves with density', function () {
  var base = parseFloat(style(el('<section class="band"></section>'), 'padding-top'));
  var dense = parseFloat(style(el('<section class="band dense"></section>'), 'padding-top'));
  var roomy = parseFloat(style(el('<section class="band roomy"></section>'), 'padding-top'));
  assert.ok(dense < base && base < roomy, 'dense ' + dense + ' < base ' + base + ' < roomy ' + roomy);
  cleanup();
});

/* ── The photo ────────────────────────────────────────────────────── */

function bandOver(fg, bg) {
  /* fg [r,g,b,a] composited over an opaque bg [r,g,b]. */
  return [0, 1, 2].map(function (i) { return fg[i] * fg[3] + bg[i] * (1 - fg[3]); });
}
function bandCSS(rgb) { return 'rgb(' + rgb.map(Math.round).join(', ') + ')'; }

test('band: a photo sits under the scrim and the content sits over both', function () {
  var band = el('<section class="band" style="block-size: 200px">' +
    '<img class="band-media" alt="" src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2210%22 height=%2210%22/%3E">' +
    '<div class="container"><h2>Title</h2></div></section>');
  var media = band.querySelector('.band-media');
  var content = band.querySelector('.container');

  assert.equal(style(media, 'position'), 'absolute');
  assert.equal(Math.round(media.getBoundingClientRect().height), Math.round(band.getBoundingClientRect().height),
    'the photo covers the Band');
  assert.equal(getComputedStyle(band, '::after').getPropertyValue('content'), '""', 'the scrim exists');
  assert.ok(+style(content, 'z-index') > +getComputedStyle(band, '::after').getPropertyValue('z-index') ||
    style(content, 'z-index') === '1', 'content is lifted above the scrim');
  cleanup();
});

test('band: over a WHITE photo, every ink clears AA through the scrim', function () {
  /*
   * The worst case a photo can be is white. One coat of --scrim is tuned to
   * dim a page behind a dialog; the Band paints two, and this is the
   * arithmetic that says why.
   */
  var band = el('<section class="band"><img class="band-media" alt=""><div class="container"><p>x</p></div></section>');
  var scrim = toRGB(prop(band, '--scrim'));
  var coats = (getComputedStyle(band, '::after').getPropertyValue('background-image').match(/linear-gradient/g) || []).length;
  assert.equal(coats, 2, 'two coats of --scrim');

  var ground = [255, 255, 255];
  var one = bandOver(scrim, ground);
  for (var i = 0; i < coats; i++) ground = bandOver(scrim, ground);

  assert.ok(contrast('#fff', bandCSS(one)) < 4.5,
    'one coat clears AA on its own (' + contrast('#fff', bandCSS(one)).toFixed(2) + ':1) — the second is dead weight');

  ['--ink', '--ink-soft', '--ink-mute'].forEach(function (name) {
    var ink = toRGB(prop(band, name));
    var ratio = contrast(bandCSS(bandOver(ink, ground)), bandCSS(ground));
    assert.atLeast(ratio, 4.5, name + ' over a white photo is ' + ratio.toFixed(2) + ':1');
  });
  cleanup();
});
