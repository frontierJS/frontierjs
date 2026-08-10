/*
 * guide.spec.js — the reference implementation has to use the system.
 *
 * The guide teaches @frontierjs/css. Nothing in this suite had ever loaded
 * any part of it: SKIP_DIRS keeps guide/ out of the shipped-stylesheet
 * collection — correct, that CSS is not the package — and the side effect
 * was that the guide's own markup and tokens were unchecked. Measured on
 * 2026-08-09: 286 hand-rolled `.sg-*` classes against a 54-term vocabulary,
 * a shell hand-built while frame.css ships one, and 28 tokens restated from
 * tokens.css, three of them with the wrong value.
 *
 * Same hole demo.spec.js closes for demo/, and the same reasoning: markup
 * that no spec owns is markup that can name anything at all.
 *
 * ── The three directions ──────────────────────────────────────────────
 *
 *   1  every class the guide WRITES is shipped, or is its own, or is named
 *      here. Catches a typo'd vocabulary class — demo/'s `class="page"` bug
 *   2  no .sg-* class re-declares a shipped term's job. This is the
 *      direction that rots: a term ships, the hand-rolled copy keeps
 *      working, and nothing fails
 *   3  guide.css declares no custom property tokens.css already declares
 *
 * 2 and 3 are the ones nothing else can do. A copy is invisible precisely
 * because it works.
 *
 * ── Why the CSS is parsed, not loaded ─────────────────────────────────
 *
 * guide.css is unlayered, so linking it into the test page would beat every
 * layer of the package and change what the other 300 assertions measure.
 * run.js hands these over as strings; the CSSOM is asked only about the
 * package's own rules.
 */

/* ── The register ──────────────────────────────────────────────────────
 *
 * Category A of guide/AUDIT.md: a .sg-* class whose job a shipped term
 * already does. Data here rather than prose there, so the audit cannot
 * claim a replacement that does not exist — every `ships` value below is
 * asserted against the real CSSOM.
 *
 * Adding a row does NOT fail the suite. It is a to-do with a test behind
 * it: `guide: every replacement named in the audit is really shipped`
 * checks the right-hand side is real, and the closing test reports how many
 * are outstanding. Deleting the .sg-* class and using the term is what
 * closes one.
 */
var REPLACEABLE = {
  'sg-shell':           'shell',
  'sg-topbar':          'topbar',
  'sg-sidebar':         'sidebar',
  'sg-main':            'screen',
  'sg-app':             'app',
  'sg-nav-list':        'navlist',
  'sg-nav-item':        'navlink',
  'sg-nav-group-title': 'navlist-label',
  'sg-section':         'pane',
  'sg-row-flex':        'cluster',
  'sg-preview-box':     'card',
  'sg-token-table':     'table',
  'sg-coming':          'empty',
  'sg-modal':           'dialog',
  'sg-editor':          'field-group',
  'sg-copy':            'btn',
  'sg-next-link':       'card',
  'sg-next-meta':       'stack',
  'sg-theme-trigger':   'btn',
  'sg-config-trigger':  'btn',
  'sg-search-trigger':  'btn',
  'sg-theme-option':    'item',

  /*
   * The Themes page picker. It is on the register despite being declared in
   * instruments.css: that file is for classes that DRAW the system, and this
   * one is an ordinary control sitting beside the preview that does. Being
   * in the other file is exactly why it outlived the sweep that caught its
   * twin in the topbar — the register is what the ratchet reads, not the
   * filename.
   */
  'sg-theme-switcher':  'tiles',
  'sg-theme-tab':       'tile',
  'sg-theme-tab-text':  'item-text',
  'sg-theme-tab-name':  'item-title',
  'sg-theme-tab-desc':  'item-sub',

  /*
   * The Learn wizard. It hand-rolled 27 classes for a trail, two cards, an
   * option grid, a filter control and an action bar — every one of which the
   * package ships — and none of them moved with `.dense` or the type ladder,
   * because each was a literal. The reference implementation was the last
   * place in the repo not speaking the vocabulary.
   *
   * The four left carry only what the term does not: -opt left-aligns and
   * stacks a Tile, -opts overrides the track FUNCTION (auto-fill, so a lone
   * option does not stretch), -trail holds the row's min-height, -crumb
   * strips the Button padding a text run does not want.
   */
  'sg-wiz-trail':       'split',
  'sg-wiz-crumbs':      'breadcrumb',
  'sg-wiz-crumb':       'btn',
  'sg-wiz-card':        'card',
  'sg-wiz-out':         'card',
  'sg-wiz-opts':        'tiles',
  'sg-wiz-opt':         'tile',
  'sg-wiz-opt-label':   'item-title',
  'sg-wiz-opt-hint':    'item-sub',
  'sg-wiz-chip':        'btn',
  'sg-wiz-chips':       'cluster',
  'sg-wiz-jump':        'btn',
  'sg-wiz-actions':     'cluster',
  'sg-wiz-nolive':      'alert',
  'sg-wiz-facts':       'cluster',
};

