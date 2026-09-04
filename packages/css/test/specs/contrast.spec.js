/*
 * contrast.spec.js — a tone clears WCAG AA in every theme, in both of the
 * jobs a tone has: as a solid fill under text, and as text itself.
 *
 * The two are separate derivations and fail apart. chip.css answers the
 * first (what colour goes ON this fill), tones.css the second (what this
 * tone becomes when it IS the text). A component that mixes them up looks
 * right in the theme it was written in.
 *
 * This is the invariant with the worst failure history in the package.
 * Through v0.6 tones.css asserted `--on-bg-mix: white` regardless of hue,
 * which failed AA on 15 of the tone × theme combinations — worst 1.99:1,
 * on the primary button of a real client theme. chip.css replaced the
 * assertion with a derivation: it reads the fill's relative luminance and
 * either keeps the hue and switches to dark text, or keeps white text and
 * dims the fill to where white reaches 4.5:1.
 *
 * A derivation is the right shape precisely because it holds for hues no
 * theme has defined yet — but only as long as nothing downstream
 * reintroduces a hardcoded color. That is what this file watches.
 */

var TONES = ['primary', 'secondary', 'muted', 'info', 'success', 'warning', 'danger'];
var THEMES = ['default', 'sunset', 'forest', 'midnight', 'dark', 'elite', 'basecamp', 'notebook', 'press', 'field'];

/* The chip lineage — everything that renders a tone as a solid fill. */
var FILLED = [
  { name: '.btn', html: '<button class="btn TONE">Save changes</button>' },
  { name: '.pill', html: '<span class="pill TONE">99+</span>' },
  { name: '.badge', html: '<span class="badge TONE">Overdue</span>' },
];

/*
 * The other job: a tone rendered as TEXT on a surface. Every one of these
 * painted --bg-mix directly until v0.16 and failed AA across most of the
 * grid — .btn.outlined on 34 of the 72 pairs, worst 1.19:1 (FJS-027). They
 * read --tone-ink now, which is the tone through the legibility window.
 *
 * Untoned is in the list because it is where the failure was first
 * measured: `.btn.outlined` with no tone class is the brand accent, and
 * that was 1.99:1 on a real client theme.
 */
var TEXTUAL = [
  { name: '.btn.outlined', html: '<button class="btn outlined TONE">Save</button>' },
  { name: '.btn.link', html: '<button class="btn link TONE">Save</button>' },
  { name: '.btn.ghost', html: '<button class="btn ghost TONE">Save</button>' },
];

/*
 * Was THEMES plus notebook, which the neutral-pairs test below could not
 * take: its --ink-mute was 2.67:1 on the sunken surface. The ramp is fitted
 * now (FJS-125) and notebook is an ordinary member of the list, which is what
 * makes the exclusion impossible to forget to remove.
 */
var TEXTUAL_THEMES = THEMES;

var AA = 4.5;

/* WCAG 1.4.11: a control's own boundary is non-text contrast, 3:1. */
var AA_NON_TEXT = 3;

FILLED.forEach(function (subject) {
  THEMES.forEach(function (theme) {
    test('contrast: ' + subject.name + ' in ' + theme + ' clears AA on all seven tones', function () {
      TONES.forEach(function (tone) {
        var node = themed(theme, subject.html.replace('TONE', tone));
        var cs = getComputedStyle(node);
        var ratio = contrast(cs.color, cs.backgroundColor);

        assert.ok(
          ratio >= AA,
          subject.name + '.' + tone + ' in theme-' + theme + ' is ' +
            ratio.toFixed(2) + ':1, below AA (' + AA + ':1)' +
            '\n      text ' + toRGB(cs.color).join(',') +
            ' on fill ' + toRGB(cs.backgroundColor).join(',')
        );
        cleanup();
      });
    });
  });
});

/*
 * A transparent variant paints nothing of its own, so what its label
 * actually sits on is the theme surface behind it. Reading
 * backgroundColor there gives rgba(0,0,0,0) and scores every ratio
 * against black — which passes, and means nothing.
 */
function groundOf(node) {
  var cs = getComputedStyle(node);
  if (toRGB(cs.backgroundColor)[3] > 0) return cs.backgroundColor;
  return cs.getPropertyValue('--surface').trim();
}

