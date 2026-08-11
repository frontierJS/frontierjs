/*
 * contrast.spec.js — text on a solid fill clears WCAG AA, for every tone,
 * in every theme.
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
var THEMES = ['default', 'sunset', 'forest', 'midnight', 'dark', 'elite', 'basecamp', 'press'];

/* The chip lineage — everything that renders a tone as a solid fill. */
var FILLED = [
  { name: '.btn', html: '<button class="btn TONE">Save changes</button>' },
  { name: '.pill', html: '<span class="pill TONE">99+</span>' },
  { name: '.badge', html: '<span class="badge TONE">Overdue</span>' },
];

var AA = 4.5;

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
    '#7f7f7f', // mid grey, right at the branch
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
        'the contrast derivation does not generalise'
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
