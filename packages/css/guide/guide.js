/*
 * guide.js — the @frontierjs/css style guide, in plain JavaScript.
 *
 * No build step, no bundler: the
 * page is a string, the router is a hash, and state is four variables. The
 * package's own bet is that a design system does not need a framework to be
 * demonstrated, so the guide should not need one either.
 *
 * Shape:
 *   1. Data           — NAV, TONES, THEMES, and the other reference tables
 *   2. Helpers        — esc/html-building primitives that replace the JSX
 *                       chrome components (PageHeader, Section, Preview, Code)
 *   3. Pages          — one function per nav entry, returning an HTML string.
 *                       A page that needs behavior hangs an `.init(root)` off
 *                       its own function; the router calls it after mount.
 *   4. Search         — the corpus, harvested by rendering every page, and
 *                       the ⌘K palette. The ranker is guide/search.js
 *   5. Shell + router — topbar, sidebar, and the hash router that drives them
 *
 * Interactive markup is wired by delegation from data-* attributes rather
 * than inline handlers, so page HTML stays copy-pasteable — what you read in
 * a preview is what you would write in an app.
 *
 * This is an ES module only so that it can import glow; VOCAB still arrives
 * from ../vocabulary.js as a classic script, which a module can read because
 * a top-level const lands in the global lexical scope.
 */

/*
 * The highlighter, imported from the sibling package rather than copied in.
 * A relative path is what makes that work in both places the guide runs: the
 * browser clamps `..` at the origin, so demo/serve.js serves the workspace
 * root, and over file:// the path simply resolves.
 */
import { glow } from '../../utils/src/glow/glow.js'

/* ══════════════════════════════════════════════════════════════════════
   1. Data
   ══════════════════════════════════════════════════════════════════════ */

/*
 * The whole of the guide's state. The React version had four useState calls
 * at the top of <StyleGuide>; this is the same four, and the page id now
 * lives in the URL hash so a page is linkable.
 */
const state = {
  page: "buttons",
  btnClasses: "btn primary",
  theme: "default",
};

const NAV = [
  {
    /*
     * First, because the reference is useless to somebody who does not yet
     * know which of the 54 terms they are looking for.
     */
    group: 'Learn',
    items: [
      { id: 'learn', label: 'Pick a term' },
      { id: 'compare', label: 'Why this one' }
    ]
  },
  {
    group: 'Start Here',
    items: [
      { id: 'overview', label: 'Overview' },
      { id: 'taxonomy', label: 'Kinds of class' },
      { id: 'composition', label: 'Composition' }
    ]
  },
  {
    // Half 1 of the system: what the HTML actually is.
    group: 'Structure',
    items: [
      { id: 'vocabulary', label: 'Vocabulary' },
      { id: 'anatomy', label: 'Anatomy' },
      { id: 'frame', label: 'App frame' }
    ]
  },
  {
    group: 'Foundation',
    items: [
      { id: 'variables', label: 'CSS Variables' },
      { id: 'tonal', label: 'Tones & contrast' },
      { id: 'density', label: 'Density & space' },
      { id: 'axes', label: 'The two axes' },
      { id: 'themes', label: 'Themes' },
      { id: 'colors', label: 'Colors' }
    ]
  },
  {
    group: 'Components',
    items: [
      { id: 'buttons', label: 'Buttons' },
      { id: 'links', label: 'Links' },
      { id: 'headings', label: 'Headings' },
      { id: 'cards', label: 'Cards' },
      { id: 'tiles', label: 'Tiles' },
      { id: 'feedback', label: 'Loading & empty' },
      { id: 'alerts', label: 'Alerts' },
      { id: 'toasts', label: 'Toasts' },
      { id: 'popovers', label: 'Popovers' },
      { id: 'tooltips', label: 'Tooltips' },
      { id: 'drawers', label: 'Drawers' },
      { id: 'tables', label: 'Tables' },
      { id: 'dialogs', label: 'Dialogs' },
      { id: 'inputs', label: 'Inputs' },
      { id: 'formcontrols', label: 'Form controls' },
      { id: 'badges', label: 'Badges & Pills' },
      { id: 'avatar', label: 'Avatar' },
      { id: 'icons', label: 'Icons' },
      { id: 'code', label: 'Code & Kbd' }
    ]
  },
  {
    // The v0.5 Block tier — layout-only patterns, no surface treatment.
    group: 'Patterns',
    items: [
      { id: 'bar', label: 'Bar' },
      { id: 'sectionheader', label: 'Section header' },
      { id: 'divider', label: 'Divider label' },
      { id: 'items', label: 'Items' },
      { id: 'rows', label: 'Rows' },
      { id: 'feed', label: 'Feed' },
      { id: 'facts', label: 'Facts' },
      { id: 'steps', label: 'Steps' },
      { id: 'disclosure', label: 'Disclosure' },
      { id: 'tabs', label: 'Tabs' },
      { id: 'nav', label: 'Navigation' }
    ]
  },
  {
    group: 'Utilities',
    items: [
      { id: 'layouts', label: 'Layouts' },
      { id: 'responsive', label: 'Responsive' },
      { id: 'behaviour', label: 'How things behave' },
      { id: 'typography', label: 'Typography' },
      { id: 'a11y', label: 'Accessibility' }
    ]
  },
  {
    group: 'Reference',
    items: [
      { id: 'cheatsheet', label: 'Cheat sheet' },
      { id: 'footprint', label: 'Footprint' },
      { id: 'install', label: 'Install' },
      { id: 'conventions', label: 'Conventions' },
      { id: 'layers', label: 'Cascade layers' }
    ]
  }
]

const TONES = [
  ["primary", "Primary"],
  ["secondary", "Secondary"],
  ["muted", "Muted"],
  ["info", "Info"],
  ["success", "Success"],
  ["warning", "Warning"],
  ["danger", "Danger"],
];

const SEMANTIC_COLORS = [
  ["--color-primary", "#0d83dd"],
  ["--color-secondary", "#E5E7EB"],
  ["--color-muted", "#6b7280"],
  ["--color-info", "#2EA2C9"],
  ["--color-success", "#16a34a"],
  ["--color-warning", "#d4b609"],
  ["--color-danger", "#F4403A"],
];

const BTN_VARS = [
  ["--bg-mix", "The tone hue, and the whole tone. Set by tone classes (.primary, .danger, …) in tones.css. Registered inherits:false, so it applies only to the element carrying the class."],
  ["--tone-fill", "The requested fill — the tone if there is one, else the component default."],
  ["--fill", "What actually gets painted: --tone-fill, luminance-capped if white text would otherwise fail contrast."],
  ["--on-fill", "Text color, derived from the fill's luminance. Override per tone or theme with --on-bg-mix."],
  ["--btn-radius", "Border radius. Themable — Elite sets it to 0."],
  ["--btn-font-weight", "Default 600. Themes can override (e.g. Elite uses 700)."],
];

const THEMES = {
  default: {
    name: 'Default',
    description: 'Blue brand, neutral surfaces.',
    tokens: {
      '--color-primary': '#0d83dd',
      '--color-secondary': '#1f2937',
      '--color-muted': '#6b7280',
      '--color-info': '#2EA2C9',
      '--color-success': '#16a34a',
      '--color-warning': '#d4b609',
      '--color-danger': '#F4403A'
    }
  },
  sunset: {
    name: 'Sunset',
    description: 'Warm oranges, earthy accents.',
    tokens: {
      '--color-primary': '#F98E2E',
      '--color-secondary': '#9a3412',
      '--color-muted': '#a8a29e',
      '--color-info': '#c2410c',
      '--color-success': '#84cc16',
      '--color-warning': '#facc15',
      '--color-danger': '#dc2626'
    }
  },
  forest: {
    name: 'Forest',
    description: 'Green primary, cool neutrals.',
    tokens: {
      '--color-primary': '#16a34a',
      '--color-secondary': '#166534',
      '--color-muted': '#64748b',
      '--color-info': '#0891b2',
      '--color-success': '#15803d',
      '--color-warning': '#ca8a04',
      '--color-danger': '#b91c1c'
    }
  },
  midnight: {
    name: 'Midnight',
    description: 'Purple accent, deep contrast.',
    tokens: {
      '--color-primary': '#8b5cf6',
      '--color-secondary': '#4338ca',
      '--color-muted': '#94a3b8',
      '--color-info': '#06b6d4',
      '--color-success': '#10b981',
      '--color-warning': '#f59e0b',
      '--color-danger': '#ef4444'
    }
  },
  dark: {
    name: 'Dark',
    description: 'Inverted neutrals, same brand colors.',
    tokens: {
      '--surface': '#1a1a1a',
      '--surface-raised': '#252525',
      '--surface-sunken': '#0f0f0f',
      '--ink': '#f5f5f5',
      '--ink-soft': '#c5c5c5',
      '--ink-mute': '#8c8c8c',
      '--rule': '#2d2d2d',
      '--rule-strong': '#404040',
      '--paper': '#0f0f0f',
      '--code-bg': '#252525',
      '--code-text': '#e5e5e5'
    }
  },
  elite: {
    name: 'Elite',
    description: 'Navy + lime, uppercase, sharp corners, Montserrat.',
    tokens: {
      '--color-primary': '#9fc612',
      '--color-secondary': '#1d3b4c',
      '--color-muted': '#6b7280',
      '--color-info': '#1d3b4c',
      '--color-success': '#3a7d1e',
      '--color-warning': '#ca8a04',
      '--color-danger': '#b22222',
      '--btn-radius': '0',
      '--card-radius': '0',
      '--field-radius': '0',
      '--btn-font-weight': '700',
      '--btn-text-transform': 'uppercase',
      '--btn-letter-spacing': '0.1em',
      '--badge-font-weight': '700',
      '--badge-letter-spacing': '0.08em',
      '--pill-text-transform': 'uppercase',
      '--pill-letter-spacing': '0.05em',
      '--shadow-md': '0 1px 3px rgba(0,0,0,.08), 0 4px 12px rgba(0,0,0,.04)',
      '--font-primary': "'Montserrat', system-ui, sans-serif",
      /*
       * Both faces. The theme tokens are written inline onto .sg-app, which
       * is INSIDE the :root that declares the guide's own --font-display —
       * so a theme that names only --font-primary changes the body and
       * leaves every heading in the guide's serif.
       */
      '--font-display': "'Montserrat', system-ui, sans-serif",
      '--font-mono': "'IBM Plex Mono', monospace"
    }
  },
  basecamp: {
    name: 'Basecamp',
    description: 'Deep blue-black, cool neutrals, six accent hues.',
    tokens: {
      '--color-primary': '#5a8ef8',
      '--color-secondary': '#9d87f5',
      '--color-muted': '#636882',
      '--color-info': '#1ec8d4',
      '--color-success': '#2dd4a0',
      '--color-warning': '#f5b540',
      '--color-danger': '#f06b6b',
      '--surface': '#151820',
      '--surface-raised': '#1b1f2c',
      '--surface-sunken': '#0b0d14',
      '--ink': '#dde1ed',
      '--ink-soft': '#a0a7cf',
      '--ink-mute': '#7c86af',
      '--rule': 'rgba(255,255,255,.07)',
      '--rule-strong': 'rgba(255,255,255,.13)',
      '--shadow-lg': '0 8px 32px rgba(0,0,0,.55), 0 0 0 1px rgba(255,255,255,.04)'
    }
  },
  notebook: {
    name: 'Notebook',
    description: 'Testing',
    tokens: {
      '--color-primary': '#5a8ef8'
    }
  }
}

function getLabel(id) {
  for (const g of NAV) {
    for (const item of g.items) {
      if (item.id === id) return item.label;
    }
  }
  return id;
}

/*
 * NAV flattened into reading order, each item carrying the group it came
 * from. This is what the "Move on to …" footer walks.
 *
 * Derived from NAV rather than written out, because a hand-kept second
 * ordering is a list that goes stale on the first page anyone adds — and
 * it would go stale silently, since a wrong "next" link still works. NAV
 * is already the order the sidebar shows, so it is the order.
 */
const PAGE_ORDER = NAV.flatMap((g) =>
  g.items.map((item) => ({ ...item, group: g.group })),
);

/*
 * Section ids are assigned after render rather than by section(), because
 * that helper has no page context and cannot see a duplicate title.
 *
 * `slugify` is not declared here — it comes from guide/search.js, a classic
 * script, so that the id stamped on a section and the href a search result
 * builds to it are the same function rather than two that agree today.
 */
function tagSections(host) {
  const seen = {};
  /*
   * A descendant selector, NOT `:scope >`. A page is free to nest its
   * sections inside a wrapper, and a direct-child selector would silently
   * index nothing on any page that did — an empty outline reads as a page
   * with one section rather than as a bug.
   *
   * `> .sg-h2` is what keeps a DEMONSTRATED .pane out: .pane is a vocabulary
   * term the guide also renders live, and a demo's heading is a plain h2 or
   * h3. The section heading class is the discriminator, not the depth.
   */
  return [...host.querySelectorAll('.pane > .sg-h2')].map((h) => {
    const label = h.textContent.trim();
    let id = slugify(label) || 'section';
    if (seen[id]) id = id + '-' + ++seen[id];
    else seen[id] = 1;
    h.parentElement.id = id;
    return { id, label };
  });
}

/*
 * The outline under the active nav item. Below two sections there is nothing
 * to navigate — a list of one repeats the page title and costs a row.
 */
function sectionNav(sections) {
  if (sections.length < 2) return '';
  /*
   * A nested Nav: .navlist of .navlink, same as the sidebar above it. Only
   * the indent rule is the guide's own — .sg-nav-sub keeps the left border
   * that makes these read as children of the page rather than as badly
   * aligned siblings, and nothing else.
   */
  return (
    '<ul class="navlist sg-nav-sub">' +
    sections
      .map(
        (s) =>
          `<li><a class="navlink" href="#${state.page}:${s.id}" data-sub="${s.id}">${esc(s.label)}</a></li>`
      )
      .join('') +
    '</ul>'
  );
}

/* null on the last page — the footer is omitted rather than wrapping. */
function nextPage(id) {
  const i = PAGE_ORDER.findIndex((p) => p.id === id);
  if (i < 0 || i === PAGE_ORDER.length - 1) return null;
  return PAGE_ORDER[i + 1];
}

/* ══════════════════════════════════════════════════════════════════════
   2. Helpers
   ══════════════════════════════════════════════════════════════════════ */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/*
 * JSX escaped text for us; template literals do not. Anything that came out
 * of a `{expression}` in the original needs this — most visibly every code
 * sample, which is full of `<` and `&`.
 */
function esc(value) {
  return String(value).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );
}

/* Markup out, text in — the class index's note is HTML (a swatch, a <code>)
   but the thing it is searched against has to be what a reader sees. */
function stripTags(html) {
  return String(html).replace(/<[^>]*>/g, '')
}

/* An object of custom properties → an inline style attribute value. */
function styleAttr(tokens) {
  return Object.entries(tokens)
    .map(([k, v]) => `${k}: ${v}`)
    .join("; ");
}

/* The four chrome components from the JSX version, as string builders. */
function pageHeader({ eyebrow, title, lead }) {
  return `
    <header class="sg-page-header">
      ${eyebrow ? `<div class="sg-eyebrow">${eyebrow}</div>` : ""}
      <h1 class="sg-h1">${title}</h1>
      ${lead ? `<p class="sg-lead">${lead}</p>` : ""}
      <hr>
    </header>`;
}

/*
 * A Pane is also a .stack, so the gap between a heading, its prose and its
 * preview is the parent's one rung rather than a bottom margin on each child.
 * The children carry none — a margin plus a gap is the doubling that put the
 * three literals here out of step in the first place, and a literal does not
 * move under .dense.
 */
function section(title, body) {
  /*
   * Prose as well as Stack: a section is authored copy, so its paragraphs
   * and lists are plain <p> and <ul> and the term styles them. It was a
   * class on every one of 286 paragraphs before the package could say
   * "this region is prose" once.
   *
   * Prose reaches every descendant, including the copy inside a Card or an
   * Alert the section demonstrates. That is intended and safe because the
   * term is thin — measure, ink, list indent — and every rule in it is
   * :where(), so a demonstrated term keeps whatever it says about itself.
   */
  return `
    <section class="pane stack prose">
      <h2 class="sg-h2">${title}</h2>
      ${body}
    </section>`;
}

function preview(body) {
  return `<div class="card">${body}</div>`;
}

/*
 * Which language a sample is, when the call site did not say.
 *
 * 137 samples and four languages: annotating every one would be noise, and
 * an annotation that drifts from the sample is worse than a guess. The
 * shapes are distinctive enough that this gets all 137 right — check it
 * against the corpus in @frontierjs/utils if you add a kind it has not seen.
 */
function codeLang(src) {
  const t = src.trim()
  if (t[0] === '<') return 'html'
  /* Prose that quotes markup — "an inline <code>x</code>" — starts as text
     but is still HTML, and a closing tag is the giveaway. */
  if (/<\/[a-z]/i.test(t)) return 'html'
  if (/^(bun|npm|npx|pnpm|yarn|git|cd|curl|node|\$) /m.test(t)) return 'bash'
  if (/^(import|export|const|let|var|function|\/\/)/.test(t)) return 'js'
  /* This is a CSS guide; a sample that is nothing else is a stylesheet. */
  return 'css'
}

/*
 * The authored source behind every rendered code block, by index.
 *
 * A copy button hands back what was WRITTEN, which is not always what is on
 * screen: `mark: true` turns `•x•` into a <mark> and REMOVES the bullets,
 * and glow's diff markers go the same way. Reading `pre.textContent` back
 * would then hand over text that is a character short and looks perfect.
 *
 * Measured: all 178 blocks currently round-trip identically, so textContent
 * would work today and this is correct by construction rather than a fix
 * for a live corruption. It is worth the array because the Code page
 * documents `•text•` as the way to mark a line — the guide teaches the one
 * syntax that would break the cheaper implementation, and the failure is
 * silent on both sides of the clipboard.
 *
 * Reset per render, so the indices in the live DOM are always the ones this
 * array holds. buildSearchIndex() renders all 52 pages into a detached node
 * and therefore pushes too — it truncates back to where it found the array.
 */
const CODE_SRC = []

/* A block and its copy control. The button is a sibling of the <pre>, not a
   child: `.code` scrolls, and a button inside it would slide away with
   the first long line. */
function codeShell(src, inner) {
  const id = CODE_SRC.push(src) - 1
  return `<div class="relative">` +
    `<button type="button" class="btn outlined sg-copy" data-copy-code="${id}" title="Copy to clipboard">Copy</button>` +
    inner +
    `</div>`
}

function code(src, lang, extra) {
  /*
   * `txt` is the escape hatch: a diagram or a plain listing is not code, and
   * glow will happily colour the word "Bootstrap" as a keyword and "Props"
   * as an identifier. There is no "no language" mode — an unknown one still
   * gets the common-word rules — so the highlighter is skipped entirely.
   */
  if (lang === 'txt') {
    return codeShell(src, `<pre class="code${extra ? ' ' + extra : ''}">${esc(src)}</pre>`)
  }

  /*
   * `prefix: false` is not optional here. With prefixes on, a line starting
   * `-`, `+` or `>` is a diff marker and the character is stripped — and in
   * CSS all three are legal first characters (`--custom-prop`, `+ .sibling`,
   * `> .child`), so every sample would quietly lose one.
   */
  return codeShell(src, `<pre class="code${extra ? ' ' + extra : ''}">${glow(src, {
    language: lang || codeLang(src),
    prefix: false,
    mark: true
  })}</pre>`)
}

/*
 * Clipboard, with the fallback the guide actually needs.
 *
 * `navigator.clipboard` is gated on a secure context and `file://` is not
 * one — and opening `guide/index.html` straight off disk is a documented
 * way to read this thing. The textarea path is the only one that works
 * there, so it is a fallback rather than a legacy branch.
 */
function writeClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text)
  }

  return new Promise((resolve, reject) => {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    /* Off-screen rather than hidden: `display: none` cannot be selected. */
    ta.style.cssText = 'position:fixed;top:-1000px;left:0;opacity:0'
    document.body.append(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    ok ? resolve() : reject(new Error('copy refused'))
  })
}

/*
 * The button's own label is its accessible name, which is why there is no
 * aria-label: an aria-label would win, and the change from Copy to Copied
 * would never be announced to the reader who most needs to hear it.
 */
function flashCopy(btn, label) {
  btn.textContent = label
  btn.classList.add('done')
  clearTimeout(btn._copyTimer)
  btn._copyTimer = setTimeout(() => {
    btn.textContent = 'Copy'
    btn.classList.remove('done')
  }, 1600)
}

function copyCode(btn) {
  const src = CODE_SRC[Number(btn.dataset.copyCode)]
  if (src == null) return
  writeClipboard(src).then(
    () => flashCopy(btn, 'Copied'),
    /* A refused clipboard is the browser's decision, not a bug. Say what to
       do instead rather than reporting failure. */
    () => flashCopy(btn, 'Press ⌘C')
  )
}

/*
 * A clickable example that loads its own class chain into the Buttons page
 * live editor. `data-btn` is read by that page's delegated handler.
 */
function chip(label, cls) {
  return `<button type="button" class="${cls}" data-btn="${esc(cls)}">${label}</button>`;
}

/*
 * The Empty term, with its anatomy — a page in NAV that has no page function
 * yet is exactly "a Block with nothing in it". Written as .empty-title /
 * .empty-text rather than a bare strong+span, because a term's parts are the
 * half of the vocabulary that is easiest to skip and this file is the
 * reference.
 */
function comingSoon(label) {
  return `
    <div class="empty">
      <div class="empty-title">${label}</div>
      <div class="empty-text">Not yet defined.</div>
    </div>`;
}

/*
 * The "Move on to …" footer, appended to every page by renderPage().
 *
 * An <a href="#id">, not a <button>. It navigates, so it must be a link:
 * middle-click and ⌘-click have to open it, and a screen reader has to
 * announce it as a link. The guide's own Principles page makes this claim
 * about the system, so the guide gets to be wrong about it exactly never.
 *
 * When the next page starts a new group the group name rides above the
 * label, so crossing from the last Component into the first Pattern reads
 * as a section change rather than an arbitrary jump.
 */
function pageNext(id) {
  const next = nextPage(id);
  if (!next) return "";

  const current = PAGE_ORDER.find((p) => p.id === id);
  const crossing = current && current.group !== next.group;

  /*
   * A Card that happens to be a link, laid out with Split: the meta column
   * on the left, the arrow pushed to the right. The <hr> above it is the
   * Divider term.
   *
   * The stack of label lines is a .stack — but at --space-2xl, which is the
   * gap between page SECTIONS, so it carries a tighter rung. Three lines of
   * one label are not three sections.
   */
  return `
    <nav class="sg-next" aria-label="Next page">
      <hr>
      <a class="card split sg-next-link" href="#${next.id}">
        <span class="stack gap-3xs">
          ${crossing ? `<span class="sg-next-group">${next.group}</span>` : ""}
          <span class="sg-next-lead">Move on to</span>
          <span class="sg-next-label">${next.label}</span>
        </span>
        <span class="sg-next-arrow" aria-hidden="true">&rarr;</span>
      </a>
    </nav>`;
}
/* ══════════════════════════════════════════════════════════════════════
   3. Pages — Start Here
   ══════════════════════════════════════════════════════════════════════ */

function overviewPage() {
  return `
      ${pageHeader({
        eyebrow: 'Start Here',
        title: 'A design system, not a component library.',
        lead: 'Small, opinionated CSS conventions for FrontierJS applications. Class chains over component APIs. CSS variables over rewrites.'
      })}

      ${section(
        'The contract',
        `
        <p>
          Every styled element follows the same pattern. A base class declares
          its var contract and uses those vars to style itself. Modifiers and
          variants only set the vars — they never write styles directly.
        </p>
        <ul>
          <li>
            <strong>Base classes</strong> like <code>btn</code>, <code>chip</code>, <code>field</code>, <code>card</code> declare a small var contract.
          </li>
          <li>
            <strong>Tone classes</strong> like <code>primary</code>, <code>success</code>, <code>danger</code> set <code>--bg-mix</code> and <code>--on-bg-mix</code>. One file. Every component reads them.
          </li>
          <li>
            <strong>Variants</strong> like <code>outlined</code> read the same vars and flip the structure.
          </li>
          <li>
            <strong>Utilities</strong> are the escape hatch — <code>text-lg</code>, <code>w-full</code>, <code>mt-4</code>, applied inline when needed.
          </li>
        </ul>`
      )}

      ${section(
        'What this buys you',
        `
        <p>
          Per-client theming is a single var file, never a component rewrite.
          A new tone is one rule. Outlined, ghost, pill — anything that reads
          the existing vars composes with every tone you've defined, for free.
          The class chain reads in English: <code>btn primary outlined</code>.
        </p>`
      )}

      ${section(
        'The six',
        `
        <div class="stack gap-lg">
          ${PRINCIPLES.map(
            ([title, body], i) => `
          <article class="card sg-principle">
            <div class="sg-principle-num">${i + 1}</div>
            <div>
              <strong class="sg-principle-title">${esc(title)}</strong>
              <p class="sg-principle-body">${esc(body)}</p>
            </div>
          </article>`
          ).join('')}
        </div>`
      )}

      ${section(
        'Principle 2 in practice',
        `
        <p>
          This is the one that comes up daily. A Pane is a labelled subdivision of
          a Screen, so it is a <code>&lt;section&gt;</code>. Anything discrete
          inside it — a card, a feed entry, a subsection you could lift out whole —
          is an <code>&lt;article&gt;</code>.
        </p>
        ${code(`<section aria-labelledby="billing-h">
  <h2 id="billing-h">Billing</h2>

  <article class="card">        <!-- self-contained unit -->
    <h3>Current plan</h3>
  </article>

  <article class="card">
    <h3>Payment method</h3>
  </article>
</section>`)}
        <p>
          The <strong>article-vs-div test</strong>: could you lift this out of the
          page and have it still make sense? Then it is an
          <code>&lt;article&gt;</code>. If it only exists to group things visually,
          it is a <code>&lt;div&gt;</code>.
        </p>`
      )}
    `
}

function installPage() {
  return `
      ${pageHeader({
        eyebrow: "Start Here",
        title: "Install",
        lead: "One dependency, one import, one class on &lt;body&gt;. Plain CSS — no build step, no UnoCSS, no config.",
      })}

      ${section(
        "Prerequisites",
        `
        <ul>
          <li>
            Anything that can load a stylesheet. Vite, SvelteKit, Next, Astro, a
            plain <code>&lt;link&gt;</code> tag — all fine.
          </li>
          <li>
            A browser from 2024 or later. The system uses
            <code>@property</code>, <code>color-mix()</code>, relative color
            syntax and cascade layers. Practically: Chrome 119+, Safari 16.4+,
            Firefox 128+.
          </li>
        </ul>
        <div class="alert info">
          <div class="alert-icon" aria-hidden="true">&#9432;</div>
          <div class="alert-content">
            <strong>UnoCSS is no longer required — but it is not neutral either.</strong>
            <p>
              Through v0.5 the component shapes lived in <code>uno.config.ts</code>
              as shortcuts, so the package needed a build step to render anything.
              As of v0.6 that all moved into plain CSS and the config was deleted.
              Bring Uno if you want atomic utilities in your own markup — but read
              <strong>Running it with UnoCSS</strong> below first. This page used to
              say the system "no longer cares either way", which was measurably
              false in four places.
            </p>
          </div>
        </div>`,
      )}

      ${section(
        "1. Add the package",
        code(`# from the monorepo
bun add @frontierjs/css

# or just copy the folder — it is 25 plain .css files
cp -r packages/css src/styles`),
      )}

      ${section(
        "2. Import it",
        `
        <p>
          One import covers everything: tokens, all seven themes, tones, the two
          lineage bases, layout helpers, components and patterns. The entry point
          assigns each file to a cascade layer as it goes.
        </p>
        ${code(`// src/main.ts
import '@frontierjs/css'

// or, without a bundler
<link rel="stylesheet" href="/styles/index.css">`)}
        <p>
          Want just a slice? Every file is individually importable, at the path
          it lives at — the folders mirror the cascade layers:
        </p>
        ${code(`@import '@frontierjs/css/foundation/tokens.css';
@import '@frontierjs/css/themes/default.css';
@import '@frontierjs/css/components/buttons.css';`)}
        <p>
          Import <code>foundation/tokens.css</code> and at least one theme
          first, or nothing will have colors. <strong>Changed in v0.11</strong>
          — these were flat (<code>@frontierjs/css/buttons.css</code>) before.
        </p>`,
      )}

      ${section(
        "3. Pick a theme",
        `
        <p>
          Themes are a class on any ancestor — usually
          <code>&lt;body&gt;</code>. They nest, so you can scope a different theme
          to a header or a sidebar, because it is all custom property
          inheritance.
        </p>
        ${code(`<body class="theme-default">
  <!-- whole app uses the default theme -->

  <header class="theme-midnight">
    <!-- but this header uses midnight -->
    <button class="btn">Sign in</button>
  </header>
</body>`)}`,
      )}

      ${section(
        "4. Use it",
        `
        ${code(`<!-- Buttons: Element class first, then Treatments in any order -->
<button class="btn">Save</button>
<button class="btn danger">Delete</button>
<button class="btn outlined success">Confirm</button>

<!-- Surfaces -->
<article class="card raised">A floating surface.</article>

<!-- Forms -->
<div class="field-group">
  <label>Email</label>
  <input type="email" class="field" placeholder="you@example.com">
</div>

<!-- Layout -->
<div class="stack">
  <h1>Welcome</h1>
  <p>Stack gives consistent vertical rhythm.</p>
</div>`)}
        <p>
          That is the whole setup. See <strong>Kinds of class</strong> for the
          composition model and <strong>Principles</strong> for how to choose the
          elements.
        </p>`,
      )}

      ${section(
        "Overriding it",
        `
        <p>
          Everything the package ships lives in a cascade layer, and unlayered CSS
          beats every layer. So your own stylesheet wins by default — no
          <code>!important</code>, no specificity ladder.
        </p>
        ${code(`/* your app.css — plain and unlayered, so it wins */
.btn { border-radius: 2px; }
td    { background: var(--zebra); }`)}`,
      )}

      ${section(
        "Running it with UnoCSS",
        `
        <p>
          Uno is optional, and the two compose well — but there are three things
          to know. All of this was measured against UnoCSS 66.7.5 with
          <code>presetWind3</code>, not inferred.
        </p>

        <p>
          <strong>1. The good part is free.</strong> Uno's output is unlayered
          and everything here is layered, so every Uno utility beats every
          component with no ordering discipline and no <code>!important</code>.
          <code>${esc('class="card p-4"')}</code> gets Uno's padding.
        </p>

        <p>
          <strong>2. The reset will flatten the package.</strong>
          <code>@unocss/reset/tailwind.css</code> is unlayered too, so it beats
          the components — and because layer priority ignores source order,
          importing it first does not save you.
        </p>
        <table class="table striped compact">
          <thead>
            <tr>
              <th>Measured</th>
              <th style="width: 22%">package alone</th>
              <th style="width: 26%">+ reset, unlayered</th>
            </tr>
          </thead>
          <tbody>
            <tr><td><code>h1</code> font-size</td><td>36px</td><td><strong>16px</strong></td></tr>
            <tr><td><code>.btn</code> background</td><td>the tone</td><td><strong>transparent</strong></td></tr>
            <tr><td><code>.btn</code> padding</td><td>6px 14px</td><td><strong>0</strong></td></tr>
          </tbody>
        </table>
        <p>
          Import the reset into a layer and it behaves. <code>uno</code> goes
          between <code>utilities</code> and <code>a11y</code> — utilities should
          beat components, but nothing should beat
          <code>.visually-hidden</code>.
        </p>
        ${code(`/* app.css */
@layer reset, tokens, themes, tones, base, layout,
       components, patterns, utilities, uno, a11y;

@import '@unocss/reset/tailwind.css'  layer(reset);
@import '@frontierjs/css';
@import 'uno.css'                     layer(uno);`)}

        <p>
          <strong>3. Two names collide.</strong> Uno owns them as utilities, and
          a generated utility outranks the component of the same name.
          <code>table</code> and <code>tab</code> also collide but are harmless —
          <code>display: table</code> and <code>tab-size: 4</code> are what those
          elements already are.
        </p>
        <table class="table striped compact">
          <thead>
            <tr>
              <th style="width: 20%">Class</th>
              <th>What Uno makes it</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><code>container</code></td>
              <td>
                <code>width:100%</code> plus breakpoint max-widths, so
                <code>.container.narrow</code> stops narrowing
              </td>
            </tr>
            <tr>
              <td><code>text-xs…xl</code></td>
              <td>
                Uno's scale (14/18px) instead of this package's (13/16px)
              </td>
            </tr>
          </tbody>
        </table>
        ${code(`// uno.config.ts
export default defineConfig({
  presets: [presetWind3()],
  blocklist: ['container', /^text-(xs|sm|md|lg|xl)$/],
})`)}
        <div class="alert info">
          <div class="alert-icon" aria-hidden="true">&#9432;</div>
          <div class="alert-content">
            <strong><code>.shell.fixed</code> was a third collision.</strong>
            <p>
              Uno's <code>fixed</code> is <code>position: fixed</code>, so
              installing Uno turned the app shell into a fixed-positioned
              element. It is <code>.shell.viewport</code> as of v0.10.1 — the
              package should not squat on a core utility name while advertising
              Uno compatibility.
            </p>
          </div>
        </div>`,
      )}

      ${section(
        "Troubleshooting",
        `
        <ul>
          <li>
            <strong>Everything is unstyled.</strong> Check the import path
            resolves, and that a <code>theme-*</code> class is set somewhere above
            your markup.
          </li>
          <li>
            <strong>Colors are flat or text is invisible.</strong> Almost always an
            unsupported browser — <code>color-mix()</code> and relative color
            syntax are what derive every tint and every text color. Check the
            versions above.
          </li>
          <li>
            <strong>Icons are missing.</strong> The package sizes icons but does
            not ship them. See <strong>Icons</strong>.
          </li>
          <li>
            <strong>A utility does nothing.</strong> It may be a scoped modifier
            rather than a Treatment — <code>.compact</code> only works on
            <code>.table</code>, <code>.icon</code> only on <code>.btn</code>. See
            <strong>Kinds of class</strong>.
          </li>
        </ul>`,
      )}
    `;
}

function compositionPage() {
  const branches = [
    {
      name: "pill",
      role: "Status & counts",
      adds: "rounded-full, smaller padding, tone fills",
      preview: `<span class="pill primary">12</span>`,
      extra: `
        <span class="pill info">info</span>
        <span class="pill success">3</span>
        <span class="pill warning">!</span>
        <span class="pill danger">99+</span>`,
      code: `/* pills.css — no tones here; tones.css owns them */
.pill {
  background: var(--bg-mix, var(--color-muted));
  color:      var(--on-bg-mix, white);
}`,
    },
    {
      name: "badge",
      role: "Inline status indicator",
      adds: "uppercase, tracking, square corners, tone fills",
      preview: `<span class="badge danger">New</span>`,
      extra: `
        <span class="badge info">Info</span>
        <span class="badge success">Active</span>
        <span class="badge warning">Pending</span>
        <span class="badge primary">Beta</span>`,
      code: `/* badges.css — no tones here; tones.css owns them */
.badge {
  background: var(--bg-mix, var(--color-muted));
  color:      var(--on-bg-mix, white);
}`,
    },
    {
      name: "btn",
      role: "Interactive control",
      adds: "bold, hover brightness, shadow, full padding",
      preview: `<button class="btn primary">Save</button>`,
      extra: `
        <button class="btn">Default</button>
        <button class="btn info">Info</button>
        <button class="btn primary outlined">Outlined</button>`,
      code: `/* buttons.css — no tones here; tones.css owns them */
.btn {
  background: var(--bg-mix, var(--color-primary));
  color:      var(--on-bg-mix, white);
  border:     1px solid transparent;
}
.btn.outlined {
  background:   var(--surface);
  color:        var(--bg-mix, var(--color-primary));
  border-color: var(--bg-mix, var(--color-primary));
}`,
    },
  ];

  return `
      ${pageHeader({
        eyebrow: 'Start Here',
        title: 'Composition',
        lead: 'A small base class supplies the bones. Everything else extends it. New visual languages plug in by sharing the same skeleton.'
      })}

      ${section(
        'The lineage',
        `
        <p>
          One core utility — <code>chip</code> — owns layout and alignment.
          Three classes inherit it and add their own visual treatment. Each
          declares its own var contract; nothing fights for the same name.
        </p>
        <div class="sg-lineage">
          <div class="sg-lineage-col">
            <div class="sg-lineage-card sg-lineage-root">
              <div class="sg-lineage-name">chip</div>
              <div class="sg-lineage-role">Core structure</div>
              <div class="sg-lineage-preview">
                <span class="chip">chip</span>
              </div>
            </div>
          </div>
          <div class="sg-lineage-arrow">
            <span>extends</span>
          </div>
          <div class="sg-lineage-col">
            ${branches
              .map(
                (b) => `
            <div class="sg-lineage-card">
              <div class="sg-lineage-name">${b.name}</div>
              <div class="sg-lineage-role">${b.role}</div>
              <div class="sg-lineage-preview">${b.preview}</div>
            </div>`
              )
              .join('')}
          </div>
        </div>`
      )}

      ${section(
        'chip — the base',
        `
        <p>
          <code>chip</code> only declares structure: inline-flex, alignment,
          gap, whitespace-nowrap. No color, no font weight. It lives in
          <code>chip.css</code> as one <code>:where()</code> rule that names
          every composite, so the structure is declared once and every
          consumer gets it by writing the leaf class alone.
        </p>
        ${preview(`<span class="chip">I am a chip</span>`)}
        ${code(`/* chip.css — the inline base, at zero specificity so every
   composite overrides it without a fight */
:where(.chip, .btn, .pill, .badge) {
  display:         inline-flex;
  align-items:     center;
  justify-content: center;
  gap:             0.375rem;
  white-space:     nowrap;
  text-align:      center;
}`)}`
      )}

      ${branches
        .map((b) =>
          section(
            `${b.name} — extends chip`,
            `
        <p>
          <strong>${b.role}.</strong> Adds: ${b.adds}.
        </p>
        ${preview(`<div class="cluster">${b.preview}${b.extra}</div>`)}
        ${code(b.code)}`
          )
        )
        .join('')}

      ${section(
        'How extension resolves',
        `
        <p>
          Nothing expands and nothing is generated. The base rule
          <em>names</em> its composites, so <code>class="badge"</code> already
          matches it — and because the base is wrapped in
          <code>:where()</code> it carries <strong>zero specificity</strong>,
          which is what lets the leaf file override any part of it without
          <code>!important</code> and without caring about import order.
        </p>
        <div class="sg-resolve">
          <div class="stack gap-sm">
            <div class="sg-resolve-label">chip.css — structure, 0 specificity</div>
            ${code(
              `:where(.chip, .btn, .pill, .badge) {
  display:     inline-flex;
  align-items: center;
  gap:         0.375rem;
  white-space: nowrap;
}`,
              'css',
              'sg-code-inline'
            )}
          </div>
          <div class="sg-resolve-arrow">+</div>
          <div class="stack gap-sm">
            <div class="sg-resolve-label">badges.css — only what is its own</div>
            ${code(
              `.badge {
  padding:       0.125rem 0.5rem;
  border-radius: var(--badge-radius,
                     var(--btn-radius));
  font-size:     var(--text-xs);
  background:    var(--fill, var(--tone-fill));
}`,
              'css',
              'sg-code-inline'
            )}
          </div>
        </div>
        <p>
          So the resolution is just the cascade. Markup writes the leaf class
          only — <code>${esc('<span class="badge success">')}</code> — and the
          three sources meet on the element: structure from
          <code>chip.css</code>, skin from <code>badges.css</code>, colour from
          whichever tone class is present.
        </p>
        <p>
          Adding a composite is therefore two edits, both explicit: a new flat
          file, and its class added to the <code>:where()</code> list. That
          second edit is deliberately not automatic — a base that silently
          adopted every new class would be a base nobody could reason about.
          <code>surface.css</code> is the same arrangement for the block
          lineage.
        </p>`
      )}

      ${section(
        'The surface lineage — block primitives',
        `
        <p>
          Block primitives compound off a shared base too. <code>surface</code>
          owns the bg, border, radius, and tonal recipe. Composites add only
          what's unique to them — card adds padding, alert adds row layout,
          toast adds positioning, dialog adds modal sizing. The surface CSS
          file is the single source of truth for "what does a block surface
          look like."
        </p>
        <div class="sg-lineage">
          <div class="sg-lineage-base">
            <div class="sg-lineage-name">surface</div>
            <div class="sg-lineage-role">
              Block visual base: bg, border, radius, tonal recipe
            </div>
          </div>
          <div class="sg-lineage-arrow">
            <div class="sg-lineage-arrow-line"></div>
            <div class="sg-lineage-arrow-label">extends</div>
          </div>
          <div class="sg-lineage-children">
            <div class="sg-lineage-card">
              <div class="sg-lineage-name">card</div>
              <div class="sg-lineage-role">+ padding</div>
              <div class="sg-lineage-preview">
                <span class="sg-cheat-mini-card">card</span>
              </div>
            </div>
            <div class="sg-lineage-card">
              <div class="sg-lineage-name">alert</div>
              <div class="sg-lineage-role">+ row layout</div>
              <div class="sg-lineage-preview">
                <span class="sg-cheat-mini-card">alert</span>
              </div>
            </div>
            <div class="sg-lineage-card">
              <div class="sg-lineage-name">toast</div>
              <div class="sg-lineage-role">+ fixed + animation</div>
              <div class="sg-lineage-preview">
                <span class="sg-cheat-mini-card">toast</span>
              </div>
            </div>
            <div class="sg-lineage-card">
              <div class="sg-lineage-name">dialog</div>
              <div class="sg-lineage-role">+ native modal</div>
              <div class="sg-lineage-preview">
                <span class="sg-cheat-mini-dialog">dialog</span>
              </div>
            </div>
          </div>
        </div>
        <p>
          The composition trick is a <code>:where()</code> selector group.
          Surface's CSS targets every composite class in one rule list — adding
          a new composite (popover, drawer, banner) means adding its name
          once, then writing only the unique behavior.
        </p>
        ${code(`/* surface.css — shared by every block primitive */
:where(.surface, .card, .alert, .toast, .dialog, .popover, .drawer) {
  background:    var(--surface-bg);
  border:        1px solid var(--surface-border);
  border-radius: var(--card-radius);
}

/* Tonal recipe — names no tones at all. Each tint is computed from
   --bg-mix, so when there is no tone it is invalid at computed-value
   time and the fallback on the next line supplies the untoned default. */
:where(.surface, .card, .alert, .toast, .dialog, .popover, .drawer) {
  --surface-tint-bg:     color-mix(in srgb, var(--bg-mix) 10%, var(--surface));
  --surface-tint-border: color-mix(in srgb, var(--bg-mix) 30%, var(--surface));
  --surface-tint-color:  color-mix(in srgb, var(--bg-mix) 55%, var(--ink));

  --surface-bg:     var(--surface-tint-bg,     var(--surface));
  --surface-border: var(--surface-tint-border, var(--rule));
  --surface-color:  var(--surface-tint-color,  var(--ink));
}`)}`
      )}

      ${section(
        'Standalone block primitives',
        `
        <p>
          Not everything fits under surface. Forms and tables have their
          own structural needs — <code>field</code> owns input chrome,
          <code>table</code> owns border-collapse and cell layout. They
          read tones via <code>--bg-mix</code> like everything else, but
          they don't share surface's visual recipe.
        </p>
        <div class="sg-lineage">
          <div class="sg-lineage-children">
            <div class="sg-lineage-card">
              <div class="sg-lineage-name">field</div>
              <div class="sg-lineage-role">Form input base</div>
              <div class="sg-lineage-preview">
                <span class="sg-cheat-mini-field">field</span>
              </div>
            </div>
            <div class="sg-lineage-card">
              <div class="sg-lineage-name">table</div>
              <div class="sg-lineage-role">Tabular data</div>
              <div class="sg-lineage-preview">
                <span class="sg-cheat-mini-table">table</span>
              </div>
            </div>
          </div>
        </div>`
      )}

      ${section(
        'Tones — the cross-cutting layer',
        `
        <p>
          One file, <code>tones.css</code>, owns every tone. Every base
          reads from it. Add a tone here once; buttons, pills, badges,
          cards, tables, dialogs, and fields all gain it automatically.
        </p>
        ${code(`/* tones.css — the single source */
.primary   { --bg-mix: var(--color-primary);   --on-bg-mix: white; }
.secondary { --bg-mix: var(--color-secondary); --on-bg-mix: white; }
.muted     { --bg-mix: var(--color-muted);     --on-bg-mix: white; }
.info      { --bg-mix: var(--color-info);      --on-bg-mix: white; }
.success   { --bg-mix: var(--color-success);   --on-bg-mix: white; }
.warning   { --bg-mix: var(--color-warning);   --on-bg-mix: #1f2937; }
.danger    { --bg-mix: var(--color-danger);    --on-bg-mix: white; }`)}
        <p>
          The class works on its own too —
          <code>${esc(`<span class="danger">7 days</span>`)}</code> sets the vars
          even with no component attached. Any element using
          <code>var(--bg-mix)</code> picks them up.
        </p>`
      )}

      ${section(
        'Why this compounds',
        `
        <p>
          Two leverage points working together:
        </p>
        <ul>
          <li>
            <strong>One layout fix updates everything.</strong> Change
            <code>gap</code> on <code>chip</code> and pills, badges, and
            buttons all line up the same.
          </li>
          <li>
            <strong>One tone class updates everything.</strong> The
            <code>.danger</code> class in <code>tones.css</code> sets
            <code>--bg-mix</code> and <code>--on-bg-mix</code>. Buttons,
            pills, badges, cards, tables, dialogs, fields all read those vars.
            Adding a new tone = one line, zero component edits.
          </li>
          <li>
            <strong>New components don't restart from zero.</strong> Add the
            class to the <code>chip</code> base, declare which vars it reads
            from the tone contract, done. No tone-mapping boilerplate per
            file.
          </li>
        </ul>`
      )}
    `
}

function conventionsPage() {
  return `
      ${pageHeader({
        eyebrow: "Start Here",
        title: "Conventions",
        lead: "The rules that let the system grow without rewrites.",
      })}

      ${section(
        "Class order doesn't matter",
        `
        <p>
          Within a chain, ordering is irrelevant. Specificity is identical
          across tone, variant, and modifier classes — the cascade does the
          work.
        </p>
        ${code(`<button class="btn primary outlined">   ✓
<button class="btn outlined primary">   ✓
<button class="outlined primary btn">   ✓`)}`,
      )}

      ${section(
        "Adding a new tone",
        `
        <p>
          One line in <code>tones.css</code>. Every component picks it up —
          buttons, pills, badges, cards, tables, dialogs, fields. No
          component file is touched.
        </p>
        ${code(`/* tones.css */
.brand { --bg-mix: var(--color-brand); --on-bg-mix: white; }`)}`,
      )}

      ${section(
        "Adding a new variant",
        `
        <p>
          Variants read the existing var contract and restructure. They never
          name specific tones — that's what makes them compose with every
          tone automatically.
        </p>
        ${code(`.btn.ghost {
  background:   transparent;
  color:        var(--bg-mix, var(--color-primary));
  border-color: transparent;
}`)}`,
      )}
    `;
}
/* ══════════════════════════════════════════════════════════════════════
   3. Pages — Foundation
   ══════════════════════════════════════════════════════════════════════ */

function variablesPage() {
  return `
      ${pageHeader({
        eyebrow: "Foundation",
        title: "CSS Variables",
        lead: "Two scopes: global tokens on :root, and per-component contracts on each base class.",
      })}

      ${section(
        "Global tokens",
        `
        <p>
          Semantic color tokens live on <code>:root</code>. Every component
          references these — never raw hex.
        </p>
        <table class="table sg-tokens">
          <thead>
            <tr><th>Token</th><th>Value</th></tr>
          </thead>
          <tbody>
            ${SEMANTIC_COLORS.map(
              ([name, value]) => `
            <tr>
              <td>${name}</td>
              <td>
                <span class="sg-swatch" style="background: ${value}"></span>
                ${value}
              </td>
            </tr>`,
            ).join("")}
          </tbody>
        </table>`,
      )}

      ${section(
        "Component contracts",
        `
        <p>
          Each base reads from a tiny set of vars. Tone classes set
          <code>--bg-mix</code> and <code>--on-bg-mix</code> elsewhere
          (tones.css); the component just consumes them.
        </p>
        ${code(`/* buttons.css */
.btn {
  background:    var(--bg-mix, var(--color-primary));
  color:         var(--on-bg-mix, white);
  border:        1px solid transparent;
  border-radius: var(--btn-radius);
  /* ... shape, sizing ... */
}

/* tones.css */
.primary { --bg-mix: var(--color-primary); --on-bg-mix: white; }
.danger  { --bg-mix: var(--color-danger);  --on-bg-mix: white; }
/* ... */`)}
        <table class="table sg-tokens">
          <thead>
            <tr><th>Variable</th><th>Role</th></tr>
          </thead>
          <tbody>
            ${BTN_VARS.map(
              ([name, role]) => `
            <tr>
              <td>${name}</td>
              <td class="sg-td-prose">${esc(role)}</td>
            </tr>`,
            ).join("")}
          </tbody>
        </table>`,
      )}

      ${section(
        "Scope rule",
        `
        <p>
          Variables defined at a more specific scope override the global ones.
          Wrap a subtree in a theme class and every component inside re-skins
          automatically — no component rewrites.
        </p>
        ${code(`:root {
  --color-primary: #0d83dd;
}

.theme-sunset {
  --color-primary: #F98E2E;
  --color-success: #d4b609;
}`)}`,
      )}
    `;
}

function buttonsPage() {
  /*
   * The real scale is xs/sm/md/lg/xl. This list used to read
   * sm/base/lg/xl/2xl — `text-base` and `text-2xl` have never existed in the
   * package, and until v0.10.1 the other three were inert on a button anyway,
   * so all five rendered identically.
   */
  const sizes = [
    ["text-xs", "XS"],
    ["text-sm", "Small"],
    ["text-md", "Body"],
    ["text-lg", "Large"],
    ["text-xl", "XL"],
  ];

  return `
      ${pageHeader({
        eyebrow: "Components",
        title: "Buttons",
        lead: "The .btn class plus modifiers. Tones set the var contract. Outlined reads them and flips structure.",
      })}

      ${section(
        "Default",
        `
        <p>
          The bare <code>btn</code> class is your primary button — no extra
          modifier needed.
        </p>
        ${preview(chip("Button", "btn"))}
        ${code(`<button class="btn">Button</button>`)}`,
      )}

      ${section(
        "Tones",
        `
        <p>
          The tone classes (<code>.primary</code>, <code>.danger</code>, …)
          live in one file — <code>tones.css</code> — and set
          <code>--bg-mix</code> + <code>--on-bg-mix</code>. The button reads
          those vars; same vocabulary works on pills, badges, cards, fields.
        </p>
        ${preview(
          `<div class="cluster">
            ${TONES.map(([cls, label]) => chip(label, `btn ${cls}`)).join("")}
          </div>`,
        )}
        ${code(
          TONES.map(([c, l]) => `<button class="btn ${c}">${l}</button>`).join("\n"),
        )}`,
      )}

      ${section(
        "Outlined",
        `
        <p>
          Adding <code>outlined</code> reads the vars set by the tone and
          inverts the structure — background becomes surface; color and border
          become the tone hue.
        </p>
        ${preview(
          `<div class="cluster">
            ${TONES.map(([cls, label]) => chip(label, `btn ${cls} outlined`)).join("")}
          </div>`,
        )}
        ${code(`<button class="btn primary outlined">Primary</button>`)}`,
      )}

      ${section(
        "Sizes",
        `
        <p>
          Sizes ride the type scale. Padding is set in <code>em</code> so
          font-size carries the whole thing.
        </p>
        ${preview(
          `<div class="cluster sg-row-baseline">
            ${sizes.map(([cls, label]) => chip(label, `btn ${cls}`)).join("")}
          </div>`,
        )}`,
      )}

      ${section(
        "Link button",
        `
        <p>
          The <code>link</code> modifier strips structure and renders the
          button visually as a link, while keeping button semantics.
        </p>
        ${preview(chip("Link Button", "btn link"))}
        ${code(`<button class="btn link">Link Button</button>`)}`,
      )}

      ${section(
        "Live editor",
        `
        <p>
          Compose the class chain yourself. Any example above populates this
          field.
        </p>
        <div class="field-group sg-editor">
          <label for="sg-btn-chain">Class chain</label>
          <input
            class="field"
            id="sg-btn-chain"
            value="${esc(state.btnClasses)}"
            placeholder="btn primary outlined"
            spellcheck="false">
          <div class="card sg-preview-center">
            <button id="sg-btn-sample" class="${esc(state.btnClasses)}">Example Button</button>
          </div>
        </div>`,
      )}
    `;
}

/*
 * The live editor is the one place the guide keeps state between renders.
 * Writing the class straight onto the sample button (rather than re-rendering
 * the page) is what keeps the caret in the input while you type.
 */
buttonsPage.init = function (root) {
  const input = $("#sg-btn-chain", root);
  const sample = $("#sg-btn-sample", root);

  function apply(value) {
    state.btnClasses = value;
    input.value = value;
    sample.className = value || "";
  }

  input.addEventListener("input", () => apply(input.value));

  root.addEventListener("click", (e) => {
    const trigger = e.target.closest("[data-btn]");
    if (trigger) apply(trigger.dataset.btn);
  });
};

function linksPage() {
  return `
      ${pageHeader({
        eyebrow: "Components",
        title: "Links",
        lead: "The .link class for inline anchors. Same tone vocabulary as buttons.",
      })}

      ${section(
        "Default",
        `
        ${preview(`<a class="link" href="#" data-noop>A normal link</a>`)}
        ${code(`<a class="link" href="/">A normal link</a>`)}`,
      )}

      ${section(
        "Button styled as link",
        `
        <p>
          A button that needs to read as a link uses <code>btn link</code>.
        </p>
        ${preview(`<button class="btn link">Link button</button>`)}
        ${code(`<button class="btn link">Link button</button>`)}`,
      )}
    `;
}

function tonalPage() {
  const tones = ["primary", "secondary", "muted", "info", "success", "warning", "danger"];

  return `
      ${pageHeader({
        eyebrow: 'Foundation',
        title: 'Tones &amp; contrast',
        lead: 'A tone is one variable. Everything else — surface tints, borders, fills, text color — is derived from it, and none of the derivations know any tone names.'
      })}

      ${section(
        'The contract is one variable',
        `
        <p>
          A tone class sets <code>--bg-mix</code>. That is the entire tone. It
          used to set a second variable, <code>--on-bg-mix</code>, asserting the
          text color — that assertion is what failed WCAG on 15 tone × theme
          combinations (worst 1.99:1, on the primary button of a real client
          theme), so it is now derived instead.
        </p>
        ${code(`/* tones.css — the whole file, essentially */
.primary   { --bg-mix: var(--color-primary);   }
.danger    { --bg-mix: var(--color-danger);    }
/* …five more… */`)}
        <div class="cluster">
          ${tones.map((t) => `<button class="btn ${t}">${t}</button>`).join('')}
        </div>`
      )}

      ${section(
        'Tones are element-scoped',
        `
        <p>
          Custom properties inherit, and <code>var(--bg-mix, fallback)</code> only
          reaches its fallback when the property is unset on the element
          <em>and</em> every ancestor. Unregistered, a tone bled into every
          descendant that read it — an untoned button inside a danger alert
          rendered red on red.
        </p>
        ${code(`@property --bg-mix    { syntax: "*"; inherits: false; }
@property --on-bg-mix { syntax: "*"; inherits: false; }`)}
        ${preview(`
          <div class="alert danger" style="width: 100%">
            <div class="alert-icon" aria-hidden="true">!</div>
            <div class="alert-content">
              <strong>Payment failed</strong>
              <p>
                The button and pill below are untoned. They keep their own
                defaults instead of inheriting the alert&rsquo;s danger tone.
              </p>
              <div class="cluster" style="margin-top: 8px">
                <button class="btn">Retry</button>
                <span class="pill">3</span>
              </div>
            </div>
          </div>`)}
        <p>
          The cost: a rule that reads <code>--bg-mix</code> must sit on the element
          carrying the tone class. Where a child needs the value — the tinted
          <code>&lt;td&gt;</code> in a toned row, the tinted header of a toned
          dialog — the toned element derives the result into a normal inheriting
          property and passes that down.
        </p>`
      )}

      ${section(
        'The surface recipe names no tones',
        `
        <p>
          Each tint is computed from <code>--bg-mix</code>. When there is no tone,
          <code>--bg-mix</code> is guaranteed-invalid, so the
          <code>color-mix()</code> is invalid at computed-value time, so the tint
          variable is too — and the fallback on the next line supplies the untoned
          default. That is the whole mechanism, and it is why every tone works on
          every surface without anything enumerating them.
        </p>
        ${code(`/* tones.css — computed on any element that carries a tone */
--tint-surface: color-mix(in srgb, var(--bg-mix) 10%, var(--surface));

/* surface.css — reads the ramp, never restates the percentage */
:where(.surface, .card, .alert, .toast, .dialog, .popover, .drawer) {
  --surface-tint-bg: var(--tint-surface);
  --surface-bg:      var(--surface-tint-bg, var(--surface));
}`)}
        <div class="stack">
          ${tones
            .map(
              (t) => `
          <article class="card ${t}">
            <strong>.card .${t}</strong>
            <p style="margin: 0">
              10% tint, 30% border, 55% text — derived, not declared.
            </p>
          </article>`
            )
            .join('')}
        </div>
        <div class="alert info">
          <div class="alert-icon" aria-hidden="true">&#9432;</div>
          <div class="alert-content">
            <strong>
              <code>.secondary</code> and <code>.muted</code> are in that list now.
            </strong>
          </div>
        </div>`
      )}

      ${section(
        'Contrast is derived, not asserted',
        `
        <p>
          For solid fills — button, pill, badge — both the fill and its text come
          from one number: the fill&rsquo;s relative luminance. The
          <code>y</code> channel of <code>xyz-d65</code> <em>is</em> WCAG&rsquo;s
          L, so there is no approximation involved.
        </p>
        <table class="table striped compact">
          <thead>
            <tr>
              <th style="width: 26%">Regime</th>
              <th>What happens</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><strong>Bright</strong> <code>y &gt; 0.35</code></td>
              <td>
                Keep the color exactly, use dark text. Contrast lands ≥ 8:1 and the
                brand hue survives — this is why Elite&rsquo;s lime stays lime.
              </td>
            </tr>
            <tr>
              <td><strong>Everything else</strong></td>
              <td>
                Keep white text, scale luminance down to 0.1783 — the point where
                white reaches 4.5:1. Uniform XYZ scaling is a scalar multiply on
                linear RGB, so hue is preserved exactly and it cannot leave gamut.
              </td>
            </tr>
          </tbody>
        </table>
        ${preview(
          `<div class="cluster">
            ${tones.map((t) => `<span class="badge ${t}">${t}</span>`).join('')}
          </div>`
        )}
        <p>
          <code>bun run test</code> checks all <strong>49</strong> tone × theme
          combinations — seven tones × seven themes — on each of
          <code>.btn</code>, <code>.pill</code> and <code>.badge</code>, and
          they clear AA. Because it is derived rather than tabulated it holds
          for hues no theme has defined yet, so the suite also throws
          <strong>eight invented hues</strong> at it — pure yellow, navy, mid
          grey, the light lime near Elite's brand — chosen to straddle the
          branch. A new theme cannot reintroduce the bug.
        </p>
        ${code(`/* chip.css — override per tone or theme if you want a specific text color */
.theme-x .warning { --on-bg-mix: #1f2937; }`)}`
      )}

      ${section(
        'The tint ramp — three named steps',
        `
        <p>
          The recipe above produces one fill. For the <em>quieter</em> uses — a
          tinted strip, a soft callout, a highlighted row — there are three
          named steps, and they are the same three a toned Card is built from.
          Set a tone, read a token.
        </p>
        <table class="table striped compact">
          <thead>
            <tr>
              <th style="width: 26%">Token</th>
              <th style="width: 16%">Mix</th>
              <th>Is</th>
            </tr>
          </thead>
          <tbody>
            <tr><td><code>--tint-surface</code></td><td>10% into <code>--surface</code></td><td>the fill of a toned block</td></tr>
            <tr><td><code>--tint-rule</code></td><td>30% into <code>--rule</code></td><td>its border</td></tr>
            <tr><td><code>--tint-ink</code></td><td>55% into <code>--ink</code></td><td>its text</td></tr>
          </tbody>
        </table>
        ${preview(`
          <div class="stack">
            <div class="danger" style="padding: 12px 16px; border-radius: 8px; background: var(--tint-surface); border: 1px solid var(--tint-rule); color: var(--tint-ink)">Your own element, three tokens</div>
            <article class="card danger" style="margin: 0">A toned Card, for comparison</article>
          </div>`)}
        ${code(`<div class="danger"
     style="background: var(--tint-surface);
            border: 1px solid var(--tint-rule);
            color: var(--tint-ink)">…</div>`)}
        <p>
          The names say which token each one tints, so there is nothing to
          look up: <code>--tint-ink</code> is <code>--ink</code> pulled toward
          the tone. They are unset on an untoned element, so
          <code>var(--tint-rule, var(--rule))</code> degrades on its own — and
          they do not inherit, so an untoned child inside a danger block gets
          nothing rather than its parent's red.
        </p>
        <p>
          These live in <code>tones.css</code> and nothing else states the
          percentages — <code>surface.css</code> reads them. An app matching a
          Card by hand would otherwise be copying three magic numbers and
          promising to keep them equal forever.
        </p>`
      )}

    `
}

/* ══════════════════════════════════════════════════════════════════════
   3. Pages — Foundation, the two axes
   ══════════════════════════════════════════════════════════════════════ */

/*
 * Every number on this page is read or measured at render time — the mix
 * percentages and the luminance constants out of the authored CSS, the
 * twelve rungs and the three densities off probe elements in this
 * document. None of it is written down here.
 *
 * That is not decoration. A diagram is the easiest thing in a repo to
 * leave stale, because nothing renders wrong when it rots: the picture
 * still looks like a picture. This one goes wrong visibly — a rung that
 * stops moving, a swatch that stops matching the component beside it.
 */

/* The tint ramp's three percentages, out of the rule that declares them. */
function tintSteps() {
  const of = (prop) => {
    const v = tokenValue(prop)
    const m = v && v.match(/([\d.]+)%\s*,\s*var\(\s*(--[a-z-]+)/)
    return m ? { pct: m[1], into: m[2] } : null
  }
  return [
    { name: '--tint-surface', role: 'the fill of a toned block', ...(of('--tint-surface') || {}) },
    { name: '--tint-rule', role: 'its border', ...(of('--tint-rule') || {}) },
    { name: '--tint-ink', role: 'its text', ...(of('--tint-ink') || {}) }
  ].filter((t) => t.pct)
}

/*
 * The two constants the contrast derivation turns on, read out of the
 * chip base's own `--fill` expression rather than restated.
 *
 * 0.35 is where the branch is: above it a hue keeps its colour and takes
 * dark text, below it the fill is scaled down and keeps white. 0.1783 is
 * the luminance at which white text reaches 4.5:1.
 */
function contrastConstants() {
  const v = tokenValue('--fill') || ''
  const target = v.match(/([\d.]+)\s*\/\s*y/)
  const split = v.match(/y\s*-\s*([\d.]+)/)
  return { target: target && target[1], split: split && split[1] }
}

/*
 * Measure, do not compute. The rungs are `calc(rem * var(--density))`, so
 * the only honest way to know what one IS in this document is to give an
 * element that width and ask.
 */
function withProbe(html, read) {
  const probe = document.createElement('div')
  probe.style.cssText = 'position:absolute;left:-9999px;top:0;visibility:hidden'
  probe.innerHTML = html
  document.body.append(probe)
  const out = read(probe)
  probe.remove()
  return out
}

function measureRungs() {
  return withProbe(
    RUNGS.map(([n]) => `<i style="display:block;width:var(--space-${n})"></i>`).join(''),
    (probe) =>
      RUNGS.map(([n], i) => ({
        name: n,
        px: Math.round(parseFloat(getComputedStyle(probe.children[i]).width) * 100) / 100
      }))
  )
}

function measureDensities() {
  return withProbe(
    ['', 'dense', 'roomy']
      .map((c) => `<i class="${c}" style="display:block;width:var(--space-4xl)"></i>`)
      .join(''),
    (probe) =>
      ['default', 'dense', 'roomy'].map((label, i) => {
        const el = probe.children[i]
        return {
          label,
          density: getComputedStyle(el).getPropertyValue('--density').trim(),
          px: Math.round(parseFloat(getComputedStyle(el).width) * 100) / 100
        }
      })
  )
}

/* ── The diagram ───────────────────────────────────────────────────── */

/*
 * Hand-built SVG rather than a chart library, for the reason the whole
 * package exists: a dependency that draws twelve rectangles is a
 * dependency. It is inline in the document, so `var(--…)` inside it
 * resolves against the live theme and the drawing follows the switcher.
 */
function axesDiagram() {
  const tints = tintSteps()
  const rungs = measureRungs()
  const dens = measureDensities()
  const c = contrastConstants()
  const max = Math.max(...rungs.map((r) => r.px))
  const SCALE = 250 / max
  /* Printed at each nesting level: the same measured number three times is
     the whole claim, so it is read once and reused rather than typed. */
  const dense = (dens.find((d) => d.label === 'dense') || {}).density

  const t = (x, y, s, cls) => `<text x="${x}" y="${y}" class="${cls || 'sg-ax-label'}">${s}</text>`

  /* ── left: one hue in, three tints out ── */
  const swatchW = 118
  const swatches = tints
    .map((s, i) => {
      const x = 40 + i * (swatchW + 16)
      return `
      <rect class="sg-ax-swatch" x="${x}" y="176" width="${swatchW}" height="52" rx="7"
            fill="color-mix(in srgb, var(--color-danger) ${s.pct}%, var(--surface))"
            stroke="var(--rule)" />
      ${t(x + swatchW / 2, 250, esc(s.name), 'sg-ax-mono sg-ax-mid')}
      ${t(x + swatchW / 2, 266, s.pct + '% into ' + esc(s.into), 'sg-ax-dim sg-ax-mid')}
      ${t(x + swatchW / 2, 282, esc(s.role), 'sg-ax-dim sg-ax-mid')}`
    })
    .join('')

  const fans = tints
    .map((s, i) => {
      const x = 40 + i * (swatchW + 16) + swatchW / 2
      return `<path d="M 236 140 C 236 158, ${x} 152, ${x} 172" class="sg-ax-flow" />`
    })
    .join('')

  /* ── right: one number in, twelve rungs out ── */
  const ladder = rungs
    .map((r, i) => {
      const y = 172 + i * 15
      return `
      ${t(596, y + 8, r.name, 'sg-ax-mono sg-ax-end')}
      <rect class="sg-ax-bar" x="606" y="${y}" width="${(r.px * SCALE).toFixed(1)}" height="9" rx="2.5"
            fill="var(--color-primary)" opacity="${(0.4 + (i / rungs.length) * 0.6).toFixed(2)}" />
      ${t(612 + r.px * SCALE, y + 8, r.px + 'px', 'sg-ax-dim')}`
    })
    .join('')

  /* The same rung at each density — the axis doing its one job. */
  const trio = dens
    .map((d, i) => {
      const y = 386 + i * 26
      return `
      ${t(596, y + 10, d.label, 'sg-ax-end')}
      <rect class="sg-ax-trio" x="606" y="${y}" width="${(d.px * SCALE).toFixed(1)}" height="13" rx="3"
            fill="var(--color-primary)" opacity="${d.label === 'default' ? 1 : 0.55}" />
      ${t(612 + d.px * SCALE, y + 10, '× ' + d.density + '  =  ' + d.px + 'px', 'sg-ax-dim')}`
    })
    .join('')

  return `
  <svg viewBox="0 0 960 646" class="sg-axes" role="img" aria-labelledby="axes-t axes-d">
    <title id="axes-t">The two axes of the system</title>
    <desc id="axes-d">
      On the left, colour: one variable --bg-mix produces ${tints.length} tints, mixed at
      ${tints.map((s) => s.pct + '%').join(', ')} into --surface, --rule and --ink, plus a text
      colour branched on the fill's own luminance. It is registered inherits: false, so it stops
      at the element that declares it. On the right, size: one number --density multiplies a
      ladder of ${rungs.length} space rungs from ${rungs[0].px}px to ${max}px. It is registered
      inherits: true, so it reaches every descendant. The same facts follow this diagram as
      tables in text.
    </desc>

    <line x1="480" y1="52" x2="480" y2="604" class="sg-ax-rule" />

    <!-- ── COLOUR ────────────────────────────────────────────────── -->
    ${t(40, 36, 'COLOUR', 'sg-ax-eyebrow')}
    ${t(40, 58, 'a fact about ONE element', 'sg-ax-head')}

    <rect x="166" y="96" width="140" height="40" rx="9" fill="var(--color-danger)" />
    ${t(236, 121, '--bg-mix', 'sg-ax-mono sg-ax-mid sg-ax-on')}
    ${fans}
    ${swatches}

    <!-- the text colour is a branch, not a mix -->
    ${t(40, 326, 'the text colour is a branch, not a fourth mix', 'sg-ax-dim')}
    <rect x="40" y="340" width="190" height="44" rx="9" fill="var(--color-warning)" />
    ${t(135, 361, 'y > ' + (c.split || '0.35') + ' — keep the hue', 'sg-ax-mono sg-ax-mid')}
    ${t(135, 376, 'dark text', 'sg-ax-dim sg-ax-mid')}
    <rect x="250" y="340" width="190" height="44" rx="9" fill="var(--color-primary)" />
    ${t(345, 361, 'y ≤ ' + (c.split || '0.35') + ' — dim the fill', 'sg-ax-mono sg-ax-mid sg-ax-on')}
    ${t(345, 376, 'white text', 'sg-ax-mid sg-ax-ondim')}
    ${t(40, 406, 'scaled to at most ' + (c.target || '0.1783') + ' luminance — where white reaches 4.5:1', 'sg-ax-dim')}

    <!-- inherits: false — the boundary that stops -->
    <rect x="40" y="464" width="400" height="140" rx="12" class="sg-ax-dash" />
    ${t(56, 488, 'inherits: false', 'sg-ax-mono sg-ax-strong')}
    <rect x="56" y="504" width="368" height="84" rx="9"
          fill="color-mix(in srgb, var(--color-danger) 10%, var(--surface))"
          stroke="color-mix(in srgb, var(--color-danger) 30%, var(--surface))" />
    ${t(72, 526, 'a danger Card', 'sg-ax-dim')}
    ${t(408, 526, '--bg-mix  stated', 'sg-ax-mono sg-ax-end sg-ax-said')}
    <rect x="72" y="536" width="118" height="38" rx="7" fill="var(--surface)" stroke="var(--rule)" />
    ${t(131, 560, 'its Button', 'sg-ax-mid sg-ax-dim')}
    <path d="M 210 555 L 262 555" class="sg-ax-flow" />
    <path d="M 228 545 L 244 565 M 244 545 L 228 565" class="sg-ax-cross" />
    ${t(276, 549, '--bg-mix  unset', 'sg-ax-mono sg-ax-said')}
    ${t(276, 566, 'the red does not reach it', 'sg-ax-dim')}

    <!-- ── SIZE ──────────────────────────────────────────────────── -->
    ${t(520, 36, 'SIZE', 'sg-ax-eyebrow')}
    ${t(520, 58, 'a fact about a REGION', 'sg-ax-head')}

    <rect x="606" y="96" width="140" height="40" rx="9" fill="var(--color-primary)" />
    ${t(676, 121, '--density', 'sg-ax-mono sg-ax-mid sg-ax-on')}
    <path d="M 676 140 L 676 166" class="sg-ax-flow" />
    ${ladder}
    ${t(606, 370, 'one rung, three densities', 'sg-ax-dim')}
    ${trio}

    <!-- inherits: true — the boundary that is crossed -->
    <rect x="520" y="464" width="400" height="140" rx="12" class="sg-ax-dash" />
    ${t(536, 488, 'inherits: true', 'sg-ax-mono sg-ax-strong')}
    <rect x="536" y="504" width="368" height="84" rx="9" class="sg-ax-nest" />
    ${t(552, 522, 'a .dense Pane', 'sg-ax-dim')}
    ${t(888, 522, '--density: ' + dense + '  stated', 'sg-ax-mono sg-ax-end sg-ax-said')}
    <rect x="552" y="530" width="336" height="50" rx="8" class="sg-ax-nest" />
    ${t(568, 548, 'a Card', 'sg-ax-dim')}
    ${t(872, 548, dense + '  inherited', 'sg-ax-mono sg-ax-end sg-ax-said')}
    <rect x="568" y="554" width="304" height="20" rx="6" class="sg-ax-nest" />
    ${t(584, 568, 'a Row', 'sg-ax-dim')}
    ${t(856, 568, dense + '  inherited', 'sg-ax-mono sg-ax-end sg-ax-said')}
  </svg>`
}

function axesPage() {
  const tints = tintSteps()
  const rungs = measureRungs()
  const dens = measureDensities()
  const c = contrastConstants()
  const spread = dens.find((d) => d.label === 'roomy').px / dens.find((d) => d.label === 'dense').px

  return `
      ${pageHeader({
        eyebrow: 'Foundation',
        title: 'The two axes',
        lead: `A tone and a density are the same idea pointed at different problems — one variable in, a whole system out. What separates them is one line of <code>@property</code>, and it is the line that decides everything else.`
      })}

      ${section(
        'Both axes at once',
        `
        <p>
          Every number below is read or measured while this page renders — the
          percentages out of the rule that declares them, the ${rungs.length} rungs
          off probe elements in this document. Change a token and the drawing
          changes with it.
        </p>
        ${axesDiagram()}`
      )}

      ${section(
        'The mirror',
        `
        <p>
          The two halves are the same shape and the opposite claim. A tone is
          <strong>a fact about one element</strong> — so a danger Card must not turn
          its own button red. A density is <strong>a fact about a region</strong> —
          so <code>.dense</code> on a Pane has to reach every Card, Row and Field
          inside it. If either inherited the other's way, it would be useless in
          exactly the case it exists for.
        </p>
        <table class="table">
          <thead>
            <tr><th style="width: 22%"></th><th style="width: 39%">Colour</th><th>Size</th></tr>
          </thead>
          <tbody>
            <tr>
              <td><strong>the input</strong></td>
              <td><code>--bg-mix</code> — ${TONES.length} tones</td>
              <td><code>--density</code> — ${dens.map((d) => d.density).join(' · ')}</td>
            </tr>
            <tr>
              <td><strong>the output</strong></td>
              <td>${tints.length} tints, plus a derived text colour</td>
              <td>${rungs.length} space rungs, ${rungs[0].px}px&ndash;${rungs[rungs.length - 1].px}px</td>
            </tr>
            <tr>
              <td><strong><code>@property</code></strong></td>
              <td><code>inherits: false</code></td>
              <td><code>inherits: true</code></td>
            </tr>
            <tr>
              <td><strong>declared on</strong></td>
              <td><code>*</code>, so every element derives from its own</td>
              <td><code>*</code>, so a rung re-multiplies where it is read</td>
            </tr>
            <tr>
              <td><strong>if it were the other</strong></td>
              <td>an untoned button inside a danger Card renders red</td>
              <td><code>.dense</code> styles the Pane and nothing in it</td>
            </tr>
          </tbody>
        </table>
        ${patternNote(`
          Both are declared on <code>*</code> rather than <code>:root</code>, and for
          the same reason in opposite directions. At <code>:root</code> a rung
          substitutes <code>var(--density)</code> once, against the root, and inherits
          that fixed length past every <code>.dense</code> — the alias trap. The tint
          ramp is on <code>*</code> so each element mixes from its own
          <code>--bg-mix</code> rather than an ancestor's.`)}`
      )}

      ${section(
        'What the colour axis derives',
        `
        <p>
          Three mixes and a branch, from one hue. The percentages are the
          stylesheet's, read back here rather than repeated:
        </p>
        <dl class="facts divided">
          ${tints
            .map(
              (s) => `
          <dt><code>${esc(s.name)}</code></dt>
          <dd>${s.pct}% of the tone into <code>${esc(s.into)}</code> &mdash; ${esc(s.role)}</dd>`
            )
            .join('')}
        </dl>
        <p>
          The text colour is not in that list because it is not a mix. It is a
          branch on the fill's own <strong>relative luminance</strong> — the
          <code>y</code> channel of <code>xyz-d65</code>, which is exactly WCAG's
          L, so no approximation is involved.
          ${
            c.split && c.target
              ? `Above <code>${c.split}</code> a hue keeps its colour exactly and takes dark text.
                 At or below it, white text is kept and the fill's luminance is scaled down to at
                 most <code>${c.target}</code> — the point where white reaches 4.5:1.`
              : ''
          }
        </p>
        ${patternNote(`
          Scaling luminance uniformly is a scalar multiply on linear RGB, so it
          preserves chromaticity exactly and only moves the colours that need
          moving. That is why a brand hue survives the treatment instead of
          turning to mud &mdash; darkening a lime is what makes it olive.`)}`
      )}

      ${section(
        'What the size axis multiplies',
        `
        <p>
          One ladder, ${rungs.length} rungs, every one of them
          <code>calc(rem &times; var(--density))</code>. Measured in this document
          just now:
        </p>
        <table class="table">
          <thead><tr><th>Rung</th><th>Here</th><th>In a <code>.dense</code> region</th><th>In a <code>.roomy</code> one</th></tr></thead>
          <tbody>
            ${rungs
              .map(
                (r) => `
            <tr>
              <td><code>--space-${r.name}</code></td>
              <td>${r.px}px</td>
              <td>${Math.round(r.px * parseFloat(dens[1].density) * 100) / 100}px</td>
              <td>${Math.round(r.px * parseFloat(dens[2].density) * 100) / 100}px</td>
            </tr>`
              )
              .join('')}
          </tbody>
        </table>
        <p>
          The whole spread is <strong>${spread.toFixed(2)}&times;</strong> from
          <code>.dense</code> to <code>.roomy</code>, and it costs one class on one
          ancestor. That is the reason there is no <code>btn-sm</code>: the axis is
          named once instead of once per component.
        </p>`
      )}`
}

/* ══════════════════════════════════════════════════════════════════════
   Density & space — the third axis
   ══════════════════════════════════════════════════════════════════════ */

const RUNGS = [
  ['3xs', '2px'],  ['2xs', '4px'],  ['xs', '6px'],   ['sm', '8px'],
  ['md', '10px'],  ['lg', '12px'],  ['xl', '14px'],  ['2xl', '16px'],
  ['3xl', '20px'], ['4xl', '24px'], ['5xl', '32px'], ['6xl', '48px']
]

function densityPage() {
  return `
      ${pageHeader({
        eyebrow: 'Foundation',
        title: 'Density & space',
        lead:
          'Two tones and a treatment describe how a thing looks. Density is ' +
          'the third axis and it describes how much room it takes — one ' +
          'number, set on a region, obeyed by everything inside it.'
      })}

      ${section(
        'Why there is an axis at all',
        `
        <p>
          Every framework hits this and most answer it per component.
          Bootstrap has <code>btn-sm</code>, <code>table-sm</code> and
          <code>form-control-sm</code>; Bulma has <code>is-small</code> on
          each element; Radix and MUI take a prop. All of them name the
          <em>combination</em>. This names the axis.
        </p>
        <p>
          It was the same here until v0.13, and the evidence is in the
          vocabulary: <code>compact</code> only works on a Table,
          <code>narrow</code> and <code>wide</code> only on a Bar. Three
          density decisions wearing three component names, because there was
          no space scale for them to live in — padding was a literal
          <code>rem</code> in whichever file needed it, while the type scale
          had been tokens for four versions.
        </p>`
      )}

      ${section(
        'One number',
        `
        <p>
          <code>--density</code> multiplies the whole space ladder. Two
          classes set it; anything can set it directly.
        </p>
        ${preview(`
          <div class="cluster" style="align-items: flex-start">
            <div style="inline-size: 12rem"><div class="card">Default<br><span class="text-muted text-xs">density 1</span></div></div>
            <div class="dense" style="inline-size: 12rem"><div class="card">Dense<br><span class="text-muted text-xs">density 0.8</span></div></div>
            <div class="roomy" style="inline-size: 12rem"><div class="card">Roomy<br><span class="text-muted text-xs">density 1.25</span></div></div>
          </div>`)}
        ${code(`<div class="dense">
  <div class="card">…</div>     <!-- tighter -->
  <table class="table">…</table> <!-- also tighter -->
  <input class="field">          <!-- also tighter -->
</div>

<section style="--density: 0.9">…</section>  <!-- or any number -->`)}
        <div class="alert info">
          <div class="alert-icon" aria-hidden="true">i</div>
          <div class="alert-content">
            <strong>Density inherits. A tone does not.</strong>
            <p>
              That is the whole difference and it is deliberate. A tone is a
              fact about <em>one element</em> — a danger Card must not turn
              the button inside it red — so it is registered
              <code>inherits: false</code>. Density is a fact about a
              <em>region</em>, so it is registered
              <code>inherits: true</code> and reaches everything inside.
            </p>
          </div>
        </div>`
      )}

      ${section(
        'The ladder',
        `
        <p>
          Twelve rungs, on a 2px grid to 16px and coarser above. The awkward
          ones — 10px and 14px — are rungs because the package genuinely
          uses them; rounding them into a prettier ladder would have moved
          real layout to flatter a table.
        </p>
        <div class="table-wrap">
          <table class="table compact striped">
            <thead><tr><th>Token</th><th>At density 1</th><th>In <code>.dense</code></th><th>In <code>.roomy</code></th></tr></thead>
            <tbody>
              ${RUNGS.map(([n, px]) => {
                const v = parseFloat(px)
                return `<tr>
                  <td><code>--space-${n}</code></td>
                  <td>${px}</td>
                  <td class="text-muted">${+(v * 0.8).toFixed(1)}px</td>
                  <td class="text-muted">${+(v * 1.25).toFixed(1)}px</td>
                </tr>`
              }).join('')}
            </tbody>
          </table>
        </div>
        <p>
          No component declares a literal padding — a test fails if one
          appears, the same guard the type scale has. Four exceptions are
          named in <code>space.spec.js</code> with their reasons, because a
          count would let a fifth in as long as a fourth left.
        </p>`
      )}

      ${section(
        'Declared, or derived',
        `
        <p>
          The same Card in a narrow sidebar should be tighter than in the
          main column, and nobody should have to remember to type that. Name
          your box and the package answers:
        </p>
        ${code(`.my-sidebar { container: fjs / inline-size; }`)}
        <div class="table-wrap">
          <table class="table compact">
            <thead><tr><th>Box is</th><th>Density becomes</th></tr></thead>
            <tbody>
              <tr><td>30rem or wider</td><td><code>1</code> — unchanged</td></tr>
              <tr><td>under 30rem</td><td><code>0.9</code></td></tr>
              <tr><td>under 20rem</td><td><code>0.8</code></td></tr>
            </tbody>
          </table>
        </div>
        <p>
          <strong>Declared beats derived.</strong> The container rules are
          written on <code>*</code>, which is zero specificity, so a stated
          <code>.dense</code> or <code>.roomy</code> inside a narrow box
          still wins. The reverse would make the axis untrustworthy: you
          would write <code>roomy</code>, see nothing happen, and have no way
          to find out why.
        </p>
        <div class="alert warning">
          <div class="alert-icon" aria-hidden="true">!</div>
          <div class="alert-content">
            <strong>The name is required, and the package ships no container of its own.</strong>
            <p>
              <code>container-type: inline-size</code> is not free. It means
              the box can no longer be sized by its contents — measured, a
              Card inside a Cluster went from <strong>83px to 42px</strong>,
              the width of its own padding, and the same in an auto-sized
              grid track. It also makes the box the containing block for
              <code>position: fixed</code> descendants, so a toast rendered
              inside one drifts. (Dialog and Popover are unaffected — the top
              layer escapes containment.) So you opt a box in, and the
              <em>named</em> query means nothing reacts to a container you
              created for some other reason.
            </p>
          </div>
        </div>`
      )}

      ${section(
        'What this replaces',
        `
        <p>
          Nothing yet — <code>compact</code>, <code>narrow</code> and
          <code>wide</code> still work and still only work on the one element
          each was written for. They are the shape the axis exists to
          retire, and retiring them is a change to markup people have
          already written.
        </p>`
      )}`
}

function themesPage() {
  const active = state.theme;
  const theme = THEMES[active];

  const themeCSS = `/* ${active}.css */
.theme-${active} {
${Object.entries(theme.tokens)
  .map(([k, v]) => `  ${k}: ${v};`)
  .join("\n")}
}`;

  const ramp = [
    ["80", "color-mix(in srgb, var(--sg-ramp) 80%, white)", "var(--ink)"],
    ["60", "color-mix(in srgb, var(--sg-ramp) 60%, white)", "var(--ink)"],
    ["40", "color-mix(in srgb, var(--sg-ramp) 40%, white)", "var(--ink)"],
    ["20", "color-mix(in srgb, var(--sg-ramp) 20%, white)", "var(--ink)"],
  ];
  const rampDark = [
    ["−20", "color-mix(in srgb, var(--sg-ramp) 20%, black)", "white"],
    ["−40", "color-mix(in srgb, var(--sg-ramp) 40%, black)", "white"],
    ["−60", "color-mix(in srgb, var(--sg-ramp) 60%, black)", "white"],
    ["−80", "color-mix(in srgb, var(--sg-ramp) 80%, black)", "white"],
  ];

  return `
      ${pageHeader({
        eyebrow: 'Foundation',
        title: 'Themes',
        lead: 'A theme is a set of CSS variables. Nothing else. Apply the theme class to any subtree and every component reskins, no rewriting required.'
      })}

      ${section(
        'Live switcher',
        `
        <p>
          Pick a theme. The vars cascade. Every button, badge, pill, and tonal
          surface below reskins instantly. No component code changes.
        </p>
        <div class="tiles sg-theme-switcher">
          ${Object.entries(THEMES)
            .map(
              ([key, t]) => `
          <button
            type="button"
            class="surface tile item sg-theme-tab"
            aria-pressed="${active === key}"
            data-theme="${key}">
            <span class="sg-theme-swatch" style="background: ${
              t.tokens['--color-primary'] || 'var(--color-primary)'
            }"></span>
            <span class="item-text">
              <span class="item-title">${t.name}</span>
              <span class="item-sub">${t.description}</span>
            </span>
          </button>`
            )
            .join('')}
        </div>

        <div class="sg-theme-preview" style="${styleAttr(theme.tokens)}">
          <div class="stack gap-md">
            <div class="sg-theme-label">Buttons</div>
            <div class="cluster">
              <button class="btn">Save</button>
              <button class="btn outlined">Cancel</button>
              <button class="btn success">Approve</button>
              <button class="btn warning">Review</button>
              <button class="btn danger outlined">Delete</button>
            </div>
          </div>

          <div class="stack gap-md">
            <div class="sg-theme-label">Badges &amp; Pills</div>
            <div class="cluster">
              <span class="badge success">Active</span>
              <span class="badge warning">Pending</span>
              <span class="badge danger">Failed</span>
              <span class="pill primary">12</span>
              <span class="pill info">i</span>
              <span class="pill danger">99+</span>
            </div>
          </div>

          <div class="stack gap-md">
            <div class="sg-theme-label">Tonal ramp</div>
            <div class="sg-theme-ramp" style="--sg-ramp: var(--color-primary); --color: var(--ink)">
              ${ramp
                .map(
                  ([n, bg, fg]) =>
                    `<div class="tonal" style="background: ${bg}; color: ${fg}">${n}</div>`
                )
                .join('')}
              <div class="tonal sg-tonal-raw">raw</div>
              ${rampDark
                .map(
                  ([n, bg, fg]) =>
                    `<div class="tonal" style="background: ${bg}; color: ${fg}">${n}</div>`
                )
                .join('')}
            </div>
          </div>

          <div class="stack gap-md">
            <div class="sg-theme-label">Form field</div>
            <div class="field-group">
              <label>Email address</label>
              <input class="field" type="email" value="you@example.com">
            </div>
          </div>
        </div>`
      )}

      ${section(
        'The active theme',
        `
        <p>
          This is everything that defines the <code>${active}</code> theme.
          One file. Seven tokens.
        </p>
        ${code(themeCSS)}`
      )}

      ${section(
        'Scoping',
        `
        <p>
          Themes don't have to be global. Wrap any subtree to scope a theme
          to it — useful for previews, per-tenant headers, comparison views.
        </p>
        ${code(`<body class="theme-default">
  <header class="theme-sunset">
    <!-- Header uses Sunset palette -->
    <button class="btn">Now orange</button>
  </header>

  <main>
    <!-- Body uses Default palette -->
    <button class="btn">Still blue</button>
  </main>
</body>`)}`
      )}

      ${section(
        'Adding a new theme',
        `
        <p>
          One <code>.css</code> file. Seven variable overrides. Done.
        </p>
        ${code(`/* oceanic.css */
.theme-oceanic {
  --color-primary:   #0891b2;
  --color-secondary: #ecfeff;
  --color-muted:     #475569;
  --color-info:      #0284c7;
  --color-success:   #059669;
  --color-warning:   #ca8a04;
  --color-danger:    #be123c;
}`)}
        <p>
          No component file touched. Apply
          <code>theme-oceanic</code> to <code>html</code>, <code>body</code>,
          or any subtree.
        </p>`
      )}
    `
}

/* The switcher drives the whole app's theme, so it re-renders rather than
 * patching in place — the topbar swatch has to move too. */
themesPage.init = function (root) {
  root.addEventListener("click", (e) => {
    const tab = e.target.closest("[data-theme]");
    if (tab) setTheme(tab.dataset.theme);
  });
};
function colorsPage() {
  const tones = [
    { name: "primary", hex: "#0d83dd", role: "Brand. Default actions, links, focus rings." },
    { name: "secondary", hex: "#E5E7EB", role: "Subtle backgrounds, low-emphasis surfaces." },
    { name: "muted", hex: "#6b7280", role: "De-emphasized text, secondary controls." },
    { name: "info", hex: "#2EA2C9", role: "Informational notices, tips." },
    { name: "success", hex: "#16a34a", role: "Confirmations, positive state." },
    { name: "warning", hex: "#d4b609", role: "Cautionary actions, pending state." },
    { name: "danger", hex: "#F4403A", role: "Errors, destructive actions." },
  ];

  const lightSteps = [90, 70, 50, 30, 10];
  const darkSteps = [10, 30, 50, 70, 90];

  return `
      ${pageHeader({
        eyebrow: "Foundation",
        title: "Colors",
        lead: "Seven semantic tones. Each one feeds a full tonal ramp via color-mix — one source-of-truth hue per role.",
      })}

      ${section(
        "The palette",
        `
        <p>
          One token per role. Components reference these by name (
          <code>--color-primary</code>, <code>--color-danger</code>) and never
          touch raw hex.
        </p>
        <div class="sg-palette">
          ${tones
            .map(
              (t) => `
          <div class="sg-palette-tile" style="background: ${t.hex}; color: ${
            t.hex === "#E5E7EB" ? "#1f2937" : "white"
          }">
            <div class="sg-palette-name">${t.name}</div>
            <div class="sg-palette-hex">${t.hex}</div>
          </div>`,
            )
            .join("")}
        </div>`,
      )}

      ${section(
        "Tonal ramps",
        `
        <p>
          Every tone gets a free 11-step ramp from the
          <code>lighten</code>/<code>darken</code> utilities. No need to
          define 50/100/200/300… steps by hand.
        </p>
        <div class="sg-color-ramps">
          ${tones
            .map(
              (t) => `
          <div class="sg-color-ramp" style="--sg-ramp: var(--color-${t.name}); --color: var(--ink)">
            <div class="sg-color-ramp-meta">
              <code class="sg-color-ramp-name">${t.name}</code>
              <span class="sg-color-ramp-role">${t.role}</span>
            </div>
            <div class="sg-color-ramp-strip">
              ${lightSteps
                .map(
                  (n) =>
                    `<div class="tonal" style="background: color-mix(in srgb, var(--sg-ramp) ${n}%, white); color: var(--ink)">${n}</div>`,
                )
                .join("")}
              <div class="tonal sg-tonal-raw">raw</div>
              ${darkSteps
                .map(
                  (n) =>
                    `<div class="tonal" style="background: color-mix(in srgb, var(--sg-ramp) ${n}%, black); color: white">−${n}</div>`,
                )
                .join("")}
            </div>
          </div>`,
            )
            .join("")}
        </div>`,
      )}

      ${section(
        "Where to use each",
        `
        <table class="table sg-tokens">
          <thead>
            <tr><th>Tone</th><th>Typical use</th></tr>
          </thead>
          <tbody>
            ${tones
              .map(
                (t) => `
            <tr>
              <td>
                <span class="sg-swatch" style="background: ${t.hex}"></span>
                ${t.name}
              </td>
              <td class="sg-td-prose">${t.role}</td>
            </tr>`,
              )
              .join("")}
          </tbody>
        </table>`,
      )}

      ${section(
        "Picking new tones",
        `
        <p>
          A few rules that keep the palette working as it scales:
        </p>
        <ul>
          <li>
            <strong>One hue per role.</strong> Don't add a second "blue" for
            "secondary action." If you need a second emphasis level, use the
            surface tint that <code>.card.primary</code> already derives, not a
            new token.
          </li>
          <li>
            <strong>Test the raw hue at every ramp step.</strong> A color that
            looks great at full saturation can muddy badly at a 10% tint. Open
            the Tones &amp; contrast page after picking.
          </li>
          <li>
            <strong>Keep state colors saturated.</strong> Success/warning/danger
            need to read instantly — desaturated state colors feel ambiguous.
          </li>
        </ul>`,
      )}
    `;
}

function headingsPage() {
  return `
      ${pageHeader({
        eyebrow: "Components",
        title: "Headings",
        lead: "A six-step type scale. Element tags get the scale by default; matching .h1–.h6 classes let you borrow the look on other elements.",
      })}

      ${section(
        "The scale",
        `
        ${preview(`
          <div class="sg-stack">
            <span class="h1">Heading 1 — display</span>
            <span class="h2">Heading 2 — section</span>
            <span class="h3">Heading 3 — subsection</span>
            <span class="h4">Heading 4 — group</span>
            <span class="h5">Heading 5 — label</span>
            <span class="h6">Heading 6 — fine print</span>
          </div>`)}
        ${code(`<h1 class="h1">Heading 1</h1>
<h2 class="h2">Heading 2</h2>
<h3 class="h3">Heading 3</h3>
<h4 class="h4">Heading 4</h4>
<h5 class="h5">Heading 5</h5>
<h6 class="h6">Heading 6</h6>`)}`,
      )}

      ${section(
        "Source",
        `
        <p>
          Tag selectors paired with classes — write the right semantic tag,
          fall back to the class when the element doesn't match the role.
        </p>
        ${code(
          ['/* typography.css — read from the live stylesheet, not copied */']
            .concat(
              ['h1, .h1', 'h2, .h2', 'h3, .h3', 'h4, .h4', 'h5, .h5', 'h6, .h6']
                .map(ruleText)
                .filter(Boolean)
            )
            .join('\n\n')
        )}
        <p>
          Every size is a rung of the type ladder rather than a number typed
          here — which is why an <code>h4</code> and
          <code>.text-xl</code> are the same size and stay that way. This
          block used to be a copy of the file and showed literal rems for
          months after the file stopped saying them.
        </p>`,
      )}

      ${section(
        "Borrowed styling",
        `
        <p>
          When semantic order matters more than visual weight — e.g. an
          <code>h2</code> visually styled as an h4 — apply the class:
        </p>
        ${preview(`
          <div class="sg-stack">
            <span class="h4">An h2 that looks like an h4</span>
            <span class="h6">A small uppercase eyebrow on a span</span>
          </div>`)}
        ${code(`<h2 class="h4">An h2 that looks like an h4</h2>
<span class="h6">A small uppercase eyebrow</span>`)}`,
      )}
    `;
}

function cardsPage() {
  return `
      ${pageHeader({
        eyebrow: "Components",
        title: "Cards",
        lead: "A surface container. Card is its own base — a block primitive that sits alongside chip, not extending it.",
      })}

      ${section(
        "Default",
        `
        <p>
          The bare <code>.card</code> class — a flat surface with a soft
          border and consistent padding.
        </p>
        ${preview(`
          <div class="card">
            A simple card. Contains text or any other content. Owns its
            padding, surface color, and border.
          </div>`)}
        ${code(`<div class="card">
  A simple card.
</div>`)}`,
      )}

      ${section(
        "Structured — header, body, footer",
        `
        <p>
          Three optional sub-components for cards that need internal sections.
          They share the card's border color so the dividers stay consistent.
        </p>
        ${preview(`
          <div class="card">
            <div class="surface-header">Maid.Tech</div>
            <div class="surface-body">
              <p class="sg-card-text">
                A platform serving cleaning businesses. Manages booking,
                scheduling, and client communication.
              </p>
            </div>
            <div class="surface-footer">
              <button class="btn">View</button>
              <button class="btn outlined">Settings</button>
            </div>
          </div>`)}
        ${code(`<div class="card">
  <div class="surface-header">Title</div>
  <div class="surface-body">...content...</div>
  <div class="surface-footer">
    <button class="btn">Action</button>
  </div>
</div>`)}`,
      )}

      ${section(
        "Variants",
        `
        <p>
          Same vocabulary as buttons. Each variant only flips the var contract
          — same structure, different surface treatment.
        </p>
        ${preview(`
          <div class="tiles gap-lg sg-card-grid">
            <div class="card">
              <strong>Default</strong>
              <p class="sg-card-text">Border + surface fill.</p>
            </div>
            <div class="card raised">
              <strong>Raised</strong>
              <p class="sg-card-text">Soft shadow, no border.</p>
            </div>
            <div class="card outlined">
              <strong>Outlined</strong>
              <p class="sg-card-text">Stronger border, transparent fill.</p>
            </div>
            <div class="card ghost">
              <strong>Ghost</strong>
              <p class="sg-card-text">No border, no fill — pure padding.</p>
            </div>
          </div>`)}
        ${code(`<div class="card raised">...</div>
<div class="card outlined">...</div>
<div class="card ghost">...</div>`)}`,
      )}

      ${section(
        "Toned",
        `
        <p>
          Tone modifiers set <code>--bg-mix</code>, and the card derives its
          surface, border, and text color from it. The mixing rules from the
          Tonal page do the work.
        </p>
        ${preview(`
          <div class="tiles gap-lg sg-card-grid">
            <div class="card info">
              <strong>Info card</strong>
              <p class="sg-card-text">
                Informational notice. Soft fill, subtle border, readable text.
              </p>
            </div>
            <div class="card success">
              <strong>Success card</strong>
              <p class="sg-card-text">
                Confirmation message. Same shape, green tonal ramp.
              </p>
            </div>
            <div class="card warning">
              <strong>Warning card</strong>
              <p class="sg-card-text">
                Caution. Yellow tonal ramp with darker text for contrast.
              </p>
            </div>
            <div class="card danger">
              <strong>Danger card</strong>
              <p class="sg-card-text">
                Error state. Red tonal ramp without screaming saturation.
              </p>
            </div>
          </div>`)}
        ${code(`<div class="card info">An informational card</div>
<div class="card success">Action completed</div>
<div class="card danger">Something failed</div>`)}`,
      )}

      ${section(
        "As a container",
        `
        <p>
          Cards hold other components without restyling them. Buttons, badges,
          fields, and pills all read normally inside any card variant.
        </p>
        ${preview(`
          <div class="card raised">
            <div class="surface-header">
              <span>Domain monitor</span>
              <span class="badge danger">7 days</span>
            </div>
            <div class="surface-body">
              <p class="sg-card-text">
                <code>greensweepnm.com</code> expires soon. Renew now to
                avoid downtime.
              </p>
              <div class="field-group" style="margin-top: 12px">
                <label>Renewal period</label>
                <select class="field">
                  <option>1 year</option>
                  <option>2 years</option>
                  <option>5 years</option>
                </select>
              </div>
            </div>
            <div class="surface-footer">
              <button class="btn">Renew now</button>
              <button class="btn outlined">Remind me later</button>
            </div>
          </div>`)}`,
      )}

      ${section(
        "Source",
        code(`/* cards.css */
.card {
  /* the shared surface contract, set in surface.css */
  background: var(--surface-bg);
  color: var(--surface-color);
  border: 1px solid var(--surface-border);
}

/* Variants — flip the var contract */
.card.raised {
  --surface-border: transparent;
  box-shadow: var(--shadow-md);
}
.card.outlined {
  --surface-bg: transparent;
  --surface-border: var(--surface-tint-border, var(--rule-strong));
}
.card.ghost {
  --surface-bg: transparent;
  --card-border: transparent;
}

/* Tones — derive surface from --bg-mix; tones.css sets --bg-mix */
.card.primary,
.card.info,
.card.success,
.card.warning,
/* No .card.danger rule exists — the recipe in surface.css names no
   tones, so every tone works on every surface automatically. */`),
      )}

      ${section(
        "When to use each",
        `
        <ul>
          <li>
            <strong>Default</strong> — most surfaces. List items, dashboard
            cells, settings panels.
          </li>
          <li>
            <strong>Raised</strong> — emphasized surfaces. Modals, top-level
            dashboard cards, anything that "floats."
          </li>
          <li>
            <strong>Outlined</strong> — secondary surfaces. Empty states,
            inline form sections, grouped controls.
          </li>
          <li>
            <strong>Ghost</strong> — invisible containers. Layout-only padding
            without a visual surface.
          </li>
          <li>
            <strong>Toned</strong> — communicate state through the surface
            itself. Alert banners, status panels, confirmation messages.
          </li>
        </ul>`,
      )}
    `;
}

function alertsPage() {
  return `
      ${pageHeader({
        eyebrow: "Components",
        title: "Alerts",
        lead: "Inline notification banner. Extends the surface base, adds a row layout, reads tones like everything else.",
      })}

      ${section(
        "Default",
        `
        ${preview(`
          <div class="alert" style="max-width: 480px">
            <div class="alert-icon">ⓘ</div>
            <div class="alert-content">
              <strong>Heads up</strong>
              <p>Something happened that you might want to know about.</p>
            </div>
          </div>`)}
        ${code(`<div class="alert">
  <div class="alert-icon">ⓘ</div>
  <div class="alert-content">
    <strong>Heads up</strong>
    <p>Something happened that you might want to know about.</p>
  </div>
</div>`)}`,
      )}

      ${section(
        "Tones",
        `
        <p>
          Tone modifiers paint the alert via the shared surface recipe —
          same one cards and toasts use.
        </p>
        ${preview(`
          <div class="stack" style="max-width: 480px">
            <div class="alert info">
              <div class="alert-icon">ⓘ</div>
              <div class="alert-content">
                <strong>FYI</strong>
                <p>Your trial expires in 7 days.</p>
              </div>
            </div>
            <div class="alert success">
              <div class="alert-icon">✓</div>
              <div class="alert-content">
                <strong>Saved</strong>
                <p>Your changes have been published.</p>
              </div>
            </div>
            <div class="alert warning">
              <div class="alert-icon">⚠</div>
              <div class="alert-content">
                <strong>Heads up</strong>
                <p>This site has 3 broken images.</p>
              </div>
            </div>
            <div class="alert danger">
              <div class="alert-icon">⨯</div>
              <div class="alert-content">
                <strong>Error</strong>
                <p>Couldn't connect to the API. Check your credentials.</p>
              </div>
            </div>
          </div>`)}
        ${code(`<div class="alert info">…</div>
<div class="alert success">…</div>
<div class="alert warning">…</div>
<div class="alert danger">…</div>`)}`,
      )}

      ${section(
        "With actions",
        `
        <p>
          Any action triggers (button, link) go in the right side. Just
          flex children — alert is <code>flex items-start gap-3</code> at
          its core.
        </p>
        ${preview(`
          <div class="alert warning" style="max-width: 520px">
            <div class="alert-icon">⚠</div>
            <div class="alert-content">
              <strong>Unsaved changes</strong>
              <p>You have edits that haven't been published.</p>
            </div>
            <div class="cluster" style="align-self: center">
              <button class="btn outlined text-sm">Discard</button>
              <button class="btn text-sm">Publish</button>
            </div>
          </div>`)}`,
      )}

      ${section(
        "Source",
        code(`/* alerts.css — 18 lines */
.alert {
  display:     flex;
  align-items: flex-start;
  gap:         12px;
  padding:     12px 16px;
}
.alert-icon    { flex-shrink: 0; font-size: 16px; }
.alert-content { flex: 1; line-height: 1.5; }
.alert-content > strong { display: block; margin-bottom: 2px; }
.alert-content > p      { margin: 0; }

/* The bg/border/radius/tones all come from surface.css */`),
      )}
    `;
}
function toastsPage() {
  const fires = [
    ["primary", "Brand toast", "Primary"],
    ["info", "Heads up", "Info"],
    ["success", "Saved!", "Success"],
    ["warning", "Watch out", "Warning"],
    ["danger", "Something broke", "Danger"],
  ];

  return `
      ${pageHeader({
        eyebrow: "Components",
        title: "Toasts",
        lead: "Transient feedback. Extends surface, adds fixed positioning and a slide-in animation. Stack multiple via toast-stack.",
      })}

      ${section(
        "Fire one",
        `
        <p>
          Click any tone to fire a real toast (bottom-right). Auto-dismisses
          after 3 seconds.
        </p>
        ${preview(
          `<div class="cluster">
            ${fires
              .map(
                ([tone, label, text]) =>
                  `<button class="btn ${tone}" data-toast="${tone}" data-label="${esc(label)}">${text}</button>`,
              )
              .join("")}
          </div>`,
        )}
        ${code(`<div class="toast success">Saved!</div>`)}`,
      )}

      ${section(
        "Markup",
        `
        <p>
          A toast is just a surface with a fixed position and an animation.
          Fire and forget — or wrap in <code>toast-stack</code> for
          multiple.
        </p>
        ${code(`<!-- Single toast -->
<div class="toast success">Saved!</div>

<!-- Multiple toasts -->
<div class="toast-stack">
  <div class="toast success">Saved 3 items</div>
  <div class="toast info">Sync complete</div>
</div>`)}`,
      )}

      ${section(
        "Source",
        code(`/* toasts.css — 22 lines */
.toast {
  position:   fixed;
  bottom:     1rem;
  right:      1rem;
  min-width:  240px;
  max-width:  360px;
  padding:    12px 16px;
  box-shadow: var(--shadow-lg);
  animation:  toast-in 200ms ease-out;
  z-index:    100;
}
@keyframes toast-in {
  from { opacity: 0; transform: translateY(8px); }
  to   { opacity: 1; transform: translateY(0); }
}

/* Bg/border/radius/tones all come from surface.css */`),
      )}

      <!-- Live render of the actual toasts -->
      <div class="toast-stack" id="sg-toast-stack" hidden></div>
    `;
}

/*
 * The React version kept an array in state and let the renderer diff it.
 * Appending and removing nodes directly is the same thing with the list
 * living in the DOM instead of beside it.
 */
toastsPage.init = function (root) {
  const stack = $("#sg-toast-stack", root);

  root.addEventListener("click", (e) => {
    const trigger = e.target.closest("[data-toast]");
    if (!trigger) return;

    const el = document.createElement("div");
    el.className = `toast ${trigger.dataset.toast}`;
    el.textContent = trigger.dataset.label;
    stack.append(el);
    stack.hidden = false;

    setTimeout(() => {
      el.remove();
      if (!stack.children.length) stack.hidden = true;
    }, 3000);
  });
};

function popoversPage() {
  const pops = [
    {
      id: "a",
      trigger: "Open popover",
      triggerClass: "btn outlined",
      popClass: "popover",
      width: 220,
      title: "Quick note",
      body: `<p style="margin: 0; color: var(--ink-soft)">Popovers carry short, contextual information.</p>`,
    },
    {
      id: "b",
      trigger: "Info popover",
      triggerClass: "btn outlined info",
      popClass: "popover info",
      width: 240,
      title: "Heads up",
      body: `<p style="margin: 0">Tones work the same as everywhere else.</p>`,
    },
    {
      id: "c",
      trigger: "Warning popover",
      triggerClass: "btn outlined warning",
      popClass: "popover warning",
      width: 240,
      title: "Careful",
      body: `<p style="margin: 0">This action will affect 3 records.</p>`,
    },
  ];

  return `
      ${pageHeader({
        eyebrow: "Components",
        title: "Popovers",
        lead: "Floating UI. Extends surface, adds absolute positioning and a slide-in animation. Positioning is the consumer's job — Uno utilities make it easy.",
      })}

      ${section(
        "Default",
        `
        <p>
          Click a button to toggle its popover. The popover positions itself
          via inline style (or Uno utilities like
          <code>${esc(`class="popover absolute top-12 left-0"`)}</code>).
        </p>
        ${preview(
          `<div class="cluster">
            ${pops
              .map(
                (p) => `
            <div style="position: relative">
              <button class="${p.triggerClass}" data-pop="${p.id}">${p.trigger}</button>
              <div class="${p.popClass}" data-pop-panel="${p.id}" hidden
                   style="top: calc(100% + 8px); left: 0; min-width: ${p.width}px">
                <strong style="display: block; margin-bottom: 4px">${p.title}</strong>
                ${p.body}
              </div>
            </div>`,
              )
              .join("")}
          </div>`,
        )}
        ${code(`<div style="position: relative">
  <button class="btn outlined" onclick="show()">Open</button>
  <div class="popover" style="top: 100%; left: 0">
    <strong>Quick note</strong>
    <p>Popovers carry short, contextual info.</p>
  </div>
</div>`)}`,
      )}

      ${section(
        "Native Popover API",
        `
        <p>
          Modern browsers support the native
          <code>[popover]</code> attribute. Free toggle behavior, light
          dismiss, top-layer rendering — all platform-provided.
        </p>
        ${code(`<button popovertarget="menu">Open menu</button>

<div id="menu" popover class="popover">
  <strong>Quick actions</strong>
  <p>Edit, duplicate, archive…</p>
</div>`)}`,
      )}

      ${section(
        "Dropdown menu",
        `
        <p>
          There is no <strong>Menu</strong> term and no <code>.menu</code>
          component, because a menu is three things and only two of them are
          CSS: this popover is the surface, <code>.items.menu</code> is the
          list inside it, and <code>role="menu"</code> plus arrow-key
          movement is owed by whatever opens it.
        </p>
        <p>
          Naming it as a term would promise the keyboard — the same reason
          <a class="link" href="#bar">Bar and Toolbar</a> are two terms
          rather than one with a variant. <code>@frontierjs/ui</code>'s
          <code>DropdownMenu</code> is exactly this composition with the
          behaviour attached.
        </p>
        ${preview(`
          <div style="min-height: 9rem">
            <button class="btn" popovertarget="sg-menu-demo" style="anchor-name: --sg-menu">Actions</button>
            <article class="popover" id="sg-menu-demo" popover
                     style="position-anchor: --sg-menu; top: calc(anchor(bottom) + 4px); left: anchor(left); padding: 0.25rem; min-inline-size: 11rem">
              <ul class="items menu" role="menu">
                <li role="none"><button class="item" role="menuitem" type="button">Rename</button></li>
                <li role="none"><button class="item" role="menuitem" type="button">Duplicate</button></li>
                <li role="none"><button class="item" role="menuitem" type="button" disabled>Move&hellip;</button></li>
              </ul>
            </article>
          </div>`)}
        ${code(`<button class="btn" popovertarget="actions" style="anchor-name: --actions">Actions</button>

<article class="popover" id="actions" popover
         style="position-anchor: --actions;
                top: calc(anchor(bottom) + 4px);
                left: anchor(left)">
  <ul class="items menu" role="menu">
    <li role="none"><button class="item" role="menuitem" type="button">Rename</button></li>
    <li role="none"><button class="item" role="menuitem" type="button">Duplicate</button></li>
  </ul>
</article>`)}
        <p>
          The two <code>anchor</code> properties are not decoration. The
          only positioning utility this package ships is
          <code>.relative</code>, which establishes a containing block, and
          <code>[popover]</code> is in the top layer, where a
          <code>position: relative</code> parent means nothing — so without
          them the menu opens in the corner of the viewport rather than under
          its button. Anchor positioning is the platform's answer and needs
          no JavaScript; a <code>style</code> attribute or your app's own
          layout CSS does just as well.
        </p>
        <div class="alert warning">
          <div class="alert-icon" aria-hidden="true">!</div>
          <div class="alert-content">
            <strong>The control goes inside the row, not on it.</strong>
            <p>
              <code>.items.menu</code> styles a row to look clickable, and an
              <code>&lt;li&gt;</code> is not focusable and takes no keyboard —
              so a hover state on the <code>&lt;li&gt;</code> writes a cheque
              the markup cannot cash. Put a real
              <code>&lt;button&gt;</code> or <code>&lt;a&gt;</code> in the row
              and the package resets it to look like the row rather than like
              a control: no background, no border, inherited type, full width,
              and a dimmed <code>disabled</code> state.
            </p>
          </div>
        </div>
        <p>
          What is still yours: opening and closing (the native
          <code>popover</code> attribute does that much), moving focus with
          the arrow keys, closing on <kbd>Esc</kbd>, and returning focus to
          the trigger. Ship <code>role="menu"</code> without them and the
          menu is harder to use than a plain list of links.
        </p>`,
      )}

      ${section(
        "Source",
        code(`/* popovers.css — 12 lines */
.popover {
  position:   absolute;
  max-width:  280px;
  padding:    10px 12px;
  box-shadow: var(--shadow-md);
  font-size:  var(--text-sm);
  z-index:    50;
  animation:  popover-in 120ms ease-out;
}
@keyframes popover-in {
  from { opacity: 0; transform: translateY(-4px); }
  to   { opacity: 1; transform: translateY(0); }
}

/* Bg/border/radius/tones all come from surface.css */`),
      )}
    `;
}

/* One open at a time, same as the original — `hidden` is the state. */
popoversPage.init = function (root) {
  root.addEventListener("click", (e) => {
    const trigger = e.target.closest("[data-pop]");
    if (!trigger) return;

    const target = $(`[data-pop-panel="${trigger.dataset.pop}"]`, root);
    const wasOpen = !target.hidden;
    $$("[data-pop-panel]", root).forEach((p) => (p.hidden = true));
    target.hidden = wasOpen;
  });
};

function drawersPage() {
  return `
      ${pageHeader({
        eyebrow: "Components",
        title: "Drawers",
        lead: "Off-canvas panel. Built on native &lt;dialog&gt; so focus trap, backdrop, and Esc-to-close are platform-provided. Slides in from any edge.",
      })}

      ${section(
        "Edges",
        `
        <p>
          Add a <code>from-*</code> modifier to control the slide direction.
        </p>
        ${preview(`
          <div class="cluster">
            <button class="btn" data-open="sg-drawer-right">From right</button>
            <button class="btn outlined" data-open="sg-drawer-left">From left</button>
            <button class="btn outlined" data-open="sg-drawer-bottom">From bottom</button>
          </div>`)}
        ${code(`<dialog class="drawer from-right">…</dialog>
<dialog class="drawer from-left">…</dialog>
<dialog class="drawer from-top">…</dialog>
<dialog class="drawer from-bottom">…</dialog>`)}`,
      )}

      ${section(
        "With sub-regions",
        `
        <p>
          Drawers use the same <code>surface-header</code>/
          <code>surface-body</code>/<code>surface-footer</code> as dialogs and
          cards. One vocabulary, every block primitive.
        </p>
        ${code(`<dialog class="drawer from-right">
  <div class="surface-header">
    <strong>Settings</strong>
    <button class="dialog-close" onclick="this.closest('dialog').close()">×</button>
  </div>
  <div class="surface-body">
    <!-- form fields, content, anything -->
  </div>
  <div class="surface-footer">
    <button class="btn outlined" onclick="this.closest('dialog').close()">Cancel</button>
    <button class="btn">Save</button>
  </div>
</dialog>`)}`,
      )}

      ${section(
        "Source",
        code(`/* drawers.css — 50 lines, mostly keyframes */
.drawer {
  margin:        0;
  padding:       0;
  width:         320px;
  max-width:     90vw;
  height:        100vh;
  border-radius: 0;
  box-shadow:    var(--shadow-lg);
}
.drawer.from-right { margin-left: auto;  animation: drawer-slide-from-right  200ms; }
.drawer.from-left  { margin-right: auto; animation: drawer-slide-from-left   200ms; }
.drawer.from-top,
.drawer.from-bottom { width: 100%; max-width: 100%; height: auto; max-height: 80vh; }

/* + keyframes for each direction, ::backdrop, reduced-motion */`),
      )}

      <!-- Real drawers -->
      <dialog id="sg-drawer-right" class="drawer from-right">
        <div class="surface-header">
          <strong>From the right</strong>
          <button class="dialog-close" data-close>×</button>
        </div>
        <div class="surface-body">
          <p>This is a drawer sliding in from the right edge.</p>
          <p>
            Built on <code>&lt;dialog&gt;</code>, so Esc closes it and
            clicking the backdrop closes it too.
          </p>
        </div>
        <div class="surface-footer">
          <button class="btn outlined" data-close>Close</button>
          <button class="btn" data-close>Done</button>
        </div>
      </dialog>

      <dialog id="sg-drawer-left" class="drawer from-left">
        <div class="surface-header">
          <strong>From the left</strong>
          <button class="dialog-close" data-close>×</button>
        </div>
        <div class="surface-body">
          <p>Same component, opposite edge.</p>
        </div>
      </dialog>

      <dialog id="sg-drawer-bottom" class="drawer from-bottom">
        <div class="surface-header">
          <strong>From the bottom</strong>
          <button class="dialog-close" data-close>×</button>
        </div>
        <div class="surface-body">
          <p>Bottom drawers stretch full-width.</p>
          <p>Good for mobile action sheets or quick pickers.</p>
        </div>
      </dialog>
    `;
}

/*
 * `data-open`/`data-close` replace the three refs. Backdrop-to-close is not
 * free on <dialog> — the ::backdrop click lands on the dialog element itself,
 * so the target check is what tells the two apart.
 */
function wireDialogs(root) {
  root.addEventListener("click", (e) => {
    const opener = e.target.closest("[data-open]");
    if (opener) {
      $(`#${opener.dataset.open}`, root)?.showModal();
      return;
    }

    const closer = e.target.closest("[data-close]");
    if (closer) {
      closer.closest("dialog")?.close();
      return;
    }

    if (e.target.matches("dialog")) e.target.close();
  });
}

drawersPage.init = wireDialogs;

function tablesPage() {
  return `
      ${pageHeader({
        eyebrow: "Components",
        title: "Tables",
        lead: "The .table base. Var contract for surfaces, tone modifiers on rows, density variants — same conventions as everything else.",
      })}

      ${section(
        "Default",
        `
        <p>
          Header gets the sunken surface and uppercase label treatment;
          rows inherit the table's background.
        </p>
        ${preview(`
          <table class="table">
            <thead>
              <tr>
                <th>Client</th>
                <th>Plan</th>
                <th>Status</th>
                <th>Renewal</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Maid.Tech</td>
                <td>Pro</td>
                <td><span class="badge success">active</span></td>
                <td>2026-08-12</td>
              </tr>
              <tr>
                <td>Clean Affinity</td>
                <td>Pro</td>
                <td><span class="badge success">active</span></td>
                <td>2026-11-03</td>
              </tr>
              <tr>
                <td>greensweepnm.com</td>
                <td>Starter</td>
                <td><span class="badge warning">trial</span></td>
                <td>2026-06-01</td>
              </tr>
            </tbody>
          </table>`)}
        ${code(`<table class="table">
  <thead>
    <tr><th>Client</th><th>Plan</th><th>Status</th></tr>
  </thead>
  <tbody>
    <tr>
      <td>Maid.Tech</td>
      <td>Pro</td>
      <td><span class="badge success">active</span></td>
    </tr>
  </tbody>
</table>`)}`,
      )}

      ${section(
        "Row states",
        `
        <p>
          Tone modifiers on the <code>&lt;tr&gt;</code> — same vocabulary as
          everywhere else. Derived from <code>--bg-mix</code> so they read as
          tints, not screaming saturation.
        </p>
        ${preview(`
          <table class="table">
            <thead>
              <tr>
                <th>Domain</th>
                <th>Expires</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>maid.tech</td>
                <td>2027-04-18</td>
                <td>OK</td>
              </tr>
              <tr class="success">
                <td>cleanaffinity.com</td>
                <td>2027-02-22</td>
                <td>Renewed</td>
              </tr>
              <tr class="warning">
                <td>greensweepnm.com</td>
                <td>2026-06-01</td>
                <td>Expiring soon</td>
              </tr>
              <tr class="danger">
                <td>oldsite.example</td>
                <td>2026-05-15</td>
                <td>Expired</td>
              </tr>
            </tbody>
          </table>`)}
        ${code(`<tr class="success">...</tr>
<tr class="warning">...</tr>
<tr class="danger">...</tr>`)}`,
      )}

      ${section(
        "Variants",
        `
        <p>
          <code>striped</code> zebras rows; <code>hover</code> highlights on
          mouseover; <code>compact</code> tightens padding for dense data.
          Combinable.
        </p>
        ${preview(`
          <table class="table striped hover compact">
            <thead>
              <tr>
                <th>ID</th>
                <th>Customer</th>
                <th>Amount</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>INV-1042</td>
                <td>Westside Cleaning Co.</td>
                <td>$1,420.00</td>
                <td><span class="badge success">paid</span></td>
              </tr>
              <tr>
                <td>INV-1043</td>
                <td>Sparkle &amp; Co.</td>
                <td>$890.00</td>
                <td><span class="badge warning">pending</span></td>
              </tr>
              <tr>
                <td>INV-1044</td>
                <td>Bright Maid Services</td>
                <td>$2,150.00</td>
                <td><span class="badge success">paid</span></td>
              </tr>
              <tr>
                <td>INV-1045</td>
                <td>FreshClean LLC</td>
                <td>$680.00</td>
                <td><span class="badge danger">overdue</span></td>
              </tr>
            </tbody>
          </table>`)}
        ${code(`<table class="table striped hover compact">...</table>`)}`,
      )}

      ${section(
        "With actions",
        preview(`
          <table class="table hover">
            <thead>
              <tr>
                <th>Name</th>
                <th>Role</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Alex Chen</td>
                <td>Admin</td>
                <td class="table-actions">
                  <button class="btn text-sm outlined">Edit</button>
                  <button class="btn text-sm danger outlined">Remove</button>
                </td>
              </tr>
              <tr>
                <td>Jordan Lee</td>
                <td>Member</td>
                <td class="table-actions">
                  <button class="btn text-sm outlined">Edit</button>
                  <button class="btn text-sm danger outlined">Remove</button>
                </td>
              </tr>
            </tbody>
          </table>`),
      )}

      ${section(
        "Source",
        code(`/* tables.css */
.table {
  --table-bg:       var(--surface);
  --table-border:   var(--rule);
  --table-head-bg:  var(--surface-sunken);

  background: var(--table-bg);
  border: 1px solid var(--table-border);
  border-radius: var(--card-radius);
  overflow: hidden;
}
.table th {
  background: var(--table-head-bg);
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--ink-mute);
}
.table td,
.table th { padding: 10px 14px; text-align: left; }
.table tr + tr td { border-top: 1px solid var(--table-border); }

/* Variants set the row's BASE color, they don't paint the cell.
   Stripe, hover and tone all want a say, and only one of them can own
   the background property — so they're layered instead of ranked. */
.table tbody tr                        { --row-base: var(--table-bg); }
.table.striped tbody tr:nth-child(odd) { --row-base: var(--surface-sunken); }
.table.hover   tbody tr:hover          { --row-base: color-mix(in srgb, var(--ring, var(--color-primary)) 5%, var(--table-bg)); }
.table.compact td,
.table.compact th { padding: 6px 10px; font-size: 13px; }

/* Row tones — no tone names. The tint mixes into whatever the base is,
   so a tone survives a stripe instead of being overwritten by it. On an
   untoned row --bg-mix is guaranteed-invalid, so --row-tint is too and
   the cell falls back to the base. All seven tones work. */
.table tbody tr { --row-tint: color-mix(in srgb, var(--bg-mix) 8%, var(--row-base)); }
.table tbody td { background: var(--row-tint, var(--row-base)); }`),
      )}
    `;
}
function dialogsPage() {
  return `
      ${pageHeader({
        eyebrow: "Components",
        title: "Dialogs",
        lead: "Built on the native &lt;dialog&gt; element — focus trap, escape-to-close, scrollable overlay all handled by the platform. Class only owns the surface treatment.",
      })}

      ${section(
        "Default",
        `
        <p>
          A minimal dialog. Open via <code>showModal()</code>, close via
          <code>close()</code>.
        </p>
        ${preview(`
          <button class="btn" data-open="sg-dialog-default">Open dialog</button>
          <dialog id="sg-dialog-default" class="dialog">
            <div class="surface-body">
              <p>This is a simple modal dialog.</p>
              <p>
                The platform handles focus management, scroll lock, and
                <kbd>Esc</kbd> to close.
              </p>
            </div>
            <div class="surface-footer">
              <button class="btn outlined" data-close>Close</button>
            </div>
          </dialog>`)}
        ${code(`<dialog class="dialog" id="confirm">
  <div class="surface-body">Are you sure?</div>
  <div class="surface-footer">
    <button class="btn outlined" onclick="confirm.close()">Cancel</button>
  </div>
</dialog>

<button onclick="confirm.showModal()">Open</button>`)}`,
      )}

      ${section(
        "With header &amp; footer",
        `
        <p>
          Same sub-component shape as cards — <code>.surface-header</code>,
          <code>.surface-body</code>, <code>.surface-footer</code>.
        </p>
        ${preview(`
          <button class="btn" data-open="sg-dialog-structured">Open structured dialog</button>
          <dialog id="sg-dialog-structured" class="dialog">
            <div class="surface-header">
              <span>Renew domain</span>
              <button class="dialog-close" data-close aria-label="Close">×</button>
            </div>
            <div class="surface-body">
              <p>
                <code>greensweepnm.com</code> expires in 7 days. Pick a
                renewal period.
              </p>
              <div class="field-group" style="margin-top: 12px">
                <label>Renewal period</label>
                <select class="field">
                  <option>1 year</option>
                  <option>2 years</option>
                  <option>5 years</option>
                </select>
              </div>
            </div>
            <div class="surface-footer">
              <button class="btn outlined" data-close>Cancel</button>
              <button class="btn" data-close>Renew</button>
            </div>
          </dialog>`)}`,
      )}

      ${section(
        "Danger confirmation",
        `
        <p>
          <code>.dialog.danger</code> tints the header. Use sparingly — only
          for destructive actions.
        </p>
        ${preview(`
          <button class="btn danger outlined" data-open="sg-dialog-danger">Delete account</button>
          <dialog id="sg-dialog-danger" class="dialog danger">
            <div class="surface-header">
              <span>Delete account?</span>
            </div>
            <div class="surface-body">
              <p>
                This will permanently delete your account and all associated
                data. This action cannot be undone.
              </p>
            </div>
            <div class="surface-footer">
              <button class="btn outlined" data-close>Cancel</button>
              <button class="btn danger" data-close>Delete account</button>
            </div>
          </dialog>`)}`,
      )}

      ${section(
        "Source",
        code(`/* dialogs.css */
.dialog {
  --dialog-bg:     var(--surface-raised);
  --dialog-border: var(--rule);

  background:     var(--dialog-bg);
  color:          var(--ink);
  border:         1px solid var(--dialog-border);
  border-radius:  var(--card-radius);
  box-shadow:     var(--shadow-lg);
  width:          90%;
  max-width:      480px;
  font-family:    var(--font-primary);
}
.dialog::backdrop {
  background:      rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(2px);
}

.surface-header,
.surface-footer { padding: 14px 20px; }

.surface-header {
  border-bottom: 1px solid var(--dialog-border);
  font-weight:   600;
  font-size:     16px;
  display:       flex;
  justify-content: space-between;
  align-items:   center;
}
.surface-body   { padding: 16px 20px; font-size: 14px; line-height: 1.55; }
.surface-footer {
  border-top: 1px solid var(--dialog-border);
  background: var(--surface-sunken);
  display:    flex;
  justify-content: flex-end;
  gap:        8px;
}

/* The dialog opts its body out of the tint, then derives the header's
   colors here — on the element carrying the tone class — and passes
   them down. No tone names, so all seven work. */
.dialog {
  --surface-tint-bg:     initial;
  --surface-tint-border: initial;
  --surface-tint-color:  initial;

  --dialog-header-bg:    color-mix(in srgb, var(--bg-mix) 10%, var(--surface));
  --dialog-header-color: color-mix(in srgb, var(--bg-mix) 55%, var(--ink));
}
.dialog > .surface-header {
  background: var(--dialog-header-bg, transparent);
  color:      var(--dialog-header-color, var(--surface-color));
}`),
      )}

      ${section(
        "Why &lt;dialog&gt;",
        `
        <ul>
          <li>
            <strong>Focus trap is free.</strong> Tab cycles inside the
            dialog only. No focus-trapping library, no manual aria juggling.
          </li>
          <li>
            <strong>Esc closes.</strong> Native behavior — no event listener
            needed.
          </li>
          <li>
            <strong>::backdrop is real.</strong> Style it via CSS, no portal,
            no z-index war.
          </li>
          <li>
            <strong>Stacking just works.</strong> Multiple open dialogs stack
            in the top layer automatically.
          </li>
        </ul>`,
      )}
    `;
}

dialogsPage.init = wireDialogs;

function inputsPage() {
  return `
      ${pageHeader({
        eyebrow: 'Components',
        title: 'Inputs',
        lead: 'One .field base class drives every form control. Tone modifiers and states share the same vocabulary as buttons.'
      })}

      ${section(
        'The field base',
        `
        <p>
          Declares its own var contract: <code>--field-bg</code>,
          <code>--field-border</code>, <code>--field-color</code>,
          <code>--field-radius</code>. Applies to inputs, textareas, and
          selects with the same class.
        </p>
        ${preview(`<input class="field" type="text" placeholder="Type something...">`)}
        ${code(`<input type="text" class="field" placeholder="Type something...">`)}`
      )}

      ${section(
        'Field group',
        `
        <p>
          Label + input paired with consistent spacing.
        </p>
        ${preview(`
          <div class="field-group">
            <label>Email address</label>
            <input class="field" type="email" placeholder="you@example.com">
            <small class="field-hint">We'll never share your email.</small>
          </div>`)}
        ${code(`<div class="field-group">
  <label>Email address</label>
  <input type="email" class="field" placeholder="you@example.com">
  <small class="field-hint">We'll never share your email.</small>
</div>`)}`
      )}

      ${section(
        'Field types',
        preview(`
          <div class="sg-stack">
            <div class="field-group">
              <label>Text</label>
              <input class="field" type="text" value="Hello">
            </div>
            <div class="field-group">
              <label>Select</label>
              <select class="field">
                <option>Maid.Tech</option>
                <option>Clean Affinity</option>
                <option>FrontierJS</option>
              </select>
            </div>
            <div class="field-group">
              <label>Textarea</label>
              <textarea class="field" rows="3">A few lines of text...</textarea>
            </div>
          </div>`)
      )}

      ${section(
        'States',
        `
        <p>
          Same tone vocabulary as buttons. <code>danger</code> indicates
          validation errors. <code>disabled</code> is handled via the
          attribute.
        </p>
        ${preview(`
          <div class="sg-stack">
            <div class="field-group">
              <label>Default</label>
              <input class="field" value="Normal state">
            </div>
            <div class="field-group">
              <label>Disabled</label>
              <input class="field" disabled value="Disabled state">
            </div>
            <div class="field-group">
              <label>Danger (validation error)</label>
              <input class="field danger" value="Invalid value">
              <small class="field-hint danger">This field is required.</small>
            </div>
          </div>`)}
        ${code(`<input type="text" class="field danger" value="Invalid">
<small class="field-hint danger">This field is required.</small>`)}`
      )}

      ${section(
        'Checkbox &amp; radio',
        preview(`
          <div class="sg-stack">
            <label class="field-check">
              <input type="checkbox" checked>
              <span>Send me email updates</span>
            </label>
            <label class="field-check">
              <input type="checkbox">
              <span>Subscribe to newsletter</span>
            </label>
            <hr class="sg-stack-divider">
            <label class="field-check">
              <input type="radio" name="sg-plan" checked>
              <span>Free plan</span>
            </label>
            <label class="field-check">
              <input type="radio" name="sg-plan">
              <span>Pro plan</span>
            </label>
          </div>`)
      )}

      ${section(
        'Source',
        code(`/* form-core.css */
.field {
  --field-bg:     var(--surface);
  --field-border: var(--rule-strong);
  --field-color:  var(--ink);

  background: var(--field-bg);
  color:      var(--field-color);
  border:     1px solid var(--field-border);
}
/* The border adopts the tone; the ring itself lives in focus.css and
   reads the same --bg-mix, so the two can't disagree. */
.field:focus {
  border-color: var(--bg-mix, var(--ring, var(--color-primary)));
}
.field:disabled {
  background: color-mix(in srgb, var(--ink) 4%, var(--surface));
  color:      var(--ink-mute);
  cursor:     not-allowed;
}

/* State tones — no tone names. Any tone class sets --bg-mix, and the
   border reads it with a fallback, so all seven work and adding an
   eighth needs no edit here. */
.field {
  --field-border: var(--bg-mix, var(--rule-strong));
}

/* Native validation drives the tone — the whole implementation. */
.field:user-invalid { --bg-mix: var(--color-danger); }`)
      )}
    `
}

function badgesPage() {
  return `
      ${pageHeader({
        eyebrow: 'Components',
        title: 'Badges & Pills',
        lead: 'Two small surfaces that both extend chip. Pills carry counts and short data. Badges carry categorical status.'
      })}

      ${section(
        'Pill — counts &amp; micro-data',
        `
        <p>
          Rounded ends, small fill, short content. Built for numbers and
          single-character indicators.
        </p>
        ${preview(`
          <div class="cluster">
            <span class="pill">0</span>
            <span class="pill primary">12</span>
            <span class="pill info">i</span>
            <span class="pill success">3</span>
            <span class="pill warning">!</span>
            <span class="pill danger">99+</span>
          </div>`)}
        ${code(`<span class="pill primary">12</span>
<span class="pill danger">99+</span>
<span class="pill warning">!</span>`)}`
      )}

      ${section(
        'Pill inside button',
        `
        <p>
          The most common use — counts inside a button or nav item.
        </p>
        ${preview(`
          <div class="cluster">
            <button class="btn">
              Notifications <span class="pill danger">3</span>
            </button>
            <button class="btn outlined">
              Inbox <span class="pill primary">12</span>
            </button>
            <button class="btn muted">
              Drafts <span class="pill">2</span>
            </button>
          </div>`)}
        ${code(`<button class="btn">
  Notifications <span class="pill danger">3</span>
</button>`)}`
      )}

      ${section(
        'Badge — categorical status',
        `
        <p>
          Uppercase, tracked, square corners. Reads as a label, not a count.
        </p>
        ${preview(`
          <div class="cluster">
            <span class="badge">muted</span>
            <span class="badge primary">beta</span>
            <span class="badge info">info</span>
            <span class="badge success">active</span>
            <span class="badge warning">pending</span>
            <span class="badge danger">archived</span>
          </div>`)}
        ${code(`<span class="badge success">active</span>
<span class="badge warning">pending</span>
<span class="badge danger">archived</span>`)}`
      )}

      ${section(
        'Inline with text',
        `
        <p>
          Both compose into running prose. Use sparingly — one signal per
          sentence keeps the eye honest.
        </p>
        ${preview(`
          <div class="sg-stack sg-prose-preview">
            <p>
              The site <span class="badge success">live</span> launched yesterday.
            </p>
            <p>
              Update available <span class="pill info">v2</span> — released last week.
            </p>
            <p>
              Domain expires in <span class="badge danger">7 days</span>
            </p>
          </div>`)}`
      )}

      ${section(
        'When to use which',
        `
        <ul>
          <li>
            <strong>Pill</strong> — counts and very short data ("12", "99+", "v2"). Rounded shape reads as "a value".
          </li>
          <li>
            <strong>Badge</strong> — categorical status ("active", "pending", "archived"). Square + uppercase reads as "a label".
          </li>
        </ul>`
      )}

      ${section(
        'What these words mean elsewhere',
        `
        <div class="alert warning">
          <div class="alert-icon" aria-hidden="true">&#9888;</div>
          <div class="alert-content">
            <strong>Read this before you reach for muscle memory.</strong>
            <p>
              Both distinctions above are real and every large system draws
              them — but almost nobody agrees on which word goes where, and
              <code>badge</code> is the word they disagree about. It means
              <em>the count</em> in more systems than it means
              <em>the status</em>. Here, it is the status.
            </p>
          </div>
        </div>
        <table class="table striped compact">
          <thead>
            <tr>
              <th style="width: 26%">System</th>
              <th>The count ("12", "99+")</th>
              <th>The status ("active")</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><strong>FrontierJS</strong></td>
              <td><code>pill</code></td>
              <td><code>badge</code></td>
            </tr>
            <tr>
              <td>Atlassian</td>
              <td>Badge</td>
              <td>Lozenge</td>
            </tr>
            <tr>
              <td>Material 3</td>
              <td>Badge</td>
              <td>Chip</td>
            </tr>
            <tr>
              <td>Primer (GitHub)</td>
              <td>Counter label</td>
              <td>Label</td>
            </tr>
            <tr>
              <td>Polaris (Shopify)</td>
              <td>&mdash;</td>
              <td>Badge <span class="text-muted">(Tag = a removable keyword)</span></td>
            </tr>
            <tr>
              <td>Bootstrap</td>
              <td colspan="2">
                Badge for both. <code>rounded-pill</code> is a
                <em>shape</em>, not a component.
              </td>
            </tr>
          </tbody>
        </table>
        <p>
          Two consequences worth carrying. <strong>A reader arriving from
          Atlassian or Material will read <code>badge</code> as a number</strong>
          — so when a badge holds a count in your markup, nothing complains and
          it looks fine, and the vocabulary has quietly stopped meaning
          anything. And <strong><code>pill</code> is a shape word almost
          everywhere else</strong> (Bootstrap's <code>rounded-pill</code>,
          Uno's <code>rounded-full</code>), so it reads as a modifier rather
          than a thing.
        </p>
        <p>
          Kept anyway, deliberately, on
          <strong>2026-08-08</strong> — see <code>DECISIONS.md</code>. The pair
          is internally consistent, both words are short, and the shape carries
          the meaning: a rounded end reads as a value, a square uppercase box
          reads as a label. Renaming would break every app in the repo to buy
          agreement with an industry that does not agree with itself.
        </p>`
      )}
    `
}
/* ══════════════════════════════════════════════════════════════════════
   3. Pages — Utilities
   ══════════════════════════════════════════════════════════════════════ */

/*
 * The declarations a selector actually ships, read from the live CSSOM.
 *
 * The Layouts page used to quote layout.css by hand, and the copy rotted the
 * moment the four rules started reading --space-* instead of literal rems:
 * the page showed `gap: 1rem` for a rule that no longer says it, and nothing
 * rendered wrong. A page that documents source has to read the source.
 */
/*
 * The rule a selector authored, or null. One walk, shared — ruleText()
 * prints it and other pages read one declaration out of it, and a second
 * copy of the walk would be a second answer to "which sheet counts".
 */
function findRule(selector) {
  let found = null
  const walk = (rules) => {
    for (const r of rules) {
      if (r.selectorText === selector && r.style && r.style.length) found = r
      if (r.cssRules) walk(r.cssRules)
      if (r.styleSheet && r.styleSheet.cssRules) walk(r.styleSheet.cssRules)
    }
  }
  for (const sheet of document.styleSheets) {
    if (!sheet.href || !/\/src\//.test(sheet.href)) continue
    try { walk(sheet.cssRules) } catch (e) { return null }
  }
  return found
}

/*
 * What the package's own stylesheets say a custom property is.
 *
 * Looked up BY PROPERTY, optionally narrowed by selector — because the
 * CSSOM does not hand back the selector that was authored. `*, *::before,
 * *::after` is serialised as `*, ::before, ::after`: the redundant `*` is
 * dropped, so an exact match on the written string finds nothing while the
 * rule sits right there. That is what made the tint ramp read as absent
 * and the swatches it feeds render as nothing at all.
 *
 * `getPropertyValue` is exact here in a way it is not for `gap`: a custom
 * property is never a shorthand, so there is nothing for the CSSOM to
 * expand into empty longhands.
 */
function tokenValue(prop, selector) {
  let value = null
  const walk = (rules) => {
    for (const r of rules) {
      if (r.style && r.selectorText && (!selector || r.selectorText === selector)) {
        const v = r.style.getPropertyValue(prop)
        /* Last one wins, which is what the cascade would say too. */
        if (v) value = v.trim()
      }
      if (r.cssRules) walk(r.cssRules)
      if (r.styleSheet && r.styleSheet.cssRules) walk(r.styleSheet.cssRules)
    }
  }
  for (const sheet of document.styleSheets) {
    if (!sheet.href || !/\/src\//.test(sheet.href)) continue
    try { walk(sheet.cssRules) } catch (e) { return null }
  }
  return value
}

function ruleText(selector) {
  const found = findRule(selector)
  if (!found) return null

  /*
   * The AUTHORED declarations, out of cssText — never by iterating
   * rule.style. That expands `gap: var(--space-sm)` into row-gap and
   * column-gap and then answers "" for both, because a shorthand carrying a
   * var() cannot be split until it resolves. The first version of this
   * printed `row-gap: ;` and looked like a broken stylesheet.
   */
  const decls = declarationsOf(found)
  if (!decls.length) return null

  const width = Math.max(...decls.map((d) => d.name.length))
  const body = decls
    .map((d) => '  ' + (d.name + ':').padEnd(width + 2) + ' ' + d.value + ';')
    .join('\n')
  return selector + ' {\n' + body + '\n}'
}

/* One parse of a rule's authored declaration block, shared by everything on
   this page that has to read the stylesheet rather than remember it. */
function declarationsOf(rule) {
  const text = rule.cssText || ''
  const open = text.indexOf('{')
  const close = text.lastIndexOf('}')
  if (open < 0 || close < 0) return []

  return text
    .slice(open + 1, close)
    .split(';')
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => {
      const at = d.indexOf(':')
      return at < 0 ? null : { name: d.slice(0, at).trim(), value: d.slice(at + 1).trim() }
    })
    .filter(Boolean)
}

function layoutsPage() {
  return `
      ${pageHeader({
        eyebrow: 'Utilities',
        title: 'Layouts',
        lead: 'Four primitive layout classes. Stack, cluster, center, split. Cover most of what most apps need.'
      })}

      ${section(
        'Stack — vertical rhythm',
        `
        <p>
          <code>stack</code> is <code>display: flex</code>, column,
          <code>gap: 1rem</code>. Children flow down with even spacing.
        </p>
        <div class="alert warning">
          <div class="alert-icon" aria-hidden="true">&#9888;</div>
          <div class="alert-content">
            <strong>The gap is a property, not a class.</strong>
            <p>
              This page used to say "override it inline with
              <code>stack gap-2</code>". The package ships no
              <code>gap-*</code> class — that example only rendered because
              <code>guide.css</code> defines <code>.gap-2</code> for its own
              chrome, which is the guide demonstrating itself while claiming
              to demonstrate the system. Set <code>gap</code> in your own
              rule, or bring UnoCSS and use its utility knowing it is Uno's.
            </p>
          </div>
        </div>
        ${preview(`
          <div class="stack" style="min-width: 280px">
            <div class="card">First card</div>
            <div class="card">Second card</div>
            <div class="card">Third card</div>
          </div>`)}
        ${code(`<div class="stack">
  <div class="card">First card</div>
  <div class="card">Second card</div>
  <div class="card">Third card</div>
</div>

<!-- A tighter stack: your rule, unlayered, so it wins -->
<style>.toolbar-stack { gap: 0.5rem }</style>
<div class="stack toolbar-stack">…</div>`)}`
      )}

      ${section(
        'Cluster — horizontal flow',
        `
        <p>
          <code>cluster</code> is <code>display: flex</code> with
          <code>flex-wrap</code>, centred items and <code>gap: 0.5rem</code>.
          Children line up horizontally, wrap when they run out of room, stay
          baseline-centered. Use it for filter chips, tag rows, button groups,
          form actions.
        </p>
        ${preview(`
          <div class="cluster">
            <span class="badge primary">Active</span>
            <span class="badge success">Verified</span>
            <span class="badge warning">Pending</span>
            <span class="badge danger">Flagged</span>
            <span class="badge muted">Archived</span>
          </div>`)}
        ${code(`<div class="cluster">
  <span class="badge primary">Active</span>
  <span class="badge success">Verified</span>
  <span class="badge warning">Pending</span>
  <span class="badge danger">Flagged</span>
  <span class="badge muted">Archived</span>
</div>`)}`
      )}

      ${section(
        'Center — perfect centering',
        `
        <p>
          <code>center</code> is <code>display: grid</code> with
          <code>place-items: center</code>. One line, no flex gymnastics.
          The child sits dead center in both axes.
        </p>
        ${preview(`
          <div class="center" style="height: 140px; border: 1px dashed var(--rule-strong); border-radius: 8px; background: var(--surface-sunken)">
            <button class="btn">Centered</button>
          </div>`)}
        ${code(`<!-- .center owns the centring; the box size is yours.
     There is no h-36 in this package — that is Uno's. -->
<div class="center" style="height: 9rem">
  <button class="btn">Centered</button>
</div>`)}`
      )}

      ${section(
        'Split — space between',
        `
        <p>
          <code>split</code> is <code>display: flex</code> with
          <code>justify-content: space-between</code>, centred items and
          <code>gap: 1rem</code>. Two-up rows
          where the first child sits left, the rest pushes right. Built for
          headers and toolbars.
        </p>
        ${preview(`
          <div class="split" style="padding: 12px 16px; border: 1px solid var(--rule); border-radius: 8px; background: var(--surface); min-width: 360px">
            <strong>Inbox</strong>
            <div class="cluster">
              <button class="btn outlined text-sm">Archive</button>
              <button class="btn text-sm">Compose</button>
            </div>
          </div>`)}
        ${code(`<header class="split p-3 border rounded">
  <strong>Inbox</strong>
  <div class="cluster">
    <button class="btn outlined text-sm">Archive</button>
    <button class="btn text-sm">Compose</button>
  </div>
</header>`)}`
      )}

      ${section(
        'When to use each',
        `
        <table class="table">
          <thead>
            <tr><th>Use case</th><th>Reach for</th></tr>
          </thead>
          <tbody>
            <tr><td>Form fields, list items, cards stacked</td><td><code>stack</code></td></tr>
            <tr><td>Tags, chips, button groups, filter rows</td><td><code>cluster</code></td></tr>
            <tr><td>Page header with title + actions</td><td><code>split</code></td></tr>
            <tr><td>Modal centered on screen, empty states</td><td><code>center</code></td></tr>
            <tr><td>Grids with N columns</td><td>Uno's <code>grid grid-cols-N</code></td></tr>
            <tr><td>Anything else</td><td>Compose Uno utilities directly</td></tr>
          </tbody>
        </table>`
      )}

      ${section(
        'The four rules, in full',
        `
        ${code(
          ['/* layout.css — read from the live stylesheet, not copied */']
            .concat(['.stack', '.cluster', '.center', '.split'].map(ruleText).filter(Boolean))
            .join('\n\n')
        )}
        <p>
          Four rules. Two flex columns, one flex row, one grid. Together
          they cover ~80% of the layout work in a typical app. The
          remaining 20% is a rule of your own — unlayered CSS beats every
          layer here, so it needs no <code>!important</code> — or an atomic
          utility from UnoCSS if you are running it.
        </p>`
      )}
    `
}

/* ══════════════════════════════════════════════════════════════════════
   How things behave — ownership, order, and what makes the width
   ══════════════════════════════════════════════════════════════════════ */

/*
 * Counted at render time, because it is the only number on this page that
 * could quietly stop being true. The claim is that the parent owns the
 * space between children; the evidence is that the package almost never
 * writes a margin.
 */
function spaceOwnership() {
  let gaps = 0
  let bleeds = 0
  let margins = 0

  const walk = (rules) => {
    for (const r of rules) {
      if (r.style && r.style.length) {
        for (const d of declarationsOf(r)) {
          if (/^(gap|row-gap|column-gap)$/.test(d.name)) { gaps++; continue }
          if (!/^margin(-|$)/.test(d.name)) continue

          /*
           * 0 and auto are not spacing decisions, and a 1px pull is a border
           * correction — tabs.css lifting a tab onto the rule it sits on.
           */
          if (/^(0(px)?|auto)(\s|$)/.test(d.value) || /^-?1px$/.test(d.value)) continue

          /* A negative margin is the documented exception, not a violation:
             it pulls a child OUT of its parent's padding — a card header
             bleeding to the edge, an avatar overlapping the one before it.
             Counting it with the rest would hide the number that matters. */
          if (/(^-)|\*\s*-1/.test(d.value)) bleeds++
          else margins++
        }
      }
      if (r.cssRules) walk(r.cssRules)
      if (r.styleSheet && r.styleSheet.cssRules) walk(r.styleSheet.cssRules)
    }
  }

  for (const sheet of document.styleSheets) {
    if (!sheet.href || !/\/src\//.test(sheet.href)) continue
    try { walk(sheet.cssRules) } catch (e) { return null }
  }
  return { gaps, bleeds, margins }
}

function behaviourPage() {
  const own = spaceOwnership()

  return `
      ${pageHeader({
        eyebrow: 'Utilities',
        title: 'How things behave',
        lead:
          'The vocabulary tells you what to call a thing. This is the part it ' +
          'cannot tell you: who owns the space around it, what order to decide ' +
          'things in, and what is actually making the width.'
      })}

      ${section(
        'The parent owns the space between',
        `
        <p>
          <strong>Padding is breathing room inside a box. The space between
          two boxes belongs to their parent.</strong> A child never carries a
          margin to push its siblings away, because a child cannot know what
          it will sit next to.
        </p>
        ${own ? `<p>
          This is not advice, it is what the package does. Counted from the
          live stylesheet as this page rendered: <strong>${own.gaps} gap
          declarations</strong>, <strong>${own.bleeds} negative margins</strong>
          — the documented exception, a child pulling out of its parent's
          padding — and <strong>${own.margins} ordinary margins</strong> left
          over. Those last ones are the honest count of places this rule is
          not followed yet.
        </p>` : ''}
        ${code(`<!-- the parent decides -->
<div class="stack">      <!-- gap: var(--space-2xl) -->
  <div class="card">…</div>
  <div class="card">…</div>
</div>

<!-- not this -->
<div class="card" style="margin-bottom: 1rem">…</div>`)}
        <p>
          Three things fall out of it, and they are the reason it is a rule
          rather than a preference.
        </p>
        <dl class="facts divided">
          <dt>No first-child, last-child gymnastics</dt>
          <dd>
            A margin on every child puts one at the start and one at the end
            that nobody asked for, so you then write
            <code>:last-child { margin: 0 }</code>. <code>gap</code> only
            exists <em>between</em>, so there is nothing to undo.
          </dd>
          <dt>No margin collapsing</dt>
          <dd>
            Adjacent vertical margins merge into one, and which one wins
            depends on the larger of the two and on whether anything is
            between them. It is the single most surprising rule in CSS. This
            package never meets it, because <code>gap</code> does not
            collapse.
          </dd>
          <dt>The component stays portable</dt>
          <dd>
            A Card with <code>margin-bottom</code> is a Card that has decided
            what comes after it. Move it into a Cluster and it is wrong. The
            same Card with only padding fits anywhere, and the container it
            lands in decides the rhythm.
          </dd>
        </dl>`
      )}

      ${section(
        'When the rhythm is not the default one',
        `
        <p>
          A <code>stack</code> gaps at <code>--space-2xl</code>, which is the
          distance between sections of a page. Three lines of one label are
          not three sections. <strong>The gap utilities are the rung
          override</strong> — one class on the parent, the same ladder,
          nothing moved onto the child.
        </p>
        ${code(`<span class="stack gap-3xs">   <!-- three lines of one label -->
  <span class="text-2xs">Foundation</span>
  <span class="text-sm text-muted">Move on to</span>
  <span class="text-2xl">Density &amp; space</span>
</span>`)}
        <p>
          <code>gap-0</code> through <code>gap-6xl</code>, one per rung
          — <code>${RUNGS.map(([n]) => 'gap-' + n).join('</code>, <code>')}</code>.
          They sit in the <code>utilities</code> layer, so one beats whatever
          the component underneath it set without a longer selector and
          without <code>!important</code>.
        </p>
        <p>
          The alternative is a one-off rule beside the component, and the
          reason not to write one is not tidiness. A rung is multiplied by
          <code>--density</code>; a literal <code>gap: 4px</code> in a bespoke
          rule is not, so it stays put while everything around it moves and
          the region misaligns at exactly the point someone writes
          <code>dense</code>.
        </p>
        <p>
          <strong>There is no matching padding or margin utility, and that is
          the rule above rather than an omission.</strong> Padding is the
          child's own business and it is decided in the component; a margin
          utility would put the space between two things onto one of them,
          which is the thing this page opens by refusing.
        </p>
        <p>
          The one other utility in that layer is
          <code>relative</code>, and it is the same distinction read from the
          other side. It establishes a containing block so an absolutely
          positioned child has something to be positioned against — a copy
          button over a code block, a badge on an avatar — and it places
          nothing itself. There is no <code>absolute</code>, no
          <code>top-0</code>, no inset ladder, because where the child goes is
          a layout the component should own. It also does not reach a native
          <code>[popover]</code>: the top layer escapes every positioning
          context, which is what the Popover page is about.
        </p>
        ${code(`<div class="relative">
  <pre class="code">…</pre>
  <button class="btn outlined" style="position: absolute; inset-block-start: 8px; inset-inline-end: 8px">Copy</button>
</div>`)}`
      )}

      ${section(
        'The order you decide things in',
        `
        <p>
          There is an order, and taking it out of order is where most of the
          nudging and re-nudging comes from.
        </p>
        <ol class="steps vertical" aria-label="The order to decide spacing in">
          <li class="step complete">
            <span class="step-marker"></span>
            <span class="step-label">Style the padding first, out of context</span>
            <span class="step-hint">How much room does this need inside itself to be readable? Answer that with the thing on its own, knowing nothing about where it will go.</span>
          </li>
          <li class="step complete">
            <span class="step-marker"></span>
            <span class="step-label">Then put it in context and decide the gap</span>
            <span class="step-hint">Now it has neighbours. How far apart should they be? A different question, a different answer, and it belongs to the parent.</span>
          </li>
          <li class="step complete">
            <span class="step-marker"></span>
            <span class="step-label">Only then reach for an exception</span>
            <span class="step-hint">A negative margin bleeding a header to the card edge, an overlap on an avatar stack. Exceptions are real; they are just not step one.</span>
          </li>
        </ol>
        <p>
          The split is also why <a href="#density">density</a> works at all.
          Padding belongs to the child and gap belongs to the parent, but both
          read the same ladder — so one number moves both, and the proportion
          between them survives.
        </p>`
      )}

      ${section(
        'Does the child shape the parent, or the parent constrain the child?',
        `
        <p>
          The usual advice is <em>flex for one dimension, grid for two</em>,
          which is true and hard to apply. This question is easier and it
          predicts more:
        </p>
        <dl class="facts divided">
          <dt>The child shapes the parent → <strong>flex</strong></dt>
          <dd>
            Each child decides how wide it is and the row takes its shape from
            them. Sizes come from content — a longer label makes a wider chip.
            <code>cluster</code> and <code>split</code> are this.
          </dd>
          <dt>The parent constrains the child → <strong>grid</strong></dt>
          <dd>
            The container decides the tracks and children fit what they are
            given. Sizes come from the track, which is what keeps alignment
            across rows. <code>tiles</code> and <code>facts</code> are this.
          </dd>
        </dl>
        <p>
          It is also the whole explanation for the one real trap in
          <a href="#density">derived density</a>.
          <code>container-type: inline-size</code> means precisely
          <em>this box no longer takes its shape from its children</em> — so
          it breaks the first of those two and leaves the second alone.
        </p>
        <div class="alert warning">
          <div class="alert-icon" aria-hidden="true">!</div>
          <div class="alert-content">
            <strong>Measured, not predicted.</strong>
            <p>
              A <code>card</code> inside a <code>cluster</code> went from
              <strong>83px to 42px</strong> — the width of its own padding —
              the moment it was made a container. In an auto-sized grid
              track, the same. In a fixed grid track, nothing changed. The
              question above told us in advance which of the three would
              break.
            </p>
          </div>
        </div>`
      )}

      ${section(
        'What is making the width?',
        `
        <p>
          When a layout is wrong the instinct is to set a width somewhere.
          The better move is to ask the diagnostic question first:
          <strong>if you deleted all the whitespace, what is the longest row,
          and why is it that long?</strong>
        </p>
        <p>
          It is almost always one piece of text that cannot wrap, or one box
          holding a minimum. Find it and fix it there, and the widths you
          were about to set become unnecessary.
        </p>
        <div class="table-wrap">
          <table class="table compact striped">
            <thead><tr><th>The thing making it wide</th><th>What to reach for</th></tr></thead>
            <tbody>
              <tr><td>A line of prose running too long to read</td><td><code>max-inline-size: 42ch</code> — a measure, not a pixel width</td></tr>
              <tr><td>An unbreakable string — an id, a URL, a token</td><td><code>overflow-wrap: anywhere</code>, or truncate it</td></tr>
              <tr><td>A table with more columns than the viewport</td><td><code>table-wrap</code> — the scroll belongs to a wrapper, a table cannot scroll itself</td></tr>
              <tr><td>A control that should grow with its content</td><td>Let it. Shrink-to-fit is the default and it is usually right</td></tr>
              <tr><td>Genuinely needing a limit</td><td><code>clamp()</code> — a floor, a preference and a ceiling in one value</td></tr>
            </tbody>
          </table>
        </div>
        <p>
          The package holds to this itself: the widest thing it declares is a
          <em>measure</em> in <code>ch</code> on empty-state copy, not a
          pixel width on a container.
        </p>`
      )}

      ${section(
        'When a wrapper div is justified',
        `
        <p>
          Naming components is easy. Naming the <code>div</code>s around them
          is the part nobody enjoys, and the reason is usually that the
          <code>div</code> should not exist.
        </p>
        <p>
          The test: <strong>is there definition around this block — a
          background, a border, or a shadow?</strong>
        </p>
        <dl class="facts divided">
          <dt>Yes — it is a surface</dt>
          <dd>
            It has an edge, so it is a thing. <code>card</code>,
            <code>alert</code>, <code>dialog</code>, <code>popover</code>.
            Give it a term.
          </dd>
          <dt>No, it only arranges things</dt>
          <dd>
            Then it is a Layout, and Layout terms are already named for you:
            <code>stack</code>, <code>cluster</code>, <code>center</code>,
            <code>split</code>. Nothing new to invent.
          </dd>
          <dt>No, and it holds a list of one kind of thing</dt>
          <dd>
            Then it is the plural of that thing, which is the naming rule the
            package uses throughout: <code>items</code> holds
            <code>item</code>, <code>rows</code> holds <code>row</code>,
            <code>tiles</code> holds <code>tile</code>,
            <code>avatars</code> holds <code>avatar</code>.
          </dd>
        </dl>
        <p>
          If none of the three fit, the wrapper is probably grouping things
          that are not a group. That is worth a second look at the markup
          before it is worth a name.
        </p>`
      )}

      ${section(
        'Where the numbers live',
        `
        <p>
          This page is about who decides. The values themselves are one
          ladder, multiplied by one number, on
          <a href="#density">Density &amp; space</a>. There are no
          <code>p-*</code>, <code>m-*</code> or <code>gap-*</code> classes to
          learn — components read the ladder, and if you want atomic spacing
          utilities on top, that is UnoCSS's job and it is supported
          alongside.
        </p>`
      )}`
}

function typographyPage() {
  /*
   * The five steps the package actually ships, in utilities.css. This table
   * used to list eight Tailwind-shaped tokens (text-base, text-2xl … up to
   * text-4xl) at Tailwind's pixel values — a leftover from the UnoCSS era.
   * Five of the eight had no rule behind them at all.
   */
  const typeScale = [
    {
      token: 'text-xs',
      va: '--text-xs',
      size: 12,
      rem: '0.75rem',
      usage: 'Fine print, captions'
    },
    {
      token: 'text-sm',
      va: '--text-sm',
      size: 13,
      rem: '0.8125rem',
      usage: 'Meta lines, dense UI'
    },
    {
      token: 'text-md',
      va: '--text-md',
      size: 14,
      rem: '0.875rem',
      usage: 'Body — the package default'
    },
    { token: 'text-lg', va: '--text-lg', size: 16, rem: '1rem', usage: 'Lead paragraph' },
    { token: 'text-xl', va: '--text-xl', size: 18, rem: '1.125rem', usage: 'Subhead' }
  ]

  /*
   * The rungs above the five classes. They exist as tokens because the
   * headings read them, but deliberately have no `.text-*` class: anything
   * louder than xl is a heading and should say so with an <h*>.
   */
  const headingRungs = [
    {
      va: '--text-2xs',
      rem: '0.6875rem',
      size: 11,
      usage: 'Uppercase overline — table head, nav group label'
    },
    { va: '--text-2xl', rem: '1.375rem', size: 22, usage: 'h3, dialog title' },
    { va: '--text-3xl', rem: '1.75rem', size: 28, usage: 'h2, tile figure' },
    { va: '--text-4xl', rem: '2.25rem', size: 36, usage: 'h1' }
  ]

  const weights = [
    { token: "font-normal", value: 400, label: "Regular" },
    { token: "font-medium", value: 500, label: "Medium" },
    { token: "font-semibold", value: 600, label: "Semibold" },
    { token: "font-bold", value: 700, label: "Bold" },
  ];

  const colors = [
    { token: "text-body", value: "var(--ink)", note: "Default" },
    { token: "text-muted", value: "var(--ink-mute)", note: "De-emphasized" },
    { token: "text-primary", value: "var(--color-primary)", note: "Brand" },
    { token: "text-info", value: "var(--color-info)", note: "Informational" },
    { token: "text-success", value: "var(--color-success)", note: "Confirm" },
    { token: "text-warning", value: "var(--color-warning)", note: "Caution" },
    { token: "text-danger", value: "var(--color-danger)", note: "Error" },
  ];

  return `
      ${pageHeader({
        eyebrow: 'Utilities',
        title: 'Typography',
        lead: 'Type scale, weights, line-height, tracking, color. Everything else inherits from these.'
      })}

      ${section(
        'Type scale',
        `
        <p>
          Five steps, deliberately shallow. <code>text-md</code> is the
          package's own body size, so the useful range is two down and two up.
          Anything louder than <code>text-xl</code> is a heading and should say
          so with an <code>&lt;h*&gt;</code>.
        </p>
        <div class="sg-typescale">
          ${typeScale
            .map(
              (t) => `
          <div class="sg-typescale-row">
            <code class="sg-typescale-token">${t.token}</code>
            <div class="sg-typescale-sample ${t.token}">
              The quick brown fox
            </div>
            <code class="sg-typescale-meta">${t.va} · ${t.rem} · ${t.size}px · ${t.usage}</code>
          </div>`
            )
            .join('')}
        </div>
        <p>
          The samples above carry the real class, not an inline
          <code>font-size</code> — so if the utility stops working, this page
          shows it.
        </p>
        <p>
          Every size in the package reads a <code>--text-*</code> token; there
          are no literal <code>font-size</code> numbers in the components. Set
          one in a theme and everything wearing that rung moves together —
          <code>.text-xl</code> and an <code>&lt;h4&gt;</code> are one number in
          one place, not two that happen to agree.
        </p>
        <table class="table striped compact">
          <thead>
            <tr>
              <th style="width: 22%">Token</th>
              <th style="width: 26%">Default</th>
              <th>Used by</th>
            </tr>
          </thead>
          <tbody>
            ${headingRungs
              .map(
                (r) => `
            <tr>
              <td><code>${r.va}</code></td>
              <td><code>${r.rem}</code> · ${r.size}px</td>
              <td>${r.usage}</td>
            </tr>`
              )
              .join('')}
          </tbody>
        </table>
        <p>
          These four rungs have no <code>.text-*</code> class on purpose. They
          are what the headings are made of, and reaching for one directly
          means you wanted a heading.
        </p>`
      )}

      ${section(
        'Font weight',
        `
        <p>
          Four weights cover everything. Heavier than bold reads as visual
          noise; lighter than regular fails on low-contrast displays.
        </p>
        <div class="sg-weights">
          ${weights
            .map(
              (w) => `
          <div class="sg-weight-row">
            <code class="sg-weight-token">${w.token}</code>
            <div class="sg-weight-sample" style="font-weight: ${w.value}">
              ${w.label} — ${w.value}
            </div>
          </div>`
            )
            .join('')}
        </div>`
      )}

      ${section(
        'Text color',
        `
        <p>
          Semantic tokens, never raw hex. The same tone vocabulary as buttons
          and badges — set once on <code>:root</code>, used everywhere.
        </p>
        <div class="sg-color-grid">
          ${colors
            .map(
              (c) => `
          <div class="sg-color-row">
            <code class="sg-color-token">${c.token}</code>
            <span class="sg-color-sample" style="color: ${c.value}">
              The quick brown fox
            </span>
            <code class="sg-color-note">${c.note}</code>
          </div>`
            )
            .join('')}
        </div>
        ${code(`/* typography.css */
.text-body    { color: var(--ink); }
.text-muted   { color: var(--ink-mute); }
.text-primary { color: var(--color-primary); }
.text-info    { color: var(--color-info); }
.text-success { color: var(--color-success); }
.text-warning { color: var(--color-warning); }
.text-danger  { color: var(--color-danger); }`)}`
      )}

      ${section(
        'Line height &amp; tracking',
        `
        <p>
          Four leading steps and three tracking steps — <strong>from UnoCSS,
          not from this package</strong>. See the note below the samples. Use
          them sparingly; most text is fine at default.
        </p>
        ${code(`/* leading */
leading-tight   /* 1.2  */
leading-snug    /* 1.4  */
leading-normal  /* 1.6  */
leading-loose   /* 1.8  */

/* tracking */
tracking-tight  /* -0.02em — display headings */
tracking-normal /* 0       — default */
tracking-wide   /* 0.05em  — uppercase labels, badges */`)}`
      )}

      ${section(
        'Alignment, leading and tracking are not shipped',
        `
        <p>
          The three code samples above are Uno's, not the package's. There is no
          <code>.text-center</code>, <code>.leading-snug</code> or
          <code>.tracking-wide</code> rule in any file here — they were Uno
          shortcuts through v0.5 and were not replaced when the config was
          deleted. The package ships size and colour only.
        </p>
        <p>
          Bring Uno for the rest (see <strong>Install</strong>), or write the two
          declarations. Documenting a class the package does not define is the
          exact failure this guide exists to prevent.
        </p>`
      )}

      ${section(
        'Rule of thumb',
        `
        <ul>
          <li>
            <strong>One scale only.</strong> No inline <code>font-size: 17px</code>. If
            17px is needed, the scale is wrong.
          </li>
          <li>
            <strong>Weight carries hierarchy more than size.</strong> A bold
            14px label often beats a regular 18px one.
          </li>
          <li>
            <strong>Color encodes meaning, not flavor.</strong> Reserve red
            for errors, green for confirmations. Don't tint copy for
            decoration.
          </li>
        </ul>`
      )}
    `
}
/* ══════════════════════════════════════════════════════════════════════
   3. Pages — Reference
   ══════════════════════════════════════════════════════════════════════ */

function cheatSheetPage() {
  /*
   * Each base, and what its own file declares. A cheat sheet is the page
   * read without checking, so a stale line here is worse than no line —
   * these must be the real declarations, never a utility-class shorthand.
   */
  /*
   * The two lineages, and what each member adds on top of its base.
   *
   * `adds` is what this class contributes ITSELF — the base is not repeated
   * into the sentence, because the base is the structure of the page now
   * rather than the first word of a description. The old data read
   * "chip + pill radius, --text-xs, tone fill", which put the single most
   * important fact about a class inside prose, where it scanned as text.
   *
   * MEMBERSHIP IS NOT LISTED HERE. It is read from the `:where()` groups in
   * chip.css and surface.css at render time by lineageMembers() below,
   * because a hand-written list is a second copy of the one fact this page
   * exists to teach — and it had already drifted: the page showed 13 of the
   * 16 real members and silently omitted pagination-link, tooltip, avatar,
   * step-marker and tile. A class added to a `:where()` list now appears
   * here by construction, and one removed disappears.
   */
  const BASE_NOTES = {
    chip: 'inline-flex, centred, gap 0.375rem, no wrap — structure only',
    surface: 'background, border, --card-radius, the tonal tint recipe',

    /* chip lineage */
    btn: '--text-md, cursor, transition, shadow-sm, tone fill',
    pill: 'pill radius, --text-xs, tone fill',
    badge: 'btn radius, --text-xs, uppercase, tone fill',
    'pagination-link': 'one control in a pager — square-ish, current is a solid fill',
    tooltip: 'the attached bubble — absolute, --text-xs, dark fill',
    avatar: 'fixed square, --avatar-size, initials centred, circle by default',
    'step-marker': 'numbered circle — counts itself from its position when empty',

    /* surface lineage */
    card: 'padding 1.25rem (and bleeds its own header/footer)',
    tile: 'a compact metric — label, value at display size, delta',
    alert: 'flex row, items start, gap 12px, padding 12/16',
    toast: 'fixed bottom-right, shadow-lg, z 100',
    popover: 'absolute, max 280px, --text-sm, shadow-md, z 50',
    drawer: 'fixed inset, 320px wide, full height, no padding',
    dialog: '90%/480px, no padding, shadow-lg — a native <dialog>'
  }

  /* The file that declares each class, for the "one owner" column. */
  const BASE_FILES = {
    chip: 'chip.css', btn: 'buttons.css', pill: 'pills.css', badge: 'badges.css',
    'pagination-link': 'nav.css', tooltip: 'tooltips.css', avatar: 'avatar.css',
    'step-marker': 'steps.css',
    surface: 'surface.css', card: 'cards.css', tile: 'tiles.css', alert: 'alerts.css',
    toast: 'toasts.css', popover: 'popovers.css', drawer: 'drawers.css',
    dialog: 'dialogs.css'
  }

  /* How to draw one. Anything not named here gets its own class on a span. */
  const BASE_PREVIEW = {
    chip: `<span class="chip">chip</span>`,
    btn: `<button class="btn">btn</button>`,
    pill: `<span class="pill primary">pill</span>`,
    badge: `<span class="badge success">badge</span>`,
    'pagination-link': `<span class="pagination-link" aria-current="page">1</span>`,
    tooltip: `<span class="tooltip" role="tooltip">tip</span>`,
    avatar: `<span class="avatar primary" aria-hidden="true">DO</span>`,
    'step-marker': `<span class="step-marker"></span>`,
    surface: `<span class="sg-cheat-mini-card">surface</span>`,
    card: `<span class="sg-cheat-mini-card">card</span>`,
    tile: `<span class="sg-cheat-mini-card">tile</span>`,
    alert: `<span class="sg-cheat-mini-card">alert</span>`,
    toast: `<span class="sg-cheat-mini-card">toast</span>`,
    popover: `<span class="sg-cheat-mini-card">popover</span>`,
    drawer: `<span class="sg-cheat-mini-dialog">drawer</span>`,
    dialog: `<span class="sg-cheat-mini-dialog">dialog</span>`
  }

  /*
   * Membership, read from the stylesheet that declares it.
   *
   * chip.css and surface.css each open with a single `:where(...)` naming
   * every composite in that lineage — the one place the fact is stated, and
   * the reason adding a lineage member is one edit. Parsing it back out is
   * what keeps this page honest: it cannot claim a member the CSS does not
   * have, and it cannot miss one the CSS gained.
   */
  function lineageMembers(base) {
    let names = []
    const walk = (rules) => {
      for (const r of rules) {
        const sel = r.selectorText || ''
        /*
         * The lineage rule is the one whose WHOLE selector is a single
         * `:where(...)` opening with the base itself. Anchoring on that
         * excludes `dialog:where(.dialog, .drawer, .surface):not([open])`
         * in surface.css — the closed-<dialog> guard, which lists a subset
         * and would silently shorten the block lineage to three.
         */
        const m = sel.match(/^:where\(([^)]*)\)$/)
        if (m) {
          const list = m[1].split(',').map((s) => s.trim().replace(/^\./, ''))
          if (list[0] === base) names = list
        }
        if (r.cssRules) walk(r.cssRules)
        /* An imported sheet is a separate CSSStyleSheet on the rule, not a
           nested rule list. index.css is 44 imports and almost nothing
           else, so a walk without this branch sees 45 rules and finds
           neither lineage. */
        if (r.styleSheet && r.styleSheet.cssRules) walk(r.styleSheet.cssRules)
      }
    }
    for (const sheet of document.styleSheets) {
      if (!sheet.href || !/\/src\//.test(sheet.href)) continue
      try { walk(sheet.cssRules) } catch (e) { return names }
    }
    return names
  }

  const sizes = [
    ['text-xs', 'XS'],
    ['text-sm', 'Small'],
    ['text-md', 'Body'],
    ['text-lg', 'Large'],
    ['text-xl', 'XL']
  ]

  const varGroups = [
    [
      'Global tokens',
      [
        '--color-primary',
        '--color-secondary',
        '--color-muted',
        '--color-info',
        '--color-success',
        '--color-warning',
        '--color-danger'
      ]
    ],
    [
      'Surfaces &amp; ink',
      [
        '--surface',
        '--surface-raised',
        '--surface-sunken',
        '--ink',
        '--ink-soft',
        '--ink-mute',
        '--rule',
        '--rule-strong'
      ]
    ],
    [
      'Focus &amp; shadows',
      [
        '--ring',
        '--ring-color',
        '--ring-width',
        '--ring-offset',
        '--shadow-sm',
        '--shadow-md',
        '--shadow-lg'
      ]
    ],
    [
      'btn contract',
      ['--btn-radius', '--btn-font-weight', '--btn-text-transform', '--btn-letter-spacing']
    ],
    [
      'pill / badge',
      [
        '--pill-font-weight',
        '--pill-text-transform',
        '--pill-letter-spacing',
        '--badge-font-weight',
        '--badge-text-transform',
        '--badge-letter-spacing'
      ]
    ],
    [
      'surface contract',
      ['--surface-bg', '--surface-color', '--surface-border', '--card-radius']
    ],
    ['field contract', ['--field-bg', '--field-color', '--field-border', '--field-radius']],
    ['table contract', ['--table-bg', '--table-border', '--table-head-bg']],
    ['dialog contract', ['--dialog-bg', '--dialog-border']],
    ['typography', ['--font-primary', '--font-display', '--font-mono']],
    [
      'type scale (one ladder — utilities AND h1–h6)',
      [
        '--text-2xs',
        '--text-xs',
        '--text-sm',
        '--text-md',
        '--text-lg',
        '--text-xl',
        '--text-2xl',
        '--text-3xl',
        '--text-4xl'
      ]
    ],
    [
      'line height (unitless)',
      [
        '--leading-display',
        '--leading-heading',
        '--leading-snug',
        '--leading-normal',
        '--leading-body',
        '--leading-relaxed'
      ]
    ],
    ['tones (set by .primary, .info, …)', ['--bg-mix', '--on-bg-mix']],
    /*
     * This row said "tonal mixing (lighten/darken)" and listed --bg and
     * --color as the derived tokens. Both were Uno-era leftovers that NO
     * rule in the package ever read — the Tonal page has said so since v0.6
     * while the cheat sheet went on naming them. These are the variables the
     * derivation actually produces.
     */
    [
      'tonal mixing — chip lineage (color-mix, no lighten/darken)',
      ['--tone-fill (requested)', '--fill (capped, painted)', '--on-fill (auto-contrast)']
    ],
    [
      'tint ramp (tones.css — the ONE place the percentages live)',
      [
        '--tint-surface (10% into --surface)',
        '--tint-rule (30% into --rule)',
        '--tint-ink (55% into --ink)'
      ]
    ],
    [
      'tonal mixing — surface lineage (reads the ramp)',
      ['--surface-tint-bg', '--surface-tint-border', '--surface-tint-color']
    ]
  ]

  const lightSteps = [80, 60, 40, 20]
  const darkSteps = [20, 40, 60, 80]

  return `
      ${pageHeader({
        eyebrow: 'Reference',
        title: 'Cheat sheet',
        lead: 'Every base, tone, variant, and size on one page. Grep-able, bookmark-able.'
      })}

      ${section(
        'Bases',
        `
        <p>
          Two bases, and every other class here is one of them plus a little
          more. <code>chip</code> is the inline lineage, <code>surface</code>
          the block one — the base gives layout and the tone machinery, and
          the class on top adds only what makes it itself.
        </p>
        <p class="sg-cheat-source">
          Membership is read from the <code>:where()</code> group in
          <code>chip.css</code> and <code>surface.css</code> when this page
          renders, so it is the stylesheet's answer rather than a list kept
          beside it.
        </p>
        ${['chip', 'surface']
          .map((base) => {
            const members = lineageMembers(base).filter((n) => n !== base)
            return `
        <div class="sg-basis">
          <div class="sg-basis-base">
            <div class="split gap-sm sg-basis-head">
              <code class="sg-cheat-name">.${base}</code>
              <span class="sg-basis-tag">${
                base === 'chip' ? 'inline lineage' : 'block lineage'
              }</span>
            </div>
            <div class="sg-cheat-base-preview">${BASE_PREVIEW[base]}</div>
            <code class="sg-cheat-shortcut">${esc(BASE_NOTES[base])}</code>
            <code class="sg-cheat-file">${BASE_FILES[base]}</code>
          </div>

          <ul class="sg-basis-members">
            ${members
              .map(
                (name) => `
            <li class="sg-basis-member">
              <div class="sg-cheat-base-preview">${
                BASE_PREVIEW[name] || `<span class="${name}">${name}</span>`
              }</div>
              <div class="item-text gap-2xs sg-cheat-base-meta">
                <code class="sg-cheat-name"><span class="sg-basis-inherit">.${base}</span> + .${name}</code>
                <code class="sg-cheat-shortcut">${esc(
                  BASE_NOTES[name] || 'declared in ' + (BASE_FILES[name] || 'the stylesheet')
                )}</code>
                <code class="sg-cheat-file">${BASE_FILES[name] || '—'}</code>
              </div>
            </li>`
              )
              .join('')}
          </ul>
        </div>`
          })
          .join('')}

        <p class="sg-cheat-note">
          <code>field</code> and <code>table</code> are deliberately absent:
          neither is in either lineage. A form control carries its own
          <code>--field-*</code> contract and a table is its own box model,
          so they answer to no base — which is exactly why they used to look
          out of place in this list.
        </p>`
      )}

      ${section(
        'Tones',
        `
        <p>
          Set the var contract. Composable with any base.
        </p>
        <div class="sg-cheat-tones">
          ${SEMANTIC_COLORS.map(([token, value]) => {
            const name = token.replace('--color-', '')
            return `
          <div class="sg-cheat-tone">
            <span class="sg-cheat-swatch" style="background: ${value}"></span>
            <code class="sg-cheat-name">.${name}</code>
            <code class="sg-cheat-token">${token}</code>
            <code class="sg-cheat-val">${value}</code>
          </div>`
          }).join('')}
        </div>`
      )}

      ${section(
        'Button matrix',
        `
        <p>
          Every tone × every variant. The system holds because tones only set
          vars and variants only read them.
        </p>
        <div class="tile sg-cheat-matrix">
          <div class="sg-matrix-head">
            <div></div>
            <div>filled</div>
            <div>outlined</div>
          </div>
          <div class="sg-matrix-row">
            <div class="sg-matrix-label"><code>btn</code></div>
            <div><button class="btn">Button</button></div>
            <div><button class="btn outlined">Button</button></div>
          </div>
          ${TONES.map(
            ([cls, label]) => `
          <div class="sg-matrix-row">
            <div class="sg-matrix-label"><code>${cls}</code></div>
            <div><button class="btn ${cls}">${label}</button></div>
            <div><button class="btn ${cls} outlined">${label}</button></div>
          </div>`
          ).join('')}
          <div class="sg-matrix-row">
            <div class="sg-matrix-label"><code>link</code></div>
            <div><button class="btn link">Link button</button></div>
            <div>—</div>
          </div>
        </div>`
      )}

      ${section(
        'Table matrix',
        `
        <p>
          Variants stack — <code>striped hover compact</code> all on one
          table. Tone modifiers go on the <code>&lt;tr&gt;</code>.
        </p>
        <table class="table striped hover compact">
          <thead>
            <tr><th>Variant / state</th><th>Class</th></tr>
          </thead>
          <tbody>
            <tr><td>Default</td><td><code>table</code></td></tr>
            <tr><td>Striped</td><td><code>table striped</code></td></tr>
            <tr><td>Hover highlight</td><td><code>table hover</code></td></tr>
            <tr><td>Compact density</td><td><code>table compact</code></td></tr>
            <tr class="info"><td>Info row</td><td><code>tr.info</code></td></tr>
            <tr class="success"><td>Success row</td><td><code>tr.success</code></td></tr>
            <tr class="warning"><td>Warning row</td><td><code>tr.warning</code></td></tr>
            <tr class="danger"><td>Danger row</td><td><code>tr.danger</code></td></tr>
          </tbody>
        </table>`
      )}

      ${section(
        'Dialog',
        `
        <p>
          Native <code>&lt;dialog&gt;</code>. Open with <code>showModal()</code>,
          close with <code>close()</code>. Sub-components mirror cards.
        </p>
        <div class="sg-cheat-card-row">
          <div class="card sg-cheat-card">
            <strong>.dialog</strong>
            <p class="sg-card-text">native modal</p>
          </div>
          <div class="card sg-cheat-card">
            <strong>.surface-header</strong>
            <p class="sg-card-text">title + close</p>
          </div>
          <div class="card sg-cheat-card">
            <strong>.surface-body</strong>
            <p class="sg-card-text">content</p>
          </div>
          <div class="card sg-cheat-card">
            <strong>.surface-footer</strong>
            <p class="sg-card-text">actions</p>
          </div>
        </div>
        <p>
          Tones tint the header. Same vocabulary —
          <code>.dialog.danger</code>, <code>.dialog.success</code>, etc.
        </p>`
      )}

      ${section(
        'Sizes',
        `
        <p>
          Scale rides the type scale. <code>em</code> padding tracks
          <code> font-size</code>.
        </p>
        <div class="sg-cheat-sizes">
          ${sizes
            .map(([cls, label]) => `<button class="btn ${cls}">${label}</button>`)
            .join('')}
        </div>`
      )}

      ${section(
        'Card matrix',
        `
        <p>
          Variants flip the surface treatment; tones derive bg/border/text
          from <code>--bg-mix</code>.
        </p>
        <div class="sg-cheat-card-row">
          <div class="card sg-cheat-card">
            <strong>default</strong>
            <p class="sg-card-text">border + fill</p>
          </div>
          <div class="card raised sg-cheat-card">
            <strong>raised</strong>
            <p class="sg-card-text">shadow, no border</p>
          </div>
          <div class="card outlined sg-cheat-card">
            <strong>outlined</strong>
            <p class="sg-card-text">stronger border</p>
          </div>
          <div class="card ghost sg-cheat-card">
            <strong>ghost</strong>
            <p class="sg-card-text">no surface</p>
          </div>
        </div>
        <div class="sg-cheat-card-row">
          <div class="card info sg-cheat-card">
            <strong>info</strong>
            <p class="sg-card-text">informational</p>
          </div>
          <div class="card success sg-cheat-card">
            <strong>success</strong>
            <p class="sg-card-text">confirmation</p>
          </div>
          <div class="card warning sg-cheat-card">
            <strong>warning</strong>
            <p class="sg-card-text">caution</p>
          </div>
          <div class="card danger sg-cheat-card">
            <strong>danger</strong>
            <p class="sg-card-text">error</p>
          </div>
        </div>`
      )}

      ${section(
        'Field states',
        `
        <p>
          Same tone vocabulary as buttons. Disabled via attribute.
        </p>
        <div class="sg-stack">
          <div class="field-group">
            <label>Default</label>
            <input class="field" value="Normal">
          </div>
          <div class="field-group">
            <label>Disabled</label>
            <input class="field" disabled value="Disabled">
          </div>
          <div class="field-group">
            <label>Danger</label>
            <input class="field danger" value="Invalid">
            <small class="field-hint danger">Required field</small>
          </div>
        </div>`
      )}

      ${section(
        'Tonal scale',
        `
        <p>
          Any shade derives from <code>--bg-mix</code> with
          <code>color-mix()</code>. (The old <code>.lighten-N</code> /
          <code>.darken-N</code> classes were removed in v0.6 — they wrote
          variables nothing read.)
        </p>
        <div class="sg-cheat-tonal-strip" style="--sg-ramp: var(--color-primary); --color: var(--ink)">
          ${lightSteps
            .map(
              (n) =>
                `<div class="tonal" style="background: color-mix(in srgb, var(--sg-ramp) ${n}%, white); color: var(--ink)">${n}</div>`
            )
            .join('')}
          <div class="tonal sg-tonal-raw">raw</div>
          ${darkSteps
            .map(
              (n) =>
                `<div class="tonal" style="background: color-mix(in srgb, var(--sg-ramp) ${n}%, black); color: white">−${n}</div>`
            )
            .join('')}
        </div>`
      )}

      ${section(
        'Themes',
        `
        <p>
          Each theme is a class that re-binds the global tokens. Wrap any
          subtree.
        </p>
        <div class="tiles gap-xs sg-cheat-themes">
          ${Object.entries(THEMES)
            .map(
              ([key, t]) => `
          <div class="sg-cheat-theme">
            <span class="sg-cheat-theme-swatch" style="background: ${
              t.tokens['--color-primary'] || 'var(--color-primary)'
            }"></span>
            <code class="sg-cheat-name">.theme-${key}</code>
            <span class="sg-cheat-theme-desc">${t.description}</span>
          </div>`
            )
            .join('')}
        </div>`
      )}

      ${section(
        'Status indicators',
        `
        <p>
          Same tone vocabulary, smaller surfaces.
        </p>
        <div class="sg-cheat-row sg-cheat-row-inline">
          <span class="badge">muted</span>
          <span class="badge primary">primary</span>
          <span class="badge info">info</span>
          <span class="badge success">success</span>
          <span class="badge warning">warning</span>
          <span class="badge danger">danger</span>
        </div>
        <div class="sg-cheat-row sg-cheat-row-inline">
          <span class="pill">0</span>
          <span class="pill primary">12</span>
          <span class="pill info">i</span>
          <span class="pill success">3</span>
          <span class="pill warning">!</span>
          <span class="pill danger">99+</span>
        </div>`
      )}

      ${section(
        'CSS variables',
        `
        <div class="tiles gap-lg sg-cheat-vars">
          ${varGroups
            .map(
              ([title, vars]) => `
          <div class="sg-cheat-var-group">
            <div class="sg-cheat-var-title">${title}</div>
            ${vars.map((v) => `<code class="sg-cheat-var">${v}</code>`).join('')}
          </div>`
            )
            .join('')}
        </div>`
      )}

      ${section(
        'Common patterns',
        code(`<!-- Buttons -->
<button class="btn">Save</button>
<button class="btn outlined">Cancel</button>
<button class="btn danger">Delete</button>
<button class="btn danger outlined">Discard</button>
<button class="btn link">Forgot password?</button>
<button class="btn text-lg">Big call to action</button>

<!-- Status -->
<span class="badge success">Active</span>
<span class="badge warning">Pending</span>
<span class="pill danger">99+</span>
<button class="btn">
  Notifications <span class="pill danger">3</span>
</button>

<!-- Cards -->
<div class="card">Default surface</div>
<div class="card raised">Floating surface</div>
<div class="card danger">Error notice</div>
<div class="card">
  <div class="surface-header">Title</div>
  <div class="surface-body">Body content...</div>
  <div class="surface-footer">
    <button class="btn">Action</button>
  </div>
</div>

<!-- Form -->
<div class="field-group">
  <label>Email</label>
  <input type="email" class="field">
  <small class="field-hint">We won't share it.</small>
</div>
<input type="text" class="field danger" value="Invalid">

<!-- Table -->
<table class="table striped hover">
  <thead>
    <tr><th>Name</th><th>Status</th></tr>
  </thead>
  <tbody>
    <tr class="success"><td>Maid.Tech</td><td>Active</td></tr>
    <tr class="warning"><td>greensweepnm.com</td><td>Trial</td></tr>
  </tbody>
</table>

<!-- Dialog -->
<dialog class="dialog" id="confirm">
  <div class="surface-header">
    <span>Confirm action</span>
    <button class="dialog-close" onclick="confirm.close()">×</button>
  </div>
  <div class="surface-body">Are you sure?</div>
  <div class="surface-footer">
    <button class="btn outlined" onclick="confirm.close()">Cancel</button>
    <button class="btn">Confirm</button>
  </div>
</dialog>
<button onclick="confirm.showModal()">Open dialog</button>

<!-- Tones: one class, everything else derived -->
<article class="card danger">Tinted surface</article>
<button class="btn danger">Solid fill, contrast-safe text</button>

<!-- Theme scoping -->
<body class="theme-default">
  <header class="theme-sunset">
    <button class="btn">Sunset button</button>
  </header>
</body>`)
      )}

      ${classIndexSection()}
    `
}

/* ── The class index ───────────────────────────────────────────────── */

/*
 * Every class the package ships, out of the live CSSOM, with what kind of
 * class it is and which file declares it.
 *
 * Read rather than listed for the obvious reason — a written list of 166
 * names is stale the first time anyone adds a rule, and stale invisibly,
 * because a missing row looks like a class that does not exist. The kinds
 * come from `vocabulary.js`: VOCAB names the terms, ANATOMY names the parts
 * and who owns them, NOT_ANATOMY and NOT_A_TERM are the two registers of
 * "this is deliberately something else, here is what".
 *
 * The walk also collects, per class, the OTHER classes that appear in the
 * same compound selector and the properties its rules set. That is what
 * lets a modifier's row say *only on .table, sets background* rather than
 * repeating the definition of the word "modifier" twenty-three times — the
 * badge beside it already said that.
 *
 * A class that lands in `unclassified` is a real finding, not a display
 * gap: `vocabulary.spec.js` and `anatomy.spec.js` between them refuse to
 * let one exist, so the row appearing means a test is about to go red.
 */
function shippedClasses() {
  const seen = {}

  const entry = (name) =>
    seen[name] ||
    (seen[name] = { name, files: [], rules: 0, scopes: new Set(), props: new Map() })

  /*
   * The compound a class sits in — `.table.striped tbody tr` splits on the
   * combinators, and `.striped`'s compound is `.table.striped`. The other
   * classes in it are what the modifier requires to do anything, which is
   * the one fact its row could not otherwise state.
   */
  const compounds = (selector) => selector.split(/\s*[\s>+~]\s*/).filter(Boolean)

  const walk = (rules, file) => {
    for (const r of rules) {
      if (r.selectorText) {
        const decls = r.style ? declarationsOf(r) : []

        r.selectorText.split(',').forEach((sel) => {
          compounds(sel).forEach((part) => {
            const classes = (part.match(/\.[a-zA-Z][a-zA-Z0-9_-]*/g) || []).map((c) => c.slice(1))
            classes.forEach((name) => {
              const e = entry(name)
              e.rules++
              if (file && e.files.indexOf(file) === -1) e.files.push(file)
              classes.forEach((other) => other !== name && e.scopes.add(other))
              /* Custom properties are the interesting half for a treatment
                 — `.raised` sets --shadow, not box-shadow directly. */
              decls.forEach((d) => e.props.has(d.name) || e.props.set(d.name, d.value))
            })
          })
        })
      }
      if (r.cssRules) walk(r.cssRules, file)
      if (r.styleSheet && r.styleSheet.cssRules) {
        walk(r.styleSheet.cssRules, (r.styleSheet.href || file).split('/').slice(-2).join('/'))
      }
    }
  }

  for (const sheet of document.styleSheets) {
    if (!sheet.href || !/\/src\//.test(sheet.href)) continue
    try { walk(sheet.cssRules, sheet.href.split('/').slice(-2).join('/')) } catch (e) { /* opaque sheet */ }
  }

  return Object.values(seen)
    .map((e) => ({ ...e, scopes: [...e.scopes], props: [...e.props.entries()] }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/*
 * A readable run of properties.
 *
 * With one or two declarations the VALUE is shown as well, because that is
 * usually the whole answer — `.narrow` and `.wide` both "set max-width",
 * and the number is the only thing that distinguishes them.
 *
 * No `+N` remainder. A rule is attributed to every class its selector
 * mentions, so `.items` collects what `.items.menu .item` sets; a count
 * would read as complete when the attribution is deliberately loose.
 */
function propSummary(props) {
  const pick = props
    .filter(([n]) => n !== 'content')
    .sort((a, b) => a[0].startsWith('--') - b[0].startsWith('--') || a[0].localeCompare(b[0]))
  if (!pick.length) return ''

  if (pick.length <= 2) {
    return 'sets ' + pick
      .map(([n, v]) => `<code>${esc(n)}: ${esc(v.length > 26 ? v.slice(0, 24) + '…' : v)}</code>`)
      .join(', ')
  }
  return 'sets ' + pick.slice(0, 3).map(([n]) => `<code>${esc(n)}</code>`).join(', ')
}

/*
 * Measured, not stated: every density class's own multiplier, and what that
 * works out to as a percentage. `.dense` saying "the density axis" told a
 * reader nothing they had not read in the badge; "compacts every rung by
 * 20%" is the thing they wanted to know.
 */
function densityFacts(names) {
  return withProbe(
    names.map((n) => `<i class="${n}" style="display:block"></i>`).join(''),
    (probe) => {
      const out = {}
      names.forEach((n, i) => {
        const d = parseFloat(getComputedStyle(probe.children[i]).getPropertyValue('--density'))
        out[n] = { d, pct: Math.round(Math.abs(1 - d) * 100) }
      })
      return out
    }
  )
}

/*
 * Each theme's own primary, measured by applying the class to a probe.
 *
 * Four of the eight override the same NUMBER of tokens, which is true and
 * useless — they differ in which values, not how many. The colour is the
 * thing they actually are.
 */
function themeFacts(names) {
  return withProbe(
    names.map((n) => `<i class="${n}" style="display:block"></i>`).join(''),
    (probe) => {
      const out = {}
      names.forEach((n, i) => {
        out[n] = getComputedStyle(probe.children[i]).getPropertyValue('--color-primary').trim()
      })
      return out
    }
  )
}

/* Same idea for the heading classes: the size, in pixels, here. */
function headingFacts(names) {
  return withProbe(
    names.map((n) => `<span class="${n}">x</span>`).join(''),
    (probe) => {
      const out = {}
      names.forEach((n, i) => {
        out[n] = Math.round(parseFloat(getComputedStyle(probe.children[i]).fontSize) * 10) / 10
      })
      return out
    }
  )
}

/*
 * The term a container holds. `.items` holds Item, `.rows` holds Row — and
 * Row is why this cannot just strip the `s` and look up a class: Row's own
 * class is `.list-row`, so the singular has to be matched against the term
 * NAME as well.
 */
function containerHolds(name) {
  const singular = name.replace(/s$/, '')
  for (const [, , rows] of VOCAB) {
    for (const row of rows) {
      if (vocabClass(row) === singular || row[0].toLowerCase() === singular) return row[0]
    }
  }
  return null
}

/* What kind of class this is, and one line that is true of THIS class. */
function classifyClass(c, extra) {
  const name = c.name

  for (const [tier, , rows] of VOCAB) {
    for (const row of rows) {
      if (vocabClass(row) === name) {
        return { kind: 'term', note: `${esc(row[0])} — ${tier} tier, <code>${esc(row[1])}</code>` }
      }
    }
  }

  for (const term of Object.keys(ANATOMY)) {
    const part = (ANATOMY[term].parts || []).find((p) => p[0] === '.' + name)
    if (part) return { kind: 'anatomy', note: `part of <strong>${esc(term)}</strong> — ${esc(part[1])}` }
  }

  /*
   * Four families whose NOT_ANATOMY reason is true of all of them at once —
   * "a theme", "a size utility". True is not the same as useful: the badge
   * has already said the kind, so the column has to say what THIS one does.
   */
  const dir = name.match(/^from-(top|right|bottom|left)$/)
  if (dir) {
    return { kind: 'not a part', note: `a Drawer that slides in from the <strong>${dir[1]}</strong>` }
  }

  const theme = name.match(/^theme-(.+)$/)
  if (theme) {
    const primary = extra.theme[name]
    return {
      kind: 'theme',
      note:
        (primary ? `<span class="sg-class-swatch" style="background: ${esc(primary)}"></span>` : '') +
        `a theme — <code>--color-primary: ${esc(primary || '—')}</code>, ` +
        `overrides <strong>${c.props.length}</strong> tokens`
    }
  }

  const text = name.match(/^text-(.+)$/)
  if (text) {
    const px = extra.text[name]
    return {
      kind: 'utility',
      note: px
        ? `the <code>--text-${esc(text[1])}</code> rung — ${px}px here`
        : `<span class="sg-class-swatch ${esc(name)}"></span> sets <code>color</code> to <code>--color-${esc(text[1])}</code>`
    }
  }



  for (const kind of Object.keys(NOT_A_TERM)) {
    if (NOT_A_TERM[kind].indexOf(name) === -1) continue

    if (kind === 'tone') {
      return {
        kind,
        note: `<span class="sg-class-swatch ${esc(name)}"></span> sets <code>--bg-mix</code> to <code>--color-${esc(name)}</code>`
      }
    }

    if (kind === 'density') {
      const f = extra.density[name]
      if (!f) return { kind, note: '' }
      const dir = f.d < 1 ? 'tightens' : 'loosens'
      return {
        kind,
        note: `<code>--density: ${f.d}</code> — ${dir} every space rung by ${f.pct}%, and it inherits`
      }
    }

    if (kind === 'container') {
      const held = containerHolds(name)
      return {
        kind,
        note: held
          ? `holds <strong>${esc(held)}</strong> — ${propSummary(c.props) || 'layout only'}`
          : propSummary(c.props)
      }
    }

    if (kind === 'heading') {
      const px = extra.heading[name]
      return {
        kind,
        note: `the <code>&lt;${esc(name)}&gt;</code> size — ${px}px here — without the outline level`
      }
    }

    if (kind === 'treatment') {
      return { kind, note: `composes onto anything — ${propSummary(c.props) || 'no declarations of its own'}` }
    }

    if (kind === 'modifier') {
      const on = c.scopes.filter((s) => !NOT_A_TERM.modifier.includes(s) && !NOT_A_TERM.tone.includes(s))
      return {
        kind,
        note:
          (on.length ? `only on ${on.slice(0, 3).map((s) => `<code>.${esc(s)}</code>`).join(', ')} — ` : '') +
          (propSummary(c.props) || 'no declarations of its own')
      }
    }

    if (kind === 'anatomy') {
      /* A part with no hyphen, so the ANATOMY lookup above missed it. */
      for (const term of Object.keys(ANATOMY)) {
        const part = (ANATOMY[term].parts || []).find((p) => p[0] === '.' + name)
        if (part) return { kind, note: `part of <strong>${esc(term)}</strong> — ${esc(part[1])}` }
      }
      return { kind, note: propSummary(c.props) }
    }

    return { kind, note: propSummary(c.props) }
  }


  /*
   * The a11y layer, identified by where it ships rather than by name — so a
   * third class added to a11y/ arrives in this group without anyone
   * remembering to list it, the same reason the table is read out of the
   * CSSOM at all.
   *
   * It runs AFTER the NOT_A_TERM loop on purpose. `.focusable` ships in
   * a11y/a11y.css and is registered there as a scoped modifier, and the
   * register is the decision record: a display rule that quietly overruled
   * it would make the guide and the suite disagree about what a class is,
   * with nothing to say which was right.
   */
  if (c.files.length && c.files.every((f) => f.indexOf('a11y/') === 0)) {
    return { kind: 'a11y', note: esc(NOT_ANATOMY[name] || '') || propSummary(c.props) }
  }

  if (NOT_ANATOMY[name]) return { kind: 'not a part', note: esc(NOT_ANATOMY[name]) }

  return { kind: 'unclassified', note: 'nothing names this — <code>vocabulary.spec.js</code> will fail' }
}

/* The badge tone for each kind. Terms are the vocabulary, so they lead. */
const CLASS_KIND_TONE = {
  term: 'primary',
  anatomy: 'info',
  tone: 'success',
  treatment: 'success',
  density: 'success',
  modifier: 'warning',
  container: '',
  heading: '',
  utility: 'info',
  theme: '',
  a11y: 'success',
  'not a part': 'muted',
  unclassified: 'danger'
}

function classIndexSection() {
  /* Measured once for the whole table rather than per row — each call
     appends a probe to the document and reads it back. */
  const extra = {
    density: densityFacts(NOT_A_TERM.density),
    heading: headingFacts(NOT_A_TERM.heading),
    text: headingFacts(Object.keys(NOT_ANATOMY).filter((n) => /^text-(2xs|xs|sm|md|lg|xl|\d?xl)$/.test(n))),
    theme: themeFacts(Object.keys(NOT_ANATOMY).filter((n) => n.indexOf('theme-') === 0))
  }
  const classes = shippedClasses().map((c) => ({ ...c, ...classifyClass(c, extra) }))
  const kinds = classes.reduce((n, c) => ((n[c.kind] = (n[c.kind] || 0) + 1), n), {})

  const rows = classes
    .map(
      (c) => `
      <tr data-kind="${esc(c.kind)}"
          data-class="${esc(c.name)} ${esc(c.kind)} ${esc(stripTags(c.note))} ${esc(c.files.join(' '))}">
        <td><code>.${esc(c.name)}</code></td>
        <td><span class="badge ${CLASS_KIND_TONE[c.kind] || ''}">${esc(c.kind)}</span></td>
        <td>${c.note}</td>
        <td><code class="sg-class-file">${esc(c.files.map((f) => f.split('/').pop()).join(' '))}</code></td>
      </tr>`
    )
    .join('')

  return section(
    'Every class, searchable',
    `
    <p>
      All <strong>${classes.length}</strong> classes the stylesheet ships, read
      out of the live CSSOM — so a rule added today is in this table today.
      Type a fragment: <code>header</code> finds every one that is a header,
      <code>tables.css</code> finds everything that file declares.
    </p>
    <div class="field-group sg-class-search">
      <label for="sg-class-q">Search class names</label>
      <input class="field" id="sg-class-q" type="search" autocomplete="off"
             placeholder="header, -icon, tone, tables.css…" data-class-search>
      <div class="field-hint" data-class-count aria-live="polite">${classes.length} classes</div>
    </div>
    <div class="cluster sg-kinds" role="group" aria-label="Filter by kind">
      <button type="button" class="btn outlined sg-kind" data-kind-all aria-pressed="true">All</button>
      ${Object.entries(kinds)
        .sort((a, b) => b[1] - a[1])
        .map(
          ([k, n]) => `
      <button type="button" class="btn outlined sg-kind" data-kind-pick="${esc(k)}" aria-pressed="false">
        ${esc(k)} <span class="badge">${n}</span>
      </button>`
        )
        .join('')}
    </div>
    <div class="sg-class-box">
      <table class="table striped">
        <thead>
          <tr>
            <th style="width: 22%">Class</th>
            <th style="width: 13%">Kind</th>
            <th>What it is</th>
            <th style="width: 18%">Declared in</th>
          </tr>
        </thead>
        <tbody data-class-rows>${rows}</tbody>
      </table>
      <p class="sg-class-empty" data-class-empty hidden>Nothing matches.</p>
    </div>
    <p>
      ${Object.entries(kinds)
        .sort((a, b) => b[1] - a[1])
        .map(([k, n]) => `<strong>${n}</strong> ${esc(k)}`)
        .join(' &middot; ')}.
      A row reading <code>unclassified</code> would mean a class nothing names —
      <code>vocabulary.spec.js</code> and <code>anatomy.spec.js</code> refuse to
      let one exist, so the count above is also a test result.
    </p>`
  )
}

cheatSheetPage.init = function (root) {
  const input = $('[data-class-search]', root)
  if (!input) return

  const rows = $$('[data-class-rows] tr', root)
  const count = $('[data-class-count]', root)
  const empty = $('[data-class-empty]', root)
  const all = $('[data-kind-all]', root)
  const picks = $$('[data-kind-pick]', root)

  /* Empty means every kind, which is why All is the resting state rather
     than a fourteenth toggle that starts on. */
  const chosen = new Set()

  function apply() {
    const terms = input.value.toLowerCase().split(/\s+/).filter(Boolean)
    let shown = 0

    rows.forEach((tr) => {
      /*
       * Text AND kind. Either alone would be a different feature: text-only
       * ignores the toggles, kind-only makes typing do nothing while a
       * filter is on — and the second is the one people report as broken.
       */
      const hay = tr.dataset.class.toLowerCase()
      const hit =
        terms.every((t) => hay.indexOf(t) !== -1) &&
        (chosen.size === 0 || chosen.has(tr.dataset.kind))
      tr.hidden = !hit
      if (hit) shown++
    })

    const filtered = terms.length || chosen.size
    count.textContent = filtered
      ? `${shown} of ${rows.length} classes`
      : `${rows.length} classes`
    empty.hidden = shown > 0

    /* The buttons ARE the state — aria-pressed, not a class, because a
       toggle that looks pressed while announcing itself unpressed is the
       exact drift this package keys every other state off ARIA to avoid. */
    all.setAttribute('aria-pressed', chosen.size === 0 ? 'true' : 'false')
    picks.forEach((b) =>
      b.setAttribute('aria-pressed', chosen.has(b.dataset.kindPick) ? 'true' : 'false')
    )
  }

  input.addEventListener('input', apply)

  $('.sg-kinds', root).addEventListener('click', (e) => {
    const pick = e.target.closest('[data-kind-pick]')
    if (pick) {
      const k = pick.dataset.kindPick
      chosen.has(k) ? chosen.delete(k) : chosen.add(k)
      apply()
      return
    }
    if (e.target.closest('[data-kind-all]')) {
      chosen.clear()
      apply()
    }
  })
}

/* ══════════════════════════════════════════════════════════════════════
   3. Pages — Half 1, Structure
   ══════════════════════════════════════════════════════════════════════ */

const PRINCIPLES = [
  [
    'Minimal DOM',
    "Every element earns its place. If a wrapper isn't carrying layout, semantics, or a style hook, delete it."
  ],
  [
    'Articles inside Sections, not Sections inside Sections',
    'A discrete self-contained unit inside a Section is an <article>, never a nested <section>. This is what decides the element for Card contents, Feed entries, Pane subsections, and Alert / Toast / Popover / View.'
  ],
  [
    'Heading levels carry structure, not size',
    'Outline the document with <h1>–<h6>; set visual size with a class. An <h4> that needs to look big gets class="text-xl", it does not become an <h2>.'
  ],
  [
    'Native elements over reinvention when possible',
    '<dialog> for modals and drawers, <details> for disclosure, <button> for buttons. Focus trapping, Escape-to-close, top-layer stacking and keyboard toggling are already written and already correct.'
  ],
  [
    'Tone is a single signal',
    '.success OR .danger, never both. A tone is one variable (--bg-mix) and one meaning; two tones on one element is a contradiction, not a blend.'
  ],
  [
    'Components only for behavior',
    'Visual treatment is a class. Keyboard handling, focus management and ARIA state are a component. Most things people call components here are class-only.'
  ]
]


/*
 * VOCAB comes from ../vocabulary.js, loaded by index.html as a plain
 * <script> before this one, so the top-level `const` is visible here.
 * test/specs/vocabulary.spec.js reads the same file — edit it there.
 */

function vocabularyPage() {
  const total = VOCAB.reduce((n, [, , rows]) => n + rows.length, 0);

  return `
      ${pageHeader({
        eyebrow: 'Half 1 — Structure',
        title: 'Vocabulary',
        lead: `${total} terms in ${VOCAB.length} tiers. Each term fixes one answer: which element, what ARIA, how it nests. Naming a thing is how the argument ends.`
      })}

      ${section(
        'Why a vocabulary at all',
        `
        <p>
          Half of this system is deciding what the HTML <em>is</em>. If "card" can
          mean a <code>&lt;div&gt;</code> on Monday and an
          <code>&lt;article&gt;</code> on Thursday, nothing downstream can rely on
          it — not the CSS, not the screen reader, not the next person. The
          vocabulary is the half of the system that has no stylesheet.
        </p>
        <div class="alert info">
          <div class="alert-icon" aria-hidden="true">&#9432;</div>
          <div class="alert-content">
            <strong>Terms marked &lt;article&gt; are liftable.</strong>
            <p>
              That is the diagnostic. A term whose element is
              <code>&lt;article&gt;</code> is a self-contained unit you could move
              elsewhere intact. A <code>&lt;div&gt;</code> is infrastructure.
            </p>
          </div>
        </div>`
      )}

      ${VOCAB.map(([tier, blurb, rows]) =>
        section(
          tier,
          `
        <p>${blurb}</p>
        <table class="table striped">
          <thead>
            <tr>
              <th style="width: 18%">Term</th>
              <th style="width: 32%">Element</th>
              <th>Meaning</th>
            </tr>
          </thead>
          <tbody>
            ${rows
              .map(
                ([term, el, meaning]) => `
            <tr>
              <td><strong>${term}</strong></td>
              <td><code>${esc(el)}</code></td>
              <td>${esc(meaning)}</td>
            </tr>`
              )
              .join('')}
          </tbody>
        </table>`
        )
      ).join('')}

      ${section(
        'Coverage',
        `
        <p>
          Every term in the table above ships CSS, and every class the
          stylesheet ships has a term in it. Both halves are checked, in both
          directions, against the rendered CSSOM.
        </p>
        <div class="alert success">
          <div class="alert-icon" aria-hidden="true">&#10003;</div>
          <div class="alert-content">
            <strong>Coverage is enforced, not asserted.</strong>
            <p>
              <code>test/specs/vocabulary.spec.js</code> fails if a term has no
              class, if a class has no term, or if a name is listed as both.
              Adding CSS for something unnamed breaks the suite, and the fix is
              a decision — name it, or classify it as a tone, treatment,
              modifier, container or anatomy with a reason.
            </p>
          </div>
        </div>`
      )}
    `
}

function tooltipPage() {
  return `
      ${pageHeader({
        eyebrow: "Components",
        title: "Tooltip",
        lead: "The last of the 29 vocabulary terms to ship CSS. An attachment to a control, not a unit — which is why it is a &lt;span&gt;, not an &lt;article&gt;.",
      })}

      ${section(
        "Anatomy",
        `
        <p>
          The anchor owns the positioning context. Hover or tab to any of these:
        </p>
        ${preview(`
          <div class="cluster" style="padding: 3rem 1rem; gap: 1.5rem">
            <span class="tooltip-anchor">
              <button class="btn square" aria-label="Delete invoice" aria-describedby="sg-tip-del">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                  <path d="M6 6l12 12M18 6L6 18" stroke-linecap="round" />
                </svg>
              </button>
              <span class="tooltip" role="tooltip" id="sg-tip-del">
                Delete invoice
              </span>
            </span>

            <span class="tooltip-anchor">
              <button class="btn outlined" aria-describedby="sg-tip-b">Below</button>
              <span class="tooltip bottom" role="tooltip" id="sg-tip-b">
                Sits underneath
              </span>
            </span>

            <span class="tooltip-anchor">
              <button class="btn outlined" aria-describedby="sg-tip-s">Start</button>
              <span class="tooltip start" role="tooltip" id="sg-tip-s">
                To the side
              </span>
            </span>

            <span class="tooltip-anchor">
              <button class="btn outlined danger" aria-describedby="sg-tip-t">Toned</button>
              <span class="tooltip danger" role="tooltip" id="sg-tip-t">
                Destructive
              </span>
            </span>

            <span class="tooltip-anchor">
              <button class="btn outlined" aria-describedby="sg-tip-w">Wrapping</button>
              <span class="tooltip wrap" role="tooltip" id="sg-tip-w">
                A longer description that wraps to a sensible measure instead of
                running off the edge of the viewport.
              </span>
            </span>
          </div>`)}
        ${code(`<span class="tooltip-anchor">
  <button class="btn square" aria-label="Delete" aria-describedby="tip-del">
    <svg aria-hidden="true">…</svg>
  </button>
  <span class="tooltip" role="tooltip" id="tip-del">Delete invoice</span>
</span>`)}
        <p>
          Sides: default is above; add <code>.bottom</code>, <code>.start</code>
          or <code>.end</code>. Add <code>.wrap</code> for anything longer than a
          few words. The arrow inherits the fill, so tones and auto-contrast carry
          through — <code>.tooltip</code> is in the chip lineage.
        </p>`,
      )}

      ${section(
        "The three rules that make it accessible",
        `
        <div class="stack">
          <article class="card">
            <strong>1. \`aria-describedby\` on the trigger.</strong>
            <p>
              This is what actually announces it. A tooltip that is only a hover
              style is invisible to a screen reader — the visual is decoration,
              the attribute is the feature.
            </p>
          </article>
          <article class="card">
            <strong>2. Show on focus, not only hover.</strong>
            <p>
              The CSS uses <code>:focus-within</code> alongside
              <code>:hover</code>, so a keyboard user gets the tooltip by tabbing
              to the control. A hover-only tooltip excludes everyone who does not
              use a mouse.
            </p>
          </article>
          <article class="card">
            <strong>3. Never put essential information only in a tooltip.</strong>
            <p>
              Touch devices have no hover at all. Anything a user must know to
              proceed belongs in a label, a <code>.field-hint</code>, or visible
              copy — a tooltip is for the nice-to-know.
            </p>
          </article>
        </div>`,
      )}

      ${section(
        "Why opacity and not display:none",
        `
        <p>
          At rest the tooltip is <code>opacity: 0</code> with
          <code>pointer-events: none</code> — invisible and unclickable, but
          still present so <code>aria-describedby</code> resolves against it.
        </p>
        <p>
          For a JS-controlled tooltip, drive <code>[hidden]</code> instead of
          relying on hover. <code>.tooltip[hidden]</code> is restated as
          <code>display: none</code> for the same reason <code>.view</code> is:
          the chip lineage gives it a <code>display</code> value, and any
          <code>display</code> declaration beats the UA default for
          <code>[hidden]</code>.
        </p>
        <div class="alert warning">
          <div class="alert-icon" aria-hidden="true">!</div>
          <div class="alert-content">
            <strong>Escape-to-dismiss is behavior (Principle 6).</strong>
            <p>
              The CSS reveals on hover and focus. Dismissing a tooltip with the
              Escape key needs a key handler, and stays the app&rsquo;s job.
            </p>
          </div>
        </div>`,
      )}

      ${section(
        "Tooltip or Popover?",
        `
        <table class="table striped compact">
          <thead>
            <tr>
              <th style="width: 18%">Term</th>
              <th style="width: 22%">Element</th>
              <th>Use when</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><strong>Tooltip</strong></td>
              <td><code>${esc('<div role="tooltip">')}</code></td>
              <td>
                A short label describing the control it is attached to. Not
                interactive, cannot contain a link or a button.
              </td>
            </tr>
            <tr>
              <td><strong>Popover</strong></td>
              <td><code>&lt;article&gt;</code></td>
              <td>
                A self-contained unit of content you could lift out — a menu, a
                form, anything the user interacts with inside.
              </td>
            </tr>
          </tbody>
        </table>
        <p>
          That is the article-vs-div test doing real work: Popover is a unit, so
          it is an <code>&lt;article&gt;</code>; Tooltip is an attachment, so it
          stays a <code>&lt;div&gt;</code>.
        </p>`,
      )}`;
}
function formsPage() {
  const checkTones = ["", "success", "warning", "danger"];

  return `
      ${pageHeader({
        eyebrow: "Components",
        title: "Form controls",
        lead: "Switches, attached addons, and validation that needs no JavaScript.",
      })}

      ${section(
        "Switch",
        `
        <p>
          A real <code>${esc('<input type="checkbox">')}</code> with
          <code>role="switch"</code>, so checked state, keyboard activation and
          label association are all native (Principle 4). Nothing to wire up
          except your own change handler.
        </p>
        ${preview(`
          <div class="stack">
            <label class="field-check">
              <input type="checkbox" role="switch" class="switch" checked>
              <span>Email notifications</span>
            </label>
            <label class="field-check">
              <input type="checkbox" role="switch" class="switch danger">
              <span>Delete after 30 days</span>
            </label>
            <label class="field-check">
              <input type="checkbox" role="switch" class="switch" disabled>
              <span>Unavailable on your plan</span>
            </label>
          </div>`)}
        ${code(`<label class="field-check">
  <input type="checkbox" role="switch" class="switch" checked>
  <span>Email notifications</span>
</label>`)}
        <div class="alert info">
          <div class="alert-icon" aria-hidden="true">&#9432;</div>
          <div class="alert-content">
            <strong>The knob is a background gradient, not a pseudo-element.</strong>
            <p>
              An <code>&lt;input&gt;</code> is a replaced element, and
              pseudo-elements on replaced elements are not guaranteed by spec —
              they happen to work on <code>appearance: none</code> checkboxes in
              current browsers, but a background gradient is defined behaviour
              everywhere.
            </p>
          </div>
        </div>`,
      )}

      ${section(
        "Checkboxes and radios",
        `
        <p>
          Still native, still styled with <code>accent-color</code> — but the
          accent now follows the tone.
        </p>
        ${preview(
          `<div class="cluster">
            ${checkTones
              .map(
                (t) => `
            <label class="field-check ${t}">
              <input type="checkbox" checked>
              <span>${t || "default"}</span>
            </label>`,
              )
              .join("")}
          </div>`,
        )}
        <p>
          Putting the tone on the <em>label</em> works because
          <code>.field-check</code> derives an inheriting
          <code>--check-accent</code> for the input to read. It has to —
          <code>--bg-mix</code> is element-scoped, so the input cannot see a tone
          set on its parent. Same shape tables and dialogs use.
        </p>
        ${code(`.field-check       { --check-accent: var(--bg-mix, var(--color-primary)); }
.field-check input { accent-color: var(--bg-mix, var(--check-accent)); }`)}`,
      )}

      ${section(
        "Attached addons",
        `
        ${preview(`
          <div class="stack" style="width: 100%; max-width: 26rem">
            <div class="field-row">
              <span class="field-addon">$</span>
              <input class="field" type="text" value="1,240" inputmode="decimal">
              <span class="field-addon">.00</span>
            </div>
            <div class="field-row">
              <input class="field" type="search" placeholder="Search invoices">
              <button class="btn">Search</button>
            </div>
            <div class="field-row">
              <span class="field-addon">https://</span>
              <input class="field" type="text" value="acme.example.com">
            </div>
          </div>`)}
        ${code(`<div class="field-row">
  <span class="field-addon">$</span>
  <input class="field" type="number" inputmode="decimal">
  <span class="field-addon">.00</span>
</div>

<div class="field-row">
  <input class="field" type="search">
  <button class="btn">Search</button>
</div>`)}
        <p>
          Internal edges square off, the outer two keep
          <code>--field-radius</code>, and neighbours pull back
          <code>-1px</code> so their borders collapse into one. A focused control
          lifts to <code>z-index: 1</code> so its ring is not clipped by whatever
          sits beside it.
        </p>
        <div class="alert warning">
          <div class="alert-icon" aria-hidden="true">!</div>
          <div class="alert-content">
            <strong>An addon is decoration.</strong>
            <p>
              If it carries meaning the input does not, put that meaning in the
              <code>&lt;label&gt;</code> or a <code>.field-hint</code> — a screen
              reader user should not have to infer &ldquo;dollars&rdquo; from a
              glyph sitting beside the box.
            </p>
          </div>
        </div>`,
      )}

      ${section(
        "Validation with no JavaScript",
        `
        <p>
          This is the entire implementation:
        </p>
        ${code(`.field:user-invalid { --bg-mix: var(--color-danger); }`)}
        <p>
          The border, the focus ring and any <code>.field-hint</code> in scope all
          derive from <code>--bg-mix</code> already, so one line turns the whole
          field red at the right moment — no class to toggle, no validation
          library, no <code>onBlur</code> handler.
        </p>
        <div class="alert success">
          <div class="alert-icon" aria-hidden="true">&#10003;</div>
          <div class="alert-content">
            <strong>
              <code>:user-invalid</code>, not <code>:invalid</code>.
            </strong>
            <p>
              <code>:invalid</code> matches an empty required input the instant
              the page loads, shouting at someone who has not typed anything yet.
              <code>:user-invalid</code> waits until the user has actually
              interacted with the field.
            </p>
          </div>
        </div>
        ${preview(`
          <div class="stack" style="width: 100%; max-width: 26rem">
            <div class="field-group">
              <label for="sg-email">Email</label>
              <input class="field" id="sg-email" type="email" required placeholder="you@example.com">
              <span class="field-hint">
                Type something invalid, then click away — the field colours itself.
              </span>
            </div>
          </div>`)}
        <p>
          Opt into the positive case per form if you want it:
          <code>.field:user-valid &#123; --bg-mix: var(--color-success); &#125;</code>
        </p>`,
      )}`;
}

/* ══════════════════════════════════════════════════════════════════════
   3. Pages — Half 1, Anatomy
   ══════════════════════════════════════════════════════════════════════ */

/*
 * Every fact on this page is read from ANATOMY in ../vocabulary.js, which
 * anatomy.spec.js checks against the real CSSOM in both directions: every
 * part ships CSS and does something where the markup puts it, and every
 * anatomy class the stylesheet ships is claimed by exactly one term.
 *
 * That is the whole reason the page can exist. The same content written by
 * hand is what it replaces — the answer to "which children" lived in seven
 * pages as markup nothing compared to anything, plus a sentence on the
 * taxonomy page, plus a convention in a test that waved every hyphenated
 * class through.
 *
 * The seven pages keep their own demonstrations. They are not markup: they
 * carry the edge cases — a label long enough to wrap, an avatar inside a
 * value, a page control that is present and unavailable — and swapping
 * them for the canonical block would cost coverage to save duplication
 * that is not duplication.
 */

/* VOCAB, indexed — the element and class columns, by term. */
function termFacts() {
  const out = {}
  VOCAB.forEach(([tier, , rows]) =>
    rows.forEach((row) => {
      out[row[0]] = { tier, element: row[1], meaning: row[2], cls: vocabClass(row) }
    })
  )
  return out
}

/* Who owns each part, so a `uses` line can name the lender. */
function partOwners() {
  const out = {}
  Object.keys(ANATOMY).forEach((term) =>
    (ANATOMY[term].parts || []).forEach((p) => {
      if (p[0].charAt(0) === '.') out[p[0].slice(1)] = term
    })
  )
  return out
}

/*
 * One term's anatomy, rendered. Reusable: a component page that wants the
 * canonical block rather than its own demonstration calls this.
 */
function anatomyBlock(term, facts, owners) {
  const entry = ANATOMY[term]
  if (!entry) return ''

  const f = facts[term]
  const parts = entry.parts || []
  const uses = entry.uses || []

  const rows = parts
    .map(
      ([sel, meaning, optional]) => `
      <tr>
        <td><code>${esc(sel)}</code></td>
        <td>${optional ? '<span class="badge muted">optional</span>' : '<span class="badge">required</span>'}</td>
        <td>${meaning}</td>
      </tr>`
    )
    .join('')

  const borrowed = uses.length
    ? `<p>
         Also takes ${uses
           .map((c) => `<code>.${esc(c)}</code>`)
           .join(', ')} — owned by
         ${[...new Set(uses.map((c) => owners[c]).filter(Boolean))]
           .map((t) => `<strong>${esc(t)}</strong>`)
           .join(' and ')}, borrowed here. One header, not five.
       </p>`
    : ''

  return `
    <p>
      <code>${esc(f.element)}</code>${f.cls ? ` &middot; <code>.${esc(f.cls)}</code>` : ''}
      &mdash; ${esc(f.meaning)}
    </p>
    ${
      parts.length
        ? `<table class="table">
             <thead><tr><th style="width: 26%">Part</th><th style="width: 14%"></th><th>What it is</th></tr></thead>
             <tbody>${rows}</tbody>
           </table>`
        : ''
    }
    ${borrowed}
    ${preview(entry.markup)}
    ${code(entry.markup, 'html')}`
}

function anatomyPage() {
  const facts = termFacts()
  const owners = partOwners()

  const total = VOCAB.reduce((n, [, , rows]) => n + rows.length, 0)
  const withParts = Object.keys(ANATOMY).length
  const partCount = Object.keys(owners).length

  /* Tier order, not object order — the page should read like the
     vocabulary it belongs to. */
  const ordered = []
  VOCAB.forEach(([, , rows]) =>
    rows.forEach((row) => {
      if (ANATOMY[row[0]]) ordered.push(row[0])
    })
  )

  return `
      ${pageHeader({
        eyebrow: 'Half 1 — Structure',
        title: 'Anatomy',
        lead: `${withParts} of the ${total} terms have children. ${partCount} named parts, one canonical block each — and the other ${total - withParts} terms are a single element, which is itself the answer.`
      })}

      ${section(
        'What a part is',
        `
        <p>
          A <strong>part</strong> is a position inside a term:
          <code>.alert-icon</code> is where the glyph goes, and it means
          nothing anywhere else. That is the difference from a Treatment,
          which composes onto anything, and from a scoped modifier, which
          changes one term without being a place inside it.
        </p>
        <p>
          Each part is <strong>owned by exactly one term</strong>, and other
          terms borrow it. Card, Dialog, Drawer and Popover all take the
          Surface sub-regions rather than declaring their own — listing them
          four times would say there are four headers with four meanings,
          which is the claim the whole lineage denies.
        </p>
        ${patternNote(`
          A part need not be a class. <strong>Facts ships none on purpose</strong> —
          the <code>&lt;dl&gt;</code> styles its own <code>&lt;dt&gt;</code> and
          <code>&lt;dd&gt;</code>, and saying so here is what stops somebody adding
          <code>.fact-label</code> to make it look like the others.`)}`
      )}

      ${section(
        'What looks like a part and is not',
        `
        <p>
          Until this page, a hyphen was the whole rule: the test suite treated
          any hyphenated class as anatomy and skipped it. That rule accepts
          <code>.alert-anything</code>, and it is wrong about these:
        </p>
        <dl class="facts divided">
          ${Object.entries(NOT_ANATOMY)
            .filter(([, why]) => !/^A (size|colour) utility$|^A theme$|^A direction modifier/.test(why))
            .map(
              ([cls, why]) => `
          <dt><code>.${esc(cls)}</code></dt>
          <dd>${esc(why)}</dd>`
            )
            .join('')}
        </dl>
        <p>
          The families are excused as families: the eight
          <code>.theme-*</code>, the five <code>.text-*</code> sizes and six
          colours, and Drawer's four <code>.from-*</code> directions. Every one
          of them is listed by name, because a prefix rule is how
          <code>.alert-anything</code> gets in.
        </p>`
      )}

      ${ordered.map((term) => section(term, anatomyBlock(term, facts, owners))).join('')}`
}

/* ══════════════════════════════════════════════════════════════════════
   3. Pages — Patterns
   ══════════════════════════════════════════════════════════════════════ */

function navPage() {
  const ROUTES = [
    ["dashboard", "Dashboard", null],
    ["invoices", "Invoices", "7"],
    ["customers", "Customers", null],
  ];

  return `
      ${pageHeader({
        eyebrow: "Patterns",
        title: "Navigation",
        lead: "Breadcrumbs, pagination, and the sidebar nav list. All three take their current item from [aria-current], not a class.",
      })}

      ${section(
        "Every nav needs a label",
        `
        <p>
          A page with three unlabelled <code>&lt;nav&gt;</code> elements is three
          identical entries in a screen reader&rsquo;s landmark list. Each of
          these patterns expects an <code>aria-label</code>.
        </p>
        ${code(`<nav class="breadcrumb" aria-label="Breadcrumb">
<nav class="pagination" aria-label="Pagination">
<nav class="sidebar"    aria-label="Main">`)}`,
      )}

      ${section(
        "Breadcrumb",
        `
        ${preview(`
          <nav class="breadcrumb" aria-label="Breadcrumb demo">
            <ol>
              <li><a class="link" href="#0">Home</a></li>
              <li><a class="link" href="#0">Invoices</a></li>
              <li><a class="link" href="#0">2024</a></li>
              <li><a aria-current="page">INV-1042</a></li>
            </ol>
          </nav>`)}
        ${code(`<nav class="breadcrumb" aria-label="Breadcrumb">
  <ol>
    <li><a class="link" href="/">Home</a></li>
    <li><a class="link" href="/invoices">Invoices</a></li>
    <li><a aria-current="page">INV-1042</a></li>
  </ol>
</nav>`)}
        <div class="alert info">
          <div class="alert-icon" aria-hidden="true">&#9432;</div>
          <div class="alert-content">
            <strong>The separator is not announced.</strong>
            <p>
              It is injected with
              <code>content: var(--breadcrumb-separator, "/") / ""</code>. That
              trailing <code>/ ""</code> is the alt-text half of the
              <code>content</code> shorthand — without it, some screen readers
              read &ldquo;slash&rdquo; between every crumb. Override the variable
              to change the glyph.
            </p>
          </div>
        </div>
        <p>
          <code>&lt;ol&gt;</code> because the order <em>is</em> the hierarchy.
          The last crumb keeps its <code>&lt;a&gt;</code> but drops the
          <code>href</code> — it is the current page, so it is not a link.
        </p>`,
      )}

      ${section(
        "Pagination",
        `
        ${preview(`
          <nav class="pagination" aria-label="Pagination demo" data-pager>
            <a class="pagination-link" href="#0" rel="prev" data-page="prev">Previous</a>
            <a class="pagination-link" href="#0" data-page="1">1</a>
            <a class="pagination-link" href="#0" data-page="2" aria-current="page">2</a>
            <a class="pagination-link" href="#0" data-page="3">3</a>
            <span class="pagination-gap" aria-hidden="true">&hellip;</span>
            <a class="pagination-link" href="#0" data-page="9">9</a>
            <a class="pagination-link" href="#0" rel="next" data-page="next">Next</a>
          </nav>`)}
        ${code(`<nav class="pagination" aria-label="Pagination">
  <a class="pagination-link" href="?p=1" rel="prev" aria-disabled="true">Previous</a>
  <a class="pagination-link" href="?p=1">1</a>
  <a class="pagination-link" href="?p=2" aria-current="page">2</a>
  <span class="pagination-gap" aria-hidden="true">…</span>
  <a class="pagination-link" href="?p=9">9</a>
</nav>`)}
        <p>
          <code>.pagination-link</code> is in the <strong>chip lineage</strong>, so it gets
          inline-flex centering and the auto-contrast machinery for free — the
          current page is a solid fill and its text color is derived from that
          fill&rsquo;s luminance, exactly like a button. Adding it took one edit
          to the <code>:where()</code> list in chip.css.
        </p>
        ${preview(
          `<div class="stack">
            ${["primary", "success", "danger"]
              .map(
                (tone) => `
            <nav class="pagination" aria-label="${tone} demo">
              ${[1, 2, 3]
                .map(
                  (n) =>
                    `<a class="pagination-link ${tone}" href="#0"${n === 2 ? ' aria-current="page"' : ""}>${n}</a>`,
                )
                .join("")}
            </nav>`,
              )
              .join("")}
          </div>`,
        )}`,
      )}

      ${section(
        "Sidebar nav list",
        `
        ${preview(`
          <nav class="sidebar" aria-label="Nav demo" style="inline-size: 15rem; width: 15rem" data-navdemo>
            <div class="navlist-label">Workspace</div>
            <ul class="navlist">
              ${ROUTES.map(
                ([id, label, count]) => `
              <li>
                <a class="navlink" href="#0" data-route="${id}"${id === "dashboard" ? ' aria-current="page"' : ""}>
                  ${label}
                  ${count ? `<span class="pill muted">${count}</span>` : ""}
                </a>
              </li>`,
              ).join("")}
            </ul>
            <div class="navlist-label">Settings</div>
            <ul class="navlist">
              <li><a class="navlink" href="#0">Billing</a></li>
            </ul>
          </nav>`)}
        ${code(`<nav class="sidebar" aria-label="Main">
  <div class="navlist-label">Workspace</div>
  <ul class="navlist">
    <li>
      <a class="navlink" href="/dash" aria-current="page">Dashboard</a>
    </li>
    <li>
      <a class="navlink" href="/inv">
        Invoices <span class="pill muted">7</span>
      </a>
    </li>
  </ul>
</nav>`)}
        <div class="alert warning">
          <div class="alert-icon" aria-hidden="true">!</div>
          <div class="alert-content">
            <strong>
              Use <code>.navlink</code>, not <code>.items.menu</code>, for
              anything navigable.
            </strong>
            <p>
              <code>.items.menu .item</code> styles an <code>&lt;li&gt;</code> to
              look clickable, but an <code>&lt;li&gt;</code> is not focusable and
              takes no keyboard input — the hover state writes a cheque the markup
              cannot cash. <code>.navlink</code> goes on a real
              <code>&lt;a&gt;</code>, so it is focusable, activatable and
              announced as a link.
            </p>
          </div>
        </div>
        <p>
          A trailing <code>.pill</code> or <code>.badge</code> is pushed to the
          end automatically, so counts line up down the column.
        </p>`,
      )}

      ${section(
        "Why aria-current and not .active",
        `
        <p>
          Same reasoning as Tabs. A class lets the visual state and the announced
          state drift apart the moment someone updates one and forgets the other.
          There are tests in the suite asserting that adding
          <code>.active</code>, <code>.current</code> and <code>.selected</code>
          to a nav link changes nothing at all.
        </p>`,
      )}`;
}

/*
 * Both demos move a single [aria-current] attribute, which is the point the
 * page is making — there is no class to keep in sync with it.
 */
navPage.init = function (root) {
  const pager = $("[data-pager]", root);
  const pages = $$("[data-page]", pager).filter((a) => /^\d+$/.test(a.dataset.page));

  function goTo(n) {
    const clamped = Math.min(9, Math.max(1, n));
    pages.forEach((a) => {
      if (Number(a.dataset.page) === clamped) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
    const prev = $('[data-page="prev"]', pager);
    if (clamped === 1) prev.setAttribute("aria-disabled", "true");
    else prev.removeAttribute("aria-disabled");
  }

  function current() {
    const active = pages.find((a) => a.hasAttribute("aria-current"));
    return active ? Number(active.dataset.page) : 1;
  }

  pager.addEventListener("click", (e) => {
    const link = e.target.closest("[data-page]");
    if (!link) return;
    e.preventDefault();
    const target = link.dataset.page;
    if (target === "prev") goTo(current() - 1);
    else if (target === "next") goTo(current() + 1);
    else goTo(Number(target));
  });

  const navDemo = $("[data-navdemo]", root);
  navDemo.addEventListener("click", (e) => {
    const link = e.target.closest("[data-route]");
    if (!link) return;
    e.preventDefault();
    $$("[data-route]", navDemo).forEach((a) => a.removeAttribute("aria-current"));
    link.setAttribute("aria-current", "page");
  });
};
function tabsPage() {
  const TABS = [
    ["details", "Details"],
    ["history", "History"],
    ["files", "Files"],
  ];
  const PILLS = [
    ["all", "All", "24"],
    ["open", "Open", "7"],
    ["closed", "Closed", "17"],
  ];
  const OVERFLOW = ["Summary", "Activity", "Members", "Settings", "Billing", "Audit"];

  return `
      ${pageHeader({
        eyebrow: "Patterns",
        title: "Tabs",
        lead: "Switching between Views inside a Pane. The panel is the existing View term, so this only adds the strip.",
      })}

      ${section(
        "Selected state comes from ARIA, not a class",
        `
        <p>
          The active tab is styled through
          <code>${esc('[aria-selected="true"]')}</code>, deliberately not through a
          <code>.active</code> class. With a class you can render a tab that
          <em>looks</em> selected while announcing itself as unselected — and the
          two drift the moment someone updates one and forgets the other.
        </p>
        <div class="alert success">
          <div class="alert-icon" aria-hidden="true">&#10003;</div>
          <div class="alert-content">
            <strong>This makes the divergence unrepresentable.</strong>
            <p>
              If it looks selected, it <em>is</em> selected as far as assistive
              tech is concerned. There is a test in the suite asserting that a
              <code>.active</code> class fails to fake it.
            </p>
          </div>
        </div>
        <p>
          The same rule applies to anything with a state a screen reader can
          observe — <code>[aria-expanded]</code>, <code>[aria-current]</code>,
          <code>[aria-disabled]</code>, <code>[hidden]</code>. The attribute is
          the source of truth; a class is the hook only when no attribute exists.
        </p>`,
      )}

      ${section(
        "Underline (default)",
        `
        ${preview(`
          <div class="tabs" style="width: 100%" data-tabs>
            <div class="tablist" role="tablist" aria-label="Invoice sections">
              ${TABS.map(
                ([id, label], i) => `
              <button class="tab" role="tab" id="sg-t-${id}"
                      aria-selected="${i === 0}" aria-controls="sg-v-${id}"
                      tabindex="${i === 0 ? 0 : -1}">${label}</button>`,
              ).join("")}
              <button class="tab" role="tab" aria-selected="false" tabindex="-1" disabled>
                Archived
              </button>
            </div>
            ${TABS.map(
              ([id, label], i) => `
            <article class="view" role="tabpanel" id="sg-v-${id}"
                     aria-labelledby="sg-t-${id}" tabindex="0"${i === 0 ? "" : " hidden"}>
              The <strong>${label}</strong> panel. This is a View — the same
              term the app frame uses.
            </article>`,
            ).join("")}
          </div>`)}
        ${code(`<div class="tabs">
  <div class="tablist" role="tablist" aria-label="Invoice sections">
    <button class="tab" role="tab" id="t-1"
            aria-selected="true" aria-controls="v-1">Details</button>
    <button class="tab" role="tab" id="t-2" tabindex="-1"
            aria-selected="false" aria-controls="v-2">History</button>
  </div>

  <article class="view" role="tabpanel" id="v-1"
           aria-labelledby="t-1" tabindex="0"> … </article>
  <article class="view" role="tabpanel" id="v-2"
           aria-labelledby="t-2" tabindex="0" hidden> … </article>
</div>`)}`,
      )}

      ${section(
        "Pills, and counts",
        `
        <p>
          <code>.tablist.pills</code> drops the baseline rule and fills the
          selected tab instead. A <code>.pill</code> inside a tab is just a
          pill — Treatments compose.
        </p>
        ${preview(`
          <div class="tabs" style="width: 100%" data-tabs>
            <div class="tablist pills" role="tablist" aria-label="Filter">
              ${PILLS.map(
                ([id, label, count], i) => `
              <button class="tab" role="tab" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}">
                ${label}
                <span class="pill muted">${count}</span>
              </button>`,
              ).join("")}
            </div>
          </div>`)}
        ${code(`<div class="tablist pills" role="tablist" aria-label="Filter">
  <button class="tab" role="tab" aria-selected="true">
    All <span class="pill muted">24</span>
  </button>
</div>`)}`,
      )}

      ${section(
        "Stretch, tones and overflow",
        `
        <div class="stack">
          <div>
            <p>
              <code>.tablist.stretch</code> — tabs share the width equally.
            </p>
            ${preview(`
              <div class="tabs" style="width: 100%" data-tabs>
                <div class="tablist stretch" role="tablist" aria-label="Stretch demo">
                  <button class="tab" role="tab" aria-selected="true">Overview</button>
                  <button class="tab" role="tab" aria-selected="false" tabindex="-1">Usage</button>
                  <button class="tab" role="tab" aria-selected="false" tabindex="-1">Billing</button>
                </div>
              </div>`)}
          </div>
          <div>
            <p>
              A tone on <code>.tablist</code> travels to its tabs through an
              inheriting <code>--tab-accent</code> — it has to, because
              <code>--bg-mix</code> is element-scoped and would not reach a
              child.
            </p>
            ${preview(`
              <div class="tabs" style="width: 100%" data-tabs>
                <div class="tablist danger" role="tablist" aria-label="Toned demo">
                  <button class="tab" role="tab" aria-selected="true">Failures</button>
                  <button class="tab" role="tab" aria-selected="false" tabindex="-1">Retries</button>
                </div>
              </div>`)}
            ${code(`<div class="tablist danger" role="tablist"> … </div>`)}
          </div>
          <div>
            <p>
              Too many tabs for the width scroll horizontally rather than wrap or
              squash — and crucially, without widening the page.
            </p>
            ${preview(`
              <div class="tabs" style="width: 260px; max-width: 100%" data-tabs>
                <div class="tablist" role="tablist" aria-label="Overflow demo">
                  ${OVERFLOW.map(
                    (l, i) =>
                      `<button class="tab" role="tab" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}">${l}</button>`,
                  ).join("")}
                </div>
              </div>`)}
          </div>
        </div>`,
      )}

      ${section(
        "Vertical",
        `
        <p>
          <code>.tabs.vertical</code> puts the strip beside the panel instead of
          above it. Good for settings screens and anything with more tabs than
          fit across.
        </p>
        ${preview(`
          <div class="tabs vertical" style="width: 100%" data-tabs>
            <div class="tablist" role="tablist" aria-orientation="vertical" aria-label="Settings sections">
              <button class="tab" role="tab" id="sg-vt-1" aria-selected="true" aria-controls="sg-vp-1">Profile</button>
              <button class="tab" role="tab" id="sg-vt-2" aria-selected="false" aria-controls="sg-vp-2" tabindex="-1">Notifications</button>
              <button class="tab" role="tab" id="sg-vt-3" aria-selected="false" aria-controls="sg-vp-3" tabindex="-1">Billing</button>
              <button class="tab" role="tab" id="sg-vt-4" aria-selected="false" aria-controls="sg-vp-4" tabindex="-1">API keys</button>
            </div>
            <article class="view" role="tabpanel" id="sg-vp-1" aria-labelledby="sg-vt-1" tabindex="0">
              The <strong>Profile</strong> panel. Arrow keys move the selection —
              Up/Down here, not Left/Right.
            </article>
            <article class="view" role="tabpanel" id="sg-vp-2" aria-labelledby="sg-vt-2" tabindex="0" hidden>
              The <strong>Notifications</strong> panel.
            </article>
            <article class="view" role="tabpanel" id="sg-vp-3" aria-labelledby="sg-vt-3" tabindex="0" hidden>
              The <strong>Billing</strong> panel.
            </article>
            <article class="view" role="tabpanel" id="sg-vp-4" aria-labelledby="sg-vt-4" tabindex="0" hidden>
              The <strong>API keys</strong> panel.
            </article>
          </div>`)}
        ${code(`<div class="tabs vertical">
  <div class="tablist" role="tablist" aria-orientation="vertical"
       aria-label="Settings sections">
    <button class="tab" role="tab" …>Profile</button>
  </div>
  <article class="view" role="tabpanel" …> … </article>
</div>`)}
        <div class="alert info">
          <div class="alert-icon" aria-hidden="true">&#9432;</div>
          <div class="alert-content">
            <strong><code>aria-orientation="vertical"</code> is not decorative.</strong>
            <p>
              It tells assistive tech which arrow keys move between tabs. Get it
              wrong and a screen reader user is told to press the keys that do
              nothing — the CSS turned the strip, and only the attribute turns
              the contract with it.
            </p>
          </div>
        </div>
        ${preview(`
          <div class="tabs vertical" style="width: 100%" data-tabs>
            <div class="tablist pills" role="tablist" aria-orientation="vertical" aria-label="Vertical pills">
              <button class="tab" role="tab" aria-selected="true">All <span class="pill muted">24</span></button>
              <button class="tab" role="tab" aria-selected="false" tabindex="-1">Open <span class="pill muted">7</span></button>
              <button class="tab" role="tab" aria-selected="false" tabindex="-1">Closed <span class="pill muted">17</span></button>
            </div>
          </div>`)}
        <p>
          A vertical pills strip has no side rule to hang the indicator on, so
          the selected tab fills instead.
        </p>`,
      )}

      ${section(
        "What the class does not do",
        `
        <div class="alert warning">
          <div class="alert-icon" aria-hidden="true">!</div>
          <div class="alert-content">
            <strong>Keyboard behavior is the app&rsquo;s job (Principle 6).</strong>
            <p>
              Visual treatment is a class; keyboard and focus behavior is a
              component. Tabs need real behavior and this file ships none of it.
            </p>
          </div>
        </div>
        <ul>
          <li>
            <strong>Roving tabindex</strong> — the selected tab is
            <code>tabindex="0"</code>, every other tab is
            <code>tabindex="-1"</code>, so Tab moves past the strip rather than
            through every tab in it.
          </li>
          <li>
            <strong>Left / Right</strong> move between tabs (Up / Down for a
            vertical strip); <strong>Home / End</strong> jump to first and last.
          </li>
          <li>
            Activating a tab sets <code>aria-selected</code> and unhides its
            panel.
          </li>
          <li>
            <strong>
              <code>tabindex="0"</code> on the panel
            </strong>
            — panel content is often not focusable, and without it a keyboard
            user tabs off the strip straight past the content it controls.
          </li>
        </ul>`,
      )}`;
}

/*
 * The page above says the package ships no tab behavior and that the app owes
 * it — so the guide owes it too. This is that component, in the ~30 lines the
 * demo's tally predicts: roving tabindex, arrows, Home/End, panel switching.
 */
tabsPage.init = function (root) {
  $$("[data-tabs]", root).forEach((group) => {
    const list = $(".tablist", group);
    const tabs = $$('[role="tab"]:not([disabled])', list);

    function select(tab) {
      tabs.forEach((t) => {
        const on = t === tab;
        t.setAttribute("aria-selected", String(on));
        t.tabIndex = on ? 0 : -1;

        const panelId = t.getAttribute("aria-controls");
        if (panelId) {
          const panel = $(`#${panelId}`, group);
          if (panel) panel.hidden = !on;
        }
      });
    }

    list.addEventListener("click", (e) => {
      const tab = e.target.closest('[role="tab"]');
      if (tab && tabs.includes(tab)) select(tab);
    });

    list.addEventListener("keydown", (e) => {
      const i = tabs.indexOf(document.activeElement);
      if (i === -1) return;

      const next = {
        ArrowRight: i + 1,
        ArrowDown: i + 1,
        ArrowLeft: i - 1,
        ArrowUp: i - 1,
        Home: 0,
        End: tabs.length - 1,
      }[e.key];
      if (next === undefined) return;

      e.preventDefault();
      const tab = tabs[(next + tabs.length) % tabs.length];
      select(tab);
      tab.focus();
    });
  });
};

function tilesPage() {
  return `
      ${pageHeader({
        eyebrow: "Components",
        title: "Tiles",
        lead: "The compact metric unit dashboards are built from. Closes the twelfth vocabulary term — only Tooltip is contract-only after this.",
      })}

      ${section(
        "A tile is a surface composite",
        `
        <p>
          Background, border, radius and the whole tone recipe come from adding
          <code>tile</code> to the <code>:where()</code> list in surface.css.
          <strong>One edit.</strong> Before v0.6 that same change meant editing
          five separate selector lists, and forgetting one gave you a composite
          that worked in three states out of four.
        </p>
        ${preview(`
          <div class="tiles" style="width: 100%">
            <article class="tile">
              <div class="tile-label">Revenue</div>
              <div class="tile-value">$48,290</div>
              <div class="tile-delta success">&uarr; 12.4%</div>
            </article>
            <article class="tile">
              <div class="tile-label">Open tickets</div>
              <div class="tile-value">27</div>
              <div class="tile-delta danger">&darr; 3.1%</div>
            </article>
            <article class="tile">
              <div class="tile-label">Churn</div>
              <div class="tile-value">1.8%</div>
              <div class="tile-delta">no change</div>
            </article>
          </div>`)}
        ${code(`<div class="tiles">
  <article class="tile">
    <div class="tile-label">Revenue</div>
    <div class="tile-value">$48,290</div>
    <div class="tile-delta success">↑ 12.4%</div>
  </article>
</div>`)}`,
      )}

      ${section(
        "Responsive without a media query",
        `
        <p>
          <code>.tiles</code> is
          <code>repeat(auto-fit, minmax(var(--tile-min, 12rem), 1fr))</code>, so
          the column count follows the container and nobody has to pick a number.
          Set <code>--tile-min</code> to change the threshold.
        </p>`,
      )}

      ${section(
        "Tones apply where you put them",
        `
        <p>
          The tile takes a tone like any surface; the delta takes its own. Because
          tones are element-scoped, an untoned <code>.tile-delta</code> inside a
          <code>.tile.danger</code> stays muted instead of inheriting red.
        </p>
        ${preview(`
          <div class="tiles" style="width: 100%">
            <article class="tile danger">
              <div class="tile-label">Failed jobs</div>
              <div class="tile-value">14</div>
              <div class="tile-delta">untoned delta stays muted</div>
            </article>
            <article class="tile success">
              <div class="tile-label">Uptime</div>
              <div class="tile-value">99.98%</div>
            </article>
          </div>`)}`,
      )}

      ${section(
        "Two details worth keeping",
        `
        <div class="stack">
          <article class="card">
            <strong>Label before value in the DOM.</strong>
            <p>
              A screen reader then hears &ldquo;Revenue, $48,290&rdquo; rather
              than a number with no subject. If you want the number visually on
              top, use <code>order: -1</code> on <code>.tile-value</code> instead
              of reordering the markup.
            </p>
          </article>
          <article class="card">
            <strong>Tabular figures on values and deltas.</strong>
            <p>
              <code>font-variant-numeric: tabular-nums</code>, so a column of
              tiles does not jitter as the numbers update.
            </p>
          </article>
        </div>`,
      )}`;
}

function feedbackPage() {
  return `
      ${pageHeader({
        eyebrow: "Components",
        title: "Loading & empty",
        lead: "The states a screen is in when it is not showing data. Internal tooling spends real time in all three, and the system had none of them.",
      })}

      ${section(
        "Spinner",
        `
        <p>
          Sized in <code>em</code>, so it scales with whatever font-size it sits
          in, and drawn with <code>currentColor</code>, so it inherits tone from
          its context.
        </p>
        ${preview(`
          <div class="cluster">
            <span class="spinner" aria-hidden="true"></span>
            <span class="spinner" aria-hidden="true" style="font-size: 1.5rem"></span>
            <span class="spinner text-danger" aria-hidden="true" style="font-size: 2rem"></span>
          </div>`)}
        ${code(`<span class="spinner" aria-hidden="true"></span>
<span class="visually-hidden" role="status">Loading invoices</span>`)}
        <div class="alert info">
          <div class="alert-icon" aria-hidden="true">&#9432;</div>
          <div class="alert-content">
            <strong>The spinner is decorative; the live region announces.</strong>
            <p>
              A spinning border communicates nothing to a screen reader. Pair it
              with a <code>role="status"</code> region — that is the part doing
              the accessibility work.
            </p>
          </div>
        </div>`,
      )}

      ${section(
        "Buttons",
        `
        ${preview(`
          <div class="cluster">
            <button class="btn primary loading" aria-busy="true" disabled>Save changes</button>
            <button class="btn outlined loading" aria-busy="true" disabled>Retry</button>
            <button class="btn primary">Not loading</button>
          </div>`)}
        ${code(`<button class="btn primary loading" aria-busy="true" disabled>
  Save changes
</button>`)}
        <p>
          The label is hidden with <code>color: transparent</code> rather than
          removed, so the button keeps its width — no layout jump — and a screen
          reader still has something to read.
          <strong>Keep <code>disabled</code></strong>:
          <code>pointer-events: none</code> stops the mouse but not the
          keyboard.
        </p>`,
      )}

      ${section(
        "Progress",
        `
        <p>
          Built on native <code>&lt;progress&gt;</code> (Principle 4), so
          <code>role="progressbar"</code>, the value and the max are announced
          without any ARIA of our own. Omit <code>value</code> and the browser
          renders its own indeterminate state.
        </p>
        ${preview(`
          <div class="stack" style="width: 100%">
            <progress class="progress" value="30" max="100">30%</progress>
            <progress class="progress success" value="100" max="100">100%</progress>
            <progress class="progress danger" value="12" max="100">12%</progress>
          </div>`)}
        ${code(`<progress class="progress" value="70" max="100">70%</progress>
<progress class="progress success" value="100" max="100">Done</progress>`)}`,
      )}

      ${section(
        "Skeleton",
        `
        <p>
          A placeholder shaped like the content that is coming, so the layout does
          not jump when the data lands. Wrap the region in
          <code>aria-busy="true"</code> so assistive tech is not told to read a
          screenful of empty boxes.
        </p>
        ${preview(`
          <article class="card" style="width: 100%" aria-busy="true">
            <div class="cluster" style="align-items: flex-start">
              <div class="skeleton circle" style="inline-size: 2.5rem; width: 2.5rem; height: 2.5rem"></div>
              <div style="flex: 1">
                <div class="skeleton text" style="width: 40%"></div>
                <div class="skeleton text"></div>
                <div class="skeleton text" style="width: 75%"></div>
              </div>
            </div>
          </article>`)}
        ${code(`<div aria-busy="true">
  <div class="skeleton circle" style="inline-size: 2.5rem"></div>
  <div class="skeleton text"></div>
</div>`)}`,
      )}

      ${section(
        "Empty state",
        `
        <p>
          An empty state without an action is a dead end, so
          <code>.empty-actions</code> is part of the anatomy rather than an
          afterthought.
        </p>
        ${preview(`
          <div class="card" style="width: 100%; padding: 0">
            <div class="empty">
              <div class="empty-icon" aria-hidden="true">&#128230;</div>
              <h3 class="empty-title">No invoices yet</h3>
              <p class="empty-text">
                Create your first invoice and it will show up here, along with its
                payment status and history.
              </p>
              <div class="empty-actions">
                <button class="btn primary">New invoice</button>
                <button class="btn outlined">Import</button>
              </div>
            </div>
          </div>`)}
        ${code(`<div class="empty">
  <div class="empty-icon" aria-hidden="true">…</div>
  <h3 class="empty-title">No invoices yet</h3>
  <p class="empty-text">Create your first one to get started.</p>
  <div class="empty-actions">
    <button class="btn primary">New invoice</button>
  </div>
</div>`)}`,
      )}

      ${section(
        "Reduced motion, and one cascade trap",
        `
        <p>
          tokens.css forces
          <code>animation-duration: 0.01ms !important</code> on everything under
          <code>prefers-reduced-motion</code>. That is right for a toast slide or
          a skeleton shimmer — and wrong for a spinner, which frozen reads as a
          broken page rather than a working one.
        </p>
        <p>
          So spinners get an exception: <strong>1.6s and still looping</strong> —
          slow enough not to trigger vestibular symptoms, alive enough to mean
          something.
        </p>
        <div class="alert warning">
          <div class="alert-icon" aria-hidden="true">!</div>
          <div class="alert-content">
            <strong>
              <code>!important</code> reverses layer order.
            </strong>
            <p>
              Normal declarations resolve later-layer-wins.
              <em>Important</em> ones resolve the other way — an
              <code>!important</code> in the first layer beats one in the last.
              So that exception has to live in tokens.css, beside the guard. Put
              it in feedback.css and the guard silently wins.
            </p>
          </div>
        </div>`,
      )}`;
}
function framePage() {
  const tokens = [
    ["--topbar-height", "3.5rem", "Topbar height"],
    ["--sidebar-width", "15rem", "Sidebar column width"],
    ["--screen-pad", "1.5rem", "Screen padding (1rem below md)"],
  ];

  return `
      ${pageHeader({
        eyebrow: "Structure",
        title: "App frame",
        lead: "The Frame and Page tiers — App, Shell, Topbar, Sidebar, Screen, Pane, View."
      })}

      ${section(
        "Anatomy",
        `
        <p>
          Shell is the only one that positions anything. The rest just claim a
          grid area, so Topbar, Sidebar and Screen stay usable on their own.
        </p>
        ${code(`<body class="app">
  <a class="skip-link" href="#screen">Skip to content</a>

  <div class="shell">
    <header class="topbar"> … </header>
    <nav class="sidebar" aria-label="Main"> … </nav>

    <main class="screen" id="screen" tabindex="-1">
      <section class="pane" aria-labelledby="billing-h">
        <div class="section-header">
          <h2 id="billing-h">Billing</h2>
        </div>
        <article class="card"> … </article>
      </section>
    </main>
  </div>
</body>`)}`,
      )}

      ${section(
        "Live shell",
        `
        ${preview(`
          <div class="shell" style="min-height: 260px; width: 100%; border: 1px solid var(--rule); border-radius: var(--card-radius); overflow: hidden">
            <header class="topbar" style="position: static">
              <strong>Acme Ops</strong>
              <div class="cluster">
                <span class="badge success">Live</span>
                <button class="btn">New invoice</button>
              </div>
            </header>
            <nav class="sidebar" aria-label="Demo">
              <ul class="items menu">
                <li class="item">Dashboard</li>
                <li class="item">Invoices</li>
                <li class="item">Customers</li>
              </ul>
            </nav>
            <main class="screen">
              <section class="pane">
                <div class="section-header">
                  <h3>Overview</h3>
                  <button class="btn outlined">Export</button>
                </div>
                <article class="card">A pane holding a card.</article>
              </section>
            </main>
          </div>`)}
        <p>
          Resize the window. Below <code>768px</code> the sidebar column
          collapses and the shell becomes one column — its contents belong in a
          <code>${esc('<dialog class="drawer">')}</code> at that size, which is a
          behavior and therefore the app&rsquo;s job, not a class&rsquo;s
          (Principle 6).
        </p>`,
      )}

      ${section(
        "Variants",
        `
        <div class="stack">
          <article class="card">
            <strong><code>.shell.sidebar-first</code></strong>
            <p>
              The sidebar runs the full height with the topbar beside it, rather
              than underneath a full-width topbar. Common when the sidebar
              carries the product identity.
            </p>
            ${code(`grid-template-areas:
  "sidebar topbar"
  "sidebar screen";`)}
          </article>
          <article class="card">
            <strong><code>.shell.viewport</code></strong>
            <p>
              The shell is exactly one viewport and the Screen scrolls inside it,
              instead of the document scrolling. The app-like mode — it costs you
              document-level scroll restoration, so it is opt-in.
            </p>
            <p>
              <strong>Renamed in v0.10.1</strong> — it was <code>.shell.fixed</code>,
              which is a name UnoCSS already owns. See <strong>Install</strong>.
            </p>
          </article>
        </div>`,
      )}

      ${section(
        "The one line that matters most",
        `
        ${code(`.screen { min-inline-size: 0; }`)}
        <div class="alert danger">
          <div class="alert-icon" aria-hidden="true">!</div>
          <div class="alert-content">
            <strong>Without it, one wide table scrolls your entire app.</strong>
            <p>
              Grid items default to <code>min-inline-size: auto</code>, so a wide
              child — a table, a long <code>&lt;pre&gt;</code>, an overflowing
              flex row — pushes its grid track wider than the viewport instead of
              scrolling inside itself. The sidebar then slides off screen and the
              whole layout moves sideways.
            </p>
          </div>
        </div>
        <p>
          Pair it with <code>.table-wrap</code> so the table scrolls in its own
          box. Any new grid child that can hold wide content needs the same
          treatment.
        </p>`,
      )}

      ${section(
        "Tokens",
        `
        <table class="table striped compact">
          <thead>
            <tr>
              <th style="width: 34%">Token</th>
              <th style="width: 16%">Default</th>
              <th>Controls</th>
            </tr>
          </thead>
          <tbody>
            ${tokens
              .map(
                ([t, d, c]) => `
            <tr>
              <td><code>${t}</code></td>
              <td><code>${d}</code></td>
              <td>${c}</td>
            </tr>`,
              )
              .join("")}
          </tbody>
        </table>`,
      )}

      ${section(
        "Pane and View",
        `
        <p>
          A <strong>Pane</strong> is a labelled major subdivision of a Screen —
          <code>&lt;section aria-labelledby&gt;</code>, 2rem of rhythm between
          siblings, none on the last. A <strong>View</strong> is one switchable
          panel inside a Pane, <code>${esc('<article role="tabpanel">')}</code>.
        </p>
        <div class="alert info">
          <div class="alert-icon" aria-hidden="true">&#9432;</div>
          <div class="alert-content">
            <strong><code>.view[hidden]</code> is restated on purpose.</strong>
            <p>
              A <code>[hidden]</code> element is <code>display: none</code> by UA
              default, but <em>any</em> <code>display</code> declaration beats
              that. A <code>.view</code> that ever gains a display value would
              stay visible while claiming to be hidden, so the rule is written
              out explicitly.
            </p>
          </div>
        </div>`,
      )}`;
}

/* ══════════════════════════════════════════════════════════════════════
   3. Pages — Half 2, the class taxonomy
   ══════════════════════════════════════════════════════════════════════ */

const KINDS = [
  [
    "Element",
    "onto valid markup",
    "Names what a thing is.",
    ".btn .pill .badge .card .alert .field .link .table .dialog .drawer .popover .toast .feed .rows .items .bar .disclosure",
  ],
  [
    "Treatment",
    "onto anything",
    "Orthogonal and element-agnostic. Works the same wherever you put it.",
    ".primary .secondary .muted .info .success .warning .danger  ·  .raised .outlined .ghost  ·  .text-*  ·  .stack .cluster .center .split",
  ],
  [
    "Density",
    "onto a region",
    "The only kind that INHERITS. A fact about a box, obeyed by everything inside it.",
    ".dense .roomy",
  ],
  [
    "Anatomy",
    "no — names a slot",
    "Names a position inside an Element. Nests, never chains.",
    ".alert-icon .alert-content  ·  .feed-item .feed-dot .feed-content  ·  .list-row .row-actions  ·  .disclosure-summary .disclosure-body  ·  .surface-header .surface-body .surface-footer",
  ],
];

function taxonomyPage() {
  return `
      ${pageHeader({
        eyebrow: 'Half 2 — Style',
        title: 'Kinds of class',
        lead: 'Utility-first, one level up. Four kinds of class — and only two of them compose freely.'
      })}

      ${section(
        'One level above Tailwind',
        `
        <p>
          Tailwind and UnoCSS utilities are <strong>one CSS property each</strong>.
          FrontierJS utilities are <strong>one UI concept each</strong>. Same
          composition model — chain single-purpose classes, no cascade fights, no
          per-page stylesheets — but the vocabulary sits at the element tier.
        </p>
        ${code(`Tailwind / Uno   class="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded
                        border border-red-600 text-red-600 bg-white"

FrontierJS       class="btn outlined danger"`)}
        <div class="alert warning">
          <div class="alert-icon" aria-hidden="true">!</div>
          <div class="alert-content">
            <strong>This is not a component framework.</strong>
            <p>
              In Bulma or Bootstrap, <code>is-primary</code> belongs to
              <code>.button</code> and means nothing anywhere else. Here
              <code>.danger</code> is free-standing — it works on a card, a
              <code>&lt;tr&gt;</code>, a field, a button, a link, a feed dot, and
              means the same thing on each. That property is the whole point.
            </p>
          </div>
        </div>`
      )}

      ${section(
        'The three kinds',
        `
        <table class="table">
          <thead>
            <tr>
              <th style="width: 14%">Kind</th>
              <th style="width: 16%">Composes</th>
              <th>What it is</th>
            </tr>
          </thead>
          <tbody>
            ${KINDS.map(
              ([kind, composes, what, examples]) => `
            <tr>
              <td><strong>${kind}</strong></td>
              <td>${composes}</td>
              <td>
                ${what}
                <div class="sg-kind-examples">
                  <code>${esc(examples)}</code>
                </div>
              </td>
            </tr>`
            ).join('')}
          </tbody>
        </table>
        <p>
          Element and Anatomy are two ends of one relationship: several Element
          classes carry an <strong>anatomy contract</strong>. <code>.alert</code>
          expects an icon and a content slot, <code>.feed</code> expects items with
          dots, <code>.disclosure</code> expects a summary and a body.
          <strong>Chaining is for Treatments; Anatomy nests.</strong>
        </p>`
      )}

      ${section(
        'The fourth group, said out loud',
        `
        <p>
          Some classes read like Treatments and are not. <code>.icon</code> only
          works on <code>.btn</code>, <code>.removable</code> only on
          <code>.pill</code>, <code>.striped</code> and <code>.compact</code> only
          on <code>.table</code>, <code>.divided</code> and <code>.hover</code>
          only on <code>.rows</code>, <code>.menu</code> only on
          <code>.items</code>.
        </p>
        <p>
          They are legitimate, but they are component modifiers living in a utility
          system. A short generic name promises free composition they do not have —
          which is exactly the naming problem still open in the system.
        </p>`
      )}`
}

/* ══════════════════════════════════════════════════════════════════════
   3. Pages — cascade layers
   ══════════════════════════════════════════════════════════════════════ */

const LAYERS = [
  ["tokens", ":root variable defaults, border-box, reduced-motion guard"],
  ["themes", ".theme-* overrides of those tokens"],
  ["tones", "the tone vocabulary — one variable per tone"],
  ["base", "the two lineage bases: chip (inline) and surface (block)"],
  ["layout", "composition helpers: stack, cluster, center, split"],
  ["components", "btn, pill, badge, card, field, table, dialog …"],
  ["patterns", "the Block tier: bar, list, feed, disclosure"],
  ["utilities", "the escape hatch: .text-* size and colour, .gap-*, .relative"],
  ["a11y", "the focus ring, .visually-hidden, .skip-link — last on purpose"],
];

function layersPage() {
  return `
      ${pageHeader({
        eyebrow: "Foundation",
        title: "Cascade layers",
        lead: "Layer order beats specificity. That turns 'don't reshuffle the imports' from a convention into a contract.",
      })}

      ${section(
        "The order",
        `
        ${code(`@layer tokens, themes, tones, base, layout,
       components, patterns, utilities, a11y;

@import './foundation/tokens.css' layer(tokens);
@import './themes/elite.css'      layer(themes);
@import './foundation/chip.css'   layer(base);
@import './components/buttons.css' layer(components);
@import './patterns/tabs.css'      layer(patterns);
@import './utilities.css'          layer(utilities);
@import './a11y/focus.css'         layer(a11y);`)}
        <p>
          The folders mirror the layers — <code>foundation/</code>,
          <code>themes/</code>, <code>components/</code>,
          <code>patterns/</code>, <code>a11y/</code> — so the tree teaches the
          order rather than competing with it. They are not a build input:
          there is no <code>src/</code> and no <code>dist/</code>, because the
          file you read is the file that ships.
        </p>
        <table class="table striped compact">
          <thead>
            <tr>
              <th style="width: 18%">Layer</th>
              <th>Holds</th>
            </tr>
          </thead>
          <tbody>
            ${LAYERS.map(
              ([name, holds]) => `
            <tr>
              <td><code>${name}</code></td>
              <td>${holds}</td>
            </tr>`,
            ).join("")}
          </tbody>
        </table>`,
      )}

      ${section(
        "What this buys you",
        `
        <div class="stack">
          <article class="card">
            <strong>Your CSS always wins.</strong>
            <p>
              Unlayered CSS beats every layer. Anything you write in your own app
              overrides this package by default — no <code>!important</code>, no
              specificity war, no <code>:not(:not(.x))</code> tricks.
            </p>
            ${code(`/* your app — plain, unlayered, wins */
td { background: var(--zebra); }`)}
          </article>
          <article class="card">
            <strong>Specificity still works inside a layer.</strong>
            <p>
              The <code>:where()</code> bases in chip.css and surface.css sit at
              zero specificity, so composites override them normally. Layers settle
              cross-file conflicts; specificity settles in-file ones.
            </p>
          </article>
          <article class="card">
            <strong>
              <code>layout</code> sits before <code>components</code> on purpose.
            </strong>
            <p>
              <code>.center</code> sets <code>display: grid</code> and
              <code>.bar</code> sets <code>display: flex</code>. Both are single
              class selectors, so specificity cannot separate them — the layer order
              does, and <code>.bar</code> wins.
            </p>
          </article>
        </div>`,
      )}`;
}

function iconsPage() {
  return `
      ${pageHeader({
        eyebrow: "Components",
        title: "Icons",
        lead: "The package sizes icons. It does not ship them. One rule, one token — replacing three hand-copied restatements that had drifted to three different sizes.",
      })}

      ${section(
        "It sizes, it does not supply",
        `
        <p>
          Bring your own glyphs — Iconify, Uno's <code>preset-icons</code>,
          inline <code>&lt;svg&gt;</code>, an <code>&lt;img&gt;</code>. The
          recognised shapes are an <code>&lt;svg&gt;</code>, an
          <code>&lt;img&gt;</code>, or any element whose class starts
          <code>i-heroicons</code>, which is what Uno's preset produces.
        </p>
        <div class="alert danger">
          <div class="alert-icon" aria-hidden="true">!</div>
          <div class="alert-content">
            <strong>This is not cosmetic.</strong>
            <p>
              An unsized <code>&lt;svg&gt;</code> defaults to
              <strong>300&times;150</strong>. An icon the package does not size
              does not look slightly wrong — it destroys the layout it is in.
            </p>
          </div>
        </div>`,
      )}

      ${section(
        "Two ways to get sized",
        `
        <p>
          <strong>1. Sit inside a component the package owns.</strong> A bare
          <code>&lt;svg&gt;</code> in a <code>.btn</code>, a
          <code>.navlink</code>, an <code>.alert-icon</code> and about twenty
          others is sized automatically, so existing markup needs no new class.
        </p>
        <p>
          <strong>2. Carry <code>.icon</code>.</strong> That works anywhere,
          including places the package has never heard of, and is the Icon
          vocabulary term proper.
        </p>
        ${code(`<svg class="icon" aria-hidden="true">…</svg>
<span class="icon i-heroicons:check" aria-hidden="true"></span>`)}
        ${preview(`
          <div class="cluster">
            <span class="badge info">
              <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <path d="M20 6L9 17l-5-5" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
              in a badge
            </span>
            <span>
              <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <circle cx="12" cy="12" r="9" />
                <path d="M12 8v5" stroke-linecap="round" />
              </svg>
              loose in a sentence, via .icon
            </span>
          </div>`)}`,
      )}

      ${section(
        "Size is a token, in em",
        `
        <p>
          <code>--icon-size</code> defaults to <code>1.15em</code>, so an icon
          tracks the text beside it rather than needing a size per context.
          Components that want a different ratio set the token instead of
          restating the rule — <code>.pill-close</code> uses
          <code>0.85em</code>, <code>.empty-icon</code> uses <code>1em</code>.
        </p>
        ${preview(`
          <div class="cluster" style="align-items: center">
            ${[
              ["text-xs", "xs"],
              ["text-sm", "sm"],
              ["text-md", "md"],
              ["text-lg", "lg"],
              ["text-xl", "xl"],
            ]
              .map(
                ([cls, label]) => `
            <span class="${cls}">
              <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <path d="M12 5v14M5 12h14" stroke-linecap="round" />
              </svg>
              ${label}
            </span>`,
              )
              .join("")}
            <span style="--icon-size: 2rem">
              <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <path d="M12 5v14M5 12h14" stroke-linecap="round" />
              </svg>
              token override
            </span>
          </div>`)}
        ${code(`.pill-close { --icon-size: 0.85em; }`)}`,
      )}

      ${section(
        "Icon-only buttons",
        `
        <p>
          <code>.btn.square</code> makes the button square via
          <code>aspect-ratio</code> with equal padding, so it scales with
          font-size. An icon-only button <strong>must</strong> carry an
          <code>aria-label</code> — there is no text for a screen reader to
          read.
        </p>
        <div class="alert warning">
          <div class="alert-icon" aria-hidden="true">!</div>
          <div class="alert-content">
            <strong>It was <code>.btn.icon</code> until v0.10.</strong>
            <p>
              The class shapes the <em>button</em>, and <code>.icon</code> now
              means "this element is an icon" — two different jobs on one name.
              A stale <code>.btn.icon</code> fails quietly outside this repo: it
              floors at 30&times;30 and looks roughly right while losing its
              <code>aspect-ratio</code> and padding.
            </p>
          </div>
        </div>
        ${preview(`
          <div class="cluster">
            <button class="btn square" aria-label="Add item">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M12 5v14M5 12h14" stroke-linecap="round" />
              </svg>
            </button>
            <button class="btn square danger" aria-label="Delete item">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M6 6l12 12M18 6L6 18" stroke-linecap="round" />
              </svg>
            </button>
            <button class="btn square outlined" aria-label="Settings">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="3" />
                <path d="M12 2v3M12 19v3M2 12h3M19 12h3" stroke-linecap="round" />
              </svg>
            </button>
            <button class="btn square ghost text-xl" aria-label="More">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" />
              </svg>
            </button>
          </div>`)}
        ${code(`<button class="btn square" aria-label="Add item">
  <span class="i-heroicons:plus" aria-hidden="true"></span>
</button>`)}`,
      )}

      ${section(
        "Decorative icons are hidden",
        `
        <p>
          An icon next to a text label adds nothing for a screen reader, so it
          gets <code>aria-hidden="true"</code>. The label already says what the
          button does. An icon-only control puts the name on the
          <em>control</em>, not on the icon.
        </p>
        ${preview(`
          <div class="cluster">
            <button class="btn success">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <path d="M20 6L9 17l-5-5" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
              Approve
            </button>
            <button class="btn outlined">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <path d="M21 12a9 9 0 11-6.2-8.6" stroke-linecap="round" />
              </svg>
              Retry
            </button>
          </div>`)}
        ${code(`<button class="btn success">
  <span class="i-heroicons:check" aria-hidden="true"></span>
  Approve
</button>`)}
        <p>
          There is no CSS for any of that — it is markup, and it is the half of
          the system that does not ship as a stylesheet.
        </p>`,
      )}

      ${section(
        "Why this is one rule now",
        `
        <p>
          Icon sizing used to live in the package three times, hand-copied and
          drifted:
        </p>
        <table class="table striped compact">
          <thead>
            <tr>
              <th style="width: 26%">File</th>
              <th style="width: 30%">Selector</th>
              <th>Size</th>
            </tr>
          </thead>
          <tbody>
            <tr><td><code>buttons.css</code></td><td><code>.btn.icon &gt; svg</code> + 2 more</td><td>1.15em, <code>width/height</code></td></tr>
            <tr><td><code>pills.css</code></td><td><code>.pill-close &gt; …</code></td><td>0.85em, <code>width/height</code></td></tr>
            <tr><td><code>feedback.css</code></td><td><code>.empty-icon &gt; …</code> — only <strong>two</strong> of the three shapes</td><td>1em, <code>inline-size</code></td></tr>
          </tbody>
        </table>
        <p>
          Three restatements of one rule, three different sizes, two different
          property spellings — and the missing branch meant an icon written
          <code>class="shrink-0 i-heroicons:inbox"</code> silently had no size
          inside an empty state. That is the four-focus-recipes problem in
          miniature, and it is why the size is a token now.
        </p>
        ${code(`:where(.btn, .square, .pill-close, .empty-icon, .alert-icon, .navlink, …)
  > :where(svg, img, [class^="i-heroicons"], [class*=" i-heroicons"]),
.icon {
  inline-size: var(--icon-size, 1.15em);
  block-size:  var(--icon-size, 1.15em);
  flex-shrink: 0;   /* an icon must never be what gives way in a flex row */
}`)}
        <p>
          <code>:where()</code> on both halves keeps the whole thing at zero
          specificity, so a component's own <code>--icon-size</code> wins, and
          so does anything you write. Adding a component that holds icons means
          adding its name to that list — the same explicit cost the surface and
          chip groups have.
        </p>`,
      )}`;
}
/* ══════════════════════════════════════════════════════════════════════
   3. Pages — Patterns, the Block tier
   ══════════════════════════════════════════════════════════════════════ */

function patternNote(body) {
  return `<p class="sg-pattern-note">${body}</p>`;
}

function barPage() {
  return `
      ${pageHeader({
        eyebrow: 'Patterns',
        title: 'Bar',
        lead: 'A horizontal strip. Layout only — no surface, no background, no border. Its sibling Toolbar is the same strip with a keyboard contract.'
      })}

      ${section(
        'Bar or Toolbar?',
        `
        <p>
          They render identically and they are not the same thing. The
          difference is a promise, not a pixel.
        </p>
        <table class="table striped compact">
          <thead>
            <tr>
              <th style="width: 18%">Term</th>
              <th style="width: 26%">Markup</th>
              <th>Use it when</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><strong>Bar</strong></td>
              <td><code>&lt;div class="bar"&gt;</code></td>
              <td>
                The strip holds a mixture — a heading, a count, a search box,
                a couple of buttons. No role, nothing promised.
              </td>
            </tr>
            <tr>
              <td><strong>Toolbar</strong></td>
              <td><code>&lt;div class="toolbar" role="toolbar"&gt;</code></td>
              <td>
                The strip is <em>all controls</em>, acting on one thing, and
                should be a single tab stop.
              </td>
            </tr>
          </tbody>
        </table>
        <div class="alert warning">
          <div class="alert-icon" aria-hidden="true">&#9888;</div>
          <div class="alert-content">
            <strong><code>role="toolbar"</code> is a promise about the keyboard.</strong>
            <p>
              It tells assistive tech this is one widget: <strong>Tab</strong>
              enters and leaves it once, and <strong>arrow keys</strong> move
              between the controls inside. The CSS cannot do that — same split
              as Tabs, Principle 6: visual treatment is a class, keyboard
              behaviour is a component. The app owes a roving
              <code>tabindex</code> (one control <code>0</code>, the rest
              <code>-1</code>), Left/Right, and Home/End.
            </p>
            <p>
              A toolbar that announces itself and then ignores an arrow key is
              <em>worse</em> than a plain Bar, because it has told the user a
              lie about how to operate it. Not providing the keys? Use
              <code>.bar</code>. Same strip, promises nothing.
            </p>
          </div>
        </div>
        ${preview(`
          <div class="toolbar" role="toolbar" aria-label="Formatting demo">
            <button class="btn ghost" tabindex="0">Bold</button>
            <button class="btn ghost" tabindex="-1">Italic</button>
            <button class="btn ghost" tabindex="-1">Underline</button>
          </div>`)}
        ${code(`<div class="toolbar" role="toolbar" aria-label="Formatting">
  <button class="btn ghost square" aria-label="Bold"     tabindex="0">…</button>
  <button class="btn ghost square" aria-label="Italic"   tabindex="-1">…</button>
  <button class="btn ghost square" aria-label="Underline" tabindex="-1">…</button>
</div>`)}
        <p>
          Defaults follow the meaning: a Bar splits (navigation one side,
          actions the other), a Toolbar packs to the start (its controls
          belong together). <code>.start</code>, <code>.center</code>,
          <code>.end</code> and <code>.bordered</code> work on both.
        </p>`
      )}

      ${section(
        'Default: split',
        `
        ${patternNote(`
          Action bars usually carry navigation on one side and actions on the
          other, so the default is <code>space-between</code>. Wrap each side in a
          <code>.cluster</code>.`)}
        ${preview(`
          <div class="bar">
            <div class="cluster">
              <button class="btn outlined">Back</button>
              <span class="badge muted">Draft</span>
            </div>
            <div class="cluster">
              <button class="btn ghost">Discard</button>
              <button class="btn primary">Publish</button>
            </div>
          </div>`)}
        ${code(`<div class="bar">
  <div class="cluster"> … left group … </div>
  <div class="cluster"> … right group … </div>
</div>`)}`
      )}

      ${section(
        'Alignment modifiers',
        `
        ${patternNote(`
          <code>.start</code>, <code>.center</code> and <code>.end</code> re-align
          a bar that has only one group.`)}
        ${preview(`
          <div class="stack">
            <div class="bar start">
              <div class="cluster">
                <button class="btn outlined">Filter</button>
                <button class="btn outlined">Sort</button>
              </div>
            </div>
            <div class="bar center">
              <div class="cluster">
                <button class="btn outlined">Prev</button>
                <button class="btn outlined">Next</button>
              </div>
            </div>
            <div class="bar end">
              <button class="btn primary">Save</button>
            </div>
          </div>`)}
        ${code(`<div class="bar start">  … </div>
<div class="bar center"> … </div>
<div class="bar end">    … </div>`)}`
      )}

      ${section(
        'Bordered',
        `
        ${patternNote(`
          Adds padding and a bottom rule, for a contained toolbar above content.`)}
        ${preview(`
          <div class="bar bordered">
            <strong>Invoices</strong>
            <button class="btn primary">New</button>
          </div>`)}
        ${code(`<div class="bar bordered"> … </div>`)}`
      )}`
}

function sectionHeaderPage() {
  return `
      ${pageHeader({
        eyebrow: "Patterns",
        title: "Section header",
        lead: "A heading paired with one trailing affordance. The canonical 'Tags [+]' pattern.",
      })}

      ${section(
        "Anatomy",
        `
        ${preview(`
          <div style="width: 100%">
            <div class="section-header">
              <h3 id="tags-h">Tags</h3>
              <button class="btn square" aria-label="Add tag">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M12 5v14M5 12h14" stroke-linecap="round" />
                </svg>
              </button>
            </div>
            <div class="cluster">
              <span class="pill info">design</span>
              <span class="pill success">shipped</span>
              <span class="pill muted">v2</span>
            </div>
          </div>`)}
        ${code(`<section aria-labelledby="tags-h">
  <div class="section-header">
    <h3 id="tags-h">Tags</h3>
    <button class="btn square" aria-label="Add tag">…</button>
  </div>
  <ul class="items"> … </ul>
</section>`)}
        ${patternNote(`
          The heading keeps its real level for the outline (Principle 3) and the
          <code>id</code> is what the surrounding <code>&lt;section&gt;</code>
          points at with <code>aria-labelledby</code>.`)}`,
      )}`;
}

function dividerPage() {
  return `
      ${pageHeader({
        eyebrow: "Patterns",
        title: "Divider label",
        lead: "A centered label on a horizontal rule. Day separators, 'OR' between options, section breaks.",
      })}

      ${section(
        "Usage",
        `
        ${preview(`
          <div class="stack" style="width: 100%">
            <div class="divider-label">
              <span>Thursday 05/21</span>
            </div>
            <div class="cluster">
              <span class="badge success">Paid</span>
              <span>Invoice #1042</span>
            </div>
            <div class="divider-label">
              <span>OR</span>
            </div>
            <button class="btn outlined">Continue with email</button>
          </div>`)}
        ${code(`<div class="divider-label"><span>Thursday 05/21</span></div>`)}
        ${patternNote(`
          The rules are <code>::before</code> and <code>::after</code> pseudo
          elements that flex to fill, so the label stays centered at any width.`)}`,
      )}`;
}

function itemsPage() {
  return `
      ${pageHeader({
        eyebrow: "Patterns",
        title: "Items",
        lead: "Lightweight list entries — contact methods, nav links, metadata. Minimal chrome.",
      })}

      ${section(
        "Plain items",
        `
        ${preview(`
          <ul class="items" style="width: 100%">
            <li class="item">
              <span class="badge info">Email</span>
              <span>ops@example.com</span>
            </li>
            <li class="item">
              <span class="badge muted">Phone</span>
              <span>+1 555 0134</span>
            </li>
            <li class="item">
              <span class="badge success">Site</span>
              <a class="link" href="#0">example.com</a>
            </li>
          </ul>`)}
        ${code(`<ul class="items">
  <li class="item"> … </li>
</ul>`)}`,
      )}

      ${section(
        "More than one line",
        `
        ${patternNote(`
          A search result, a command-palette row, a picker option — a title with a
          category under it and sometimes a snippet under that.
          <code>.item-text</code> stacks them, <code>.item-lead</code> is a fixed
          gutter in front, and the row switches to baseline alignment on its own
          once there is a lead, so the gutter sits opposite the title rather than
          the middle of the block.`)}
        ${preview(`
          <ul class="items menu" style="width: 100%">
            <li class="item">
              <span class="item-lead">section</span>
              <span class="item-text">
                <span class="item-title">Below 640px it stacks</span>
                <span class="item-sub">Facts</span>
                <span class="item-sub clamp-2">Two columns stop being worth it on a phone — the label column is either too narrow to read or too wide to leave room for the value beside it.</span>
              </span>
            </li>
            <li class="item">
              <span class="item-lead">term</span>
              <span class="item-text">
                <span class="item-title">Drawer</span>
                <span class="item-sub">Overlay</span>
              </span>
            </li>
          </ul>`)}
        ${code(`<li class="item">
  <span class="item-lead">section</span>
  <span class="item-text">
    <span class="item-title">Below 640px it stacks</span>
    <span class="item-sub">Facts</span>
    <span class="item-sub clamp-2">Two columns stop being worth&hellip;</span>
  </span>
</li>`)}
        ${patternNote(`
          The snippet clamps with <code>.clamp-2</code>, a utility rather than a
          part of Item: a snippet that grows makes the list jump as a query
          narrows, and that failure belongs to the list, not to the paragraph.
          <code>.item-text</code> can shrink below its content, so a long title
          ellipses instead of pushing the row wider.`)}`,
      )}

      ${section(
        "Menu variant",
        `
        ${patternNote(`
          <code>.items.menu</code> adds padding, a radius and a hover background —
          for interactive lists inside a popover or sidebar.`)}
        ${preview(`
          <ul class="items menu" style="width: 260px">
            <li class="item">Duplicate</li>
            <li class="item">Move to&hellip;</li>
            <li class="item">Archive</li>
          </ul>`)}
        ${code(`<ul class="items menu">
  <li class="item">Duplicate</li>
</ul>`)}
        <div class="alert warning">
          <div class="alert-icon" aria-hidden="true">!</div>
          <div class="alert-content">
            <strong>Interactive means focusable.</strong>
            <p>
              <code>.items.menu .item</code> only sets <code>cursor</code> and a
              hover background — an <code>&lt;li&gt;</code> is not focusable and
              takes no keyboard input. If the entries are actionable, put a
              <code>&lt;button&gt;</code> or <code>&lt;a&gt;</code> inside, or give
              the list real <code>role="menu"</code> behavior in a component
              (Principle 6).
            </p>
          </div>
        </div>`,
      )}`;
}

function rowsPage() {
  const tasks = ["Ship the release notes", "Rotate API keys", "Archive Q3 invoices"];

  return `
      ${pageHeader({
        eyebrow: "Patterns",
        title: "Rows",
        lead: "Record entries with a content area and trailing actions. Checklists, settings rows, admin lists.",
      })}

      ${section(
        "Naming",
        patternNote(`
          The vocabulary term is <strong>Row</strong>, but the class is
          <code>.list-row</code> — <code>.row</code> would collide with Bootstrap's
          grid. The concept and the class name diverge on purpose.`),
      )}

      ${section(
        "Divided",
        `
        ${preview(
          `<ul class="rows divided" style="width: 100%">
            ${tasks
              .map(
                (label, i) => `
            <li class="list-row">
              <label class="field-check">
                <input type="checkbox"${i === 0 ? " checked" : ""}>
                <span>${label}</span>
              </label>
              <div class="row-actions">
                <button class="btn square ghost" aria-label="Edit ${label}">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M4 20h4L20 8l-4-4L4 16v4z" stroke-linejoin="round" />
                  </svg>
                </button>
              </div>
            </li>`,
              )
              .join("")}
          </ul>`,
        )}
        ${code(`<ul class="rows divided">
  <li class="list-row">
    <label class="field-check"> … </label>
    <div class="row-actions">
      <button class="btn square ghost" aria-label="Edit">…</button>
    </div>
  </li>
</ul>`)}`,
      )}

      ${section(
        "Hover",
        `
        ${patternNote(`
          <code>.rows.hover</code> highlights on hover, for rows that are
          themselves clickable. Same caveat as Items — make the target a real
          control.`)}
        ${preview(`
          <ul class="rows hover" style="width: 100%">
            <li class="list-row">
              <span>Billing</span>
              <span class="badge success">Active</span>
            </li>
            <li class="list-row">
              <span>Notifications</span>
              <span class="badge muted">Off</span>
            </li>
          </ul>`)}
        ${code(`<ul class="rows hover"> … </ul>`)}`,
      )}`;
}

function feedPage() {
  const entries = [
    ["success", "2 days ago", "Form response added"],
    ["info", "3 days ago", "Assigned to Dana"],
    ["warning", "5 days ago", "SLA warning raised"],
    ["muted", "1 week ago", "Ticket created"],
  ];

  return `
      ${pageHeader({
        eyebrow: "Patterns",
        title: "Feed",
        lead: "A chronological event stream plotted on a connecting timeline.",
      })}

      ${section(
        "Anatomy",
        `
        ${patternNote(`
          An <code>&lt;ol&gt;</code>, because chronological order is semantically
          meaningful. Each entry is wrapped in an <code>&lt;article&gt;</code>
          because each is a self-contained event (Principle 2). The dot reads
          <code>--bg-mix</code>, so any tone class colors it.`)}
        ${preview(
          `<ol class="feed" style="width: 100%">
            ${entries
              .map(
                ([tone, when, what]) => `
            <li>
              <article class="feed-item">
                <span class="feed-dot ${tone}" aria-hidden="true"></span>
                <div class="feed-content">
                  <div class="text-muted text-sm">${when}</div>
                  <div>${what}</div>
                </div>
              </article>
            </li>`,
              )
              .join("")}
          </ol>`,
        )}
        ${code(`<ol class="feed">
  <li>
    <article class="feed-item">
      <span class="feed-dot success" aria-hidden="true"></span>
      <div class="feed-content">
        <div class="text-muted text-sm">2 days ago</div>
        <div>Form response added</div>
      </div>
    </article>
  </li>
</ol>`)}`,
      )}

      ${section(
        "The connecting line",
        patternNote(`
          The line is an <code>::after</code> on <code>.feed-item</code>, hidden on
          the last entry. Its geometry is tuned to the dot — worth eyeballing if
          entry heights vary a lot, or in the Elite theme where radii are zero.`),
      )}`;
}

function disclosurePage() {
  return `
      ${pageHeader({
        eyebrow: "Patterns",
        title: "Disclosure",
        lead: "Expand and collapse on native &lt;details&gt; / &lt;summary&gt;. Keyboard, focus and toggle state are all platform-provided.",
      })}

      ${section(
        "Usage",
        `
        ${preview(`
          <div class="stack" style="width: 100%">
            <details class="disclosure" open>
              <summary class="disclosure-summary">
                <span>To Do</span>
                <span class="text-muted">1 / 3</span>
              </summary>
              <div class="disclosure-body">
                <ul class="rows divided">
                  <li class="list-row">
                    <label class="field-check">
                      <input type="checkbox" checked>
                      <span>Draft the changelog</span>
                    </label>
                  </li>
                  <li class="list-row">
                    <label class="field-check">
                      <input type="checkbox">
                      <span>Tag the release</span>
                    </label>
                  </li>
                </ul>
              </div>
            </details>
            <details class="disclosure">
              <summary class="disclosure-summary">
                <span>Archived</span>
                <span class="text-muted">12</span>
              </summary>
              <div class="disclosure-body">Nothing to see here.</div>
            </details>
          </div>`)}
        ${code(`<details class="disclosure" open>
  <summary class="disclosure-summary">
    <span>To Do</span>
    <span class="text-muted">1 / 3</span>
  </summary>
  <div class="disclosure-body"> … </div>
</details>`)}`,
      )}

      ${section(
        "Principle 4 in one component",
        `
        <p>
          No JavaScript, no <code>aria-expanded</code> to keep in sync, no focus
          management, no keyboard handler. The caret is a CSS-drawn box rotated on
          <code>[open]</code>, so there is no icon dependency either. This is what
          "native elements over reinvention" buys.
        </p>`,
      )}`;
}
/* ══════════════════════════════════════════════════════════════════════
   3. Pages — Responsive & Accessibility
   ══════════════════════════════════════════════════════════════════════ */

const BREAKPOINTS = [
  ["sm", "640px", "large phone, landscape"],
  ["md", "768px", "tablet — container gutter steps to 1.5rem"],
  ["lg", "1024px", "small laptop"],
  ["xl", "1280px", "desktop — container gutter steps to 2rem"],
  ["2xl", "1536px", "wide desktop"],
];

function responsivePage() {
  return `
      ${pageHeader({
        eyebrow: "Utilities",
        title: "Responsive",
        lead: "A breakpoint scale, a container, and a scroll wrapper for tables.",
      })}

      ${section(
        "The scale",
        `
        <table class="table striped compact">
          <thead>
            <tr>
              <th style="width: 12%">Name</th>
              <th style="width: 16%">Min width</th>
              <th>Used for</th>
            </tr>
          </thead>
          <tbody>
            ${BREAKPOINTS.map(
              ([n, w, use]) => `
            <tr>
              <td><code>${n}</code></td>
              <td><code>${w}</code></td>
              <td>${use}</td>
            </tr>`,
            ).join("")}
          </tbody>
        </table>
        <div class="alert warning">
          <div class="alert-icon" aria-hidden="true">!</div>
          <div class="alert-content">
            <strong>These are not custom properties, on purpose.</strong>
            <p>
              <code>@media (min-width: var(--bp-md))</code> does not work and
              never has — a custom property cannot be used in a media query.
              Shipping <code>--bp-*</code> tokens would look themable and
              silently do nothing, so the numbers are written literally wherever
              the package needs them and documented here so you can match.
            </p>
          </div>
        </div>
        <p>
          The scale is Tailwind&rsquo;s, which is also UnoCSS&rsquo;s default. If
          you still run Uno for atomic utilities alongside this package, you get
          one set of breakpoints rather than two that nearly agree.
        </p>`,
      )}

      ${section(
        "Container",
        `
        <p>
          Centers content, holds it to a readable width, and steps its gutters up
          at <code>768px</code> and <code>1280px</code>. What <em>is</em> themable
          is the outcome — <code>--container-max</code>,
          <code>--container-narrow</code> and <code>--container-pad</code> are
          ordinary tokens, so a theme can change the page width without touching
          a media query.
        </p>
        ${code(`<div class="container">        <!-- page width, 1280px cap -->
<div class="container narrow"> <!-- prose width, 768px cap -->
<div class="container wide">   <!-- full bleed, gutters only -->`)}
        ${preview(`
          <div style="width: 100%; display: grid; gap: 8px">
            <div class="container" style="background: var(--surface-sunken); padding-block: 10px">
              <span class="badge muted">container</span>
            </div>
            <div class="container narrow" style="background: var(--surface-sunken); padding-block: 10px">
              <span class="badge muted">narrow</span>
            </div>
          </div>`)}
        ${code(`:root {
  --container-max:    1280px;
  --container-narrow: 768px;
  --container-pad:    1rem;
}
@media (min-width: 768px)  { .container { --container-pad: 1.5rem; } }
@media (min-width: 1280px) { .container { --container-pad: 2rem;   } }`)}`,
      )}

      ${section(
        "Tables need a wrapper",
        `
        <p>
          A <code>&lt;table&gt;</code> cannot scroll itself — <code>overflow</code>
          on a table does nothing, and forcing <code>display: block</code> to make
          it work destroys the table layout algorithm. So the scroll lives on a
          wrapper, which is why <code>.table-wrap</code> is an
          <strong>Anatomy</strong> class and not a modifier on
          <code>.table</code>.
        </p>
        ${code(`<div class="table-wrap">
  <table class="table"> … </table>
</div>`)}
        <div class="alert danger">
          <div class="alert-icon" aria-hidden="true">!</div>
          <div class="alert-content">
            <strong>Without it, a wide table takes the page with it.</strong>
            <p>
              The table overflows its parent, the parent overflows the body, and
              the whole layout scrolls sideways on mobile. This was the single
              most likely way the system broke on a phone.
            </p>
          </div>
        </div>`,
      )}`;
}

function accessibilityPage() {
  return `
      ${pageHeader({
        eyebrow: "Utilities",
        title: "Accessibility",
        lead: "Two primitives the system had none of: hide something visually but not from a screen reader, and let a keyboard user skip the chrome.",
      })}

      ${section(
        "Visually hidden",
        `
        <p>
          For text a screen reader must read and a sighted user must not see: the
          real label on an icon-only control, a table caption, a status region,
          the word &ldquo;current&rdquo; in a breadcrumb.
        </p>
        ${code(`<button class="btn square">
  <svg aria-hidden="true">…</svg>
  <span class="visually-hidden">Delete invoice</span>
</button>`)}
        <div class="alert danger">
          <div class="alert-icon" aria-hidden="true">!</div>
          <div class="alert-content">
            <strong>
              Not <code>display: none</code>, not <code>visibility: hidden</code>.
            </strong>
            <p>
              Both of those remove the element from the accessibility tree as
              well as the screen, which defeats the entire purpose. The class
              uses a clipped 1&times;1 box that still participates in the a11y
              tree.
            </p>
          </div>
        </div>
        ${code(`.visually-hidden {
  position:    absolute;
  width:       1px;
  height:      1px;
  padding:     0;
  margin:      -1px;
  border:      0;
  overflow:    hidden;
  clip-path:   inset(50%);   /* not the deprecated clip: rect(…) */
  white-space: nowrap;
}`)}
        <p>
          It lives in the <code>a11y</code> layer, declared after every other
          layer, so nothing in the package can outrank it on
          position/size/clip — which is why it needs no
          <code>!important</code>. Your own unlayered CSS still overrides it, and
          that is correct: if you deliberately restyle it, you should win.
        </p>`,
      )}

      ${section(
        "Reveal on focus",
        `
        <p>
          Add <code>.focusable</code> for content that should stay hidden until a
          keyboard user reaches it. Tab into the preview below.
        </p>
        ${preview(`
          <span class="visually-hidden focusable" tabindex="0">
            You found me — I was visually hidden until focused.
          </span>
          <span class="text-muted text-sm">
            (tab here — a hidden element sits to the left)
          </span>`)}
        ${code(`<span class="visually-hidden focusable" tabindex="0"> … </span>`)}`,
      )}

      ${section(
        "Skip link",
        `
        <p>
          The first focusable thing in the document, so a keyboard user can jump
          past the Topbar and Sidebar instead of tabbing through them on every
          page. Off-screen until focused, then it slides in.
        </p>
        ${code(`<body>
  <a class="skip-link" href="#main">Skip to content</a>
  …
  <main id="main" tabindex="-1"> … </main>`)}
        <div class="alert info">
          <div class="alert-icon" aria-hidden="true">&#9432;</div>
          <div class="alert-content">
            <strong>
              The <code>tabindex="-1"</code> on the target matters.
            </strong>
            <p>
              Without it some browsers move the visual viewport but not the
              focus, so the next Tab resumes from the skip link instead of the
              content — which makes the skip link do nothing useful.
            </p>
          </div>
        </div>`,
      )}

      ${section(
        "What is still missing",
        `
        <p>
          Honest gaps: four components use four different focus-ring recipes,
          and <code>.items.menu .item</code> is styled to look clickable on a
          non-focusable <code>&lt;li&gt;</code>. Both are on the list.
        </p>`,
      )}`;
}

/* ══════════════════════════════════════════════════════════════════════
   3. Pages — the v0.8 terms
   ══════════════════════════════════════════════════════════════════════ */

function avatarPage() {
  return `
      ${pageHeader({
        eyebrow: "Components",
        title: "Avatar",
        lead: "The person — or org, or bot — marker. Two forms, one token for size, and an accessibility decision that goes wrong in both directions.",
      })}

      ${section(
        "Two forms",
        `
        <p>
          An image carries its own name in <code>alt</code> and needs nothing
          else. Initials are a fill with text on top, so
          <code>.avatar</code> is in the <strong>chip lineage</strong> — it
          inherits the same auto-contrast machinery as <code>.btn</code>, which
          means initials clear AA on any hue a theme can define.
        </p>
        ${preview(`
          <div class="cluster">
            <span class="avatar" aria-hidden="true">DO</span>
            <span class="avatar primary" aria-hidden="true">SR</span>
            <span class="avatar success" aria-hidden="true">AC</span>
            <span class="avatar warning" aria-hidden="true">JL</span>
            <span class="avatar danger" aria-hidden="true">MK</span>
          </div>`)}
        ${code(`<img class="avatar" src="/u/12.jpg" alt="Dana Ortiz">

<span class="avatar primary" aria-hidden="true">DO</span>`)}`,
      )}

      ${section(
        "The accessibility decision",
        `
        <p>
          Nine times out of ten an initials avatar is a fallback rendering of a
          name that is <em>already on screen</em> — beside the name in a list
          row, inside a cell whose row is labelled. Announcing "D O" there is
          noise, so the default is <code>aria-hidden</code>.
        </p>
        <p>
          When the avatar stands alone and <em>is</em> the only identification,
          give it the real name instead:
        </p>
        ${code(`<span class="avatar" role="img" aria-label="Dana Ortiz">DO</span>`)}
        <div class="alert warning">
          <div class="alert-icon" aria-hidden="true">!</div>
          <div class="alert-content">
            <strong>This is the common avatar bug, in both directions.</strong>
            <p>
              A wall of unlabelled images, or a screen reader spelling out
              initials after every name it just read. Neither is visible on
              screen, which is why the rule is written down rather than left to
              taste.
            </p>
          </div>
        </div>`,
      )}

      ${section(
        "Size is one token, not a size class",
        `
        <p>
          <code>--avatar-size</code> drives the box and the font size together,
          so one value resizes the whole thing. There is deliberately no
          <code>.sm</code>/<code>.lg</code> — those would be scoped modifiers
          with maximally generic names, the exact liability the
          <strong>Kinds of class</strong> page flags, and each would need a
          matching font size anyway.
        </p>
        ${preview(`
          <div class="cluster" style="align-items: center">
            <span class="avatar" style="--avatar-size: 1.25rem" aria-hidden="true">XS</span>
            <span class="avatar" style="--avatar-size: 1.75rem" aria-hidden="true">SM</span>
            <span class="avatar" aria-hidden="true">MD</span>
            <span class="avatar" style="--avatar-size: 3rem" aria-hidden="true">LG</span>
            <span class="avatar" style="--avatar-size: 4rem" aria-hidden="true">XL</span>
            <span class="avatar primary" style="--avatar-size: 3rem; --avatar-radius: 8px" aria-hidden="true">SQ</span>
          </div>`)}
        ${code(`<span class="avatar" style="--avatar-size: 1.5rem">DO</span>

.comment-avatar { --avatar-size: 1.5rem; }

/* --avatar-radius squares it off; a theme can do that globally */`)}`,
      )}

      ${section(
        "Avatars — the overlapping group",
        `
        ${preview(`
          <div class="avatars" role="group" aria-label="Assignees">
            <span class="avatar primary" aria-hidden="true">DO</span>
            <span class="avatar success" aria-hidden="true">SR</span>
            <span class="avatar warning" aria-hidden="true">AC</span>
            <span class="avatar muted" role="img" aria-label="3 more">+3</span>
          </div>`)}
        ${code(`<div class="avatars" role="group" aria-label="Assignees">
  <img class="avatar" src="/u/12.jpg" alt="Dana Ortiz">
  <img class="avatar" src="/u/48.jpg" alt="Sam Ruiz">
  <span class="avatar" role="img" aria-label="3 more">+3</span>
</div>`)}
        <p>
          The separating ring is an inset <code>box-shadow</code>, not a border
          — a border would eat into <code>--avatar-size</code> and make a
          grouped avatar smaller than a lone one at the same token value. It is
          <code>--surface</code> coloured; on a tinted surface set
          <code>--avatar-ring</code> to match.
        </p>
        ${preview(`
          <div class="cluster" style="align-items: center; gap: 2rem">
            <div class="avatars" style="--avatar-overlap: 0">
              <span class="avatar" aria-hidden="true">A</span>
              <span class="avatar" aria-hidden="true">B</span>
              <span class="avatar" aria-hidden="true">C</span>
            </div>
            <div class="avatars" style="--avatar-overlap: 1rem">
              <span class="avatar info" aria-hidden="true">A</span>
              <span class="avatar info" aria-hidden="true">B</span>
              <span class="avatar info" aria-hidden="true">C</span>
            </div>
          </div>`)}
        <p>
          <code>--avatar-overlap: 0</code> gives a plain spaced row. There is no
          hover fan-out on purpose: it shifts layout under the pointer, and the
          group usually sits inside a row that is itself a click target.
        </p>`,
      )}`;
}

function factsPage() {
  return `
      ${pageHeader({
        eyebrow: "Patterns",
        title: "Facts",
        lead: "The label/value list a detail screen is mostly made of. A real &lt;dl&gt;, with no Anatomy classes at all.",
      })}

      ${section(
        "Structure",
        `
        ${preview(`
          <dl class="facts" style="width: 100%">
            <dt>Customer</dt>
            <dd>Acme Corp</dd>
            <dt>Invoice</dt>
            <dd>INV-1042</dd>
            <dt>Status</dt>
            <dd><span class="badge success">Paid</span></dd>
            <dt>Owner</dt>
            <dd class="cluster">
              <span class="avatar primary" style="--avatar-size: 1.25rem" aria-hidden="true">DO</span>
              Dana Ortiz
            </dd>
            <dt>A deliberately long label that has to wrap</dt>
            <dd>The column caps at 40% rather than growing to fit.</dd>
          </dl>`)}
        ${code(`<dl class="facts">
  <dt>Customer</dt>
  <dd>Acme Corp</dd>

  <dt>Status</dt>
  <dd><span class="badge success">Paid</span></dd>
</dl>`)}
        <p>
          <code>&lt;dl&gt;</code> is the whole point. A pile of divs with a bold
          span makes the pairing visual only; a description list announces
          "Customer, Acme Corp" as an associated pair and lets a screen reader
          user move between terms. It is one of the few elements left that does
          semantic work no ARIA pattern replaces.
        </p>`,
      )}

      ${section(
        "No Anatomy classes, on purpose",
        `
        <p>
          There is no <code>.fact-label</code> or <code>.fact-value</code>:
          <code>&lt;dt&gt;</code> and <code>&lt;dd&gt;</code> already name those
          positions. Adding classes would be Principle 1 violated for no gain,
          and would let markup drift from meaning the moment someone put
          <code>.fact-label</code> on something that is not a
          <code>&lt;dt&gt;</code>.
        </p>
        <div class="alert info">
          <div class="alert-icon" aria-hidden="true">&#9432;</div>
          <div class="alert-content">
            <strong>The cost: no wrapper per pair.</strong>
            <p>
              The grid targets direct children, so a <code>&lt;div&gt;</code>
              around each <code>dt</code>/<code>dd</code> breaks the layout.
              That is deliberate — the <code>&lt;dl&gt;</code> is the wrapper.
            </p>
          </div>
        </div>`,
      )}

      ${section(
        "Divided",
        `
        <p>
          Same modifier name and meaning as <code>.rows.divided</code>. Long
          lists on a detail pane read much better ruled.
        </p>
        ${preview(`
          <dl class="facts divided" style="width: 100%">
            <dt>Created</dt>
            <dd>12 Mar 2026</dd>
            <dt>Due</dt>
            <dd>26 Mar 2026</dd>
            <dt>Terms</dt>
            <dd>Net 14</dd>
            <dt>Amount</dt>
            <dd><strong>$4,200.00</strong></dd>
          </dl>`)}
        ${code(`<dl class="facts divided"> … </dl>`)}
        <p>
          The column gap has to go for this, and the label carries it as padding
          instead: <strong>a border cannot span a grid gap</strong>, so with one
          the rule comes out as two disconnected segments with a hole between
          the columns — obvious on screen, and invisible to a test that only
          asks whether a border exists.
        </p>`,
      )}

      ${section(
        "Below 640px it stacks",
        `
        <p>
          Two columns stop being worth it on a phone — the label column is
          either too narrow to read or too wide to leave room for the value. It
          stacks, and the pair spacing tightens so a stacked pair still reads as
          one unit rather than two rows. Narrow this window to see it.
        </p>
        ${code(`--fact-label-max: 40%;   /* how wide the label column may grow */`)}
        <p>
          That cap is <code>fit-content(40%)</code>, which is the track function
          that means "size to content, but stop there". The obvious-looking
          <code>min(max-content, 40%)</code> does not work and
          <strong>fails silently</strong>: <code>min()</code> takes a
          length-percentage, <code>max-content</code> is not one, so the whole
          declaration is invalid and the grid quietly collapses to one column.
        </p>`,
      )}`;
}

function stepsPage() {
  return `
      ${pageHeader({
        eyebrow: "Patterns",
        title: "Steps",
        lead: "The multi-stage flow indicator — onboarding, checkout, a wizard, an approval chain. An &lt;ol&gt;, because the sequence is the meaning.",
      })}

      ${section(
        "Structure",
        `
        ${preview(`
          <ol class="steps" aria-label="Checkout progress" style="width: 100%">
            <li class="step complete">
              <span class="step-marker"></span>
              <span class="step-label">Cart<span class="visually-hidden"> — completed</span></span>
            </li>
            <li class="step" aria-current="step">
              <span class="step-marker"></span>
              <span class="step-label">Shipping</span>
              <span class="step-hint">Address &amp; delivery</span>
            </li>
            <li class="step">
              <span class="step-marker"></span>
              <span class="step-label">Payment</span>
            </li>
          </ol>`)}
        ${code(`<ol class="steps" aria-label="Checkout progress">
  <li class="step complete">
    <span class="step-marker"></span>
    <span class="step-label">Cart<span class="visually-hidden"> — completed</span></span>
  </li>
  <li class="step" aria-current="step">
    <span class="step-marker"></span>
    <span class="step-label">Shipping</span>
    <span class="step-hint">Address & delivery</span>
  </li>
  <li class="step">
    <span class="step-marker"></span>
    <span class="step-label">Payment</span>
  </li>
</ol>`)}
        <p>
          <code>&lt;ol&gt;</code> because a screen reader announcing "list of 3
          items" and a position is most of what a stepper communicates.
          <code>&lt;li&gt;</code> per step, so each is a Row in the vocabulary's
          sense, not a Card.
        </p>`,
      )}

      ${section(
        "The current step comes from ARIA — completion does not",
        `
        <p>
          <code>aria-current="step"</code> is a real ARIA token and exactly this
          case, so it drives the styling — the same rule tabs, breadcrumbs and
          pagination follow.
        </p>
        <div class="alert danger">
          <div class="alert-icon" aria-hidden="true">!</div>
          <div class="alert-content">
            <strong>There is no ARIA token for "done".</strong>
            <p>
              <code>.complete</code> is a styling hook with nothing behind it,
              which means the checkmark is <em>invisible to a screen reader</em>:
              a sighted user sees three states, a screen reader user hears two.
              This is the one place in the package where the visual state cannot
              be derived from the markup, so it is the one place the markup has
              to say it twice.
            </p>
          </div>
        </div>
        ${code(`<span class="step-label">Cart<span class="visually-hidden"> — completed</span></span>`)}`,
      )}

      ${section(
        "Markers number themselves",
        `
        <p>
          An empty <code>.step-marker</code> numbers itself with a CSS counter,
          so the markup does not carry indices that go stale the moment a step
          is inserted. Put anything inside — a checkmark, an icon — and that
          wins instead. The marker is decorative either way; the label is what
          is read.
        </p>
        ${preview(`
          <ol class="steps success" aria-label="Tone demo" style="width: 100%">
            <li class="step complete">
              <span class="step-marker">✓</span>
              <span class="step-label">Own glyph<span class="visually-hidden"> — completed</span></span>
            </li>
            <li class="step" aria-current="step">
              <span class="step-marker"></span>
              <span class="step-label">Self-numbered</span>
            </li>
            <li class="step">
              <span class="step-marker"></span>
              <span class="step-label">Also self-numbered</span>
            </li>
          </ol>`)}
        <p>
          A tone on <code>.steps</code> travels down as
          <code>--step-accent</code>, the same inheriting-property trick tabs
          and tables use — <code>--bg-mix</code> is element-scoped and would not
          reach the markers.
        </p>`,
      )}

      ${section(
        "Vertical",
        `
        <p>
          <code>.steps.vertical</code> turns the connectors 90°. Good for a
          sidebar, an approval chain, or any flow with hints long enough that
          the horizontal form runs out of room.
        </p>
        ${preview(`
          <ol class="steps vertical" aria-label="Approval chain" style="width: 100%; max-width: 24rem">
            <li class="step complete">
              <span class="step-marker"></span>
              <span class="step-label">Submitted<span class="visually-hidden"> — completed</span></span>
              <span class="step-hint">by Dana Ortiz, 12 Mar</span>
            </li>
            <li class="step complete">
              <span class="step-marker"></span>
              <span class="step-label">Manager review<span class="visually-hidden"> — completed</span></span>
              <span class="step-hint">Approved 13 Mar</span>
            </li>
            <li class="step" aria-current="step">
              <span class="step-marker"></span>
              <span class="step-label">Finance</span>
              <span class="step-hint">Waiting — usually 2 business days</span>
            </li>
            <li class="step">
              <span class="step-marker"></span>
              <span class="step-label">Payment scheduled</span>
            </li>
          </ol>`)}
        ${code(`<ol class="steps vertical" aria-label="Approval chain"> … </ol>`)}`,
      )}`;
}

function codePage() {
  return `
      ${pageHeader({
        eyebrow: "Components",
        title: "Code & Kbd",
        lead: "Two Inline-tier terms that are mostly element selectors: a &lt;kbd&gt; is a key, and a code block is a &lt;pre&gt; holding a &lt;code&gt;.",
      })}

      ${section(
        "Inline code",
        `
        <p>
          Styled on the element as well as the class, because
          <code>&lt;code&gt;</code> already means exactly this. Sized in
          <code>em</code>, so it shrinks with whatever it sits in.
        </p>
        ${preview(`
          <p style="margin: 0">
            Run <code>bun run test</code> to check it, or set
            <code class="code-inline">--icon-size</code> on the component.
          </p>`)}
        ${code(`an inline <code>identifier</code>
<span class="code-inline">for markup that cannot use the element</span>`)}`,
      )}

      ${section(
        "Code block",
        `
        ${preview(`
          <pre class="code" style="width: 100%"><code>bun add @frontierjs/css
bun run demo

# a deliberately long line, to show that it scrolls in its own box rather than taking the page sideways with it</code></pre>`)}
        ${code(`<pre class="code"><code>bun run test</code></pre>`)}
        <p>
          <code>&lt;pre&gt;</code> is what preserves the whitespace; the class
          only dresses it. The nested <code>&lt;code&gt;</code> is not optional
          decoration either — it is what says "this is code" rather than "this
          is preformatted text", and screen readers and search engines both use
          the distinction.
        </p>
        <div class="alert danger">
          <div class="alert-icon" aria-hidden="true">!</div>
          <div class="alert-content">
            <strong>A code block must scroll in its own box.</strong>
            <p>
              Without <code>overflow-x</code>, one long line pushes its grid
              track wider than the viewport and takes the whole page sideways —
              the same failure <code>.table-wrap</code> exists to prevent, and
              the reason <code>.screen</code> sets
              <code>min-inline-size: 0</code>. Long lines scroll here; they do
              not silently wrap and renumber themselves.
            </p>
          </div>
        </div>
        <p>
          Inside a block, the inline treatment would double the background, so
          <code>.code &gt; code</code> resets it.
        </p>`,
      )}

      ${section(
        "Syntax highlighting",
        `
        <p>
          Every sample on this site is highlighted by <code>glow()</code> from
          <code>@frontierjs/utils</code>. It marks each token with the element
          that already means it — <code>&lt;em&gt;</code> for a value,
          <code>&lt;sup&gt;</code> for a comment — and wraps the block in
          <code>&lt;code language="css"&gt;</code>. So the theme in
          <code>code.css</code> is element selectors and one attribute: it
          ships no class, adds nothing to the vocabulary, and themes any
          highlighter that emits the same shape.
        </p>
        ${preview(
          '<pre class="code" style="width: 100%">' +
            glow(
              `/* the tone is the whole contract */
.card.danger {
  --bg-mix:     var(--color-danger);
  background:   color-mix(in srgb, var(--bg-mix) 10%, var(--surface));
  border-color: #f4403a;
}

@media (prefers-reduced-motion: reduce) {
  .toast { animation: none !important; }
}`,
              { language: 'css', prefix: false }
            ) +
            '</pre>'
        )}
        <div class="table-wrap">
          <table class="table compact">
            <thead>
              <tr><th>Element</th><th>Marks</th><th>Colour</th></tr>
            </thead>
            <tbody>
              <tr><td><code>&lt;sup&gt;</code></td><td>comment</td><td><code>--code-comment</code>, else <code>--ink-mute</code></td></tr>
              <tr><td><code>&lt;i&gt;</code></td><td>punctuation</td><td><code>--code-punct</code>, else <code>--ink-mute</code></td></tr>
              <tr><td><code>&lt;b&gt;</code></td><td>identifier — property, function, key</td><td><code>--code-name</code>, else <code>--color-primary</code></td></tr>
              <tr><td><code>&lt;em&gt;</code></td><td>value — string, number, custom property</td><td><code>--code-value</code>, else <code>--color-success</code></td></tr>
              <tr><td><code>&lt;strong&gt;</code></td><td>keyword, tag name, hex colour</td><td><code>--code-keyword</code>, else a hue off <code>--color-primary</code></td></tr>
              <tr><td><code>&lt;label&gt;</code></td><td><code>@rule</code>, decorator, <code>!important</code></td><td><code>--code-special</code>, else <code>--color-danger</code></td></tr>
            </tbody>
          </table>
        </div>
        <p>
          None of those six is a literal colour: each is a tone read through a
          <code>--code-*</code> override with the tone as the fallback, so the
          highlighting retints with the theme. Switch to Dark or Forest in the
          topbar and the block above follows. Declaring the aliases at
          <code>:root</code> instead would look identical and be wrong — a
          <code>var()</code> alias resolves once against <code>:root</code> and
          inherits past every <code>.theme-*</code>.
        </p>
        <p>
          Three markers are the author's, not the parser's:
          <code>+</code>, <code>-</code> and <code>&gt;</code> at the start of a
          line, and <code>•text•</code> inside one
          (<code>••text••</code> for an error).
        </p>
        ${preview(
          '<pre class="code" style="width: 100%">' +
            glow(
              `- const rows = client.find({ limit: 100 })
+ const rows = await client.findData({}, { limit: 100 })
> find() answers the •list envelope•; findData() is the rows
  return ••rows.map(r => r.id)••`,
              { language: 'js', prefix: true }
            ) +
            '</pre>'
        )}
        <div class="alert warning">
          <div class="alert-icon" aria-hidden="true">!</div>
          <div class="alert-content">
            <strong>Line markers and CSS share the first column.</strong>
            <p>
              <code>+ .sibling</code> and <code>&gt; .child</code> are
              combinators, and a marker eats the character — so a caller
              highlighting CSS wants <code>prefix: false</code>, which is what
              this guide passes. <code>--custom-property</code> is the one case
              handled for you: two dashes are never a diff marker.
            </p>
          </div>
        </div>`,
      )}

      ${section(
        "Kbd",
        `
        ${preview(`
          <p style="margin: 0">
            Press <kbd>⌘</kbd><kbd>K</kbd> to search, <kbd>Esc</kbd> to dismiss,
            or <kbd class="kbd">Shift</kbd> + <kbd class="kbd">?</kbd> for help.
          </p>`)}
        ${code(`Press <kbd>⌘</kbd><kbd>K</kbd> to search
<kbd class="kbd">Esc</kbd>`)}
        <p>
          The heavier bottom border is the whole keycap effect. A
          <code>box-shadow</code> would be more literal but would not survive a
          dark theme, where the shadow disappears and the cap flattens — switch
          to Dark in the topbar and the border is still there.
        </p>
        <p>
          Sized in <code>em</code> too, so a <code>kbd</code> inside small print
          shrinks with it.
        </p>
        ${preview(`
          <p class="text-xs" style="margin: 0">
            Fine print with a <kbd>⌘</kbd><kbd>K</kbd> inside it.
          </p>`)}`,
      )}`;
}

/* ══════════════════════════════════════════════════════════════════════
   4. Shell + router
   ══════════════════════════════════════════════════════════════════════ */

/*
 * One map, not a router plus a parallel `defined` list. The old JSX version
 * kept both and they fell out of sync — install/alerts/toasts/popovers/
 * drawers/layouts each rendered their real page AND a "coming soon"
 * placeholder under it. Deriving the fallback from the same object makes that
 * unrepresentable.
 */
/* ══════════════════════════════════════════════════════════════════════
   Learn — the decision wizard
   ══════════════════════════════════════════════════════════════════════ */

/*
 * The other 48 pages answer "how does Badge work" for somebody who already
 * knows they want a Badge. This one answers the question that comes first
 * and that nothing else in the package answers: which term IS the thing I
 * am about to build.
 *
 * The tree lives in decisions.js. The element, class, tier and meaning of
 * every outcome are read out of vocabulary.js — nothing about a term is
 * written twice, so a rename cannot leave the teacher describing a class
 * the stylesheet no longer ships. test/specs/decisions.spec.js holds both
 * directions, including the one nothing else would catch: a term that no
 * path can reach.
 */

const TERM = (() => {
  const out = {}
  VOCAB.forEach((tier) => {
    tier[2].forEach((row) => {
      out[row[0]] = {
        term: row[0],
        element: row[1],
        meaning: row[2],
        cls: row.length > 3 ? row[3] : row[0].toLowerCase(),
        tier: tier[0]
      }
    })
  })
  return out
})()

/*
 * The wizard's own state, kept off `state` because it is not part of the
 * page identity — going to Buttons and coming back should not restore a
 * half-answered question, it should start over.
 */
let wiz = null

function wizReset() {
  wiz = { at: DECIDE.start, trail: [], term: null, tone: '', treatments: [] }
}

/* The class chain, assembled in the order the Composition page teaches:
   Element, then tone, then treatments. */
function wizChain() {
  const t = TERM[wiz.term]
  return [t && t.cls, wiz.tone].concat(wiz.treatments).filter(Boolean).join(' ')
}

const WIZ_TONES = ['primary', 'secondary', 'muted', 'info', 'success', 'warning', 'danger']

/*
 * The trail back up through the answers is a Breadcrumb, which is the term
 * for exactly that. Each crumb is a <button> rather than an <a> because
 * going back is a state change, not a navigation — the href would be a lie.
 * The separator is `.breadcrumb li + li::before`, so there is no element
 * between the crumbs to hide from a screen reader.
 */
function wizTrail() {
  if (!wiz.trail.length) return ''
  const steps = wiz.trail
    .map(
      (step, i) =>
        `<li><button type="button" class="btn link sg-wiz-crumb" data-wiz-back="${i}">${esc(step.label)}</button></li>`
    )
    .join('')
  return `
    <div class="split sg-wiz-trail">
      <nav class="breadcrumb sg-wiz-crumbs" aria-label="Answers so far"><ol>${steps}</ol></nav>
      <button type="button" class="btn ghost" data-wiz-restart>Start over</button>
    </div>`
}

/*
 * A wireframe per option, keyed by question and then by the term or branch
 * that option leads to.
 *
 * ── Which questions get drawn ─────────────────────────────────────
 *
 * The ones whose answer is a SHAPE. `frame`, `layout`, `block`, `nav` and
 * the small forks under them are all spatial questions — where a thing sits,
 * how it is divided, what it is next to — and a wireframe answers them
 * faster than a sentence.
 *
 * Five are deliberately left undrawn, and each omission is the point:
 *
 *   inline    a Button and a Link are the same shape. Drawing them would
 *             say the choice is visual, and it is the one place this wizard
 *             most needs to say it is not
 *   waiting   Progress, Spinner and Skeleton do look different, and the
 *             question's own note says picking the wrong one is an
 *             accessibility bug rather than a style choice. A picture
 *             invites picking by look
 *   strip     Toolbar and Bar are the same shape BY DESIGN — the difference
 *             is a keyboard contract. Two identical drawings would teach
 *             that the question is meaningless
 *   anchored  two of its three options resolve to Popover, so a sketch set
 *             would show one drawing twice
 *   form      same shape of problem: two of three resolve to Field
 *
 * Kept here rather than in decisions.js: that file is routing data with a
 * spec guarding it against the vocabulary in both directions, and a drawing
 * is chrome. The option's `on`/`to` id is the join.
 */
const WIZ_SKETCH = {
  root: {
    /* In a line of text, among words — not on its own row. */
    inline: `<div class="sg-sk">
      <div class="sg-sk-bar" style="--w: 70%"></div>
      <div class="sg-sk-row mid">
        <span class="sg-sk-bar" style="--w: 34%"></span>
        <span class="sg-sk-chip"></span>
        <span class="sg-sk-bar" style="--w: 26%"></span>
      </div>
      <div class="sg-sk-bar" style="--w: 55%"></div>
    </div>`,

    /* Owns a row of the page and has an edge of its own. */
    block: `<div class="sg-sk">
      <div class="sg-sk-bar" style="--w: 46%"></div>
      <div class="sg-sk-box on"></div>
    </div>`,

    /* Above everything, over a scrim — the page is still there underneath. */
    overlay: `<div class="sg-sk">
      <div class="sg-sk-bar" style="--w: 60%"></div>
      <div class="sg-sk-box"></div>
      <div class="sg-sk-dim"></div>
      <div class="sg-sk-float"></div>
    </div>`,

    /* A strip that persists while the content under it changes. */
    nav: `<div class="sg-sk">
      <div class="sg-sk-top on"></div>
      <div class="sg-sk-box"></div>
    </div>`,

    form: `<div class="sg-sk">
      <div class="sg-sk-bar" style="--w: 30%"></div>
      <div class="sg-sk-field on"></div>
      <div class="sg-sk-bar" style="--w: 24%"></div>
      <div class="sg-sk-field"></div>
    </div>`,

    /* Arrangement and nothing else, so nothing here is filled in. */
    layout: `<div class="sg-sk">
      <div class="sg-sk-row">
        <span class="sg-sk-box ghost"></span>
        <span class="sg-sk-box ghost"></span>
        <span class="sg-sk-box ghost"></span>
      </div>
    </div>`,

    text: `<div class="sg-sk">
      <div class="sg-sk-bar on" style="--w: 58%; block-size: 7px"></div>
      <div class="sg-sk-bar" style="--w: 100%"></div>
      <div class="sg-sk-bar" style="--w: 92%"></div>
      <div class="sg-sk-bar" style="--w: 64%"></div>
    </div>`,

    frame: `<div class="sg-sk">
      <div class="sg-sk-top on"></div>
      <div class="sg-sk-row">
        <span class="sg-sk-rail on"></span>
        <span class="sg-sk-box"></span>
      </div>
    </div>`
  },

  /* ── The shell, part by part. One of each per application. ───────── */
  frame: {
    App: `<div class="sg-sk seam-app" style="outline: 2px solid var(--color-primary); outline-offset: -2px">
      <div class="sg-sk-top"></div>
      <div class="sg-sk-row"><span class="sg-sk-rail"></span><span class="sg-sk-box"></span></div>
    </div>`,

    /* The grid itself — what holds the parts apart, drawn as the seams. */
    Shell: `<div class="sg-sk">
      <div class="sg-sk-top sg-sk-seam"></div>
      <div class="sg-sk-row">
        <span class="sg-sk-rail sg-sk-seam"></span>
        <span class="sg-sk-box sg-sk-seam"></span>
      </div>
    </div>`,

    Topbar: `<div class="sg-sk">
      <div class="sg-sk-top on"></div>
      <div class="sg-sk-row"><span class="sg-sk-rail"></span><span class="sg-sk-box"></span></div>
    </div>`,

    Sidebar: `<div class="sg-sk">
      <div class="sg-sk-top"></div>
      <div class="sg-sk-row"><span class="sg-sk-rail on"></span><span class="sg-sk-box"></span></div>
    </div>`,

    Screen: `<div class="sg-sk">
      <div class="sg-sk-top"></div>
      <div class="sg-sk-row"><span class="sg-sk-rail"></span><span class="sg-sk-box on"></span></div>
    </div>`,

    /* A subdivision of the Screen, so the Screen is drawn around it. */
    Pane: `<div class="sg-sk">
      <div class="sg-sk-top"></div>
      <div class="sg-sk-row">
        <span class="sg-sk-rail"></span>
        <span class="sg-sk-col">
          <span class="sg-sk-box on" style="flex: 0 0 13px"></span>
          <span class="sg-sk-box"></span>
        </span>
      </div>
    </div>`,

    /* One of several, and only one is showing. */
    View: `<div class="sg-sk">
      <div class="sg-sk-row mid" style="gap: 3px">
        <span class="sg-sk-sq on"></span><span class="sg-sk-sq"></span><span class="sg-sk-sq"></span>
      </div>
      <div class="sg-sk-box on"></div>
    </div>`
  },

  /* ── Arrangement. Nothing is filled: a Layout term ships no skin. ── */
  layout: {
    Stack: `<div class="sg-sk">
      <div class="sg-sk-bar on" style="--w: 100%; block-size: 9px"></div>
      <div class="sg-sk-bar on" style="--w: 100%; block-size: 9px"></div>
      <div class="sg-sk-bar on" style="--w: 100%; block-size: 9px"></div>
    </div>`,

    Cluster: `<div class="sg-sk">
      <div class="sg-sk-row mid" style="flex-wrap: wrap; gap: 3px">
        <span class="sg-sk-chip" style="inline-size: 30px"></span>
        <span class="sg-sk-chip" style="inline-size: 18px"></span>
        <span class="sg-sk-chip" style="inline-size: 40px"></span>
        <span class="sg-sk-chip" style="inline-size: 24px"></span>
        <span class="sg-sk-chip" style="inline-size: 34px"></span>
      </div>
    </div>`,

    Center: `<div class="sg-sk">
      <div class="center sg-sk-center">
        <span class="sg-sk-chip" style="inline-size: 38px; block-size: 16px"></span>
      </div>
    </div>`,

    Split: `<div class="sg-sk">
      <div class="sg-sk-row mid" style="justify-content: space-between; flex: 1">
        <span class="sg-sk-chip" style="inline-size: 34px; block-size: 14px"></span>
        <span class="sg-sk-chip" style="inline-size: 22px; block-size: 14px"></span>
      </div>
    </div>`,

    Container: `<div class="sg-sk">
      <div class="sg-sk-row" style="justify-content: center">
        <span class="sg-sk-box on" style="flex: 0 0 58%"></span>
      </div>
    </div>`
  },

  /* ── Kinds of block. Each one is a recognisable shape. ───────────── */
  block: {
    unit: `<div class="sg-sk">
      <div class="sg-sk-box on" style="padding: 4px; display: flex; flex-direction: column; gap: 3px">
        <span class="sg-sk-bar" style="--w: 55%"></span>
        <span class="sg-sk-bar" style="--w: 90%"></span>
      </div>
    </div>`,

    entry: `<div class="sg-sk">
      <div class="sg-sk-bar" style="--w: 100%; block-size: 8px"></div>
      <div class="sg-sk-bar on" style="--w: 100%; block-size: 8px"></div>
      <div class="sg-sk-bar" style="--w: 100%; block-size: 8px"></div>
    </div>`,

    Alert: `<div class="sg-sk">
      <div class="sg-sk-box on" style="padding: 5px; display: flex; gap: 5px; align-items: flex-start">
        <span class="sg-sk-dot on"></span>
        <span class="sg-sk-col">
          <span class="sg-sk-bar" style="--w: 70%"></span>
          <span class="sg-sk-bar" style="--w: 45%"></span>
        </span>
      </div>
    </div>`,

    Table: `<div class="sg-sk" style="gap: 3px">
      <div class="sg-sk-row mid" style="gap: 3px"><span class="sg-sk-sq sg-sk-fill on"></span><span class="sg-sk-sq sg-sk-fill on"></span><span class="sg-sk-sq sg-sk-fill on"></span><span class="sg-sk-sq sg-sk-fill on"></span></div>
      <div class="sg-sk-row mid" style="gap: 3px"><span class="sg-sk-sq sg-sk-fill"></span><span class="sg-sk-sq sg-sk-fill"></span><span class="sg-sk-sq sg-sk-fill"></span><span class="sg-sk-sq sg-sk-fill"></span></div>
      <div class="sg-sk-row mid" style="gap: 3px"><span class="sg-sk-sq sg-sk-fill"></span><span class="sg-sk-sq sg-sk-fill"></span><span class="sg-sk-sq sg-sk-fill"></span><span class="sg-sk-sq sg-sk-fill"></span></div>
      <div class="sg-sk-row mid" style="gap: 3px"><span class="sg-sk-sq sg-sk-fill"></span><span class="sg-sk-sq sg-sk-fill"></span><span class="sg-sk-sq sg-sk-fill"></span><span class="sg-sk-sq sg-sk-fill"></span></div>
    </div>`,

    Facts: `<div class="sg-sk">
      <div class="sg-sk-row mid" style="justify-content: space-between"><span class="sg-sk-bar" style="--w: 34%"></span><span class="sg-sk-bar on" style="--w: 30%"></span></div>
      <div class="sg-sk-row mid" style="justify-content: space-between"><span class="sg-sk-bar" style="--w: 28%"></span><span class="sg-sk-bar on" style="--w: 22%"></span></div>
      <div class="sg-sk-row mid" style="justify-content: space-between"><span class="sg-sk-bar" style="--w: 38%"></span><span class="sg-sk-bar on" style="--w: 26%"></span></div>
    </div>`,

    Steps: `<div class="sg-sk">
      <div class="center sg-sk-center">
        <span class="sg-sk-row mid" style="gap: 0">
          <span class="sg-sk-dot on"></span>
          <span class="sg-sk-bar on" style="--w: 26px"></span>
          <span class="sg-sk-dot on"></span>
          <span class="sg-sk-bar" style="--w: 26px"></span>
          <span class="sg-sk-dot"></span>
        </span>
      </div>
    </div>`,

    Feed: `<div class="sg-sk">
      <div class="sg-sk-row mid"><span class="sg-sk-dot on"></span><span class="sg-sk-bar" style="--w: 62%"></span></div>
      <div class="sg-sk-row mid"><span class="sg-sk-dot on"></span><span class="sg-sk-bar" style="--w: 44%"></span></div>
      <div class="sg-sk-row mid"><span class="sg-sk-dot on"></span><span class="sg-sk-bar" style="--w: 70%"></span></div>
    </div>`,

    Disclosure: `<div class="sg-sk">
      <div class="sg-sk-box on" style="flex: 0 0 13px"></div>
      <div class="sg-sk-box ghost"></div>
    </div>`,

    Code: `<div class="sg-sk">
      <div class="sg-sk-box" style="padding: 4px; display: flex; flex-direction: column; gap: 3px">
        <span class="sg-sk-bar on" style="--w: 46%"></span>
        <span class="sg-sk-bar" style="--w: 72%"></span>
        <span class="sg-sk-bar on" style="--w: 34%"></span>
      </div>
    </div>`,

    Empty: `<div class="sg-sk">
      <div class="sg-sk-box ghost" style="display: grid; place-items: center">
        <span class="sg-sk-bar" style="--w: 40px"></span>
      </div>
    </div>`,

    grouping: `<div class="sg-sk">
      <div class="sg-sk-bar on" style="--w: 44%; block-size: 7px"></div>
      <div class="sg-sk-box"></div>
    </div>`
  },

  unit: {
    /* Content you read. */
    Card: `<div class="sg-sk">
      <div class="sg-sk-box on" style="padding: 5px; display: flex; flex-direction: column; gap: 4px">
        <span class="sg-sk-bar" style="--w: 52%; block-size: 6px"></span>
        <span class="sg-sk-bar" style="--w: 96%"></span>
        <span class="sg-sk-bar" style="--w: 72%"></span>
      </div>
    </div>`,
    /* One number, read at a glance. */
    Tile: `<div class="sg-sk">
      <div class="sg-sk-box on" style="padding: 5px; display: flex; flex-direction: column; gap: 5px; justify-content: center">
        <span class="sg-sk-bar" style="--w: 30%"></span>
        <span class="sg-sk-bar on" style="--w: 52%; block-size: 12px"></span>
      </div>
    </div>`
  },

  entry: {
    Item: `<div class="sg-sk">
      <div class="sg-sk-row mid"><span class="sg-sk-dot"></span><span class="sg-sk-bar on" style="--w: 62%"></span></div>
      <div class="sg-sk-row mid"><span class="sg-sk-dot"></span><span class="sg-sk-bar" style="--w: 48%"></span></div>
      <div class="sg-sk-row mid"><span class="sg-sk-dot"></span><span class="sg-sk-bar" style="--w: 56%"></span></div>
    </div>`,
    /* The actions on the right are the whole difference. */
    Row: `<div class="sg-sk">
      <div class="sg-sk-row mid" style="justify-content: space-between">
        <span class="sg-sk-bar" style="--w: 44%"></span>
        <span class="sg-sk-row mid" style="gap: 3px"><span class="sg-sk-sq on"></span><span class="sg-sk-sq on"></span></span>
      </div>
      <div class="sg-sk-row mid" style="justify-content: space-between">
        <span class="sg-sk-bar" style="--w: 52%"></span>
        <span class="sg-sk-row mid" style="gap: 3px"><span class="sg-sk-sq on"></span><span class="sg-sk-sq on"></span></span>
      </div>
      <div class="sg-sk-row mid" style="justify-content: space-between">
        <span class="sg-sk-bar" style="--w: 38%"></span>
        <span class="sg-sk-row mid" style="gap: 3px"><span class="sg-sk-sq on"></span><span class="sg-sk-sq on"></span></span>
      </div>
    </div>`
  },

  grouping: {
    /* The heading is the difference — it is what a reader can jump to. */
    Section: `<div class="sg-sk">
      <div class="sg-sk-bar on" style="--w: 46%; block-size: 7px"></div>
      <div class="sg-sk-box"></div>
    </div>`,
    Group: `<div class="sg-sk">
      <div class="sg-sk-box on"></div>
    </div>`
  },

  overlay: {
    modal: `<div class="sg-sk">
      <div class="sg-sk-bar" style="--w: 60%"></div>
      <div class="sg-sk-box"></div>
      <div class="sg-sk-dim"></div>
      <div class="sg-sk-float"></div>
    </div>`,
    /* No scrim: the page is still usable, and it hangs off its trigger. */
    anchored: `<div class="sg-sk">
      <div class="sg-sk-row mid" style="gap: 4px">
        <span class="sg-sk-bar" style="--w: 22%"></span>
        <span class="sg-sk-chip"></span>
      </div>
      <div class="sg-sk-box"></div>
      <div class="sg-sk-attach"></div>
    </div>`,
    Toast: `<div class="sg-sk">
      <div class="sg-sk-bar" style="--w: 56%"></div>
      <div class="sg-sk-box"></div>
      <div class="sg-sk-corner"></div>
    </div>`
  },

  modal: {
    Dialog: `<div class="sg-sk">
      <div class="sg-sk-box"></div>
      <div class="sg-sk-dim"></div>
      <div class="sg-sk-float"></div>
    </div>`,
    Drawer: `<div class="sg-sk">
      <div class="sg-sk-box"></div>
      <div class="sg-sk-dim"></div>
      <div class="sg-sk-edge"></div>
    </div>`
  },

  nav: {
    Nav: `<div class="sg-sk">
      <div class="sg-sk-row mid"><span class="sg-sk-bar on" style="--w: 54%"></span></div>
      <div class="sg-sk-row mid"><span class="sg-sk-bar" style="--w: 44%"></span></div>
      <div class="sg-sk-row mid"><span class="sg-sk-bar" style="--w: 60%"></span></div>
      <div class="sg-sk-row mid"><span class="sg-sk-bar" style="--w: 38%"></span></div>
    </div>`,
    Breadcrumb: `<div class="sg-sk">
      <div class="sg-sk-row mid" style="gap: 4px">
        <span class="sg-sk-bar" style="--w: 22px"></span>
        <span class="sg-sk-bar" style="--w: 4px"></span>
        <span class="sg-sk-bar" style="--w: 28px"></span>
        <span class="sg-sk-bar" style="--w: 4px"></span>
        <span class="sg-sk-bar on" style="--w: 24px"></span>
      </div>
      <div class="sg-sk-box"></div>
    </div>`,
    Pagination: `<div class="sg-sk">
      <div class="sg-sk-box"></div>
      <div class="sg-sk-row mid" style="gap: 3px; justify-content: center">
        <span class="sg-sk-sq"></span><span class="sg-sk-sq on"></span><span class="sg-sk-sq"></span><span class="sg-sk-sq"></span>
      </div>
    </div>`,
    Tabs: `<div class="sg-sk">
      <div class="sg-sk-row mid" style="gap: 3px">
        <span class="sg-sk-sq on" style="inline-size: 20px"></span>
        <span class="sg-sk-sq" style="inline-size: 20px"></span>
        <span class="sg-sk-sq" style="inline-size: 20px"></span>
      </div>
      <div class="sg-sk-box on"></div>
    </div>`,
    strip: `<div class="sg-sk">
      <div class="sg-sk-box on" style="flex: 0 0 13px; display: flex; align-items: center; gap: 3px; padding-inline: 4px">
        <span class="sg-sk-sq"></span><span class="sg-sk-sq"></span><span class="sg-sk-sq"></span>
      </div>
      <div class="sg-sk-box"></div>
    </div>`,
    Divider: `<div class="sg-sk">
      <div class="sg-sk-box"></div>
      <div class="sg-sk-row mid" style="gap: 4px">
        <span class="sg-sk-bar" style="--w: 30%"></span>
        <span class="sg-sk-bar on" style="--w: 26px"></span>
        <span class="sg-sk-bar" style="--w: 30%"></span>
      </div>
      <div class="sg-sk-box"></div>
    </div>`
  },

  text: {
    Heading: `<div class="sg-sk">
      <div class="center sg-sk-center">
        <span class="sg-sk-bar on" style="--w: 70px; block-size: 10px"></span>
      </div>
    </div>`,
    Text: `<div class="sg-sk">
      <div class="sg-sk-bar" style="--w: 100%"></div>
      <div class="sg-sk-bar" style="--w: 94%"></div>
      <div class="sg-sk-bar" style="--w: 98%"></div>
      <div class="sg-sk-bar" style="--w: 58%"></div>
    </div>`
  }
}

/*
 * An option that LANDS on a term shows that term on the tile, muted. The
 * wizard's whole claim is that the term follows from the question, so
 * hiding the answer behind the click makes it a quiz — someone who already
 * knows the vocabulary had to commit to a branch to find out where it went,
 * and someone who doesn't never sees the two names side by side. Muted and
 * last in the tile so it reads as the destination, not as the label.
 */
function wizQuestion(id) {
  const q = DECIDE.questions[id]
  /* Only where the answer is a shape. WIZ_SKETCH's header lists the five
     questions left undrawn and why each one would mislead. */
  const set = WIZ_SKETCH[id]
  const opts = q.options
    .map(
      (o, i) => `
      <button type="button" class="tile sg-wiz-opt" data-wiz-pick="${i}">
        ${(set && set[o.on || o.to]) || ''}
        <span class="item-title">${esc(o.label)}</span>
        ${o.hint ? `<span class="item-sub">${esc(o.hint)}</span>` : ''}
        ${o.on && TERM[o.on] ? `<span class="sg-wiz-lands">${esc(o.on)}</span>` : ''}
      </button>`
    )
    .join('')

  return `
    ${wizTrail()}
    <div class="card">
      <h3 class="sg-wiz-ask">${esc(q.ask)}</h3>
      ${q.note ? `<p class="sg-wiz-note">${esc(q.note)}</p>` : ''}
      <div class="tiles sg-wiz-opts">${opts}</div>
    </div>`
}

function wizChipset(label, name, current, values, allowNone) {
  if (!values.length) return ''
  /*
   * Selected is a filled Button, unselected is the same Button `outlined` —
   * the shipped pair, so the two states cannot drift. Not a Pill or a Badge:
   * both of those are filled at rest and neither is a control. `aria-pressed`
   * carries the state; the class follows it rather than the other way round.
   */
  const one = (v, on, val) =>
    `<button type="button" class="btn dense ${on ? 'primary' : 'outlined'}" data-wiz-${name}="${esc(val)}" aria-pressed="${on}">${esc(v)}</button>`

  const none = allowNone ? one('none', !current.length, '') : ''
  return `
    <div class="sg-wiz-axis">
      <span class="sg-kicker">${label}</span>
      <div class="cluster">${none}${values.map((v) => one(v, current.indexOf(v) !== -1, v)).join('')}</div>
    </div>`
}

function wizOutcome() {
  const o = DECIDE.outcomes[wiz.term]
  const t = TERM[wiz.term]
  const chain = wizChain()
  const markup = o.markup(chain)

  const tones = o.tones ? wizChipset('Tone', 'tone', wiz.tone ? [wiz.tone] : [], WIZ_TONES, true) : ''
  const treats = wizChipset('Treatment', 'treat', wiz.treatments, o.treatments, true)

  const states = (o.states || []).length
    ? `
      <div class="sg-wiz-states">
        <h4 class="sg-kicker">State comes from the platform</h4>
        <dl class="facts">
          ${o.states
            .map(
              (s) =>
                `<dt>${esc(s.label)}</dt><dd><code>${esc(s.apply)}</code> — ${esc(s.why)}</dd>`
            )
            .join('')}
        </dl>
      </div>`
    : ''

  const instead = (o.instead || []).length
    ? `
      <div class="sg-wiz-instead">
        <h4 class="sg-kicker">Not this — reach for something else when…</h4>
        <ul>
          ${o.instead
            .map(
              (i) =>
                `<li><button type="button" class="btn link" data-wiz-goto="${esc(i.term)}">${esc(i.term)}</button> when ${esc(i.when)}</li>`
            )
            .join('')}
        </ul>
      </div>`
    : ''

  const live =
    o.live === false
      ? `<div class="alert muted sg-wiz-nolive"><div class="alert-content"><p>Not previewable in place — ${esc(t.tier)}-tier markup only renders inside a real app shell or once it is opened.</p></div></div>`
      : `<div class="sg-wiz-live" data-wiz-live></div>`

  return `
    ${wizTrail()}
    <div class="card sg-wiz-out">
      <div class="sg-wiz-verdict">
        <span class="sg-kicker">You want a</span>
        <h3 class="sg-wiz-term">${esc(t.term)}</h3>
        <p class="sg-wiz-lead">${esc(o.lead)}</p>
        <p class="cluster sg-wiz-facts">
          <code>${esc(t.element)}</code>
          ${t.cls ? `<code>.${esc(t.cls)}</code>` : '<em>no class — the element is the term</em>'}
          <span class="badge">${esc(t.tier)}</span>
        </p>
      </div>

      ${tones}${treats}

      ${live}
      <div class="sg-wiz-markup" data-wiz-markup></div>

      ${o.note ? `<div class="alert info"><div class="alert-content"><p>${esc(o.note)}</p></div></div>` : ''}
      ${states}
      ${instead}

      <hr>
      <div class="cluster">
        <a class="btn primary" href="#${esc(o.page)}">Open the ${esc(t.term)} reference →</a>
        <button type="button" class="btn ghost" data-wiz-restart>Build something else</button>
      </div>
    </div>

    <script type="application/json" data-wiz-src>${JSON.stringify(markup)}</script>`
}

function learnPage() {
  if (!wiz) wizReset()
  return `
      ${pageHeader({
        eyebrow: 'Learn',
        title: 'Pick a term',
        lead: 'The rest of the guide explains how each component works. This asks the question that comes before that one — of the 54 things in the vocabulary, which one is what you are about to build.'
      })}

      ${section(
        'Answer about the thing, not the look',
        `
        <p>
          Every question below is about behaviour, placement or promise —
          never about colour, size or border. That order is the system: pick
          the term first and the look is three more decisions, all of which
          compose. Pick the look first and you end up with
          <code>class="card-small-blue-bordered"</code>.
        </p>
        <div class="sg-wiz" data-wiz></div>`
      )}`
}

learnPage.init = function (root) {
  const host = $('[data-wiz]', root)
  if (!host) return

  function paint() {
    host.innerHTML = wiz.term ? wizOutcome() : wizQuestion(wiz.at)

    if (!wiz.term) return

    /*
     * The markup is stashed as JSON rather than re-derived here, so the
     * string that is highlighted and the string that is injected are the
     * same one — deriving it twice is how a preview drifts from the code
     * it is supposedly previewing.
     */
    const src = JSON.parse($('[data-wiz-src]', host).textContent)
    $('[data-wiz-markup]', host).innerHTML = `<pre class="code">${glow(src, {
      language: 'html',
      prefix: false
    })}</pre>`

    const live = $('[data-wiz-live]', host)
    if (live) live.innerHTML = src
  }

  host.addEventListener('click', (e) => {
    const pick = e.target.closest('[data-wiz-pick]')
    if (pick) {
      const q = DECIDE.questions[wiz.at]
      const opt = q.options[Number(pick.dataset.wizPick)]
      wiz.trail.push({ at: wiz.at, label: opt.label })
      if (opt.on) wiz.term = opt.on
      else wiz.at = opt.to
      paint()
      return
    }

    const back = e.target.closest('[data-wiz-back]')
    if (back) {
      /* Rewind to the question that answer was given at — the trail entry
         records where you WERE, not where it sent you. */
      const i = Number(back.dataset.wizBack)
      wiz.at = wiz.trail[i].at
      wiz.trail = wiz.trail.slice(0, i)
      wiz.term = null
      wiz.tone = ''
      wiz.treatments = []
      paint()
      return
    }

    if (e.target.closest('[data-wiz-restart]')) {
      wizReset()
      paint()
      return
    }

    const goto = e.target.closest('[data-wiz-goto]')
    if (goto) {
      /* Jumping to a near miss keeps the trail — you got here by asking the
         questions, and the point of the jump is to see the difference. */
      wiz.term = goto.dataset.wizGoto
      wiz.tone = ''
      wiz.treatments = []
      paint()
      return
    }

    const tone = e.target.closest('[data-wiz-tone]')
    if (tone) {
      wiz.tone = tone.dataset.wizTone
      paint()
      return
    }

    const treat = e.target.closest('[data-wiz-treat]')
    if (treat) {
      const v = treat.dataset.wizTreat
      if (!v) wiz.treatments = []
      else if (wiz.treatments.indexOf(v) === -1) wiz.treatments.push(v)
      else wiz.treatments = wiz.treatments.filter((x) => x !== v)
      paint()
    }
  })

  paint()
}

/* ══════════════════════════════════════════════════════════════════════
   Compare — where this sits, and where it loses
   ══════════════════════════════════════════════════════════════════════ */

/*
 * Every number this page states about THIS package is counted from the
 * vocabulary and the live CSSOM at render time. A comparison page is the
 * single most tempting place in a repo to leave a stale number, because
 * nothing renders wrong when it rots — it just quietly becomes a lie, and
 * the reader has no way to tell. Numbers about other frameworks are dated
 * and sourced instead, which is the closest equivalent available.
 */

function countShippedClasses() {
  const seen = new Set()
  const walk = (rules) => {
    for (const r of rules) {
      if (r.selectorText) {
        for (const c of r.selectorText.match(/\.[a-zA-Z][a-zA-Z0-9_-]*/g) || []) seen.add(c.slice(1))
      }
      if (r.cssRules) walk(r.cssRules)
      if (r.styleSheet && r.styleSheet.cssRules) walk(r.styleSheet.cssRules)
    }
  }
  for (const sheet of document.styleSheets) {
    /* The package's own sheets only — guide.css would add 200 .sg-* names
       and turn the smallest number on the page into the largest. */
    if (!sheet.href || !/\/src\//.test(sheet.href)) continue
    try {
      walk(sheet.cssRules)
    } catch (e) {
      return null /* an unreadable sheet is not a count of zero */
    }
  }
  return seen.size
}

const FRAMEWORKS = [
  {
    name: 'Tailwind CSS v4',
    kind: 'Utility-first',
    write: 'Every declaration, in the class attribute',
    build: 'Required',
    behaviour: 'None',
    theming: '@theme in CSS; tokens become both variables and utilities',
    layers: 'Yes — native',
    lock: 'Nothing, but the markup is unreadable without it'
  },
  {
    name: 'Bootstrap 5.3',
    kind: 'Component + variant',
    write: 'A component class plus one variant per look',
    build: 'Optional — CDN',
    behaviour: 'Included',
    theming: '--bs-* variables per component, plus Sass',
    layers: 'No',
    lock: 'Nothing'
  },
  {
    name: 'Bulma 1.0',
    kind: 'Component + modifier',
    write: 'A component class plus stacking is-* modifiers',
    build: 'Optional — Sass',
    behaviour: 'None, deliberately',
    theming: 'CSS variables since 1.0, Sass before that',
    layers: 'No',
    lock: 'Nothing'
  },
  {
    name: 'Pico CSS 2',
    kind: 'Classless / semantic',
    write: 'Nothing. It styles the elements',
    build: 'None',
    behaviour: 'None',
    theming: 'CSS variables, light and dark schemes',
    layers: 'No',
    lock: 'Nothing'
  },
  {
    name: 'Open Props',
    kind: 'Tokens only',
    write: 'Your own CSS, using its variables',
    build: 'None',
    behaviour: 'None',
    theming: 'It IS the theming — 500+ props, no components',
    layers: 'No',
    lock: 'Nothing'
  },
  {
    name: 'Radix Themes',
    kind: 'Component library',
    write: 'JSX props, not classes',
    build: 'Required',
    behaviour: 'Included — the point of it',
    theming: '12-step colour scales, accent and grey',
    layers: 'Layerable',
    lock: 'React'
  },
  {
    name: 'Web Awesome (Shoelace)',
    kind: 'Web components',
    write: 'Custom elements — <wa-dialog>',
    build: 'Bundler, in practice',
    behaviour: 'Included, with the ARIA',
    theming: 'CSS variables and parts',
    layers: 'n/a (shadow DOM)',
    lock: 'Nothing — web standards'
  }
]

function comparePage() {
  const terms = VOCAB.reduce((n, t) => n + t[2].length, 0)
  const tiers = VOCAB.length
  const classes = countShippedClasses()

  const rows = FRAMEWORKS.map(
    (f) => `
      <tr>
        <td><strong>${esc(f.name)}</strong><br><span class="text-muted text-xs">${esc(f.kind)}</span></td>
        <td>${esc(f.build)}</td>
        <td>${esc(f.behaviour)}</td>
        <td>${esc(f.layers)}</td>
      </tr>`
  ).join('')

  return `
      ${pageHeader({
        eyebrow: 'Learn',
        title: 'Why this one',
        lead:
          'An honest audit against the frameworks people actually reach for — ' +
          'where this one differs, and where each of them is the better answer.'
      })}

      ${section(
        'Where it sits',
        `
        <p>
          Two questions separate almost every CSS framework, and neither is
          about how it looks. <strong>Who names the thing</strong> — you, in
          the class attribute, or the framework, in its vocabulary. And
          <strong>does behaviour come with it</strong> — the focus trap, the
          arrow keys, the open and close.
        </p>
        ${code(`                     YOU name it           the FRAMEWORK names it
                     ------------          --------------------
  ships no           Tailwind              Bulma
  behaviour          UnoCSS                Pico CSS
                     Open Props            Bootstrap's CSS half
                                           FrontierJS  <-- here

  ships the          (nothing lives         Bootstrap's JS half
  behaviour           here)                 Radix Themes
                                            Web Awesome
                                            MUI`, 'txt')}
        <p>
          This package is in the bottom-left of nothing: it names things and
          ships no behaviour. That is a deliberate corner, and it is the
          corner Bulma occupies too. The difference between us and Bulma is
          not the corner — it is what the names are attached to, which is the
          next section.
        </p>`
      )}

      ${section(
        'The classic example: a button',
        `
        <p>
          Every framework looks alike on a button until the button needs a
          second variant, and alike again until you need a colour it did not
          ship. So this walks one button through all three. Nothing below is
          a strawman — each is what that framework's own documentation tells
          you to write.
        </p>

        <h3 class="h5">1. One button</h3>
        <p>An outlined danger button.</p>
        ${code(`Tailwind v4   <button class="inline-flex items-center gap-1.5 rounded-md
                             border border-red-600 px-3.5 py-1.5 text-sm
                             font-medium text-red-600 hover:bg-red-50
                             focus-visible:outline-2 focus-visible:outline-red-600">

Bootstrap     <button class="btn btn-outline-danger">

Bulma         <button class="button is-danger is-outlined">

Pico CSS      <button class="outline">          <- no danger; you write the colour

FrontierJS    <button class="btn outlined danger">`, 'txt')}
        <p>
          Bootstrap and Bulma are the same answer as ours here, and it would
          be dishonest to pretend otherwise. Nothing has been decided yet.
        </p>

        <h3 class="h5">2. Now the whole set</h3>
        <p>
          Bootstrap only, because it is the closest of the three and the one
          most readers already know. Tailwind has no row in this table at
          all: there is no set, only the attribute above written out again
          with different numbers in it — which is the trade it is making on
          purpose, not an oversight.
        </p>
        <div class="table-wrap">
          <table class="table compact">
            <thead><tr><th>You want</th><th>Bootstrap 5.3</th><th>FrontierJS</th></tr></thead>
            <tbody>
              <tr><td>Solid</td><td><code>btn btn-danger</code></td><td><code>btn danger</code></td></tr>
              <tr><td>Outlined</td><td><code>btn btn-outline-danger</code></td><td><code>btn danger outlined</code></td></tr>
              <tr><td>Small</td><td><code>btn btn-danger btn-sm</code></td><td><code>btn danger text-sm</code></td></tr>
              <tr><td>Disabled</td><td><code>disabled</code></td><td><code>disabled</code></td></tr>
              <tr><td>Busy</td><td>a nested <code>&lt;span class="spinner-border"&gt;</code></td><td><code>loading</code> + <code>aria-busy</code></td></tr>
            </tbody>
          </table>
        </div>
        <p>
          One difference is worth naming and one is worth conceding.
          <code>btn-sm</code> is a size that only a button has; ours is
          <code>text-sm</code>, the type scale, and it is the same class on a
          heading or a table. That is the pattern, not a coincidence. The
          concession is the spinner: <strong>Pico needs no class for it at
          all</strong> — <code>aria-busy="true"</code> draws it — where ours
          wants the attribute <em>and</em> a class, because the attribute
          announces and the class draws. Pico's is the better idea.
        </p>

        <h3 class="h5">3. Now a colour the framework did not ship</h3>
        <p>
          The client's purple, <code>#6d28d9</code>. Every project reaches
          this, usually in week one, and it is where the shapes come apart.
        </p>
        ${code(`/* Bootstrap — its own docs' shape for a custom button.
   Thirteen declarations, and you choose four shades yourself. */
.btn-brand {
  --bs-btn-bg:               #6d28d9;
  --bs-btn-border-color:     #6d28d9;
  --bs-btn-color:            #fff;
  --bs-btn-hover-bg:         #5b21b6;   /* your call */
  --bs-btn-hover-border-color: #55219f; /* your call */
  --bs-btn-active-bg:        #4c1d95;   /* your call */
  --bs-btn-focus-shadow-rgb: 109, 40, 217;
  /* …and the disabled trio */
}
/* Still only a button. A brand alert, badge or table row is a
   Sass \$theme-colors entry and a recompile. */`)}
        ${code(`/* Tailwind v4 — a ramp, then the chain at every call site. */
@theme {
  --color-brand-500: oklch(0.51 0.24 296);
  --color-brand-600: oklch(0.46 0.24 296);   /* your call */
  --color-brand-700: oklch(0.40 0.22 296);   /* your call */
}
/* <button class="bg-brand-600 hover:bg-brand-700 text-white …"> */`)}
        ${code(`# Bulma — a Sass map entry and a recompile.
$custom-colors: ("brand": (#6d28d9, #fff));`, 'bash')}
        ${code(`/* FrontierJS — plain CSS in your own stylesheet, unlayered. */
.brand { --bg-mix: #6d28d9; }`)}
        <p>
          One declaration, no build step, and the text colour is not in it
          because it is not a decision — it is derived from that hue's
          luminance. The four <em>your call</em> comments above are the real
          cost of the other shape: each is a shade somebody has to pick, and
          picking it wrong is how a design system ends up with two purples.
        </p>

        <h3 class="h5">4. And the same purple on things that are not buttons</h3>
        <p>
          This is the part that does not carry over. The tone was never
          attached to the button, so nothing else has to be told about it.
        </p>
        ${preview(`
          <style>
            /* The literal rule from step 3, live on this page. Nothing else
               in the guide uses .brand, so it is unscoped on purpose — the
               sample and the thing it renders are the same declaration. */
            .brand { --bg-mix: #6d28d9; }
          </style>
          <div class="cluster" style="align-items: center">
            <button class="btn brand" id="cmp-brand">Save</button>
            <button class="btn brand outlined">Save</button>
            <span class="badge brand">New</span>
            <span class="pill brand">7</span>
            <input class="field brand" value="input" style="inline-size: 8rem">
          </div>
          <div class="alert brand" style="margin-block-start: 1rem">
            <div class="alert-content">An alert, in a tone that shipped with nothing.</div>
          </div>`)}
        ${code(`<button class="btn brand">Save</button>
<span class="badge brand">New</span>
<input class="field brand">
<div class="alert brand">…</div>
<tr class="brand">…</tr>`)}
        <p id="cmp-measured">
          The filled button above is measured in your browser as you read
          this.
        </p>
        <p>
          That is the whole claim, and it is a claim about
          <em>multiplication</em>. A framework that names each combination
          needs one name per cell of the grid; one that keeps the axes
          separate needs one name per axis. The grid grows, the axes do not.
        </p>
        <div class="table-wrap">
          <table class="table compact">
            <thead><tr><th>Framework</th><th>Names for the button matrix</th><th>Reusable elsewhere?</th></tr></thead>
            <tbody>
              <tr>
                <td>Bootstrap 5.3</td>
                <td><strong>17</strong> — 9 solid + 8 outline, one per combination</td>
                <td>No — a button, nothing else</td>
              </tr>
              <tr>
                <td>Bulma 1.0</td>
                <td>Modifiers stack — roughly <strong>12 + 4</strong></td>
                <td>Partly — also a tag, a notification, a message</td>
              </tr>
              <tr>
                <td>FrontierJS</td>
                <td><strong>${TONES.length} tones + 3 treatments</strong> — <code>raised</code>,
                    <code>outlined</code>, <code>ghost</code>, declared once on the
                    surface lineage and orthogonal to every tone</td>
                <td>Yes — card, row, field, badge, alert…</td>
              </tr>
            </tbody>
          </table>
        </div>`
      )}

      ${section(
        'The matrix',
        `
        <div class="table-wrap">
          <table class="table compact striped">
            <thead>
              <tr>
                <th>Framework</th><th>Build step</th>
                <th>Behaviour</th><th>Layers</th>
              </tr>
            </thead>
            <tbody>
              <tr class="success">
                <td><strong>FrontierJS</strong><br><span class="text-muted text-xs">Semantic + orthogonal modifiers</span></td>
                <td><strong>None</strong></td>
                <td>None</td>
                <td><strong>Yes</strong> — nine</td>
              </tr>
              ${rows}
            </tbody>
          </table>
        </div>
        <p>
          Only one of these ties you to anything: <strong>Radix Themes is a
          React package</strong>. Everything else on the list, this one
          included, is a stylesheet or a web component and does not care what
          renders your HTML.
        </p>
        <p class="text-xs">
          Framework facts checked against each project's own documentation on
          2026-08-08. Versions move; re-check before quoting this at anyone.
        </p>`
      )}

      ${section(
        'Five things this does that the others do not',
        `
        <p>
          Stated narrowly, because a long list of advantages is how you can
          tell nobody measured any of them.
        </p>

        <h3 class="h5">1. Contrast is derived, not chosen</h3>
        <p>
          Every other framework here ships a palette somebody eyeballed. A
          tone here sets one variable, and the text colour on top of it is
          <em>computed</em> from that colour's relative luminance — so a hue
          no theme has defined yet still lands above 4.5:1.
        </p>
        <div class="alert info">
          <div class="alert-icon" aria-hidden="true">i</div>
          <div class="alert-content">
            <strong>The platform caught up in March 2026.</strong>
            <p>
              <code>contrast-color()</code> now ships in browsers and picks
              black or white against any background — one line, no library.
              If that is all you need, use it. This package's derivation
              still does one thing more: where white cannot reach 4.5:1 it
              <em>dims the fill</em> rather than flipping the text, so the
              hue survives instead of the button turning into a pale box
              with black text. That is the whole reason to keep it.
            </p>
          </div>
        </div>

        <h3 class="h5">2. Your CSS wins without <code>!important</code></h3>
        <p>
          Everything ships inside a cascade layer, and unlayered CSS beats
          every layer no matter how specific the layered rule is. So your own
          stylesheet overrides this package by existing. Of the frameworks
          above only Tailwind v4 ships native layers; with Bootstrap or Bulma
          you are wrapping the import yourself or counting selectors.
        </p>
        ${code(`/* your app.css — plain, unlayered, and it wins */
.btn { border-radius: 0; }`)}

        <h3 class="h5">3. State comes from the platform</h3>
        <p>
          There is no <code>.active</code>, no <code>.is-open</code>, no
          <code>.selected</code>. A current nav item is
          <code>aria-current="page"</code>, a selected tab is
          <code>aria-selected="true"</code>, an invalid field is
          <code>:user-invalid</code>. The styling follows the attribute, so
          there is no second source of truth to forget to update — and the
          accessibility is not a separate task you do afterwards.
        </p>
        <p>
          Overlays close the same way, which is the part that used to need
          JavaScript. Bootstrap animates a modal out with
          <code>.fade.show</code> driven by its own JS; Radix uses
          <code>data-state="closed"</code>; Web Awesome runs a Web Animation.
          Here the state is <code>[open]</code>, <code>:popover-open</code>
          and <code>[hidden]</code>, and
          <code>@starting-style</code> + <code>allow-discrete</code> +
          <code>overlay</code> do the rest. A Toast leaves with
          <code>el.hidden = true</code>.
        </p>

        <h3 class="h5">4. Density is an axis, not a size per component</h3>
        <p>
          Bootstrap needs <code>btn-sm</code>, <code>table-sm</code> and
          <code>form-control-sm</code>; Bulma puts <code>is-small</code> on
          each element; Radix and MUI take a prop. All of them name the
          combination again. Here it is one inheriting number:
          <code>dense</code> on a region and every Card, Row, Field and Table
          inside it tightens, because space is a token ladder that
          <code>--density</code> multiplies.
        </p>
        ${code(`<div class="dense">   <!-- everything inside, tighter -->`)}
        <p>
          It is the exact mirror of a tone, and that pairing is the thing to
          remember: <strong>a tone is a fact about one element and does not
          inherit; density is a fact about a region and does.</strong> It can
          also be derived — name a box a container and a narrow one tightens
          what is inside it, with a stated <code>dense</code> or
          <code>roomy</code> still winning.
        </p>

        <h3 class="h5">5. The vocabulary is tested, in both directions</h3>
        <p>
          ${terms} terms in ${tiers} tiers, each fixing one answer: which
          element, what ARIA, how it nests. A test reads the real CSSOM and
          fails if a term has no CSS <em>or</em> if the package ships a class
          the vocabulary does not name. The second direction is the unusual
          one — it is what stops a design system growing a private dialect
          nobody wrote down.${classes ? ` Total classes shipped: <strong>${classes}</strong>.` : ''}
        </p>`
      )}

      ${section(
        'What the others do better',
        `
        <p>
          None of these are close calls.
        </p>
        <dl class="facts divided">
          <dt>Tailwind</dt>
          <dd>
            You never leave the file you are in, the tooling completes the
            class names, and unused CSS is genuinely gone. For a team that
            has internalised it, the long class attribute is not the cost it
            looks like here. Nothing in this package competes with that.
          </dd>
          <dt>Bootstrap</dt>
          <dd>
            Twelve years of answers to your exact question, a grid, a JS
            layer, and every developer you hire has already used it. That is
            worth more than any argument on this page.
          </dd>
          <dt>Radix Themes, Web Awesome, MUI</dt>
          <dd>
            They ship the <em>behaviour</em> — focus traps, arrow-key
            roving, dismissal, announcement. This package ships none of it.
            A menu here is a popover plus a list plus a keyboard contract you
            write yourself.
          </dd>
          <dt>Open Props</dt>
          <dd>
            If you want tokens and no opinions at all, take them. This is a
            more opinionated thing by design, and opinions you disagree with
            are a cost.
          </dd>
          <dt>Pico CSS</dt>
          <dd>
            For a document — a blog, a README, an admin page nobody designs —
            classless wins outright. You write plain HTML and it looks fine.
          </dd>
        </dl>`
      )}

      ${section(
        'Where the ideas came from',
        `
        <p>
          Almost none of this is new. What is new, at most, is the
          combination — and saying so is cheaper than being caught not saying
          it.
        </p>
        <dl class="facts divided">
          <dt>Every Layout</dt>
          <dd>
            <code>Stack</code>, <code>Cluster</code>, <code>Center</code> and
            <code>Container</code> are Heydon Pickering and Andy Bell's names,
            taken deliberately — the vocabulary people already have beats a
            better one they have to learn. Two of their thirteen names are
            reused here for different things, which is worth knowing: their
            <code>Frame</code> is an aspect-ratio box and ours is the app
            shell tier, their <code>Sidebar</code> is a two-column layout
            primitive and ours is the navigation column.
          </dd>
          <dt>Bulma and Bootstrap</dt>
          <dd>
            The element-plus-modifier shape is theirs. The change here is
            making the modifiers orthogonal and free-standing rather than
            owned by one component.
          </dd>
          <dt>Open Props</dt>
          <dd>
            That a design system can be variables and nothing else, consumed
            without a build.
          </dd>
          <dt>The platform</dt>
          <dd>
            Cascade layers, <code>@property</code>,
            <code>color-mix()</code>, relative colour syntax,
            <code>:user-invalid</code>, <code>&lt;dialog&gt;</code>, the
            popover attribute. Most of what looks clever here is a browser
            feature being used rather than reimplemented.
          </dd>
        </dl>`
      )}`
}

/*
 * The worked example measures its own punchline.
 *
 * Step 3 claims a hand-declared tone gets a readable text colour without
 * anyone choosing one. A page that only asserts that is a page nobody can
 * check, and the number would rot the first time the derivation changed.
 *
 * The colours have to go through a canvas rather than a regex: Chrome
 * serialises the derived fill as `color(xyz-d65 0.19 0.09 0.66)`, and
 * parsing those three floats as 8-bit channels gives a plausible, wrong
 * answer for every colour — which is exactly what it did the first time.
 */
comparePage.init = function (root) {
  const btn = root.querySelector('#cmp-brand')
  const out = root.querySelector('#cmp-measured')
  if (!btn || !out) return

  const cv = document.createElement('canvas')
  cv.width = cv.height = 1
  const ctx = cv.getContext('2d', { willReadFrequently: true })

  const luminance = (css) => {
    ctx.fillStyle = '#000'
    ctx.fillStyle = css
    ctx.fillRect(0, 0, 1, 1)
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data
    const lin = (v) => {
      v /= 255
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
    }
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
  }

  const s = getComputedStyle(btn)
  const a = luminance(s.color)
  const b = luminance(s.backgroundColor)
  const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
  const pass = ratio >= 4.5

  out.innerHTML =
    'Measured in your browser just now: the filled button above reads at ' +
    `<strong>${ratio.toFixed(2)}:1</strong>, which ` +
    (pass ? 'clears' : '<strong>fails</strong>') +
    ' WCAG AA. Nobody wrote that text colour down — <code>#6d28d9</code> ' +
    'was the only value in the rule.'
}

/* ══════════════════════════════════════════════════════════════════════
   Footprint — what it weighs, measured
   ══════════════════════════════════════════════════════════════════════ */

/*
 * `Why this one` argues taxonomy: what a name is attached to, and whether
 * the axes multiply. This page is the same argument reduced to bytes and
 * counted class names, which is the half a reader can check without
 * agreeing with any of it.
 *
 * The two halves are sourced differently ON PURPOSE.
 *
 * Numbers about THIS package are counted from the live CSSOM at render
 * time, so they cannot rot — same rule as the compare page.
 *
 * Numbers about other frameworks CANNOT be, so they are frozen constants
 * with a version and a date on every row, and the method is stated so the
 * reader can rerun it. Fetching a competitor's CSS at render time would
 * make the page fail without a network and quietly re-measure whatever the
 * CDN serves next year, which is a worse lie than a dated one.
 */

/*
 * Measured 2026-08-10. Each file is the project's own minified dist from
 * its CDN, gzip -9, no tree-shaking on any of them including ours — the
 * comparison is bundle-as-shipped. `classes` counts unique class names in
 * the file; `variants` counts those that are a breakpoint clone
 * (`-sm`/`-md`/`-lg`/`-tablet`/…) or a colour clone (`-primary-40-invert`),
 * which is the number the rest of the page is about.
 */
const FOOTPRINT_DATE = '2026-08-10'

const FOOTPRINT = [
  {
    name: 'Open Props',
    version: '1.7.7',
    kind: 'Tokens only',
    raw: 25615,
    gzip: 7026,
    classes: 2,
    breakpoint: 0,
    colour: 0,
    note: 'Smaller because it ships no components at all — variables, and nothing that uses them.'
  },
  {
    name: 'Pico CSS',
    version: '2.0.6',
    kind: 'Classless',
    raw: 82194,
    gzip: 11496,
    classes: 16,
    breakpoint: 0,
    colour: 0,
    note: 'The same weight as ours for 16 classes — it styles bare elements, so the weight buys polish rather than vocabulary.'
  },
  {
    name: 'Foundation',
    version: '6.8.1',
    kind: 'Component + grid',
    raw: 136326,
    gzip: 17578,
    classes: 456,
    breakpoint: 0,
    colour: 9,
    note: 'The XY grid is most of it, and the breakpoint work is done in Sass rather than in shipped class names.'
  },
  {
    name: 'Bootstrap',
    version: '5.3.3',
    kind: 'Component + variant',
    raw: 232803,
    gzip: 30773,
    classes: 2031,
    breakpoint: 1202,
    colour: 177,
    note: 'Includes the grid and the full utility API. Sass users ship far less than this; the CDN file is what most projects actually load.'
  },
  {
    name: 'Bulma',
    version: '1.0.2',
    kind: 'Component + modifier',
    raw: 677242,
    gzip: 64958,
    classes: 3292,
    breakpoint: 1368,
    colour: 1129,
    note: 'v1.0 generates a full lightness ramp per colour per helper — <code>.has-background-primary-40-invert</code> and 1,128 siblings.'
  }
]

function kb(bytes) {
  return (bytes / 1024).toFixed(1) + ' kB'
}

/*
 * The classes that change under a width media query — counted, because the
 * claim beside it is that this package has no breakpoint VARIANTS while
 * still being responsive, and the second half of that is only credible if
 * the number is real.
 *
 * Width only: the bundle also carries `prefers-reduced-motion` and
 * `hover: hover`, which are @media and are not breakpoints. Counting every
 * @media gives 14 instead of 8, and the six it adds — `.card`, `.tile`,
 * `.btn`, `.surface`, `.spinner`, `.loading` — make the package look
 * responsive in places it is not.
 *
 * Descends through @import and @layer the same way countShippedClasses()
 * does — index.css is 44 imports, so a walk that stops at the top level
 * counts nothing.
 *
 * Reading the CSSOM rather than the file text is also what keeps comments
 * out: `frame.css` explains the toggle's display by naming `.btn` in prose
 * inside a width query, and a regex over the source counts that as a ninth
 * class. Two methods agreeing on 8 is why this one is trusted.
 */
function countResponsiveClasses() {
  const seen = new Set()
  const walk = (rules, underWidth) => {
    for (const r of rules) {
      const isWidth =
        r.media && /\b(min|max)-width\b/.test(r.conditionText || r.media.mediaText || '')
      const inside = underWidth || isWidth
      if (inside && r.selectorText) {
        for (const c of r.selectorText.match(/\.[a-zA-Z][a-zA-Z0-9_-]*/g) || []) seen.add(c.slice(1))
      }
      if (r.cssRules) walk(r.cssRules, inside)
      if (r.styleSheet && r.styleSheet.cssRules) walk(r.styleSheet.cssRules, inside)
    }
  }
  for (const sheet of document.styleSheets) {
    if (!sheet.href || !/\/src\//.test(sheet.href)) continue
    try {
      walk(sheet.cssRules, false)
    } catch (e) {
      return null
    }
  }
  return seen.size
}

/*
 * Our own two numbers, read rather than remembered.
 *
 * The class count is countShippedClasses() — the same walk the compare page
 * and the cheat sheet use, so all three pages cannot disagree.
 *
 * The byte count cannot be measured in the browser: the guide loads 44
 * separate files through @import, and dist/ is a build artefact that is not
 * fetched here. So the two below are constants. `bun run build` prints the
 * RAW size it writes, which checks the first; the gzip figure has to be
 * taken, and the Measuring it yourself section is the command that takes it.
 */
const FJS_RAW = 69889
const FJS_GZIP = 11200

function footprintPage() {
  const classes = countShippedClasses()
  const responsive = countResponsiveClasses()
  const terms = VOCAB.reduce((n, t) => n + t[2].length, 0)

  /* Ours is inserted in weight order like everything else — putting it on
     top would be the one arrangement that flatters it regardless. */
  const ourRow = `
      <tr class="success">
        <td><strong>FrontierJS</strong> <span class="text-muted text-xs">this build</span><br>
            <span class="text-muted text-xs">Semantic + orthogonal modifiers</span></td>
        <td>${kb(FJS_RAW)}</td>
        <td><strong>${kb(FJS_GZIP)}</strong></td>
        <td>${classes === null ? '—' : classes}</td>
      </tr>`

  const sorted = FOOTPRINT.slice().sort((a, b) => a.gzip - b.gzip)
  const before = sorted.filter((f) => f.gzip < FJS_GZIP)
  const bootstrap = FOOTPRINT.find((f) => f.name === 'Bootstrap')
  const bulma = FOOTPRINT.find((f) => f.name === 'Bulma')

  const theirRow = (f) => `
      <tr>
        <td><strong>${esc(f.name)}</strong> <span class="text-muted text-xs">${esc(f.version)}</span><br>
            <span class="text-muted text-xs">${esc(f.kind)}</span></td>
        <td>${kb(f.raw)}</td>
        <td><strong>${kb(f.gzip)}</strong></td>
        <td>${f.classes.toLocaleString()}</td>
      </tr>`

  /*
   * Ours is counted by the SAME command as theirs, which is the only reason
   * the ratio means anything — and running it rather than eyeballing it is
   * what caught two errors in this row.
   *
   * The suffix count is 10, not the 12 a hand-written pattern first gave:
   * `.gap-2xl`/`.gap-3xl` end in `xl` but the published regex requires a
   * separator before it, so they do not match. Ten is what the command
   * prints, so ten is what ships here.
   *
   * The colour count is 13, and three of those are substring false
   * positives the grep cannot avoid — `.bordered` contains "red",
   * `.theme-dark` contains "dark", `.secondary` is not a colour name at
   * all. They are counted anyway. Every framework in the table gets the
   * same crude instrument pointed at it, and quietly exempting our own row
   * is the one edit that would make the comparison worthless.
   */
  const varRows = FOOTPRINT.concat([
    { name: 'FrontierJS', classes, breakpoint: 10, colour: 13, ours: true }
  ])
    .slice()
    .sort((a, b) => (a.classes || 0) - (b.classes || 0))
    .map((f) => {
      const total = f.classes || 0
      const variants = (f.breakpoint || 0) + (f.colour || 0)
      const pct = total ? Math.round((variants / total) * 100) : 0
      return `
      <tr${f.ours ? ' class="success"' : ''}>
        <td>${f.ours ? '<strong>FrontierJS</strong>' : esc(f.name)}</td>
        <td>${total.toLocaleString()}</td>
        <td>${(f.breakpoint || 0).toLocaleString()}</td>
        <td>${(f.colour || 0).toLocaleString()}</td>
        <td><strong>${pct}%</strong></td>
      </tr>`
    })
    .join('')

  return `
      ${pageHeader({
        eyebrow: 'Reference',
        title: 'Footprint',
        lead:
          'What this package weighs against the frameworks people actually ' +
          'reach for, and — the part that matters more — where their class ' +
          'counts come from.'
      })}

      ${section(
        'The weight',
        `
        <p>
          Every file below is that project's own minified bundle from its CDN,
          compressed with <code>gzip -9</code>. Nothing is tree-shaken,
          including ours, so this is bundle-as-shipped rather than
          bundle-as-tuned.
        </p>
        <div class="table-wrap">
          <table class="table compact striped">
            <thead>
              <tr><th>Package</th><th>Raw</th><th>Gzipped</th><th>Classes</th></tr>
            </thead>
            <tbody>
              ${sorted.filter((f) => f.gzip < FJS_GZIP).map(theirRow).join('')}
              ${ourRow}
              ${sorted.filter((f) => f.gzip >= FJS_GZIP).map(theirRow).join('')}
            </tbody>
          </table>
        </div>
        <p>
          It is <strong>${(bootstrap.gzip / FJS_GZIP).toFixed(1)}&times;</strong>
          smaller than Bootstrap and
          <strong>${(bulma.gzip / FJS_GZIP).toFixed(1)}&times;</strong> smaller
          than Bulma, and it is the lightest thing here that ships a component
          vocabulary at all. ${before.length === 2
            ? 'The two below it are lighter for reasons that are not a saving:'
            : 'What sits below it is lighter for reasons that are not a saving:'}
          Open&nbsp;Props ships no components, and Pico ships almost no classes
          because it styles bare elements instead.
        </p>
        <p class="text-muted text-xs">
          Third-party files measured ${FOOTPRINT_DATE} at the versions shown.
          Versions move — re-measure before quoting this at anyone. The class
          count in our own row is read out of the live stylesheet as this page
          renders; the byte counts are what <code>bun run build</code> last
          wrote to <code>dist/</code>.
        </p>`
      )}

      ${section(
        'Where the class counts come from',
        `
        <p>
          The size table is the less interesting half. A framework is not big
          because it does more — it is big because it <em>names combinations</em>,
          and a combination is one class per cell of a grid that grows every
          time either axis does.
        </p>
        <p>
          So the same class lists, split by what the names are:
          <strong>size-suffixed</strong> (<code>.col-md-6</code>,
          <code>.d-lg-none</code>, <code>.text-sm</code>) and
          <strong>colour-worded</strong>
          (<code>.has-background-primary-40-invert</code>).
        </p>
        <p>
          Both columns are one crude grep over class names, run identically on
          every row including ours. That is the point — a measurement that
          flatters whoever wrote it is not a measurement — but it means the
          columns count <em>spelling</em>, not meaning, and the next section
          is where our own row does not mean what it appears to.
        </p>
        <div class="table-wrap">
          <table class="table compact striped">
            <thead>
              <tr>
                <th>Package</th><th>Classes</th>
                <th>Size-suffixed</th><th>Colour-worded</th><th>Share</th>
              </tr>
            </thead>
            <tbody>${varRows}</tbody>
          </table>
        </div>
        <p>
          <strong>Well over half of Bootstrap's class names are the same
          handful of ideas at five widths</strong>, and a third of Bulma's are
          one colour helper at every step of a lightness ramp. Neither is
          waste on its own terms — a responsive grid is a real feature, and
          this package does not ship one. But it is where the number comes
          from, and it is why the number cannot stop growing.
        </p>`
      )}

      ${section(
        'Why ours does not multiply',
        `
        <p>
          ${classes === null
            ? 'The stylesheet ships its classes'
            : `The stylesheet ships <strong>${classes} classes</strong>`}
          for <strong>${terms} vocabulary terms</strong>, ${TONES.length}
          tones, three treatments, eight themes and a density axis. That is
          not restraint — nothing was left out to keep the number down. It is
          that a tone is not attached to a component.
        </p>
        ${code(`.danger { --bg-mix: var(--color-danger); }`)}
        <p>
          One declaration, and it is the whole of what <code>danger</code>
          means. It works on a button, a card, a table row, a field, a badge
          and a feed dot, because none of those were told about it — they read
          <code>--bg-mix</code> and derive their own fill and text colour from
          whatever is in it.
        </p>
        <p>
          The comparison is not that we wrote fewer classes. It is the
          exponent: <strong>a framework that names each combination needs one
          name per cell; one that keeps the axes separate needs one name per
          axis.</strong> Adding a component to Bulma costs a class per colour
          per size. Adding one here costs roughly one class, because the tone,
          the treatment and the density already exist and already compose.
        </p>
        <p>
          Our own row in that table is 23 classes, so here they are in full.
          A share is a number nobody can check; a list of 23 names is one
          anybody can.
        </p>
        ${code(`size-suffixed (10)
  .gap-xs  .gap-sm  .gap-md  .gap-lg  .gap-xl      one space rung each
  .text-xs .text-sm .text-md .text-lg .text-xl     one type rung each

colour-worded (13)
  .primary .secondary .success .warning .danger .info .muted   the 7 tones
  .text-primary .text-success .text-warning .text-danger .text-info
                                                   the same 7 as ink
  .bordered      contains "red"
  .theme-dark    contains "dark"`, 'txt')}
        <p>
          <strong>Not one of them is a variant of another class.</strong>
          <code>.gap-lg</code> is one rung of the space ladder, not
          <code>.gap</code> at a large breakpoint. <code>.text-sm</code> is
          one rung of the type scale, and it is the same class on a heading, a
          button and a table cell. <code>.bordered</code> and
          <code>.theme-dark</code> are in the list because the grep matches
          <em>red</em> inside <em>bordered</em> — they are counted rather than
          excused, because exempting our own row is how a comparison stops
          being one.
        </p>
        <p>
          The number that is actually zero is the one the left column is named
          after. <strong>This package ships no breakpoint variant of anything.</strong>
          There is no <code>.gap-md-lg</code>, no <code>.text-sm-xl</code>, no
          <code>.col-md-6</code>.
          ${responsive === null ? 'Some classes' : `<strong>${responsive} classes</strong>`}
          do change at a width — <code>.shell</code>, <code>.sidebar</code>,
          <code>.screen</code>, <code>.container</code> among them — and every
          one of them keeps
          the same name while the rule underneath it changes. That is the
          difference between a framework where the author picks the breakpoint
          and one where the stylesheet already knows it, and it is the whole
          of why ${bootstrap.breakpoint.toLocaleString()} of Bootstrap's names
          do not have an equivalent here.
        </p>`
      )}

      ${section(
        'What the number is not',
        `
        <p>
          Four things this table would let you conclude that it does not
          support.
        </p>
        <ul>
          <li>
            <strong>Eight themes are in our bundle.</strong> Most of these
            ship one, and Bootstrap's dark mode is an attribute rather than a
            second stylesheet. Strip the seven we are not using and the number
            drops again — which is to say a chunk of our weight is a feature
            nobody else is being charged for here.
          </li>
          <li>
            <strong>No grid, no responsive utilities.</strong> Bootstrap's
            1,202 breakpoint classes are a feature we chose not to buy. If an
            app needs that API, the comparison is not like for like, and
            Bootstrap is the smaller total once you have hand-written the
            equivalent.
          </li>
          <li>
            <strong>No behaviour.</strong> Bootstrap ships JavaScript for its
            dialog and dropdown; ours live in
            <code>@frontierjs/ui</code> and are not in this file. Bulma ships
            none either, so that row is like for like and Bootstrap's is not.
          </li>
          <li>
            <strong>Nothing here is tree-shaken.</strong> A Bootstrap project
            importing four Sass partials ships far less than 30 kB. Ours has
            no build step, so ${kb(FJS_GZIP)} is simply what arrives — which
            favours us in practice and flatters us in this table.
          </li>
        </ul>`
      )}

      ${section(
        'Measuring it yourself',
        `
        <p>
          Every number above came from these commands, and they are the same
          four lines for any package you want to add to the table.
        </p>
        ${code(`# ours — build first; dist/ is what ships
cd packages/css && bun run build
gzip -9 -c dist/frontier.min.css | wc -c

# theirs
curl -sL -o bulma.css https://cdn.jsdelivr.net/npm/bulma@1.0.2/css/bulma.min.css
gzip -9 -c bulma.css | wc -c

# unique class names in a file
grep -oE '\\.[a-zA-Z_-][a-zA-Z0-9_-]*' bulma.css | sort -u | wc -l

# how many of those are size-suffixed — swap the file to compare
grep -oE '\\.[a-zA-Z_-][a-zA-Z0-9_-]*' bulma.css | sort -u \\
  | grep -cE '\\-(sm|md|lg|xl|xxl|xs|tablet|desktop|mobile|widescreen|fullhd|touch)(\\-|$)'

# drop the -c to see the names rather than the count. Run it on
# dist/frontier.min.css and it prints the ten in the list above.`, 'bash')}
        <p class="text-muted text-xs">
          The class-name grep is a lexical count, not a parse: it counts a
          name once no matter how many rules declare it, and it cannot tell a
          class the framework documents from one it uses internally. Both
          sides of every comparison are counted the same way, which is what
          makes the ratio meaningful even though no single number is exact.
        </p>`
      )}`
}

const PAGES = {
  // Learn
  learn: learnPage,
  compare: comparePage,
  // Start Here
  overview: overviewPage,
  taxonomy: taxonomyPage,
  install: installPage,
  composition: compositionPage,
  conventions: conventionsPage,
  // Structure (Half 1)
  vocabulary: vocabularyPage,
  anatomy: anatomyPage,
  frame: framePage,
  // Foundation
  variables: variablesPage,
  tonal: tonalPage,
  density: densityPage,
  axes: axesPage,
  layers: layersPage,
  themes: themesPage,
  colors: colorsPage,
  // Components
  buttons: buttonsPage,
  links: linksPage,
  headings: headingsPage,
  cards: cardsPage,
  tiles: tilesPage,
  feedback: feedbackPage,
  alerts: alertsPage,
  toasts: toastsPage,
  popovers: popoversPage,
  tooltips: tooltipPage,
  drawers: drawersPage,
  tables: tablesPage,
  dialogs: dialogsPage,
  inputs: inputsPage,
  formcontrols: formsPage,
  badges: badgesPage,
  avatar: avatarPage,
  icons: iconsPage,
  code: codePage,
  // Patterns (Block tier)
  bar: barPage,
  sectionheader: sectionHeaderPage,
  divider: dividerPage,
  items: itemsPage,
  rows: rowsPage,
  feed: feedPage,
  facts: factsPage,
  steps: stepsPage,
  disclosure: disclosurePage,
  tabs: tabsPage,
  nav: navPage,
  // Utilities
  layouts: layoutsPage,
  responsive: responsivePage,
  behaviour: behaviourPage,
  a11y: accessibilityPage,
  typography: typographyPage,
  // Reference
  cheatsheet: cheatSheetPage,
  footprint: footprintPage
}

/* ══════════════════════════════════════════════════════════════════════
   4. Search
   ══════════════════════════════════════════════════════════════════════ */

/*
 * The ranker and the term entries are in guide/search.js. What is here is
 * the half that needs the pages: the corpus, harvested by rendering every
 * one of them, and the palette.
 *
 * Harvesting is the only honest option. The guide's text is 51 page
 * functions and a table of contents is not one of them, so a written index
 * would be a 300-line list that goes stale on the first heading anyone
 * edits — silently, because a missing entry looks like a page with less in
 * it. Rendering the pages costs one pass at startup and cannot disagree
 * with what the reader will see.
 */

let SEARCH_INDEX = null

/* Text as a reader sees it, not as the markup spells it. */
function searchText(node) {
  return (node.textContent || '').replace(/\s+/g, ' ').trim()
}

function buildSearchIndex() {
  if (SEARCH_INDEX) return SEARCH_INDEX

  const out = searchVocabEntries(VOCAB)
  const host = document.createElement('div')

  /* Rendering 52 pages calls code() a few hundred times, and every one of
     those blocks is thrown away with the detached node. The live page's
     indices are already assigned, so appending cannot disturb them —
     but leaving the entries would hold the whole guide's source forever. */
  const codeMark = CODE_SRC.length

  for (const group of NAV) {
    for (const item of group.items) {
      const page = PAGES[item.id]
      if (!page) continue

      let html
      try {
        html = page()
      } catch (err) {
        /* One page that throws must not cost the other fifty — and it has
           to say so, or the only symptom is a page nobody can find. */
        console.warn('search: could not index #' + item.id, err)
        continue
      }

      host.innerHTML = html

      /*
       * tagSections, the same function renderPage() calls, so a result's
       * href and the id it lands on are produced once. It also numbers
       * duplicate headings the same way, which a separate walk would have
       * to reimplement to get right.
       */
      const sections = tagSections(host)
      sections.forEach((s) => {
        const el = $('#' + CSS.escape(s.id), host)
        if (!el) return
        out.push({
          kind: 'section',
          title: s.label,
          sub: item.label,
          page: item.id,
          section: s.id,
          text: searchText(el)
        })
      })

      /*
       * The page entry takes what is NOT in a section — the header and its
       * lead. The sections own the rest, so no sentence is indexed twice
       * and a body hit names the section it is in rather than the page it
       * is somewhere in.
       */
      const rest = host.cloneNode(true)
      /*
       * The page entry is what the SECTIONS did not claim, so this removes
       * the same nodes tagSections() indexed — matched the same way, by the
       * section heading inside rather than by depth, so the two cannot
       * disagree about what a section is. A plain `.pane` would also swallow
       * the App frame page's live demo, which is content that belongs to the
       * page entry.
       */
      $$('.pane', rest).forEach((el) => {
        if (el.querySelector(':scope > .sg-h2')) el.remove()
      })

      out.push({
        kind: 'page',
        title: item.label,
        sub: group.group,
        page: item.id,
        text: searchText(rest)
      })
    }
  }

  CODE_SRC.length = codeMark

  SEARCH_INDEX = out
  return out
}

/* Where the palette points with an empty box. Ids, looked up in the index,
   so a renamed page breaks visibly here rather than linking to nothing. */
const SEARCH_SUGGEST = ['learn', 'vocabulary', 'compare', 'cheatsheet']

const SEARCH_LIMIT = 12

/* ⌘ on a Mac, Ctrl everywhere else. Printing the wrong one is a small lie
   in the one piece of chrome that is on every page. */
const SEARCH_MOD = /Mac|iPhone|iPad|iPod/.test(navigator.platform || '') ? '⌘' : 'Ctrl+'

function searchHref(e) {
  return '#' + e.page + (e.section ? ':' + e.section : '')
}

function searchRow(e, i, parts) {
  const snippet = (parts || [])
    .map((p) => (p.hit ? `<mark>${esc(p.text)}</mark>` : esc(p.text)))
    .join('')

  return `
    <a class="item sg-search-hit" role="option" id="sg-hit-${i}" aria-selected="false"
       href="${searchHref(e)}" data-hit="${i}">
      <span class="item-lead" data-kind="${e.kind}">${e.kind}</span>
      <span class="item-text">
        <span class="item-title">${esc(e.title)}</span>
        ${e.sub ? `<span class="item-sub">${esc(e.sub)}</span>` : ''}
        ${snippet ? `<span class="item-sub clamp-2 sg-search-snip">${snippet}</span>` : ''}
      </span>
    </a>`
}

/*
 * The rendered list, and the entries behind it. They are returned together
 * because the keyboard needs the second: Enter navigates to a result, and
 * reading the href back out of the DOM to do it would make the list the
 * source of truth for where it points.
 */
function searchList(query) {
  const entries = buildSearchIndex()

  if (!searchTokens(query).length) {
    const picks = SEARCH_SUGGEST
      .map((id) => entries.find((e) => e.kind === 'page' && e.page === id))
      .filter(Boolean)

    return {
      entries: picks,
      html:
        '<div class="sg-search-hint">Start here</div>' +
        picks.map((e, i) => searchRow(e, i, null)).join('')
    }
  }

  const hits = searchRank(entries, query, SEARCH_LIMIT)
  if (!hits.length) {
    return {
      entries: [],
      html: `<div class="sg-search-empty">Nothing matches <strong>${esc(query.trim())}</strong>.</div>`
    }
  }

  return {
    entries: hits.map((h) => h.entry),
    html: hits
      .map((h, i) => searchRow(h.entry, i, searchSnippet(h.entry.text, h.tokens)))
      .join('')
  }
}

function searchPanel() {
  return `
    <div class="sg-search-backdrop" data-search-panel>
      <div class="sg-search" role="dialog" aria-modal="true" aria-label="Search the guide">
        <div class="sg-search-head">
          <span class="sg-search-glyph" aria-hidden="true">&#9906;</span>
          <input class="sg-search-input" type="text" data-search-input
                 role="combobox" aria-expanded="true" aria-controls="sg-search-results"
                 aria-autocomplete="list" aria-label="Search the guide"
                 autocomplete="off" spellcheck="false"
                 placeholder="Terms, pages, class names…">
          <kbd class="sg-search-esc">Esc</kbd>
        </div>
        <div class="items menu sg-search-results" id="sg-search-results" role="listbox"
             aria-label="Results" data-search-results></div>
      </div>
    </div>`
}

/* Open-state, and the node to hand focus back to when it closes. */
const search = { open: false, hits: [], at: 0, from: null }

function searchHighlight() {
  $$('[data-hit]', app).forEach((el, i) => {
    const on = i === search.at
    el.setAttribute('aria-selected', on ? 'true' : 'false')
    if (on) {
      el.scrollIntoView({ block: 'nearest' })
      $('[data-search-input]', app).setAttribute('aria-activedescendant', el.id)
    }
  })
}

function searchRender(query) {
  const list = searchList(query)
  search.hits = list.entries
  search.at = 0
  $('[data-search-results]', app).innerHTML = list.html
  searchHighlight()
}

function openSearch() {
  if (search.open) return
  search.open = true
  search.from = document.activeElement

  app.insertAdjacentHTML('beforeend', searchPanel())
  searchRender('')

  const input = $('[data-search-input]', app)
  input.focus()

  input.addEventListener('input', () => searchRender(input.value))
}

function closeSearch() {
  if (!search.open) return
  search.open = false
  const panel = $('[data-search-panel]', app)
  if (panel) panel.remove()
  /* Put focus back where it came from. A palette that swallows focus
     leaves a keyboard user at the top of the document. */
  if (search.from && search.from.isConnected) search.from.focus()
  search.from = null
}

/*
 * Navigate, then close. If the hash is already what we are setting,
 * hashchange never fires and route() would never run — which reads as a
 * result that does nothing when you pick the page you are already on.
 */
function searchGo(hash) {
  closeSearch()
  if (location.hash === hash) route()
  else location.hash = hash
}

/* An editable target owns its own keystrokes — `/` inside the Inputs page
   is a slash, not a shortcut. */
function searchIsTyping(el) {
  return !!(el && el.closest && el.closest('input, textarea, select, [contenteditable="true"]'))
}

function wireSearch() {
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault()
      search.open ? closeSearch() : openSearch()
      return
    }

    if (!search.open) {
      if (e.key === '/' && !searchIsTyping(e.target) && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        openSearch()
      }
      return
    }

    if (e.key === 'Escape') { e.preventDefault(); closeSearch(); return }

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!search.hits.length) return
      e.preventDefault()
      const step = e.key === 'ArrowDown' ? 1 : -1
      search.at = (search.at + step + search.hits.length) % search.hits.length
      searchHighlight()
      return
    }

    if (e.key === 'Enter') {
      const hit = search.hits[search.at]
      if (!hit) return
      e.preventDefault()
      searchGo(searchHref(hit))
    }
  })

  app.addEventListener('click', (e) => {
    if (e.target.closest('[data-search-open]')) { openSearch(); return }

    const hit = e.target.closest('[data-hit]')
    if (hit) {
      /* Ctrl/⌘-click and middle-click are the browser's, not ours — the
         rows are real links so that stays true. */
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
      e.preventDefault()
      searchGo(hit.getAttribute('href'))
      return
    }

    /* The backdrop, not the panel: a click on the input must not close it. */
    const panel = e.target.closest('[data-search-panel]')
    if (panel && e.target === panel) closeSearch()
  })
}

/* ══════════════════════════════════════════════════════════════════════
   5. Shell + router
   ══════════════════════════════════════════════════════════════════════ */

function topbar() {
  const theme = THEMES[state.theme];

  /*
   * .topbar is the shipped Frame term and claims its own grid area, so it is
   * a direct child of .shell. It already lays its children out — flex,
   * space-between, gap — so brand and actions are its direct children and
   * there is no inner wrapper.
   *
   * There was one, carrying `split sg-topbar-inner` to cap the width at
   * 1400px. All three of its properties were dead: `margin: 0 auto` cannot
   * centre a flex item, `width: 100%` is a hint the flex algorithm overrides,
   * and the max-width never bound because .shell already caps at the same
   * 1400px — measured, brand and actions land on the identical pixel with the
   * wrapper and without it. `split` restated what .topbar declares itself.
   *
   * The two groups are `bar start`, not `cluster`. A Cluster WRAPS — that is
   * its definition, not a default — and a Topbar has a fixed
   * --topbar-height, so a wrapped second line is drawn outside the bar
   * rather than growing it: at 640px the version badge landed on the page
   * below. Bar is nowrap and already carries this gap. Not `toolbar`, which
   * would promise arrow-key movement between what are three separate tab
   * stops.
   *
   * Bar is Region-tier and means a horizontal STRIP, so two of them inside a
   * Topbar reads as three strips where there is one. It is the right
   * geometry at the wrong scale, and the vocabulary has no word for a group
   * within a strip. Unruled on purpose — FJS-D24.
   */
  return `
    <header class="topbar" id="sg-topbar">
        <div class="bar start sg-brand">
          <span class="sg-brand-mark"></span>
          <span class="sg-brand-name">FrontierJS</span>
          <span class="sg-brand-sub">Design System</span>
        </div>
        <div class="bar start sg-topbar-actions">
          <button type="button" class="btn outlined sg-search-trigger" data-search-open>
            <span class="sg-search-trigger-glyph" aria-hidden="true">&#9906;</span>
            <span class="sg-search-trigger-label">Search</span>
            <kbd class="sg-search-kbd">${SEARCH_MOD}K</kbd>
          </button>
          <div class="relative">
            <button type="button" class="btn outlined sg-theme-trigger" data-theme-menu>
              <span class="sg-theme-trigger-swatch" style="background: ${
                theme.tokens['--color-primary'] || 'var(--color-primary)'
              }"></span>
              ${theme.name}
              <span class="sg-theme-trigger-arrow" aria-hidden="true">⌄</span>
            </button>
            <div hidden data-theme-dropdown>
              <div class="sg-theme-backdrop" data-theme-close></div>
              <div class="surface raised items menu sg-theme-dropdown" role="menu">
                ${Object.entries(THEMES)
                  .map(
                    ([key, t]) => `
                <button type="button" class="item sg-theme-option" role="menuitemradio" aria-pressed="${
                  key === state.theme
                }" aria-checked="${key === state.theme}" data-theme="${key}">
                  <span class="sg-theme-option-swatch" style="background: ${
                    t.tokens['--color-primary'] || 'var(--color-primary)'
                  }"></span>
                  <span class="item-text">
                    <span class="item-title sg-theme-option-name">${t.name}</span>
                    <span class="item-sub">${t.description}</span>
                  </span>
                  ${key === state.theme ? `<span class="sg-theme-option-check" aria-hidden="true">✓</span>` : ''}
                </button>`
                  )
                  .join('')}
              </div>
            </div>
          </div>
          <button type="button" class="btn outlined sg-config-trigger" data-config>
            <span class="sg-config-glyph">{ }</span>
            index.css
          </button>
          <span class="sg-version" data-version>v0.14.6</span>
        </div>
    </header>`
}

/*
 * The package's Nav term: .navlist / .navlink / .navlist-label, and the
 * active state carried by aria-current rather than an .active class.
 *
 * That is not a cosmetic swap. `aria-current="page"` is what a screen reader
 * announces, and PROJECT_STATE.md § "Style interactive state from ARIA, not
 * a class" is the convention the package documents — so the guide's own nav
 * was demonstrating the opposite of it on the most-read page in the repo.
 * nav.css styles the attribute directly, so there is nothing else to set.
 *
 * <nav> carries the .sidebar here: the shipped Sidebar term IS the <nav>
 * (VOCAB: Sidebar, <nav>), where the hand-rolled version was an <aside>
 * wrapping one.
 *
 * .stack on the <nav> owns the space between groups. The unclassed <div> is
 * still load-bearing — it is what makes a group ONE flex item, so the gap
 * falls between groups rather than between every label and its own list.
 * Unwrapping it spaces the label off the links it titles.
 */
function sidebar() {
  return `
    <nav class="sidebar stack" aria-label="Guide">
      ${NAV.map(
        (group) => `
      <div data-wrapper>
        <div class="navlist-label">${group.group}</div>
        <ul class="navlist">
          ${group.items
            .map(
              (item) => `
          <li>
            <a class="navlink" ${state.page === item.id ? 'aria-current="page"' : ""}
               href="#${item.id}" data-nav="${item.id}">${item.label}</a>
          </li>`,
            )
            .join("")}
        </ul>
      </div>`,
      ).join("")}
    </nav>`;
}

/*
 * A copy of the real index.css, embedded so the modal works over file://.
 * It is refreshed from ../index.css whenever the guide is served over http
 * (see openConfig), because a hand-maintained copy of a file whose whole job
 * is to declare the layer order is exactly the drift this package keeps
 * designing out. Re-paste it when index.css changes.
 */
const INDEX_CSS = `/*
 * index.css
 * Single entry point. Import this from your app root.
 *
 * Plain CSS, no build step, no UnoCSS.
 *
 * ── Layout ──────────────────────────────────────────────────────────
 *
 *   index.css        this file — the only thing most apps import
 *   utilities.css    the escape hatch; late layer, so it beats components
 *   foundation/      tokens, tones, and the two lineage bases
 *   themes/          the six shipped themes
 *   components/      btn, card, field, table, dialog …
 *   patterns/        the Block tier: bar, list, feed, steps, tabs …
 *   a11y/            the focus ring and the a11y primitives
 *
 * The folders mirror the layer order below, which is the architecture —
 * so the tree teaches it rather than competing with it. They are NOT a
 * build input: there is no src/ and no dist/, because the file you read
 * here is the file that ships.
 *
 * Directories were tried once before and are why v0.6 exists: every
 * @import pointed at a ./themes/ and ./utilities/ that had never been
 * created, so the entry point resolved nothing and the package did not
 * load at all. A failed @import is silent — the rule stays in place with
 * a null styleSheet — so \`meta: every @import in index.css resolved\` in
 * the test suite is what makes this layout safe to have at all. If you
 * move a file, run \`bun run test\`.
 *
 * ── Cascade layers ──────────────────────────────────────────────────
 *
 * Later layers win, regardless of selector specificity. That replaces the
 * old "order matters, don't reshuffle the imports" convention with an
 * explicit contract:
 *
 *   tokens      :root variable defaults
 *   themes      .theme-* overrides of those tokens
 *   tones       tone vocabulary (.primary, .danger, …)
 *   base        the two lineage bases — chip (inline), surface (block)
 *   layout      composition helpers (stack, cluster, center, split)
 *   components  btn, pill, badge, card, field, table, dialog, …
 *   patterns    block-tier layout patterns (bar, list, feed, disclosure)
 *   utilities   the escape hatch — .text-*, .gap-*, .relative. After
 *               components on purpose: .btn sets a font-size, so a
 *               same-layer .text-lg lost to it and every size modifier
 *               was inert. See utilities.css.
 *   a11y        visually-hidden, skip link — last, so nothing outranks
 *               them without a deliberate unlayered override
 *
 * Three consequences worth knowing:
 *
 * 1. Unlayered CSS beats every layer, so consumer styles override this
 *    package by default — no !important, no specificity war.
 *
 * 2. Specificity still decides *within* a layer, so the :where() bases in
 *    chip.css and surface.css stay overridable by their own composites.
 *
 * 3. \`layout\` sits before \`components\`/\`patterns\` on purpose: it lets
 *    \`.bar\` beat \`.center\` on the \`display\` property. See layout.css.
 */

@layer tokens, themes, tones, base, layout, components, patterns, utilities, a11y;

@import './foundation/tokens.css' layer(tokens);

/* Themes */
@import './themes/default.css'  layer(themes);
@import './themes/sunset.css'   layer(themes);
@import './themes/forest.css'   layer(themes);
@import './themes/midnight.css' layer(themes);
@import './themes/dark.css'     layer(themes);
@import './themes/elite.css'    layer(themes);
@import './themes/basecamp.css' layer(themes);
@import './themes/notebook.css' layer(themes);

/* Foundation — the rest of it; tokens.css is imported above */
@import './foundation/tones.css'   layer(tones);
@import './foundation/chip.css'    layer(base);
@import './foundation/surface.css' layer(base);
@import './foundation/layout.css'  layer(layout);

/* Frame + Page tiers — the app shell and the routed page */
@import './components/frame.css' layer(components);

/* Components */
@import './components/typography.css' layer(components);
@import './components/icon.css'       layer(components);
@import './components/buttons.css'    layer(components);
@import './components/pills.css'      layer(components);
@import './components/badges.css'     layer(components);
@import './components/cards.css'      layer(components);
@import './components/tiles.css'      layer(components);
@import './components/avatar.css'     layer(components);
@import './components/feedback.css'   layer(components);
@import './components/alerts.css'     layer(components);
@import './components/toasts.css'     layer(components);
@import './components/popovers.css'   layer(components);
@import './components/tooltips.css'   layer(components);
@import './components/drawers.css'    layer(components);
@import './components/form-core.css'  layer(components);
@import './components/tables.css'     layer(components);
@import './components/dialogs.css'    layer(components);

/* Block-tier patterns */
@import './patterns/bars.css'       layer(patterns);
@import './patterns/lists.css'      layer(patterns);
@import './patterns/feed.css'       layer(patterns);
@import './patterns/disclosure.css' layer(patterns);
@import './patterns/facts.css'      layer(patterns);
@import './patterns/steps.css'      layer(patterns);
@import './patterns/tabs.css'       layer(patterns);
@import './patterns/nav.css'        layer(patterns);

/*
 * The escape hatch — after every component and pattern, before a11y.
 * A utility that cannot beat a component is not a utility.
 */
@import './utilities.css' layer(utilities);

/*
 * Accessibility primitives — last layer on purpose.
 *
 * focus.css is here rather than with the components because the focus ring
 * is an accessibility guarantee, not a component detail. In the last layer
 * a stray \`outline: none\` in a component file cannot switch it off; that is
 * exactly how .btn.outlined lost its ring to a \`box-shadow: none\` before
 * v0.7. See the header of focus.css.
 */
@import './a11y/focus.css' layer(a11y);
@import './a11y/a11y.css'  layer(a11y);
`

/*
 * The Dialog term — a real <dialog>, opened with showModal().
 *
 * It was a div with role="dialog" and a hand-built backdrop, which is the
 * shape the package documents as the wrong one: ::backdrop, the top layer,
 * focus trapping, Esc-to-close and inert-behind are all things the element
 * does and a div has to reimplement. It reimplemented none of them, so the
 * config modal could not be closed with Esc and left focus in the page
 * behind it.
 *
 * .surface-header / .surface-body are the borrowed sub-regions, and
 * .dialog-close is Dialog's own part.
 */
function configModal() {
  return `
    <dialog class="dialog sg-modal" aria-labelledby="sg-modal-title" data-modal>
      <header class="surface-header">
        <div class="sg-modal-title" id="sg-modal-title">
          <span class="sg-modal-glyph">{ }</span>
          index.css
        </div>
        <div class="cluster">
          <button type="button" class="btn primary" data-copy>Copy</button>
          <button type="button" class="dialog-close" data-modal-close aria-label="Close">&times;</button>
        </div>
      </header>
      <pre class="code sg-modal-code"><code>${esc(INDEX_CSS)}</code></pre>
    </dialog>`;
}

const app = $("#app");

/* A theme is nothing but custom properties, so applying one is one assignment.
 * cssText rather than setProperty so the previous theme's tokens go with it —
 * Dark and Elite set keys the others never do. */
function applyTheme() {
  app.style.cssText = styleAttr(THEMES[state.theme].tokens);
}

function setTheme(key) {
  state.theme = key;
  applyTheme();
  /*
   * The topbar REPLACES itself. It used to be a <header> inside a wrapper
   * div whose innerHTML was refilled — but .topbar claims a grid area on
   * .shell, so it has to be the shell's own child now, and refilling it
   * would nest a second <header> inside the first and drop it out of the
   * grid.
   */
  $("#sg-topbar", app).outerHTML = topbar();
  /* The Themes page prints the active theme's source, so it has to redraw. */
  if (state.page === "themes") renderPage();
}

/*
 * The page host is REPLACED, not refilled. A page's init() hangs listeners
 * off this node, and setting innerHTML on a surviving node leaves those
 * listeners attached — visit Popovers twice and every click fires the toggle
 * twice, which reads as "the popover doesn't open." Swapping the node lets
 * the listeners go with it, so init() never has to clean up after itself.
 */
function renderPage() {
  const page = PAGES[state.page]
  const host = document.createElement('div')

  /* The copy buttons index into CODE_SRC, and the page about to render is
     the only page whose indices can be in the document. */
  CODE_SRC.length = 0
  /* Must match the host boot() writes — the node is REPLACED on every
     navigation, so a class only set in one of the two places is lost on the
     first route change and the prose column silently goes full width. */
  host.className = 'container narrow'
  host.id = 'sg-page'

  /*
   * The footer is appended HERE rather than by each page function, so a new
   * page gets it by existing in NAV — 49 hand-written next links is 49
   * chances to point at the wrong page, and a wrong one still works.
   * A page not in NAV (or the last one) gets no footer; pageNext returns ''.
   */
  host.innerHTML = (page ? page() : comingSoon(getLabel(state.page))) + pageNext(state.page)
  $('#sg-page', app).replaceWith(host)

  /*
   * aria-current, not a class. nav.css styles `.navlink[aria-current="page"]`
   * — the state is the announcement, so setting a class instead would style
   * nothing AND tell a screen reader nothing. The attribute is removed rather
   * than set to "false": `aria-current="false"` is a legal value meaning not
   * current, which the CSS then does not match but which is noise to read.
   */
  $$('[data-nav]', app).forEach((a) => {
    if (a.dataset.nav === state.page) a.setAttribute('aria-current', 'page')
    else a.removeAttribute('aria-current')
  })

  /*
   * The outline is rebuilt from the rendered DOM, not from a table of
   * contents kept beside each page. A hand-kept one goes stale the first
   * time someone adds a section, and it goes stale silently — a missing
   * entry looks like a page that simply has fewer sections.
   */
  $$('.sg-nav-sub', app).forEach((ul) => ul.remove())
  const sections = tagSections(host)
  const active = $(`[data-nav="${state.page}"]`, app)
  if (active) active.parentElement.insertAdjacentHTML('beforeend', sectionNav(sections))

  if (page && page.init) page.init(host)
}

/*
 * The document is the scroller. `.screen` declares no overflow, so a
 * `.screen.scrollTop = 0` would never move anything: navigating from the
 * bottom of a long page would land you part-way down the next one. It is
 * also why the shell is NOT `.shell.viewport`, which would make the Screen
 * the scroller and break every anchor here.
 *
 * The topbar is sticky, so a section left to the browser's own anchor
 * handling sits underneath it. The offset is READ from --topbar-height
 * rather than hard-coded: it was 69px against a 53px bar, and once the
 * topbar started reading the token, a literal here would drift from it with
 * nothing to say so.
 */
function scrollToSection(id) {
  const el = id && document.getElementById(id)
  if (!el) {
    window.scrollTo(0, 0)
    return
  }
  const bar = parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue('--topbar-height')
  ) || 3.5
  /* The token is in rem; the gap below the bar is a sixth of it. */
  const offset = bar * 16 * (7 / 6)
  window.scrollTo(0, Math.max(0, el.getBoundingClientRect().top + window.scrollY - offset))
}

/*
 * Renamed page ids. A hash is a bookmark and someone has it — an unknown id
 * falls through to comingSoon(), which reads as "the guide lost a page"
 * rather than "that page moved". Every rename lands here.
 */
const RENAMED = {
  tags: "badges",
  principles: "overview",
  /*
   * Spacing documented a 4px numeric scale the package never had, and a set
   * of margin utilities it does not ship — on a page whose real subject was
   * who OWNS the space. That is what behaviour is.
   */
  spacing: "behaviour",
};

/*
 * The hash carries both: `#badges` is a page, `#badges:when-to-use-which` is
 * a section of one. A plain `#section-id` cannot be used for the second —
 * this router owns the whole hash, so a bare anchor would read as a request
 * for a page of that name and land on "not yet defined".
 */
function route() {
  const [rawId, section] = location.hash.slice(1).split(':')

  if (RENAMED[rawId]) {
    /* Rewrite rather than redirect, so the address bar stops lying too. */
    location.replace('#' + RENAMED[rawId] + (section ? ':' + section : ''))
    return
  }

  const id = rawId || 'buttons'
  const samePage = id === state.page && $('#sg-page', app).childElementCount > 0

  if (!samePage) {
    state.page = id
    renderPage()
  }

  /* Re-rendering for a section would throw away the scroll position we are
     about to set, and re-run the page's init() for no reason. */
  scrollToSection(section)

  /*
   * aria-current="true", not "page" — the page is the sidebar entry above
   * these; a section within it is current in a weaker sense, and two
   * elements claiming aria-current="page" is a contradiction a screen reader
   * reads out twice.
   */
  $$('[data-sub]', app).forEach((a) => {
    if (section && a.dataset.sub === section) a.setAttribute('aria-current', 'true')
    else a.removeAttribute('aria-current')
  })
}

function openConfig() {
  app.insertAdjacentHTML("beforeend", configModal());
  const modal = $("[data-modal]", app);

  /*
   * Show the file, not our copy of it. Over http (bun run demo) this replaces
   * the embedded text with whatever ../index.css actually says right now; over
   * file:// the fetch is blocked by CORS and the copy stands. The guide has
   * been two versions behind before, and it was always a copy that did it.
   */
  fetch("../src/index.css")
    .then((r) => (r.ok ? r.text() : null))
    .then((text) => {
      if (!text) return;
      const pre = $("code", modal);
      if (pre) pre.textContent = text;
      modal.dataset.source = "live";
    })
    .catch(() => {});

  modal.showModal();

  /*
   * `close` is the one exit every route funnels through — Esc, the close
   * button, a backdrop click — so removal hangs off it rather than off each
   * of the three. `once`, because the handler removes the node and a reopen
   * builds a fresh one.
   *
   * The dispose() below is the same removal reached directly. Headless
   * Chrome does not deliver `close` at all: measured, `close()` flips the
   * open attribute and no listener fires, not even a capture listener on
   * document. That is the same class of gap CLAUDE.md records for top-layer
   * transitions — so a drive that only asserted "the dialog is gone" would
   * report a bug in this file forever. Calling dispose() at each exit keeps
   * the DOM correct without a real browser, and the `close` listener keeps
   * Esc working in one.
   */
  const dispose = () => {
    if (modal.open) modal.close();
    modal.remove();
  };
  modal.addEventListener("close", () => modal.remove(), { once: true });

  modal.addEventListener("click", (e) => {
    /*
     * `e.target === modal` IS the backdrop click on a <dialog>: the backdrop
     * is a pseudo-element of the dialog, so a click on it targets the dialog
     * itself, while a click inside targets a descendant. The panel used to
     * be a child of a backdrop div, and the same line meant the same thing —
     * it reads differently now and behaves identically.
     */
    if (e.target === modal || e.target.closest("[data-modal-close]")) {
      dispose();
      return;
    }

    if (e.target.closest("[data-copy]") && navigator.clipboard) {
      const btn = e.target.closest("[data-copy]");
      /* Read the panel, not the constant — the fetch above may have
       * replaced it with the live file. */
      navigator.clipboard.writeText($("code", modal).textContent).then(() => {
        btn.textContent = "Copied";
        setTimeout(() => (btn.textContent = "Copy"), 1500);
      });
    }
  });
}

function boot() {
  /*
   * The frame is the package's own — .shell positions .topbar, .sidebar and
   * .screen through grid-template-areas, so the topbar lives INSIDE the grid
   * rather than above it. The hand-rolled version had it as a sibling, which
   * is why setTheme() re-rendered it through a wrapper div; it now replaces
   * the <header> itself.
   *
   * .container.narrow holds the prose column, which is the job the
   * hand-rolled .sg-main-inner max-width was doing.
   */
  app.innerHTML = `
    <div class="shell">
      ${topbar()}
      ${sidebar()}
      <main class="screen" id="screen">
        <div class="container narrow" id="sg-page"></div>
      </main>
    </div>`

  applyTheme()

  /*
   * Show the version the manifest says, not our copy of it. Same rule the
   * config modal follows for index.css: link the source, never copy it. The
   * literal in topbar() had been two releases stale (v0.10.1 against a
   * package.json saying 0.12.0), on every page, in the chrome — which is the
   * one place a reader takes on trust.
   *
   * Over file:// the fetch is blocked by CORS and the literal stands, so it
   * has to stay correct as a fallback rather than being emptied.
   */
  fetch('../package.json')
    .then((r) => (r.ok ? r.json() : null))
    .then((pkg) => {
      const el = $('[data-version]', app)
      if (pkg && pkg.version && el) el.textContent = 'v' + pkg.version
    })
    .catch(() => {})

  /* Chrome behaviour, delegated once from the root — the topbar and the
   * sidebar are re-rendered as HTML, so nothing may hold a node reference. */
  app.addEventListener('click', (e) => {
    if (e.target.closest('[data-theme-menu]')) {
      const dropdown = $('[data-theme-dropdown]', app)
      dropdown.hidden = !dropdown.hidden
      return
    }

    if (e.target.closest('[data-theme-close]')) {
      $('[data-theme-dropdown]', app).hidden = true
      return
    }

    const themeOption = e.target.closest('[data-theme]')
    if (themeOption && themeOption.closest('[data-theme-dropdown]')) {
      setTheme(themeOption.dataset.theme)
      return
    }

    const copyBtn = e.target.closest('[data-copy-code]')
    if (copyBtn) {
      copyCode(copyBtn)
      return
    }

    if (e.target.closest('[data-config]')) {
      openConfig()
      return
    }

    /* Demo links that go nowhere — every one of them is `href="#"` or
     * `href="#0"`, which would otherwise hijack the hash router. */
    const dead = e.target.closest('a[href="#"], a[href="#0"], a[data-noop]')
    if (dead) e.preventDefault()
  })

  wireSearch()

  window.addEventListener('hashchange', route)
  route()

  /*
   * Warm the corpus once the first page is on screen. Building it renders
   * all 51 pages, which is short but not free — paying for it on the first
   * keystroke instead would put the whole cost between typing a letter and
   * seeing it, which is the one place it would be felt.
   */
  if (window.requestIdleCallback) requestIdleCallback(buildSearchIndex, { timeout: 3000 })
  else setTimeout(buildSearchIndex, 600)
}

boot();