TEXTUAL.forEach(function (subject) {
  TEXTUAL_THEMES.forEach(function (theme) {
    test('contrast: ' + subject.name + ' in ' + theme + ' clears AA untoned and on all seven tones', function () {
      var failures = [];

      [''].concat(TONES).forEach(function (tone) {
        var node = themed(theme, subject.html.replace('TONE', tone));
        var cs = getComputedStyle(node);
        var ground = groundOf(node);
        var ratio = contrast(cs.color, ground);

        if (ratio < AA) {
          failures.push(
            (tone || '(untoned)') + '  text ' + ratio.toFixed(2) + ':1' +
            '  — ' + toRGB(cs.color).join(',') + ' on ' + toRGB(ground).join(',')
          );
        }

        /*
         * The border is the whole of .outlined: at 1.99:1 the variant is
         * not being drawn, whatever the label does.
         */
        if (subject.name === '.btn.outlined') {
          var edge = contrast(cs.borderTopColor, ground);
          if (edge < AA_NON_TEXT) {
            failures.push((tone || '(untoned)') + '  border ' + edge.toFixed(2) + ':1');
          }
        }
        cleanup();
      });

      assert.equal(
        failures.length,
        0,
        subject.name + ' in theme-' + theme + ', ' + failures.length + ' below threshold:' +
          '\n        ' + failures.join('\n        ')
      );
    });
  });
});

/*
 * The third job, and the one nothing checked: a toned BLOCK, whose text is
 * --tint-ink on --tint-surface. Both sides move with the tone, which is why
 * it reads as safe and is not — measured across the grid, sunset's warning
 * sat at 3.86:1 (FJS-288). --tint-ink now goes through the same legibility
 * window --tone-ink does.
 */
var TINTED = [
  { name: '.alert', html: '<div class="alert TONE">Careful</div>' },
  { name: '.card', html: '<article class="card TONE">Careful</article>' },
  { name: '.tile', html: '<article class="tile TONE">Careful</article>' },
];

TINTED.forEach(function (subject) {
  THEMES.forEach(function (theme) {
    test('contrast: a toned ' + subject.name + ' in ' + theme + ' clears AA on all seven tones', function () {
      var failures = [];

      TONES.forEach(function (tone) {
        var node = themed(theme, subject.html.replace('TONE', tone));
        var cs = getComputedStyle(node);
        var ratio = contrast(cs.color, groundOf(node));
        if (ratio < AA) failures.push(tone + '  ' + ratio.toFixed(2) + ':1');
        cleanup();
      });

      assert.equal(
        failures.length, 0,
        'toned ' + subject.name + ' in theme-' + theme + ':\n        ' + failures.join('\n        ')
      );
    });
  });
});

test('contrast: a tone rendered as text generalises to a hue no theme defines', function () {
  /*
   * The sibling of the fill test below, and the same claim: --tone-ink is
   * a derivation, so a brand nobody here has seen must clear AA too. A
   * fixed table of seven tones cannot show that.
   *
   * Both windows are exercised — the shipped light default and a dark
   * theme's inverted pair — because the two are declared, not derived,
   * and a hue that reads through one can fail the other.
   */
  var hues = ['#ffff00', '#00ff00', '#c0ff3e', '#000080', '#7f7f7f', '#ff00ff', '#00ffff', '#8b4513'];

  ['default', 'dark'].forEach(function (theme) {
    hues.forEach(function (hue) {
      var node = themed(
        theme,
        '<button class="btn outlined" style="--bg-mix: ' + hue + '">Save</button>'
      );
      var cs = getComputedStyle(node);
      var ratio = contrast(cs.color, groundOf(node));
      assert.ok(
        ratio >= AA,
        'an undeclared hue ' + hue + ' rendered at ' + ratio.toFixed(2) + ':1 in theme-' +
          theme + ' — the tone-as-text window does not generalize'
      );
      cleanup();
    });
  });
});

test('contrast: --tone-ink is unset on an untoned element', function () {
  /*
   * The mechanism the whole family rests on: --bg-mix is registered with
   * no initial value, so on an untoned element --tone-ink is
   * guaranteed-invalid and `var(--tone-ink, X)` falls through to X. If it
   * ever computed to something, every untoned .ghost would silently take
   * the brand accent instead of --ink-soft, and nothing would look broken.
   */
  var node = el('<button class="btn ghost">Save</button>');
  assert.equal(prop(node, '--tone-ink'), '', '--tone-ink computed on an untoned element');
  assert.sameColor(
    style(node, 'color'),
    style(node, '--ink-soft'),
    'an untoned ghost button no longer falls back to --ink-soft'
  );
});