/*
 * Not in REPLACEABLE, and each for a stated reason — the register is only
 * useful if a row means "this is debt", so a class that turned out not to be
 * comes out with the finding rather than staying as a permanent near-miss.
 *
 *   sg-swatch      an early draft of AUDIT.md called it a Badge. It is not:
 *                  a Badge carries text, pads around it and derives its ink
 *                  from its fill, and this is an empty 18px square whose
 *                  whole content is a colour. The package has no term for
 *                  "a colour, shown" because that is what a guide does.
 *   sg-search-kbd  the element is already a <kbd> and code.css styles the
 *                  ELEMENT, so the Kbd term was never missing. The class
 *                  survives as the hook the narrow-viewport rule hides it
 *                  by, not as a copy of anything.
 *   sg-stack       Stack is `gap: var(--space-2xl)` between block sections;
 *                  this is a 12px column of preview rows that also stretches
 *                  its children. Same shape, different job — using .stack
 *                  and then overriding both declarations says the term fits
 *                  when it does not.
 */

/*
 * Classes the guide writes that are neither shipped nor `sg-`-prefixed, each
 * with the reason. A register rather than a skip-list: an entry that stops
 * appearing in the guide fails, so this cannot silently accumulate.
 */
var NOT_SHIPPED_OK = {
  tonal: 'an instrument class from instruments.css, unprefixed for historical reasons — see the note in that file',
  brand: 'the compare page\'s worked example — a deliberate live <style> demonstrating one --bg-mix rule',
};

/* ── 1. Every class the guide writes is one the package ships ───────── */

test('guide: every class in guide.js markup is shipped, its own, or named here', function () {
  var declared = {};
  allRules().forEach(function (rule) {
    if (!(window.CSSStyleRule && rule instanceof CSSStyleRule)) return;
    ((rule.selectorText || '').match(/\.[a-zA-Z][a-zA-Z0-9_-]*/g) || []).forEach(function (c) {
      declared[c.slice(1)] = true;
    });
  });

  /* The guide's own chrome and instruments. Both files are .sg-*; the two
     unprefixed instrument classes are in NOT_SHIPPED_OK by name. */
  function isGuideOwn(cls) {
    return cls.indexOf('sg-') === 0;
  }

  /*
   * Code SAMPLES are stripped before scanning, and that is the whole
   * difficulty of this test. The guide quotes other frameworks on purpose —
   * the compare page shows the same button in Tailwind, Bootstrap and Bulma
   * — so `class="btn btn-outline-danger"` appears in this file as a
   * *quotation*, rendered through esc() into text. Scanning the raw source
   * reports 30 of those as classes the package does not ship, which is true
   * and completely beside the point.
   *
   * A sample is the first argument to code()/codeShell(), always a template
   * literal. Dropping every backtick-delimited run drops the samples and
   * keeps the markup, which is built with ordinary string concatenation and
   * quoted attributes.
   */
  var markup = window.__FJS_GUIDE_JS__
    .replace(/`[\s\S]*?`/g, '')
    /*
     * <code> contents go too, for the same reason one level down: a guide
     * about class names quotes them in prose constantly, and
     * `<code>class="card p-4"</code>` is a sentence about UnoCSS, not a
     * div. Five of these survived the sample strip — including
     * `class="card-small-blue-bordered"`, which the taxonomy page cites as
     * an example of a name NOBODY should write.
     */
    .replace(/<code>[\s\S]*?<\/code>/g, '');

  /*
   * Only static class="..." attributes. guide.js also builds classes by
   * interpolation (`class="btn ${tone}"`) and those cannot be read without
   * running it — the ones that matter are covered by components.spec.js
   * against the real rules anyway.
   */
  var missing = {};
  (markup.match(/class="([^"${}]*)"/g) || []).forEach(function (attr) {
    attr
      .slice(7, -1)
      .split(/\s+/)
      .forEach(function (c) {
        if (!c || declared[c] || isGuideOwn(c) || NOT_SHIPPED_OK[c]) return;
        missing[c] = true;
      });
  });

  var names = Object.keys(missing).sort();
  assert.equal(
    names.length,
    0,
    'the guide writes a class the stylesheet does not ship:\n        ' +
      names.map(function (c) { return '.' + c; }).join('\n        ')
  );
});

