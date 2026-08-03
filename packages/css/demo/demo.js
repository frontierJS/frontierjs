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
 *   dialog / drawer open + close       ~15 lines
 *   toasts                             ~15 lines
 *   routing                            ~20 lines
 *   theme switch                        ~5 lines
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
  setTimeout(() => el.remove(), 4000);
}

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

/* Deep links: #invoices etc. */
if (location.hash) go(location.hash.slice(1));
