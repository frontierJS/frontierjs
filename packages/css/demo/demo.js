/*
 * demo.js — the behavior half.
 *
 * The package draws components and refuses to drive them (Principle 6:
 * "visual treatment is a class; keyboard/focus/ARIA behavior is a
 * component"). Every file header states the contract it expects. This
 * file is the other side of those contracts, written once, in plain JS,
 * with no framework — which is itself the test: if a contract needs more
 * than a few lines of vanilla JS to honour, it is too demanding.
 *
 * Running tally, for demo/README.md:
 *   tabs (roving tabindex + arrows)   ~30 lines
 *   toolbar (roving tabindex)         ~20 lines
 *   dialog / drawer open + close       ~15 lines
 *   toasts                             ~15 lines
 *   popover show / dismiss             ~20 lines
 *   routing                            ~20 lines
 *   theme switch                        ~5 lines
 *   density                             ~4 lines
 *
 * The legend at the bottom of this file is not in that tally. It is not a
 * contract the package expects a consumer to honour — it is the demo
 * measuring its own coverage, and it exists because the alternative was a
 * hand-written list that was wrong on the first day.
 */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/* ── Routing ─────────────────────────────────────────────────────────
 *
 * Routes are <div data-route> inside the Screen. `hidden` is the switch,
 * not a class — the same reason .view restates `display: none` for
 * [hidden] in frame.css: the attribute is the state, and a class would
 * let the two drift.
 */
function go(name) {
  $$('[data-route]').forEach((r) => {
    r.hidden = r.dataset.route !== name;
  });

  /* aria-current is what the sidebar styles off, so set that, not a class. */
  $$('.navlink').forEach((a) => {
    if (a.dataset.nav === name) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });

  /*
   * Move focus to the Screen on navigation, or a keyboard user stays
   * parked on the link they just followed while the page changes under
   * them. This is why .screen carries tabindex="-1".
   */
  const screen = $('#screen');
  screen.focus({ preventScroll: true });
  screen.scrollTop = 0;

  closeAll();

  /* The legend describes the ACTIVE route, so it is recomputed here rather
     than once at boot. Defined further down; hoisted. */
  renderLegend();
}

document.addEventListener('click', (e) => {
  const nav = e.target.closest('[data-nav], [data-route-to]');
  if (!nav) return;
  e.preventDefault();
  go(nav.dataset.nav || nav.dataset.routeTo);
});

/* ── Tabs ────────────────────────────────────────────────────────────
 *
 * The contract from tabs.css, implemented once for both orientations:
 *
 *   - roving tabindex — the selected tab is 0, the rest -1
 *   - arrows move; Home/End jump
 *   - activating sets aria-selected and unhides the matching View
 *
 * Which arrows depends on aria-orientation, which is exactly why that
 * attribute is not decorative: a vertical strip that answers to Left and
 * Right is wrong in a way a sighted mouse user never notices.
 */
function initTabs(tabsEl) {
  const list = $('.tablist', tabsEl);
  const tabs = $$('.tab', list);
  const vertical = list.getAttribute('aria-orientation') === 'vertical';

  function select(tab, focus = true) {
    tabs.forEach((t) => {
      const on = t === tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      $('#' + t.getAttribute('aria-controls'), tabsEl).hidden = !on;
    });
    if (focus) tab.focus();
  }

  list.addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (tab) select(tab);
  });

  list.addEventListener('keydown', (e) => {
    const prev = vertical ? 'ArrowUp' : 'ArrowLeft';
    const next = vertical ? 'ArrowDown' : 'ArrowRight';
    const i = tabs.indexOf(document.activeElement);
    if (i < 0) return;

    let target = null;
    if (e.key === prev) target = tabs[(i - 1 + tabs.length) % tabs.length];
    else if (e.key === next) target = tabs[(i + 1) % tabs.length];
    else if (e.key === 'Home') target = tabs[0];
    else if (e.key === 'End') target = tabs[tabs.length - 1];

    if (target) {
      e.preventDefault();
      select(target);
    }
  });
}
$$('.tabs').forEach(initTabs);