test('guide: every exception in NOT_SHIPPED_OK is still written by the guide', function () {
  /*
   * The reverse direction. An exception that outlives its use is a licence
   * nobody is using and the next reader has to evaluate.
   */
  var stale = Object.keys(NOT_SHIPPED_OK).filter(function (cls) {
    var re = new RegExp('class="[^"]*\\b' + cls + '\\b');
    return !re.test(window.__FJS_GUIDE_JS__) &&
           window.__FJS_GUIDE_CSS__.indexOf('.' + cls) === -1 &&
           window.__FJS_INSTRUMENTS_CSS__.indexOf('.' + cls) === -1;
  });

  assert.equal(
    stale.length,
    0,
    'NOT_SHIPPED_OK names a class the guide no longer writes:\n        ' + stale.join('\n        ')
  );
});

/* ── 2. The replacements the audit names are real ───────────────────── */

test('guide: every replacement named in the audit is really shipped', function () {
  /*
   * The audit is a document and documents rot. Each right-hand side is
   * asked of the live CSSOM, so a renamed or removed term fails here rather
   * than misleading whoever picks the work up.
   */
  var declared = {};
  allSelectors().forEach(function (sel) {
    (sel.match(/\.[a-zA-Z][a-zA-Z0-9_-]*/g) || []).forEach(function (c) {
      declared[c.slice(1)] = true;
    });
  });

  var bogus = Object.keys(REPLACEABLE).filter(function (sg) {
    return !declared[REPLACEABLE[sg]];
  }).map(function (sg) {
    return '.' + sg + ' -> .' + REPLACEABLE[sg] + ' (not shipped)';
  });

  assert.equal(
    bogus.length,
    0,
    'guide/AUDIT.md names a replacement the package does not ship:\n        ' + bogus.join('\n        ')
  );
});

/* ── 3. The guide declares no token the package already owns ────────── */

