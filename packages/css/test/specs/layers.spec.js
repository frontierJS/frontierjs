/*
 * layers.spec.js — the cascade-layer order is the architecture.
 *
 * index.css declares one layer order and the whole system leans on it:
 * `.bar` beats `.center` because layout precedes patterns, consumer CSS
 * overrides the package without !important because unlayered beats every
 * layer, and the focus ring cannot be switched off by a component because
 * it sits in the last one.
 *
 * None of that is visible in any single file, and all of it breaks
 * silently if the order is reshuffled — the failure is a subtly wrong
 * background, not an error. These tests make the order load-bearing in a
 * way that shows up as red.
 */

var EXPECTED_ORDER = [
  /*
   * First, and it has to be: the only rule in reset.css targets a bare
   * element, so a `:where()` base at zero specificity would otherwise tie
   * with it and win on source order.
   */
  'reset',
  'tokens',
  'themes',
  'tones',
  'base',
  'layout',
  'components',
  'patterns',
  'utilities',
  'a11y',
];

test('layers: the declared order is the documented one', function () {
  var statements = [];
  var sheet = document.styleSheets[0];
  for (var i = 0; i < sheet.cssRules.length; i++) {
    var r = sheet.cssRules[i];
    if (window.CSSLayerStatementRule && r instanceof CSSLayerStatementRule) {
      statements.push(Array.prototype.slice.call(r.nameList));
    }
  }
  assert.equal(statements.length, 1, 'expected exactly one @layer statement in index.css');
  assert.equal(
    statements[0].join(' → '),
    EXPECTED_ORDER.join(' → '),
    'the layer order changed — every override in the package depends on it'
  );
});

test('layers: every import lands in a declared layer', function () {
  /*
   * An @import without `layer(...)` is unlayered, and unlayered beats every
   * layer — so one forgotten annotation would put a component file above
   * the a11y primitives and above any consumer override, silently.
   */
  var sheet = document.styleSheets[0];
  var unlayered = [];
  for (var i = 0; i < sheet.cssRules.length; i++) {
    var r = sheet.cssRules[i];
    if (!(window.CSSImportRule && r instanceof CSSImportRule)) continue;
    if (!r.layerName || EXPECTED_ORDER.indexOf(r.layerName) === -1) {
      unlayered.push(r.href + ' → ' + JSON.stringify(r.layerName));
    }
  }
  assert.equal(
    unlayered.length,
    0,
    'imports not in a declared layer:\n        ' + unlayered.join('\n        ')
  );
});

/* ── What the order actually buys ────────────────────────────────────*/

test('layers: .bar.center stays a flex bar, not a centring grid', function () {
  /*
   * `.center` (layout.css) is "centre on both axes, via grid".
   * `.bar.center` (bars.css) is "centre this bar's contents, still flex".
   * Both are single-class selectors on `display`, so specificity cannot
   * separate them — only `layout` sitting before `patterns` does.
   *
   * This is the collision that the naming question is really about; until
   * it is resolved, this test is what holds the answer in place.
   */
  var bar = el('<div class="bar center"><button class="btn">A</button></div>');
  assert.equal(style(bar, 'display'), 'flex', '.bar.center collapsed into the .center grid');

  var plain = el('<div class="center">x</div>');
  assert.equal(style(plain, 'display'), 'grid', '.center is no longer a centring grid');
});

test('layers: a .text-* utility beats a component that sets its own font-size', function () {
  /*
   * The bug the `utilities` layer was added for (v0.10.1). `.btn` declares
   * `font-size: 0.875rem` and buttons.css is imported after typography.css;
   * while the size utilities lived in `components` alongside it, the two
   * tied on specificity and source order settled it — so every one of the
   * five documented size modifiers rendered at 14px on a button, and the
   * style guide showed five identical buttons under a caption explaining
   * how they differ.
   *
   * Checked on .btn because that is where it bit, and on .badge because the
   * fix has to be layer-wide rather than a rule aimed at buttons.
   */
  var steps = [
    ['text-xs', '12px'],
    ['text-sm', '13px'],
    ['text-md', '14px'],
    ['text-lg', '16px'],
    ['text-xl', '18px'],
  ];

  steps.forEach(function (step) {
    var btn = el('<button class="btn ' + step[0] + '">Save</button>');
    assert.equal(
      style(btn, 'font-size'),
      step[1],
      '.btn.' + step[0] + ' lost to .btn’s own font-size'
    );
  });

  var badge = el('<span class="badge text-xl">New</span>');
  assert.equal(style(badge, 'font-size'), '18px', '.badge.text-xl lost to .badge');

  /* Colour is the other axis, and it has the same problem to avoid. */
  var delta = el('<div class="tile"><div class="tile-delta text-danger">d</div></div>');
  assert.sameColor(
    style(delta.firstChild, 'color'),
    'rgb(244, 64, 58)',
    '.text-danger lost to .tile-delta'
  );
});