/* ── Toolbar ─────────────────────────────────────────────────────────
 *
 * The debt `role="toolbar"` takes on. Bar and Toolbar look identical and
 * the vocabulary keeps them apart on this alone: the role tells a screen
 * reader the strip is ONE tab stop with arrow keys inside it, and a strip
 * that announces that and then behaves like a row of separate buttons is
 * worse than the plain Bar it could have been. Reach for Bar when this
 * function is not going to be called.
 *
 * Same roving tabindex as the tabs above, minus the panels — a toolbar
 * button acts on press, so nothing is "selected" by arrowing onto it.
 */
function initToolbar(bar) {
  const items = $$('.btn', bar);
  if (!items.length) return;
  items.forEach((b, i) => (b.tabIndex = i ? -1 : 0));

  bar.addEventListener('keydown', (e) => {
    const i = items.indexOf(document.activeElement);
    if (i < 0) return;

    let target = null;
    if (e.key === 'ArrowLeft') target = items[(i - 1 + items.length) % items.length];
    else if (e.key === 'ArrowRight') target = items[(i + 1) % items.length];
    else if (e.key === 'Home') target = items[0];
    else if (e.key === 'End') target = items[items.length - 1];
    if (!target) return;

    e.preventDefault();
    items.forEach((b) => (b.tabIndex = -1));
    target.tabIndex = 0;
    target.focus();
  });
}
$$('[role="toolbar"]').forEach(initToolbar);

/* The status filters are a pressed-state group, so aria-pressed is the
   state and there is no class to toggle. */
$('#status-toolbar')?.addEventListener('click', (e) => {
  const btn = e.target.closest('[aria-pressed]');
  if (!btn) return;
  $$('[aria-pressed]', $('#status-toolbar')).forEach((b) =>
    b.setAttribute('aria-pressed', String(b === btn))
  );
});

/* ── Dialogs and drawers ─────────────────────────────────────────────
 *
 * Both are <dialog>, so showModal() supplies the focus trap, Escape,
 * inertness of the page behind, and the ::backdrop — none of which the
 * CSS had to reimplement. That is Principle 4 paying for itself: the
 * drawer is a modal that happens to slide in from the edge.
 */
function closeAll() {
  $$('dialog[open]').forEach((d) => d.close());
}

document.addEventListener('click', (e) => {
  if (e.target.closest('[data-close]')) {
    e.target.closest('dialog')?.close();
  }
});

/* Click on the backdrop closes — <dialog> reports those as hits on itself. */
$$('dialog').forEach((d) => {
  d.addEventListener('click', (e) => {
    if (e.target === d) d.close();
  });
});

$('#filters-btn')?.addEventListener('click', () => $('#filters-drawer').showModal());

const menuBtn = $('#menu-btn');
const navDrawer = $('#nav-drawer');
menuBtn.addEventListener('click', () => {
  navDrawer.showModal();
  menuBtn.setAttribute('aria-expanded', 'true');
});
navDrawer.addEventListener('close', () => menuBtn.setAttribute('aria-expanded', 'false'));

/* Delete confirmation — the dialog is reused, the target text is swapped. */
document.addEventListener('click', (e) => {
  const trigger = e.target.closest('[data-confirm]');
  if (!trigger) return;
  $('#confirm-target').textContent = trigger.dataset.confirm;
  $('#confirm-dialog').showModal();
});

$('#confirm-ok').addEventListener('click', () => {
  const name = $('#confirm-target').textContent;
  $('#confirm-dialog').close();
  toast(`${name} deleted.`, 'danger');
});

/* ── Toasts ──────────────────────────────────────────────────────────
 *
 * .toast-stack was already in the package and had never been written
 * down anywhere. The live region is the app's job: the class positions
 * the stack, aria-live is what makes it announced.
 */