test('guide: guide.css declares no custom property tokens.css declares', function () {
  /*
   * The check that would have caught all three token bugs on the day they
   * landed. A restated token is invisible while the values agree, which is
   * how 28 of them survived four versions — and how --ring got written in
   * the one form tokens.css forbids by name.
   *
   * The guide is allowed its own brand: --paper, --accent, --code-bg and
   * --code-text are not in tokens.css, so they do not appear here. The rule
   * is not "declare nothing", it is "do not restate the package".
   *
   * THEMEABLE is the other half of that distinction, and it is a short list
   * on purpose. A token whose shipped value is a stated default — the font
   * stack is `system-ui, sans-serif`, which exists to be replaced — is one
   * a consumer is supposed to set, and the guide is a consumer. Restating
   * `--surface: #ffffff` is a copy; setting `--font-primary: Geist` is the
   * token doing its job. Anything not on this list is a copy until someone
   * argues otherwise here.
   */
  var THEMEABLE = { '--font-primary': true, '--font-mono': true };
  var shipped = {};
  allRules().forEach(function (rule) {
    if (!(window.CSSStyleRule && rule instanceof CSSStyleRule)) return;
    if ((rule.selectorText || '').indexOf(':root') === -1) return;
    for (var i = 0; i < rule.style.length; i++) {
      var p = rule.style[i];
      if (p.indexOf('--') === 0) shipped[p] = true;
    }
  });

  /*
   * Read from the authored text, not a live sheet: guide.css is not loaded
   * into this page on purpose. Only the :root block — a --custom-prop set
   * ON a .sg-* class is that component's own business.
   */
  var rootBlock = (window.__FJS_GUIDE_CSS__.match(/:root\s*\{([\s\S]*?)\}/) || [])[1] || '';
  var restated = (rootBlock.match(/--[a-zA-Z0-9-]+\s*:/g) || [])
    .map(function (d) { return d.replace(/\s*:$/, ''); })
    .filter(function (p) { return shipped[p] && !THEMEABLE[p]; });

  assert.equal(
    restated.length,
    0,
    'guide.css restates a token the package ships — delete it and inherit:\n        ' +
      restated.join('\n        ')
  );
});

test('guide: --ring is not declared at :root anywhere in the guide', function () {
  /*
   * Called out separately from the test above because it is the one that
   * bites even when the VALUE is right. tokens.css:
   *
   *   `--ring: var(--color-primary)` at :root looks equivalent and silently
   *   isn't: the var() resolves once, against :root's own --color-primary,
   *   and the computed value then inherits past any .theme-* override.
   *
   * So a guide that declares it pins every focus ring to one theme's
   * colour. focus.css reads `var(--ring, var(--color-primary))` at the use
   * site, which is the form that follows a theme switch.
   */
  var both = window.__FJS_GUIDE_CSS__ + '\n' + window.__FJS_INSTRUMENTS_CSS__;
  var rootBlocks = both.match(/:root\s*\{[\s\S]*?\}/g) || [];
  var offenders = rootBlocks.filter(function (b) { return /--ring\s*:/.test(b); });

  assert.equal(
    offenders.length,
    0,
    '--ring is declared at :root in the guide. It must be a use-site fallback ' +
      '— see the alias-trap note in foundation/tokens.css'
  );
});

/* ── The split, and what is left of it ──────────────────────────────── */

test('guide: instruments.css and guide.css do not both declare a class', function () {
  /*
   * The split is only meaningful while it is a partition. A class declared
   * in both files is a merge conflict that renders — last one wins, and
   * which one that is depends on the <link> order in index.html.
   */
  /*
   * The SUBJECT of the selector, not every class in it. `.sg-wiz-opt .sg-sk`
   * in instruments.css styles the sketch inside a wizard option — the
   * sketch's own spacing, which belongs with the sketches — and reading it
   * as a declaration of .sg-wiz-opt reports a conflict that is not one. A
   * file may reach INTO another's component; what it may not do is declare
   * the same subject twice.
   */
  function classesIn(css) {
    var out = {};
    css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\.[^{]*)\{/gm, function (_, sel) {
      sel.split(',').forEach(function (one) {
        /* The last compound is the subject; take its first class. */
        var compound = one.trim().split(/\s+|>|\+|~/).filter(Boolean).pop() || '';
        var m = compound.match(/^\.(sg-[a-zA-Z0-9_-]+)/);
        if (m) out['.' + m[1]] = true;
      });
      return '';
    });
    return out;
  }

  var a = classesIn(window.__FJS_GUIDE_CSS__);
  var b = classesIn(window.__FJS_INSTRUMENTS_CSS__);
  var both = Object.keys(a).filter(function (c) { return b[c]; }).sort();

  assert.equal(
    both.length,
    0,
    'a class is declared in BOTH guide.css and instruments.css:\n        ' + both.join('\n        ')
  );
});