test('layers: utilities still lose to the a11y primitives', function () {
  /*
   * `utilities` is late, but not last. `.visually-hidden` has to win over
   * anything a consumer chains onto it, or an icon-only button's label
   * becomes visible.
   */
  var span = el('<span class="visually-hidden text-xl">Delete invoice</span>');
  assert.equal(style(span, 'position'), 'absolute', '.visually-hidden was outranked');
  assert.equal(style(span, 'width'), '1px', '.visually-hidden was outranked');
});

test('layers: unlayered consumer CSS beats the package without !important', function () {
  /*
   * The promise made to consumers. A plain rule in an app stylesheet is
   * unlayered, and unlayered beats every layer regardless of specificity —
   * so overriding this package should never need an !important or a
   * specificity war.
   */
  var sheet = document.createElement('style');
  sheet.textContent = '.btn { background-color: rgb(1, 2, 3); }';
  document.head.appendChild(sheet);
  try {
    var btn = el('<button class="btn primary">Save</button>');
    assert.sameColor(
      style(btn, 'background-color'),
      'rgb(1, 2, 3)',
      'a single-class unlayered rule failed to override .btn.primary'
    );
  } finally {
    sheet.remove();
  }
});

test('layers: a component cannot switch the focus ring off by accident', function () {
  /*
   * The regression that put focus.css in the a11y layer. `.btn.outlined`
   * killed its own focus ring with `box-shadow: none` — same specificity,
   * same layer, declared later. In the last layer that cannot happen: this
   * injects the most aggressive version of that mistake into the
   * components layer and the ring survives on layer order alone.
   */
  var sheet = document.createElement('style');
  sheet.textContent =
    '@layer components { .btn:focus-visible, .btn.outlined:focus-visible { outline: none; box-shadow: none; } }';
  document.head.appendChild(sheet);
  try {
    var btn = el('<button class="btn outlined">Save</button>');
    btn.focus();
    assert.ok(
      hasVisibleRing(btn),
      'a components-layer `outline: none` erased the focus ring'
    );
  } finally {
    sheet.remove();
  }
});

test('layers: a consumer can still remove a ring deliberately', function () {
  /*
   * The other half. Making the ring hard to lose by accident must not make
   * it impossible to change on purpose — an unlayered rule still wins.
   */
  var sheet = document.createElement('style');
  sheet.textContent = '.btn:focus-visible { outline: none; }';
  document.head.appendChild(sheet);
  try {
    var btn = el('<button class="btn">Save</button>');
    btn.focus();
    assert.equal(style(btn, 'outline-style'), 'none', 'an unlayered override could not remove the ring');
  } finally {
    sheet.remove();
  }
});

/*
 * Remove every `:where(…)` group, matching parentheses by depth so nested
 * groups come out whole. What is left is the part of the selector that
 * still carries specificity.
 */
function stripWhere(selector) {
  var out = '';
  var i = 0;
  while (i < selector.length) {
    var at = selector.indexOf(':where(', i);
    if (at === -1) {
      out += selector.slice(i);
      break;
    }
    out += selector.slice(i, at);
    var depth = 0;
    var j = at + ':where'.length;
    for (; j < selector.length; j++) {
      if (selector[j] === '(') depth++;
      else if (selector[j] === ')') {
        depth--;
        if (depth === 0) { j++; break; }
      }
    }
    i = j;
  }
  return out;
}