function toast(message, tone = 'success') {
  const el = document.createElement('article');
  el.className = `toast ${tone} raised`;
  el.textContent = message;
  $('#toasts').appendChild(el);

  /*
   * `hidden` is the exit, not remove().
   *
   * The package transitions a Toast out on the hidden attribute, so taking
   * the node straight out of the DOM skips the animation entirely — which is
   * what this used to do, and the toast simply blinked out of existence.
   *
   * The node still has to be reclaimed afterwards, and that is a timeout
   * rather than a transitionend listener on purpose: a transition that never
   * starts never ends, and a listener that never fires leaks the node
   * forever. The duration is read from the package's own token so the two
   * cannot drift.
   */
  setTimeout(() => {
    el.hidden = true;
    const ms = parseFloat(getComputedStyle(el).getPropertyValue('--overlay-time')) || 200;
    setTimeout(() => el.remove(), ms + 50);
  }, 4000);
}

/* ── Popover ─────────────────────────────────────────────────────────
 *
 * Not the native [popover] attribute, on purpose. The native one is in the
 * top layer, which escapes the anchor's positioning context entirely — and
 * since the package ships no anchor positioning, it would open in the
 * corner of the viewport. As a plain element the app shows and hides, the
 * anchor's `position: relative` is enough. That relative is in demo.css,
 * because the package has no `.popover-anchor` to match `.tooltip-anchor`.
 *
 * Escape and click-away are the app's, like every other behaviour here.
 */
const helpBtn = $('#help-btn');
const helpPop = $('#help-pop');
if (helpBtn) {
  const setHelp = (open) => {
    helpPop.hidden = !open;
    helpBtn.setAttribute('aria-expanded', String(open));
  };

  helpBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    setHelp(helpPop.hidden);
  });

  document.addEventListener('click', (e) => {
    if (!helpPop.hidden && !helpPop.contains(e.target)) setHelp(false);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !helpPop.hidden) {
      setHelp(false);
      helpBtn.focus();
    }
  });
}

/* ── Density ──────────────────────────────────────────────────────────
 *
 * One line of behaviour, because density is one number. Setting it on the
 * Pane is enough: --density inherits, so the table, its cells, the bar
 * above it and every badge in that bar all follow. Nothing is told which
 * components exist.
 */
$('#density-select')?.addEventListener('change', (e) => {
  const pane = e.target.closest('.pane');
  if (e.target.value) pane.style.setProperty('--density', e.target.value);
  else pane.style.removeProperty('--density');
});

/* ── Forms ───────────────────────────────────────────────────────────
 *
 * There is no validation code here on purpose. The form is `novalidate`
 * so the browser does not put up its own bubble, and `.field:user-invalid`
 * in the package turns the field red by itself — border, ring and hint,
 * all from one declaration. checkValidity() is only asked whether to
 * submit.
 */
$('#profile-form')?.addEventListener('submit', (e) => {
  e.preventDefault();
  const form = e.target;

  if (!form.checkValidity()) {
    /*
     * :user-invalid only fires once a field has been interacted with, so
     * a never-touched empty required field would stay neutral after a
     * submit. Focusing the first invalid one both moves the user there
     * and marks it as interacted.
     */
    const bad = $(':invalid', form);
    bad?.focus();
    toast('Check the highlighted fields.', 'danger');
    return;
  }
  toast('Profile saved.');
});

/* ── Theme ───────────────────────────────────────────────────────────
 * One class on an ancestor. That is the entire theming API.
 */
$('#theme').addEventListener('change', (e) => {
  document.body.className = `app theme-${e.target.value}`;
});

/* ── The legend ──────────────────────────────────────────────────────
 *
 * "What does this page demonstrate" answered by READING the page, not by
 * a list somebody maintains beside it.
 *
 * A written list is a second copy of a package fact, which is the failure
 * this repo keeps paying for — three guide pages quoted source that had
 * moved and nothing rendered wrong. Here it would have been wrong on the
 * first day: a static scan of index.html misses Toast and Progress, which
 * this file creates at runtime, and Kbd, Text, Heading, Section and Group,
 * which are carried by an ELEMENT and have no class to search for.
 *
 * So the terms come from ../vocabulary.js — the same file the guide and
 * the test suite read — and presence is asked of the live DOM.
 */