test('guide: the replaceable-class debt does not grow', function () {
  /*
   * A ratchet, in the spirit of the repo's typecheck baselines: the number
   * may go DOWN as classes are replaced with the shipped term, never up.
   * Lower it when you close one; the assertion message says how.
   *
   * It counts what is still WRITTEN in the guide's markup, not what is
   * declared in the CSS — a dead rule is not debt the reader can see.
   */
  /*
   * Zero. Every class in REPLACEABLE now appears beside the term it was
   * standing in for, so the ratchet's only remaining job is to stay at zero:
   * a new hand-rolled shell, nav or dialog fails here the day it lands.
   */
  var CEILING = 0;

  /*
   * A .sg-* class counts as debt only where the shipped term is NOT beside
   * it. `class="btn outlined sg-copy"` is not a hand-rolled button — it is
   * the package's, plus where this one sits, which is what a consumer is
   * supposed to write. `class="sg-copy"` alone would be the copy this
   * ratchet exists to count.
   *
   * `\b` is not a class boundary either: `sg-topbar\b` matches inside
   * `sg-topbar-inner`, so a class that is gone still reads as live. The
   * token has to end at whitespace or the closing quote.
   */
  var live = Object.keys(REPLACEABLE).filter(function (sg) {
    var attrs = window.__FJS_GUIDE_JS__.match(/class="[^"${}]*"/g) || [];
    var token = new RegExp('(?:^|\\s)' + sg + '(?:\\s|$)');
    var shipped = new RegExp('(?:^|\\s)' + REPLACEABLE[sg] + '(?:\\s|$)');
    return attrs.some(function (a) {
      var list = a.slice(7, -1);
      return token.test(list) && !shipped.test(list);
    });
  });

  assert.ok(
    live.length <= CEILING,
    'the guide hand-rolls ' + live.length + ' classes a shipped term already does, ' +
      'ceiling is ' + CEILING + '. Replace one, then lower CEILING:\n        ' +
      live.map(function (s) { return '.' + s + ' -> .' + REPLACEABLE[s]; }).join('\n        ')
  );
});

/* ── The redundancy sweep — computed values, not class names ────────── */

/*
 * The check the other six could not make, and the reason it is worth its
 * length: everything above compares NAMES. A name search finds `.sg-copy`
 * next to `.btn` and is satisfied; it cannot find `.sg-stack-divider`, a
 * <div> hand-drawing the 1px rule that `<hr>` has shipped all along, because
 * the two strings have nothing in common.
 *
 * So this renders every `.sg-*` class and every candidate term and compares
 * what the browser actually computes. A class is redundant only when the
 * shipped term produces the same numbers.
 *
 * Found five on its first run, after two passes of name-matching had twice
 * reported the work finished: .sg-topbar-inner (= Split), .sg-stack-divider
 * (= <hr>), .sg-sk-center (= Center), .sg-wiz-facts (= Cluster) and
 * .sg-cheat-matrix (= Tile).
 *
 * ── Two ways to get this wrong, both measured ─────────────────────────
 *
 * Comparing property NAMES rather than values reports 220 matches and means
 * nothing: every class sets color and font-size, so .btn "matches" the whole
 * file. It has to be the computed values.
 *
 * And the property list has to be long enough. At 21 properties this
 * reported eight false positives, all of them list terms — .items and
 * .navlist carry list-style/margin/padding resets that a <div> probe cannot
 * show and that the short list did not read. At 38 they disappear. A
 * property left out is a difference this cannot see, so err long.
 */

var PROBE_PROPS = [
  'display', 'position', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'margin-top', 'margin-bottom', 'border-top-width', 'border-radius', 'background-color',
  'color', 'font-size', 'font-weight', 'font-family', 'row-gap', 'column-gap',
  'align-items', 'align-content', 'justify-content', 'justify-items', 'place-items',
  'flex-direction', 'flex-grow', 'flex-basis', 'flex-wrap',
  'min-width', 'min-height', 'height', 'width', 'max-width', 'list-style-type',
  'box-shadow', 'cursor', 'text-align', 'text-transform', 'letter-spacing', 'line-height',
  'overflow-x', 'overflow-y', 'grid-template-columns', 'opacity',
];