test('layers: a lineage base contributes no specificity', function () {
  /*
   * chip.css, surface.css and focus.css each write ONE rule body targeting
   * a whole family, at zero specificity, so a composite can restate
   * anything it needs without a specificity war. If a base ever gained
   * class specificity, every composite would start losing to it.
   *
   * The claim is about specificity, not text, so this measures it: strip
   * every :where() group — which contributes none by definition — and
   * check no class or id survives in the residue.
   *
   * Only rules that use :where() are in scope. The Anatomy classes that
   * also live in surface.css (.surface-header and friends) are ordinary
   * component rules that nothing needs to override, and they carry
   * specificity on purpose.
   *
   * Splitting selectorText on commas does not work here: `:where(.card,
   * .alert)` is one selector, and naive splitting reports its innards as
   * bare classes. Hence stripping balanced groups.
   */
  var offenders = [];
  allRules().forEach(function (rule) {
    if (!(window.CSSStyleRule && rule instanceof CSSStyleRule)) return;
    var href = (rule.parentStyleSheet && rule.parentStyleSheet.href) || '';
    if (!/\/(chip|surface|focus)\.css$/.test(href)) return;
    if ((rule.selectorText || '').indexOf(':where(') === -1) return;

    var residue = stripWhere(rule.selectorText);
    if (/[.#][A-Za-z_-]/.test(residue)) {
      offenders.push(href.split('/').pop() + ': ' + rule.selectorText + '  (residue: ' + residue + ')');
    }
  });
  assert.equal(
    offenders.length,
    0,
    'a base was only half-wrapped, so part of it carries specificity:\n        ' +
      offenders.join('\n        ')
  );
});

test('layers: every composite is actually enrolled in its base', function () {
  /*
   * The other half, and the one that rots. Both bases work by enumerating
   * their family in a :where() list, so a new composite is only joined to
   * the lineage by being added to that list — a step nothing enforces.
   *
   * That is exactly how the pre-v0.6 shortcuts failed: `.card` was
   * documented as `surface + padding` but never actually carried the
   * surface base, so surface.css had to re-enumerate composites anyway.
   */
  var enrolled = {};
  allRules().forEach(function (rule) {
    if (!(window.CSSStyleRule && rule instanceof CSSStyleRule)) return;
    var href = (rule.parentStyleSheet && rule.parentStyleSheet.href) || '';
    var file = href.split('/').pop();
    if (file !== 'chip.css' && file !== 'surface.css') return;
    if ((rule.selectorText || '').indexOf(':where(') === -1) return;
    enrolled[file] = (enrolled[file] || '') + rule.selectorText;
  });

  var LINEAGES = {
    'chip.css': ['.btn', '.pill', '.badge', '.pagination-link', '.tooltip', '.avatar', '.step-marker'],
    'surface.css': ['.card', '.tile', '.alert', '.toast', '.dialog', '.popover', '.drawer'],
  };

  Object.keys(LINEAGES).forEach(function (file) {
    assert.ok(enrolled[file], file + ' has no :where() base group at all');
    LINEAGES[file].forEach(function (composite) {
      assert.ok(
        new RegExp('\\' + composite + '(?![\\w-])').test(enrolled[file]),
        composite + ' is not enrolled in the ' + file + ' lineage — it will not inherit the base'
      );
    });
  });
});

/* ── !important reverses layer order ─────────────────────────────────*/

test('layers: the reduced-motion spinner exception lives with its guard', function () {
  /*
   * tokens.css forces `animation-duration: 0.01ms !important` on
   * everything under prefers-reduced-motion, which would freeze a spinner
   * — a frozen spinner reads as a broken page, so .spinner gets an
   * exception at 1.6s.
   *
   * That exception has to sit in tokens.css, because IMPORTANT
   * declarations resolve in REVERSE layer order: an !important in the
   * first layer beats one in the last. Move the exception to feedback.css
   * and the guard silently wins again. Nothing about the CSS would look
   * wrong; the spinner would just stop.
   */
  var guardSheets = [];
  var exceptionSheets = [];

  allRules().forEach(function (rule) {
    if (!(window.CSSStyleRule && rule instanceof CSSStyleRule)) return;
    var text = rule.cssText || '';
    if (text.indexOf('animation-duration') === -1 || text.indexOf('important') === -1) return;

    var href = ((rule.parentStyleSheet && rule.parentStyleSheet.href) || '').split('/').pop();
    if (/\.spinner|\.loading/.test(rule.selectorText || '')) exceptionSheets.push(href);
    else guardSheets.push(href);
  });

  assert.atLeast(guardSheets.length, 1, 'the reduced-motion guard is gone');
  assert.atLeast(exceptionSheets.length, 1, 'the spinner exception is gone — spinners freeze under reduced motion');
  exceptionSheets.forEach(function (href) {
    assert.equal(
      guardSheets.indexOf(href) > -1,
      true,
      'the spinner exception is in ' + href + ' but the guard is in ' +
        guardSheets.join('/') + ' — !important resolves in reverse layer order, so the guard wins'
    );
  });
});

/* ── Registered properties ───────────────────────────────────────────*/

test('layers: the scoped custom properties stay non-inheriting', function () {
  /*
   * --bg-mix, --on-bg-mix and --ring-color are registered `inherits: false`
   * so a value set for one element does not leak into every descendant
   * that reads it. Losing that registration brings back tones bleeding
   * through untoned children — an untoned .btn inside .alert.danger
   * rendering red on red.
   *
   * `syntax: "*"` with no initial-value is the other half: it is what
   * leaves the property guaranteed-invalid when unset, which is what makes
   * every `var(--bg-mix, fallback)` in the package reach its fallback.
   */
  var registered = {};
  allRules().forEach(function (rule) {
    if (window.CSSPropertyRule && rule instanceof CSSPropertyRule) {
      registered[rule.name] = rule;
    }
  });

  ['--bg-mix', '--on-bg-mix', '--ring-color'].forEach(function (name) {
    var rule = registered[name];
    assert.ok(rule, name + ' is no longer registered with @property');
    assert.equal(rule.inherits, false, name + ' became inheriting — tones will bleed into descendants');
    assert.equal(rule.syntax, '*', name + ' gained a syntax, which breaks its var() fallbacks');
    assert.ok(
      !rule.initialValue,
      name + ' gained an initial-value, so it is never guaranteed-invalid and no fallback fires'
    );
  });
});