test('contrast: the derivation covers a hue no theme defines', function () {
  /*
   * The claim chip.css makes is not "these 42 combinations pass" — it is
   * that contrast is *derived*, so it holds for any hue. A fixed table of
   * tones cannot demonstrate that; an invented one can.
   *
   * These are chosen to straddle the branch: very light hues should keep
   * their color and take dark text, dark ones should keep white text.
   */
  var hues = [
    '#ffff00', // pure yellow — brightest case, must flip to dark text
    '#00ff00', // pure green
    '#c0ff3e', // light lime, near the Elite brand
    '#000080', // navy — dark, keeps white text
    '#7f7f7f', // mid gray, right at the branch
    '#ff00ff',
    '#00ffff',
    '#8b4513',
  ];

  hues.forEach(function (hue) {
    var node = el('<button class="btn" style="--bg-mix: ' + hue + '">Save</button>');
    var cs = getComputedStyle(node);
    var ratio = contrast(cs.color, cs.backgroundColor);
    assert.ok(
      ratio >= AA,
      'an undeclared hue ' + hue + ' rendered at ' + ratio.toFixed(2) + ':1 — ' +
        'the contrast derivation does not generalize'
    );
    cleanup();
  });
});

test('contrast: a bright fill keeps its hue and takes dark text', function () {
  /*
   * The half of the branch that matters commercially: Elite's lime brand
   * must stay lime. Dimming it to fit white text would be a "fix" that
   * silently rebrands the client.
   */
  var node = el('<button class="btn" style="--bg-mix: #ffff00">Save</button>');
  var cs = getComputedStyle(node);
  assert.sameColor(cs.backgroundColor, '#ffff00', 'a bright fill was dimmed instead of taking dark text');
  /* Dark text is text that contrasts strongly against white, not against black. */
  assert.atLeast(
    contrast(cs.color, '#ffffff'),
    AA,
    'expected dark text on a bright fill, got ' + cs.color
  );
});

test('contrast: --on-bg-mix still overrides the derivation', function () {
  /*
   * The derivation replaced --on-bg-mix as an assertion but kept it as an
   * escape hatch, which is what lets a theme pin a specific text color.
   * If the override stopped working, the only way to change chip text
   * would be to fight the luminance branch.
   */
  var node = el('<button class="btn primary" style="--on-bg-mix: #123456">Save</button>');
  assert.sameColor(style(node, 'color'), '#123456', '--on-bg-mix no longer overrides');
});

test('contrast: body text clears AA on every theme surface', function () {
  /*
   * Tones get all the attention, but the neutral pairing is what most of a
   * screen actually is. --ink on --surface, and the muted variants, have
   * never been checked.
   */
  var pairs = [
    ['--ink', '--surface'],
    ['--ink', '--surface-raised'],
    ['--ink', '--surface-sunken'],
    ['--ink-soft', '--surface'],
    ['--ink-soft', '--surface-sunken'],
    ['--ink-mute', '--surface'],
    /* .table th is --ink-mute on --surface-sunken — the tighter pairing. */
    ['--ink-mute', '--surface-sunken'],
    ['--ink-mute', '--surface-raised'],
  ];

  /*
   * Every pair is measured before anything is asserted. A per-pair assert
   * stops at the first failure and reports one number, which tells you
   * nothing about whether it is one bad token or a systemic problem — and
   * that distinction decides whether the fix is a value or a rethink.
   */
  var failures = [];

  THEMES.forEach(function (theme) {
    var probe = themed(theme, '<div>x</div>');
    var cs = getComputedStyle(probe);

    pairs.forEach(function (pair) {
      var fg = cs.getPropertyValue(pair[0]).trim();
      var bg = cs.getPropertyValue(pair[1]).trim();
      var ratio = contrast(fg, bg);

      /*
       * AA for body text is 4.5:1. The 3:1 threshold is for large text,
       * and none of these are: --ink-mute is placeholder text, table
       * headers, field hints and nav labels, all at 11–13px.
       */
      if (ratio < AA) {
        failures.push(
          'theme-' + theme + '  ' + pair[0] + ' on ' + pair[1] +
          '  ' + ratio.toFixed(2) + ':1'
        );
      }
    });
    cleanup();
  });

  assert.equal(
    failures.length,
    0,
    failures.length + ' neutral text pairs below AA:\n        ' + failures.join('\n        ')
  );
});