/*
 * The terms a guide class could plausibly be a copy of. Not every shipped
 * class — a match against something like .surface-header would be noise,
 * since a guide class is never trying to be a sub-region.
 */
var PROBE_TERMS = [
  'btn', 'card', 'tile', 'alert', 'item', 'list-row', 'field', 'field-group', 'table',
  'code', 'kbd', 'pill', 'badge', 'avatar', 'chip', 'surface', 'cluster', 'stack', 'split',
  'center', 'container', 'empty', 'navlist', 'navlink', 'items', 'facts', 'steps', 'step',
  'tabs', 'tab', 'tablist', 'bar', 'toolbar', 'pane', 'dialog', 'drawer', 'popover', 'toast',
  'tooltip', 'feed', 'divider', 'progress', 'spinner', 'skeleton', 'tiles', 'rows', 'avatars',
];

test('guide: no .sg-* class renders identically to a shipped term', function () {
  /*
   * The guide's CSS is injected for the duration of this test and removed in
   * the finally. It is unlayered, so leaving it in place would beat every
   * layer of the package and change what the other assertions in this run
   * measure — the same reason run.js hands it over as text rather than
   * linking it. layers.spec.js uses the same inject/remove shape.
   */
  var sheet = document.createElement('style');
  sheet.textContent = window.__FJS_GUIDE_CSS__.replace(/@import[^;]+;/g, '') +
    '\n' + window.__FJS_INSTRUMENTS_CSS__;
  document.head.appendChild(sheet);

  try {
    /* Only simple `.sg-foo` subjects: a descendant or state rule cannot be
       rendered standalone, so a probe of one would compare nothing. */
    var subjects = {};
    allRules().forEach(function (rule) {
      if (!(window.CSSStyleRule && rule instanceof CSSStyleRule)) return;
      (rule.selectorText || '').split(',').forEach(function (one) {
        var t = one.trim();
        if (/^\.sg-[\w-]+$/.test(t)) subjects[t.slice(1)] = true;
      });
    });

    var host = document.createElement('div');
    host.className = 'app';
    document.body.appendChild(host);

    function render(cls) {
      var e = document.createElement('div');
      e.className = cls;
      e.textContent = 'Ag';
      host.appendChild(e);
      var cs = getComputedStyle(e);
      return PROBE_PROPS.map(function (p) { return cs.getPropertyValue(p); }).join('|');
    }

    /* A class that changes nothing about a bare div has nothing to compare —
       it is a hook, or it only does something in context. */
    var bare = render('');
    var termSig = {};
    PROBE_TERMS.forEach(function (t) {
      var sig = render(t);
      if (sig !== bare) termSig[t] = sig;
    });

    var dupes = [];
    Object.keys(subjects).forEach(function (sg) {
      var sig = render(sg);
      if (sig === bare) return;
      Object.keys(termSig).forEach(function (t) {
        if (termSig[t] === sig) dupes.push('.' + sg + ' renders exactly as .' + t);
      });
    });

    host.remove();

    assert.equal(
      dupes.length,
      0,
      'a guide class renders identically to a term the package ships — ' +
        'write the term and keep only what differs:\n        ' + dupes.join('\n        ')
    );
  } finally {
    sheet.remove();
  }
});