const TERMS = (() => {
  const out = [];
  VOCAB.forEach(([tier, , rows]) => {
    rows.forEach((row) => {
      /* vocabClass: absent 4th element means the lowercased term, an
         explicit null means the term has no class at all. A truthiness
         check here would invent `.heading`, which is not shipped. */
      out.push({ term: row[0], tier, cls: vocabClass(row), el: row[1] });
    });
  });
  return out;
})();

/*
 * The four terms with no class of their own, plus Kbd. Each is a real
 * element, so the test is a tag selector — scoped to the Screen so the
 * shell's own <header>/<nav> do not credit every route with a term it
 * does not use.
 */
const ELEMENT_TESTS = {
  Section: 'section, article',
  Group:   '.cluster, .stack, [data-route] > div',
  Heading: 'h1, h2, h3, h4, h5, h6',
  Text:    'p',
  Kbd:     'kbd',
};

function termsIn(root) {
  const found = new Set();

  TERMS.forEach(({ term, cls }) => {
    const sel = ELEMENT_TESTS[term] || (cls ? '.' + cls : null);
    if (!sel) return;
    try {
      if (root.querySelector(sel) || (cls && root.classList?.contains(cls))) found.add(term);
    } catch { /* a selector this browser cannot parse is not evidence */ }
  });

  return found;
}

/*
 * Everything a route demonstrates without containing it.
 *
 * The Frame tier is persistent BY DEFINITION — App is the <body>, Shell is
 * the grid, Topbar and Sidebar sit beside the Screen rather than inside it
 * — so scoping the scan to the active route credits no route with the
 * frame every route is rendered in. Same for the overlays and the toast
 * stack, which any route can reach.
 *
 * This is the one judgement in the legend, and it is the reason the count
 * is derived rather than written: getting it wrong is invisible in a
 * static list and obvious the moment the number is wrong.
 */
const GLOBAL_ROOTS = () => [
  $('.topbar'), $('.sidebar'), $('#toasts'), ...$$('dialog'),
].filter(Boolean);

/*
 * Terms carried by an ancestor of everything above, so no querySelector
 * inside a root can reach them: App is the <body>, Shell is the grid the
 * Screen sits IN, Screen is the <main>.
 *
 * Scanning `.shell` instead is the trap, and it is silent: the Shell
 * CONTAINS the Screen, so the scan sweeps up every route including the
 * hidden ones and every page reports the whole vocabulary. Measured —
 * 54 of 54 on all five routes, which reads as success.
 */
const ANCESTOR_TERMS = [
  ['App', 'body.app'],
  ['Shell', '.shell'],
  ['Screen', '.screen'],
];

function renderLegend() {
  const route = $$('[data-route]').find((r) => !r.hidden);
  if (!route) return;

  const found = termsIn(route);
  GLOBAL_ROOTS().forEach((r) => termsIn(r).forEach((t) => found.add(t)));

  ANCESTOR_TERMS.forEach(([term, sel]) => {
    if (document.querySelector(sel)) found.add(term);
  });

  /* Toast is created on demand and is not in the DOM until something
     fires one, so it is credited from the stack that receives it. */
  if ($('#toasts')) found.add('Toast');

  const byTier = new Map();
  TERMS.forEach(({ term, tier }) => {
    if (!found.has(term)) return;
    if (!byTier.has(tier)) byTier.set(tier, []);
    byTier.get(tier).push(term);
  });

  const total = TERMS.length;
  $('#legend-body').innerHTML =
    '<p class="text-sm text-muted">' +
      '<strong>' + found.size + '</strong> of ' + total + ' vocabulary terms are on this screen. ' +
      'Counted from the DOM, not from a list — see demo.js.' +
    '</p>' +
    '<dl class="facts divided">' +
      [...byTier].map(([tier, terms]) =>
        '<dt>' + tier + '</dt><dd class="cluster">' +
          terms.map((t) => '<span class="badge">' + t + '</span>').join('') +
        '</dd>'
      ).join('') +
    '</dl>';
}

/* Deep links: #invoices etc. */
if (location.hash) go(location.hash.slice(1));

renderLegend();