/*
 * ── 9. …and none is a shipped term plus a tweak ───────────────────────
 *
 * The check above demands a byte-identical signature, and that is exactly
 * how the Themes page picker survived it: `.sg-theme-tab` was `.tile` plus a
 * padding, so ONE differing property made it invisible. A term with a tweak
 * on top is the normal way this debt appears — nobody hand-rolls an exact
 * copy, they hand-roll a copy they then adjust.
 *
 * So this asks the weaker question — how CLOSE is the nearest term — and
 * puts the answer in a register rather than a threshold. `%` is properties
 * matched out of PROBE_PROPS; an entry in ACCEPTED_NEAR names the term and
 * the properties that differ, so an exception is a specific claim that goes
 * stale loudly when the class changes underneath it.
 *
 * ── Why the obvious gate does not work ────────────────────────────────
 *
 * Three terms produced 40 of the first run's 56 findings — `.feed`,
 * `.skeleton` and `.spinner`. Each is defined by properties a <div> probe
 * cannot read (background-image, animation, user-select, a border colour),
 * so each sits 1–5 properties from a bare div and EVERY one-line guide
 * class lands within 90% of it. `.sg-next-arrow` — a colour and a font-size
 * — is not "90% of a skeleton" in any sense a reader would accept.
 *
 * The tempting fix is a threshold on how far the term itself sits from
 * default. Measured, that is wrong: `.spinner` differs in 5 properties and
 * `.tiles` in 4, so any cut that drops the noise drops `.tiles` with it —
 * and `.tiles` is the term this whole check was written to find (three
 * guide classes are a .tiles with a different track width). A threshold
 * cannot separate them because SIZE is not what makes a match meaningful.
 *
 * What does is WHICH properties agree. A resemblance is only interesting if
 * the two classes agree on how the box is BUILT — display, the flex/grid
 * axes, gap, alignment. Agreeing on `border-radius` and `color` is a
 * coincidence between any two styled boxes. So a term must set at least one
 * STRUCTURAL property, and the near-miss must agree with it on all of them:
 * `.tiles` (display+grid-template-columns) qualifies, `.spinner` (border,
 * radius, height, width — no structure) does not, and no threshold has to
 * guess.
 *
 * `list-style-type` is dropped from the diff for a related reason: a <div>
 * cannot show a list reset, so every `ul`-based term differs from every
 * guide class by it and it carries no signal.
 *
 * The floor is 0.90 — measured. At 0.85 the run fills with two unrelated
 * flex boxes; at 0.95 it misses `.sg-wiz-opts`, a .tiles with a different
 * track function, which is a real one.
 */

var NEAR_FLOOR = 0.9;

/*
 * How a box is built, as opposed to how it is painted or spaced.
 *
 * `display` is deliberately NOT here even though it is the most structural
 * property there is: `.spinner` is an inline-block circle and nothing else
 * the probe can read, so display alone would readmit it and every 16px box
 * in the guide "nearly" is one. A term earns comparison by stating a LAYOUT
 * — an axis, a track, an alignment — not merely by having a box type.
 *
 * The gaps are absent for the opposite reason: `.sg-card-grid` is a .tiles
 * whose gap is 12px rather than 16px, which is the exact case this check
 * exists to catch. A gap is a value inside a layout, not a different layout.
 */
var STRUCTURAL = [
  'flex-direction', 'flex-wrap', 'grid-template-columns',
  'align-items', 'justify-content', 'place-items',
];

/*
 * A near miss that has been looked at and kept, `sg-class`: 'term: prop,prop'.
 * The properties are the ones that MUST still differ — if the class drifts
 * closer or further, the entry stops matching and the check reports it again
 * rather than staying quietly muted.
 */
var ACCEPTED_NEAR = {
  /*
   * A wizard wireframe. `sk-*` is the one family that must NOT be built from
   * the vocabulary — the instruments header states why: drawing a Button and
   * a Link the same way would say the choice between them is visual, which is
   * the thing the wizard exists to deny. That it resembles .items is the
   * coincidence of two flex columns, not a copy.
   */
  'sg-sk-col': 'items: flex-grow,flex-basis',

  /*
   * Stack is `gap: var(--space-2xl)` between block-level page sections; this
   * is a 12px column of preview rows that also stretches its children to full
   * width. The near-miss names .steps, which it resembles for the same
   * accidental reason. Taking a term and then overriding both the properties
   * that make it that term says the term fits when it does not — the same
   * argument the REPLACEABLE register already records for this class.
   */
  'sg-stack': 'steps: row-gap,column-gap,flex-direction',

  /*
   * Already `class="dialog sg-modal"` — the term is written and this is the
   * skin on top. The near-miss names .rows because a flex column with no gap
   * is what a Rows list also is; what it cannot see is that the match is with
   * a term the element does not claim and would not want. The three
   * properties left are the config viewer's own: a max-width, and the
   * column+overflow that lets the <pre> take the remaining height instead of
   * growing the dialog past its own max.
   */
  'sg-modal': 'rows: max-width,overflow-x,overflow-y',

  /*
   * Already `class="card sg-preview-center"`. A centred box with a minimum
   * height, which is what a preview needs so single-chip samples do not sit
   * in a 20px-tall card. .avatars is a flex row that centres — true of any
   * centred row, and an avatar stack is not what this is.
   */
  'sg-preview-center': 'avatars: justify-content,min-height,height',
};

test('guide: no .sg-* class is a shipped term plus a tweak', function () {
  var sheet = document.createElement('style');
  sheet.textContent = window.__FJS_GUIDE_CSS__.replace(/@import[^;]+;/g, '') +
    '\n' + window.__FJS_INSTRUMENTS_CSS__;
  document.head.appendChild(sheet);

  try {
    var subjects = {};
    allRules().forEach(function (rule) {
      if (!(window.CSSStyleRule && rule instanceof CSSStyleRule)) return;
      (rule.selectorText || '').split(',').forEach(function (one) {
        var t = one.trim();
        if (/^\.sg-[\w-]+$/.test(t)) subjects[t.slice(1)] = true;
      });
    });

    var host = document.createElement('div');
    host.className = 'app';
    document.body.appendChild(host);

    function vec(cls) {
      var e = document.createElement('div');
      e.className = cls;
      e.textContent = 'Ag';
      host.appendChild(e);
      var cs = getComputedStyle(e);
      return PROBE_PROPS.map(function (p) { return cs.getPropertyValue(p); });
    }

    var bareVec = vec('');
    var bare = bareVec.join('|');

    /* A term is comparable only if it says something about STRUCTURE. */
    var termVec = {};
    PROBE_TERMS.forEach(function (t) {
      var v = vec(t);
      var structural = PROBE_PROPS.some(function (p, i) {
        return STRUCTURAL.indexOf(p) !== -1 && v[i] !== bareVec[i];
      });
      if (structural) termVec[t] = v;
    });

    /* Nearest term per class, so one finding names one fix. */
    var near = [];
    Object.keys(subjects).sort().forEach(function (sg) {
      var v = vec(sg);
      if (v.join('|') === bare) return;

      var best = null;
      Object.keys(termVec).forEach(function (t) {
        var tv = termVec[t];
        var diff = [];
        for (var i = 0; i < v.length; i++) {
          if (v[i] !== tv[i] && PROBE_PROPS[i] !== 'list-style-type') diff.push(PROBE_PROPS[i]);
        }
        var score = (v.length - diff.length) / v.length;
        if (score === 1) return;   /* check 8 owns the exact case */

        /*
         * The structural properties the TERM states are the ones that make
         * it that term. Differ on any of them and the guide class is built
         * a different way, however much paint the two happen to share.
         */
        var sharesBuild = PROBE_PROPS.every(function (p, i) {
          if (STRUCTURAL.indexOf(p) === -1) return true;
          if (tv[i] === bareVec[i]) return true;
          return v[i] === tv[i];
        });
        if (!sharesBuild) return;

        if (score >= NEAR_FLOOR && (!best || score > best.score)) {
          best = { term: t, score: score, diff: diff };
        }
      });
      if (!best) return;

      var claim = best.term + ': ' + best.diff.join(',');
      if (ACCEPTED_NEAR[sg] === claim) return;

      near.push(
        '.' + sg + ' is ' + (best.score * 100).toFixed(0) + '% of .' + best.term +
        ' — differs only in ' + best.diff.join(', ') +
        (ACCEPTED_NEAR[sg]
          ? '\n            (ACCEPTED_NEAR says "' + ACCEPTED_NEAR[sg] + '" — it has drifted)'
          : '')
      );
    });

    host.remove();

    assert.equal(
      near.length,
      0,
      'a guide class is a shipped term with a tweak on top. Write the term and\n' +
      '        keep only the tweak — or, if the difference is the point, add it to\n' +
      '        ACCEPTED_NEAR as "' + 'term: props' + '":\n        ' +
      near.join('\n        ')
    );
  } finally {
    sheet.remove();
  }
});
