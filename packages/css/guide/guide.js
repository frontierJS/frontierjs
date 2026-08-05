/*
 * guide.js — the @frontierjs/css style guide, in plain JavaScript.
 *
 * Converted from style-guide.jsx (retired 2026-08-02; see git history if you
 * need to compare). No React, no build step, no bundler: the
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
 *   4. Shell + router — topbar, sidebar, and the hash router that drives them
 *
 * Interactive markup is wired by delegation from data-* attributes rather
 * than inline handlers, so page HTML stays copy-pasteable — what you read in
 * a preview is what you would write in an app.
 */

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
    group: "Start Here",
    items: [
      { id: "overview", label: "Overview" },
      { id: "principles", label: "Principles" },
      { id: "taxonomy", label: "Kinds of class" },
      { id: "install", label: "Install" },
      { id: "composition", label: "Composition" },
      { id: "conventions", label: "Conventions" },
    ],
  },
  {
    // Half 1 of the system: what the HTML actually is.
    group: "Structure",
    items: [
      { id: "vocabulary", label: "Vocabulary" },
      { id: "frame", label: "App frame" },
    ],
  },
  {
    group: "Foundation",
    items: [
      { id: "variables", label: "CSS Variables" },
      { id: "tonal", label: "Tones & contrast" },
      { id: "layers", label: "Cascade layers" },
      { id: "themes", label: "Themes" },
      { id: "colors", label: "Colors" },
    ],
  },
  {
    group: "Components",
    items: [
      { id: "buttons", label: "Buttons" },
      { id: "links", label: "Links" },
      { id: "headings", label: "Headings" },
      { id: "cards", label: "Cards" },
      { id: "tiles", label: "Tiles" },
      { id: "feedback", label: "Loading & empty" },
      { id: "alerts", label: "Alerts" },
      { id: "toasts", label: "Toasts" },
      { id: "popovers", label: "Popovers" },
      { id: "tooltips", label: "Tooltips" },
      { id: "drawers", label: "Drawers" },
      { id: "tables", label: "Tables" },
      { id: "dialogs", label: "Dialogs" },
      { id: "inputs", label: "Inputs" },
      { id: "formcontrols", label: "Form controls" },
      { id: "tags", label: "Tags & Pills" },
      { id: "avatar", label: "Avatar" },
      { id: "icons", label: "Icons" },
      { id: "code", label: "Code & Kbd" },
    ],
  },
  {
    // The v0.5 Block tier — layout-only patterns, no surface treatment.
    group: "Patterns",
    items: [
      { id: "bar", label: "Bar" },
      { id: "sectionheader", label: "Section header" },
      { id: "divider", label: "Divider label" },
      { id: "items", label: "Items" },
      { id: "rows", label: "Rows" },
      { id: "feed", label: "Feed" },
      { id: "facts", label: "Facts" },
      { id: "steps", label: "Steps" },
      { id: "disclosure", label: "Disclosure" },
      { id: "tabs", label: "Tabs" },
      { id: "nav", label: "Navigation" },
    ],
  },
  {
    group: "Utilities",
    items: [
      { id: "layouts", label: "Layouts" },
      { id: "responsive", label: "Responsive" },
      { id: "spacing", label: "Spacing" },
      { id: "typography", label: "Typography" },
      { id: "a11y", label: "Accessibility" },
    ],
  },
  {
    group: "Reference",
    items: [{ id: "cheatsheet", label: "Cheat sheet" }],
  },
];

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
    name: "Default",
    description: "Blue brand, neutral surfaces.",
    tokens: {
      "--color-primary": "#0d83dd",
      "--color-secondary": "#1f2937",
      "--color-muted": "#6b7280",
      "--color-info": "#2EA2C9",
      "--color-success": "#16a34a",
      "--color-warning": "#d4b609",
      "--color-danger": "#F4403A",
    },
  },
  sunset: {
    name: "Sunset",
    description: "Warm oranges, earthy accents.",
    tokens: {
      "--color-primary": "#F98E2E",
      "--color-secondary": "#9a3412",
      "--color-muted": "#a8a29e",
      "--color-info": "#c2410c",
      "--color-success": "#84cc16",
      "--color-warning": "#facc15",
      "--color-danger": "#dc2626",
    },
  },
  forest: {
    name: "Forest",
    description: "Green primary, cool neutrals.",
    tokens: {
      "--color-primary": "#16a34a",
      "--color-secondary": "#166534",
      "--color-muted": "#64748b",
      "--color-info": "#0891b2",
      "--color-success": "#15803d",
      "--color-warning": "#ca8a04",
      "--color-danger": "#b91c1c",
    },
  },
  midnight: {
    name: "Midnight",
    description: "Purple accent, deep contrast.",
    tokens: {
      "--color-primary": "#8b5cf6",
      "--color-secondary": "#4338ca",
      "--color-muted": "#94a3b8",
      "--color-info": "#06b6d4",
      "--color-success": "#10b981",
      "--color-warning": "#f59e0b",
      "--color-danger": "#ef4444",
    },
  },
  dark: {
    name: "Dark",
    description: "Inverted neutrals, same brand colors.",
    tokens: {
      "--surface": "#1a1a1a",
      "--surface-raised": "#252525",
      "--surface-sunken": "#0f0f0f",
      "--ink": "#f5f5f5",
      "--ink-soft": "#c5c5c5",
      "--ink-mute": "#8c8c8c",
      "--rule": "#2d2d2d",
      "--rule-strong": "#404040",
      "--paper": "#0f0f0f",
      "--code-bg": "#252525",
      "--code-text": "#e5e5e5",
    },
  },
  elite: {
    name: "Elite",
    description: "Navy + lime, uppercase, sharp corners, Montserrat.",
    tokens: {
      "--color-primary": "#9fc612",
      "--color-secondary": "#1d3b4c",
      "--color-muted": "#6b7280",
      "--color-info": "#1d3b4c",
      "--color-success": "#3a7d1e",
      "--color-warning": "#ca8a04",
      "--color-danger": "#b22222",
      "--btn-radius": "0",
      "--card-radius": "0",
      "--field-radius": "0",
      "--btn-font-weight": "700",
      "--btn-text-transform": "uppercase",
      "--btn-letter-spacing": "0.1em",
      "--badge-font-weight": "700",
      "--badge-letter-spacing": "0.08em",
      "--pill-text-transform": "uppercase",
      "--pill-letter-spacing": "0.05em",
      "--shadow-md": "0 1px 3px rgba(0,0,0,.08), 0 4px 12px rgba(0,0,0,.04)",
      "--font-primary": "'Montserrat', system-ui, sans-serif",
      "--font-mono": "'IBM Plex Mono', monospace",
    },
  },
};

function getLabel(id) {
  for (const g of NAV) {
    for (const item of g.items) {
      if (item.id === id) return item.label;
    }
  }
  return id;
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
      <hr class="sg-divider">
    </header>`;
}

function section(title, body) {
  return `
    <section class="sg-section">
      <h2 class="sg-h2">${title}</h2>
      ${body}
    </section>`;
}

function preview(body) {
  return `<div class="sg-preview-box">${body}</div>`;
}

function code(src) {
  return `<pre class="sg-code"><code>${esc(src)}</code></pre>`;
}

/*
 * A clickable example that loads its own class chain into the Buttons page
 * live editor. `data-btn` is read by that page's delegated handler.
 */
function chip(label, cls) {
  return `<button type="button" class="${cls}" data-btn="${esc(cls)}">${label}</button>`;
}

function comingSoon(label) {
  return `
    <div class="sg-coming">
      <strong>${label}</strong>
      <span> — not yet defined.</span>
    </div>`;
}
/* ══════════════════════════════════════════════════════════════════════
   3. Pages — Start Here
   ══════════════════════════════════════════════════════════════════════ */

function overviewPage() {
  return `
    <article>
      ${pageHeader({
        eyebrow: "Start Here",
        title: "A design system, not a component library.",
        lead: "Small, opinionated CSS conventions for Svelte applications. Class chains over component APIs. CSS variables over rewrites.",
      })}

      ${section(
        "The contract",
        `
        <p class="sg-prose">
          Every styled element follows the same pattern. A base class declares
          its var contract and uses those vars to style itself. Modifiers and
          variants only set the vars — they never write styles directly.
        </p>
        <ul class="sg-list">
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
        </ul>`,
      )}

      ${section(
        "What this buys you",
        `
        <p class="sg-prose">
          Per-client theming is a single var file, never a component rewrite.
          A new tone is one rule. Outlined, ghost, pill — anything that reads
          the existing vars composes with every tone you've defined, for free.
          The class chain reads in English: <code>btn primary outlined</code>.
        </p>`,
      )}
    </article>`;
}

function installPage() {
  return `
    <article>
      ${pageHeader({
        eyebrow: "Start Here",
        title: "Install",
        lead: "One dependency, one import, one class on &lt;body&gt;. Plain CSS — no build step, no UnoCSS, no config.",
      })}

      ${section(
        "Prerequisites",
        `
        <ul class="sg-list">
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
        <p class="sg-prose">
          One import covers everything: tokens, all six themes, tones, the two
          lineage bases, layout helpers, components and patterns. The entry point
          assigns each file to a cascade layer as it goes.
        </p>
        ${code(`// src/main.ts
import '@frontierjs/css'

// or, without a bundler
<link rel="stylesheet" href="/styles/index.css">`)}
        <p class="sg-prose">
          Want just a slice? Every file is individually importable, at the path
          it lives at — the folders mirror the cascade layers:
        </p>
        ${code(`@import '@frontierjs/css/foundation/tokens.css';
@import '@frontierjs/css/themes/default.css';
@import '@frontierjs/css/components/buttons.css';`)}
        <p class="sg-prose">
          Import <code>foundation/tokens.css</code> and at least one theme
          first, or nothing will have colors. <strong>Changed in v0.11</strong>
          — these were flat (<code>@frontierjs/css/buttons.css</code>) before.
        </p>`,
      )}

      ${section(
        "3. Pick a theme",
        `
        <p class="sg-prose">
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
        <p class="sg-prose">
          That is the whole setup. See <strong>Kinds of class</strong> for the
          composition model and <strong>Principles</strong> for how to choose the
          elements.
        </p>`,
      )}

      ${section(
        "Overriding it",
        `
        <p class="sg-prose">
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
        <p class="sg-prose">
          Uno is optional, and the two compose well — but there are three things
          to know. All of this was measured against UnoCSS 66.7.5 with
          <code>presetWind3</code>, not inferred.
        </p>

        <p class="sg-prose">
          <strong>1. The good part is free.</strong> Uno's output is unlayered
          and everything here is layered, so every Uno utility beats every
          component with no ordering discipline and no <code>!important</code>.
          <code>${esc('class="card p-4"')}</code> gets Uno's padding.
        </p>

        <p class="sg-prose">
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
        <p class="sg-prose">
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

        <p class="sg-prose">
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
        <ul class="sg-list">
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
    </article>`;
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
    <article>
      ${pageHeader({
        eyebrow: "Start Here",
        title: "Composition",
        lead: "A small base class supplies the bones. Everything else extends it. New visual languages plug in by sharing the same skeleton.",
      })}

      ${section(
        "The lineage",
        `
        <p class="sg-prose">
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
            </div>`,
              )
              .join("")}
          </div>
        </div>`,
      )}

      ${section(
        "chip — the base",
        `
        <p class="sg-prose">
          <code>chip</code> only declares structure: inline-flex, alignment,
          gap, whitespace-nowrap. No color, no font weight. It lives as a
          Uno shortcut so every consumer composes it the same way.
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
}`)}`,
      )}

      ${branches
        .map((b) =>
          section(
            `${b.name} — extends chip`,
            `
        <p class="sg-prose">
          <strong>${b.role}.</strong> Adds: ${b.adds}.
        </p>
        ${preview(`<div class="sg-row-flex">${b.preview}${b.extra}</div>`)}
        ${code(b.code)}`,
          ),
        )
        .join("")}

      ${section(
        "How extension resolves",
        `
        <p class="sg-prose">
          Shortcuts compose by name. <code>badge</code>'s shortcut starts
          with <code>chip</code>, so Uno inlines <code>chip</code>'s utilities
          alongside <code>badge</code>'s own. Markup writes the leaf class only.
        </p>
        <div class="sg-resolve">
          <div class="sg-resolve-col">
            <div class="sg-resolve-label">Shortcut</div>
            <pre class="sg-code sg-code-inline">${esc(`['badge',
  'chip text-xs uppercase
   tracking-wide font-semibold
   px-2 py-0.5 rounded']`)}</pre>
          </div>
          <div class="sg-resolve-arrow">→</div>
          <div class="sg-resolve-col">
            <div class="sg-resolve-label">Resolved</div>
            <pre class="sg-code sg-code-inline">${esc(`inline-flex items-center
justify-center gap-1.5
whitespace-nowrap text-center
text-xs uppercase tracking-wide
font-semibold px-2 py-0.5 rounded`)}</pre>
          </div>
        </div>
        <p class="sg-prose">
          Source of truth is the CSS. Each composite owns one flat file —
          <code>buttons.css</code>, <code>cards.css</code> — and shares a
          zero-specificity <code>:where()</code> base: <code>chip.css</code>
          for the inline lineage, <code>surface.css</code> for the block one.
        </p>`,
      )}

      ${section(
        "The surface lineage — block primitives",
        `
        <p class="sg-prose">
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
        <p class="sg-prose">
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
}`)}`,
      )}

      ${section(
        "Standalone block primitives",
        `
        <p class="sg-prose">
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
        </div>`,
      )}

      ${section(
        "Tones — the cross-cutting layer",
        `
        <p class="sg-prose">
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
        <p class="sg-prose">
          The class works on its own too —
          <code>${esc(`<span class="danger">7 days</span>`)}</code> sets the vars
          even with no component attached. Any element using
          <code>var(--bg-mix)</code> picks them up.
        </p>`,
      )}

      ${section(
        "Why this compounds",
        `
        <p class="sg-prose">
          Two leverage points working together:
        </p>
        <ul class="sg-list">
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
            <strong>New components don't restart from zero.</strong> Add a
            new shortcut that extends <code>chip</code>, declare which vars
            it reads from the tone contract, done. No tone-mapping
            boilerplate per file.
          </li>
        </ul>`,
      )}
    </article>`;
}

function conventionsPage() {
  return `
    <article>
      ${pageHeader({
        eyebrow: "Start Here",
        title: "Conventions",
        lead: "The rules that let the system grow without rewrites.",
      })}

      ${section(
        "Class order doesn't matter",
        `
        <p class="sg-prose">
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
        <p class="sg-prose">
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
        <p class="sg-prose">
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
    </article>`;
}
/* ══════════════════════════════════════════════════════════════════════
   3. Pages — Foundation
   ══════════════════════════════════════════════════════════════════════ */

function variablesPage() {
  return `
    <article>
      ${pageHeader({
        eyebrow: "Foundation",
        title: "CSS Variables",
        lead: "Two scopes: global tokens on :root, and per-component contracts on each base class.",
      })}

      ${section(
        "Global tokens",
        `
        <p class="sg-prose">
          Semantic color tokens live on <code>:root</code>. Every component
          references these — never raw hex.
        </p>
        <table class="sg-token-table">
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
        <p class="sg-prose">
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
        <table class="sg-token-table">
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
        <p class="sg-prose">
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
    </article>`;
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
    <article>
      ${pageHeader({
        eyebrow: "Components",
        title: "Buttons",
        lead: "The .btn class plus modifiers. Tones set the var contract. Outlined reads them and flips structure.",
      })}

      ${section(
        "Default",
        `
        <p class="sg-prose">
          The bare <code>btn</code> class is your primary button — no extra
          modifier needed.
        </p>
        ${preview(chip("Button", "btn"))}
        ${code(`<button class="btn">Button</button>`)}`,
      )}

      ${section(
        "Tones",
        `
        <p class="sg-prose">
          The tone classes (<code>.primary</code>, <code>.danger</code>, …)
          live in one file — <code>tones.css</code> — and set
          <code>--bg-mix</code> + <code>--on-bg-mix</code>. The button reads
          those vars; same vocabulary works on pills, badges, cards, fields.
        </p>
        ${preview(
          `<div class="sg-row-flex">
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
        <p class="sg-prose">
          Adding <code>outlined</code> reads the vars set by the tone and
          inverts the structure — background becomes surface; color and border
          become the tone hue.
        </p>
        ${preview(
          `<div class="sg-row-flex">
            ${TONES.map(([cls, label]) => chip(label, `btn ${cls} outlined`)).join("")}
          </div>`,
        )}
        ${code(`<button class="btn primary outlined">Primary</button>`)}`,
      )}

      ${section(
        "Sizes",
        `
        <p class="sg-prose">
          Sizes ride the type scale. Padding is set in <code>em</code> so
          font-size carries the whole thing.
        </p>
        ${preview(
          `<div class="sg-row-flex sg-row-baseline">
            ${sizes.map(([cls, label]) => chip(label, `btn ${cls}`)).join("")}
          </div>`,
        )}`,
      )}

      ${section(
        "Link button",
        `
        <p class="sg-prose">
          The <code>link</code> modifier strips structure and renders the
          button visually as a link, while keeping button semantics.
        </p>
        ${preview(chip("Link Button", "btn link"))}
        ${code(`<button class="btn link">Link Button</button>`)}`,
      )}

      ${section(
        "Live editor",
        `
        <p class="sg-prose">
          Compose the class chain yourself. Any example above populates this
          field.
        </p>
        <div class="sg-editor">
          <label class="sg-editor-label" for="sg-btn-chain">Class chain</label>
          <input
            id="sg-btn-chain"
            value="${esc(state.btnClasses)}"
            placeholder="btn primary outlined"
            spellcheck="false">
          <div class="sg-preview-box sg-preview-center">
            <button id="sg-btn-sample" class="${esc(state.btnClasses)}">Example Button</button>
          </div>
        </div>`,
      )}
    </article>`;
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
    <article>
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
        <p class="sg-prose">
          A button that needs to read as a link uses <code>btn link</code>.
        </p>
        ${preview(`<button class="btn link">Link button</button>`)}
        ${code(`<button class="btn link">Link button</button>`)}`,
      )}
    </article>`;
}

function tonalPage() {
  const tones = ["primary", "secondary", "muted", "info", "success", "warning", "danger"];

  return `
    <article>
      ${pageHeader({
        eyebrow: "Foundation",
        title: "Tones &amp; contrast",
        lead: "A tone is one variable. Everything else — surface tints, borders, fills, text color — is derived from it, and none of the derivations know any tone names.",
      })}

      ${section(
        "The contract is one variable",
        `
        <p class="sg-prose">
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
          ${tones.map((t) => `<button class="btn ${t}">${t}</button>`).join("")}
        </div>`,
      )}

      ${section(
        "Tones are element-scoped",
        `
        <p class="sg-prose">
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
        <p class="sg-prose">
          The cost: a rule that reads <code>--bg-mix</code> must sit on the element
          carrying the tone class. Where a child needs the value — the tinted
          <code>&lt;td&gt;</code> in a toned row, the tinted header of a toned
          dialog — the toned element derives the result into a normal inheriting
          property and passes that down.
        </p>`,
      )}

      ${section(
        "The surface recipe names no tones",
        `
        <p class="sg-prose">
          Each tint is computed from <code>--bg-mix</code>. When there is no tone,
          <code>--bg-mix</code> is guaranteed-invalid, so the
          <code>color-mix()</code> is invalid at computed-value time, so the tint
          variable is too — and the fallback on the next line supplies the untoned
          default. That is the whole mechanism, and it is why every tone works on
          every surface without anything enumerating them.
        </p>
        ${code(`:where(.surface, .card, .alert, .toast, .dialog, .popover, .drawer) {
  --surface-tint-bg:     color-mix(in srgb, var(--bg-mix) 10%, var(--surface));
  --surface-tint-border: color-mix(in srgb, var(--bg-mix) 30%, var(--surface));
  --surface-tint-color:  color-mix(in srgb, var(--bg-mix) 55%, var(--ink));

  --surface-bg:     var(--surface-tint-bg,     var(--surface));
  --surface-border: var(--surface-tint-border, var(--rule));
  --surface-color:  var(--surface-tint-color,  var(--ink));
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
          </article>`,
            )
            .join("")}
        </div>
        <div class="alert info">
          <div class="alert-icon" aria-hidden="true">&#9432;</div>
          <div class="alert-content">
            <strong>
              <code>.secondary</code> and <code>.muted</code> are in that list now.
            </strong>
            <p>
              Before v0.6 the recipe read
              <code>:is(.primary, .info, .success, .warning, .danger)</code> — so
              those two set a variable and nothing happened. Four files each
              enumerated a different subset of the seven tones.
            </p>
          </div>
        </div>`,
      )}

      ${section(
        "Contrast is derived, not asserted",
        `
        <p class="sg-prose">
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
            ${tones.map((t) => `<span class="badge ${t}">${t}</span>`).join("")}
          </div>`,
        )}
        <p class="sg-prose">
          <code>bun run test</code> checks all <strong>42</strong> tone × theme
          combinations — seven tones × six themes — on each of
          <code>.btn</code>, <code>.pill</code> and <code>.badge</code>, and
          they clear AA. Because it is derived rather than tabulated it holds
          for hues no theme has defined yet, so the suite also throws
          <strong>eight invented hues</strong> at it — pure yellow, navy, mid
          grey, the light lime near Elite's brand — chosen to straddle the
          branch. A new theme cannot reintroduce the bug.
        </p>
        ${code(`/* chip.css — override per tone or theme if you want a specific text color */
.theme-x .warning { --on-bg-mix: #1f2937; }`)}`,
      )}

      ${section(
        "Why not lighten-N / darken-N",
        `
        <p class="sg-prose">
          Through v0.5 this page documented a <code>lighten-N</code> /
          <code>darken-N</code> scale from <code>uno.config.ts</code>. Those rules
          wrote <code>--bg</code> and <code>--color</code>, which
          <strong>no rule in the package ever read</strong> — they had never
          worked. They were removed in v0.6 along with the rest of the Uno config.
        </p>
        <p class="sg-prose">
          If you want a shade, use <code>color-mix()</code> directly. It is the
          same primitive the recipe above is built from, and it needs no build
          step.
        </p>
        ${code(`background: color-mix(in srgb, var(--color-primary) 20%, var(--surface));`)}`,
      )}
    </article>`;
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
    <article>
      ${pageHeader({
        eyebrow: "Foundation",
        title: "Themes",
        lead: "A theme is a set of CSS variables. Nothing else. Apply the theme class to any subtree and every component reskins, no rewriting required.",
      })}

      ${section(
        "Live switcher",
        `
        <p class="sg-prose">
          Pick a theme. The vars cascade. Every button, badge, pill, and tonal
          surface below reskins instantly. No component code changes.
        </p>
        <div class="sg-theme-switcher">
          ${Object.entries(THEMES)
            .map(
              ([key, t]) => `
          <button
            type="button"
            class="sg-theme-tab${active === key ? " active" : ""}"
            data-theme="${key}">
            <span class="sg-theme-swatch" style="background: ${t.tokens["--color-primary"] || "var(--color-primary)"}"></span>
            <div class="sg-theme-tab-text">
              <div class="sg-theme-tab-name">${t.name}</div>
              <div class="sg-theme-tab-desc">${t.description}</div>
            </div>
          </button>`,
            )
            .join("")}
        </div>

        <div class="sg-theme-preview" style="${styleAttr(theme.tokens)}">
          <div class="sg-theme-block">
            <div class="sg-theme-label">Buttons</div>
            <div class="sg-row-flex">
              <button class="btn">Save</button>
              <button class="btn outlined">Cancel</button>
              <button class="btn success">Approve</button>
              <button class="btn warning">Review</button>
              <button class="btn danger outlined">Delete</button>
            </div>
          </div>

          <div class="sg-theme-block">
            <div class="sg-theme-label">Badges &amp; Pills</div>
            <div class="sg-row-flex">
              <span class="badge success">Active</span>
              <span class="badge warning">Pending</span>
              <span class="badge danger">Failed</span>
              <span class="pill primary">12</span>
              <span class="pill info">i</span>
              <span class="pill danger">99+</span>
            </div>
          </div>

          <div class="sg-theme-block">
            <div class="sg-theme-label">Tonal ramp</div>
            <div class="sg-theme-ramp" style="--sg-ramp: var(--color-primary); --color: var(--ink)">
              ${ramp
                .map(
                  ([n, bg, fg]) =>
                    `<div class="tonal" style="background: ${bg}; color: ${fg}">${n}</div>`,
                )
                .join("")}
              <div class="tonal sg-tonal-raw">raw</div>
              ${rampDark
                .map(
                  ([n, bg, fg]) =>
                    `<div class="tonal" style="background: ${bg}; color: ${fg}">${n}</div>`,
                )
                .join("")}
            </div>
          </div>

          <div class="sg-theme-block">
            <div class="sg-theme-label">Form field</div>
            <div class="field-group">
              <label>Email address</label>
              <input class="field" type="email" value="you@example.com">
            </div>
          </div>
        </div>`,
      )}

      ${section(
        "The active theme",
        `
        <p class="sg-prose">
          This is everything that defines the <code>${active}</code> theme.
          One file. Seven tokens.
        </p>
        ${code(themeCSS)}`,
      )}

      ${section(
        "Scoping",
        `
        <p class="sg-prose">
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
</body>`)}`,
      )}

      ${section(
        "Adding a new theme",
        `
        <p class="sg-prose">
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
        <p class="sg-prose">
          No components touched. No shortcuts updated. Apply
          <code>theme-oceanic</code> to <code>html</code>, <code>body</code>,
          or any subtree.
        </p>`,
      )}
    </article>`;
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
    <article>
      ${pageHeader({
        eyebrow: "Foundation",
        title: "Colors",
        lead: "Seven semantic tones. Each one feeds a full tonal ramp via color-mix — one source-of-truth hue per role.",
      })}

      ${section(
        "The palette",
        `
        <p class="sg-prose">
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
        <p class="sg-prose">
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
        <table class="sg-token-table">
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
        <p class="sg-prose">
          A few rules that keep the palette working as it scales:
        </p>
        <ul class="sg-list">
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
    </article>`;
}

function headingsPage() {
  return `
    <article>
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
        <p class="sg-prose">
          Tag selectors paired with classes — write the right semantic tag,
          fall back to the class when the element doesn't match the role.
        </p>
        ${code(`/* typography.css */
h1, .h1 { font-size: 2.25rem; font-weight: 700; letter-spacing: -0.02em;  line-height: 1.1; }
h2, .h2 { font-size: 1.75rem; font-weight: 700; letter-spacing: -0.015em; line-height: 1.2; }
h3, .h3 { font-size: 1.375rem; font-weight: 600; line-height: 1.3; }
h4, .h4 { font-size: 1.125rem; font-weight: 600; }
h5, .h5 { font-size: 1rem;     font-weight: 600; }
h6, .h6 { font-size: 0.875rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }`)}`,
      )}

      ${section(
        "Borrowed styling",
        `
        <p class="sg-prose">
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
    </article>`;
}

function cardsPage() {
  return `
    <article>
      ${pageHeader({
        eyebrow: "Components",
        title: "Cards",
        lead: "A surface container. Card is its own base — a block primitive that sits alongside chip, not extending it.",
      })}

      ${section(
        "Default",
        `
        <p class="sg-prose">
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
        <p class="sg-prose">
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
        <p class="sg-prose">
          Same vocabulary as buttons. Each variant only flips the var contract
          — same structure, different surface treatment.
        </p>
        ${preview(`
          <div class="sg-card-grid">
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
        <p class="sg-prose">
          Tone modifiers set <code>--bg-mix</code>, and the card derives its
          surface, border, and text color from it. The mixing rules from the
          Tonal page do the work.
        </p>
        ${preview(`
          <div class="sg-card-grid">
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
        <p class="sg-prose">
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
        <ul class="sg-list">
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
    </article>`;
}

function alertsPage() {
  return `
    <article>
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
        <p class="sg-prose">
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
        <p class="sg-prose">
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
    </article>`;
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
    <article>
      ${pageHeader({
        eyebrow: "Components",
        title: "Toasts",
        lead: "Transient feedback. Extends surface, adds fixed positioning and a slide-in animation. Stack multiple via toast-stack.",
      })}

      ${section(
        "Fire one",
        `
        <p class="sg-prose">
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
        <p class="sg-prose">
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
    </article>`;
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
    <article>
      ${pageHeader({
        eyebrow: "Components",
        title: "Popovers",
        lead: "Floating UI. Extends surface, adds absolute positioning and a slide-in animation. Positioning is the consumer's job — Uno utilities make it easy.",
      })}

      ${section(
        "Default",
        `
        <p class="sg-prose">
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
        <p class="sg-prose">
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
        "Source",
        code(`/* popovers.css — 12 lines */
.popover {
  position:   absolute;
  max-width:  280px;
  padding:    10px 12px;
  box-shadow: var(--shadow-md);
  font-size:  13px;
  z-index:    50;
  animation:  popover-in 120ms ease-out;
}
@keyframes popover-in {
  from { opacity: 0; transform: translateY(-4px); }
  to   { opacity: 1; transform: translateY(0); }
}

/* Bg/border/radius/tones all come from surface.css */`),
      )}
    </article>`;
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
    <article>
      ${pageHeader({
        eyebrow: "Components",
        title: "Drawers",
        lead: "Off-canvas panel. Built on native &lt;dialog&gt; so focus trap, backdrop, and Esc-to-close are platform-provided. Slides in from any edge.",
      })}

      ${section(
        "Edges",
        `
        <p class="sg-prose">
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
        <p class="sg-prose">
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
    </article>`;
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
    <article>
      ${pageHeader({
        eyebrow: "Components",
        title: "Tables",
        lead: "The .table base. Var contract for surfaces, tone modifiers on rows, density variants — same conventions as everything else.",
      })}

      ${section(
        "Default",
        `
        <p class="sg-prose">
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
        <p class="sg-prose">
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
        <p class="sg-prose">
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
    </article>`;
}
function dialogsPage() {
  return `
    <article>
      ${pageHeader({
        eyebrow: "Components",
        title: "Dialogs",
        lead: "Built on the native &lt;dialog&gt; element — focus trap, escape-to-close, scrollable overlay all handled by the platform. Class only owns the surface treatment.",
      })}

      ${section(
        "Default",
        `
        <p class="sg-prose">
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
        <p class="sg-prose">
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
        <p class="sg-prose">
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
        <ul class="sg-list">
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
    </article>`;
}

dialogsPage.init = wireDialogs;

function inputsPage() {
  return `
    <article>
      ${pageHeader({
        eyebrow: "Components",
        title: "Inputs",
        lead: "One .field base class drives every form control. Tone modifiers and states share the same vocabulary as buttons.",
      })}

      ${section(
        "The field base",
        `
        <p class="sg-prose">
          Declares its own var contract: <code>--field-bg</code>,
          <code>--field-border</code>, <code>--field-color</code>,
          <code>--field-radius</code>. Applies to inputs, textareas, and
          selects with the same class.
        </p>
        ${preview(`<input class="field" type="text" placeholder="Type something...">`)}
        ${code(`<input type="text" class="field" placeholder="Type something...">`)}`,
      )}

      ${section(
        "Field group",
        `
        <p class="sg-prose">
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
</div>`)}`,
      )}

      ${section(
        "Field types",
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
                <option>ksite</option>
              </select>
            </div>
            <div class="field-group">
              <label>Textarea</label>
              <textarea class="field" rows="3">A few lines of text...</textarea>
            </div>
          </div>`),
      )}

      ${section(
        "States",
        `
        <p class="sg-prose">
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
<small class="field-hint danger">This field is required.</small>`)}`,
      )}

      ${section(
        "Checkbox &amp; radio",
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
            <div class="sg-stack-divider"></div>
            <label class="field-check">
              <input type="radio" name="sg-plan" checked>
              <span>Free plan</span>
            </label>
            <label class="field-check">
              <input type="radio" name="sg-plan">
              <span>Pro plan</span>
            </label>
          </div>`),
      )}

      ${section(
        "Source",
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
.field:user-invalid { --bg-mix: var(--color-danger); }`),
      )}
    </article>`;
}

function tagsPage() {
  return `
    <article>
      ${pageHeader({
        eyebrow: "Components",
        title: "Tags & Pills",
        lead: "Two small surfaces that both extend chip. Pills carry counts and short data. Badges carry categorical status.",
      })}

      ${section(
        "Pill — counts &amp; micro-data",
        `
        <p class="sg-prose">
          Rounded ends, small fill, short content. Built for numbers and
          single-character indicators.
        </p>
        ${preview(`
          <div class="sg-row-flex">
            <span class="pill">0</span>
            <span class="pill primary">12</span>
            <span class="pill info">i</span>
            <span class="pill success">3</span>
            <span class="pill warning">!</span>
            <span class="pill danger">99+</span>
          </div>`)}
        ${code(`<span class="pill primary">12</span>
<span class="pill danger">99+</span>
<span class="pill warning">!</span>`)}`,
      )}

      ${section(
        "Pill inside button",
        `
        <p class="sg-prose">
          The most common use — counts inside a button or nav item.
        </p>
        ${preview(`
          <div class="sg-row-flex">
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
</button>`)}`,
      )}

      ${section(
        "Badge — categorical status",
        `
        <p class="sg-prose">
          Uppercase, tracked, square corners. Reads as a label, not a count.
        </p>
        ${preview(`
          <div class="sg-row-flex">
            <span class="badge">muted</span>
            <span class="badge primary">beta</span>
            <span class="badge info">info</span>
            <span class="badge success">active</span>
            <span class="badge warning">pending</span>
            <span class="badge danger">archived</span>
          </div>`)}
        ${code(`<span class="badge success">active</span>
<span class="badge warning">pending</span>
<span class="badge danger">archived</span>`)}`,
      )}

      ${section(
        "Inline with text",
        `
        <p class="sg-prose">
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
          </div>`)}`,
      )}

      ${section(
        "When to use which",
        `
        <ul class="sg-list">
          <li>
            <strong>Pill</strong> — counts and very short data ("12", "99+", "v2"). Rounded shape reads as "a value".
          </li>
          <li>
            <strong>Badge</strong> — categorical status ("active", "pending", "archived"). Square + uppercase reads as "a label".
          </li>
        </ul>`,
      )}
    </article>`;
}
/* ══════════════════════════════════════════════════════════════════════
   3. Pages — Utilities
   ══════════════════════════════════════════════════════════════════════ */

function layoutsPage() {
  return `
    <article>
      ${pageHeader({
        eyebrow: "Utilities",
        title: "Layouts",
        lead: "Four primitive layout shortcuts. Stack, cluster, center, split. Cover most of what most apps need.",
      })}

      ${section(
        "Stack — vertical rhythm",
        `
        <p class="sg-prose">
          <code>stack</code> = <code>flex flex-col gap-4</code>. Children flow
          down with even spacing. The default gap can be overridden inline
          with a Uno utility — <code>stack gap-2</code>, <code>stack gap-8</code>.
        </p>
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

<!-- Adjust the gap inline -->
<div class="stack gap-2">…</div>`)}`,
      )}

      ${section(
        "Cluster — horizontal flow",
        `
        <p class="sg-prose">
          <code>cluster</code> = <code>flex flex-wrap items-center gap-2</code>.
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
</div>`)}`,
      )}

      ${section(
        "Center — perfect centering",
        `
        <p class="sg-prose">
          <code>center</code> = <code>grid place-items-center</code>. One
          line, no flex gymnastics. The child sits dead center in both axes.
        </p>
        ${preview(`
          <div class="center" style="height: 140px; border: 1px dashed var(--rule-strong); border-radius: 8px; background: var(--surface-sunken)">
            <button class="btn">Centered</button>
          </div>`)}
        ${code(`<div class="center h-36">
  <button class="btn">Centered</button>
</div>`)}`,
      )}

      ${section(
        "Split — space between",
        `
        <p class="sg-prose">
          <code>split</code> =
          <code>flex justify-between items-center gap-4</code>. Two-up rows
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
</header>`)}`,
      )}

      ${section(
        "When to use each",
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
        </table>`,
      )}

      ${section(
        "The shortcuts",
        `
        ${code(`/* layout.css */
.stack   { display: flex; flex-direction: column; gap: 1rem; }
.cluster { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; }
.center  { display: grid; place-items: center; }
.split   { display: flex; justify-content: space-between;
           align-items: center; gap: 1rem; }`)}
        <p class="sg-prose">
          Four shortcuts. Two flex columns, one flex row, one grid. Together
          they cover ~80% of the layout work in a typical app. For the
          remaining 20%, drop down to raw Uno utilities (<code>grid-cols-3</code>,
          <code>flex-1</code>, <code>self-start</code>).
        </p>`,
      )}
    </article>`;
}

function spacingPage() {
  const scale = [
    { token: "0", value: "0", px: 0 },
    { token: "1", value: "0.25rem", px: 4 },
    { token: "2", value: "0.5rem", px: 8 },
    { token: "3", value: "0.75rem", px: 12 },
    { token: "4", value: "1rem", px: 16 },
    { token: "5", value: "1.25rem", px: 20 },
    { token: "6", value: "1.5rem", px: 24 },
    { token: "8", value: "2rem", px: 32 },
    { token: "12", value: "3rem", px: 48 },
    { token: "16", value: "4rem", px: 64 },
    { token: "24", value: "6rem", px: 96 },
  ];

  return `
    <article>
      ${pageHeader({
        eyebrow: "Utilities",
        title: "Spacing",
        lead: "One 4-pixel scale drives every padding, margin, and gap. No one-off pixel values, no per-component nudging.",
      })}

      ${section(
        "The scale",
        `
        <p class="sg-prose">
          Every step is a multiple of 4px (<code>0.25rem</code>). Most layouts
          only ever need six or seven values.
        </p>
        <div class="sg-scale">
          ${scale
            .map(
              (s) => `
          <div class="sg-scale-row">
            <code class="sg-scale-token">${s.token}</code>
            <div class="sg-scale-track">
              <div class="sg-scale-bar" style="width: ${s.px}px"></div>
            </div>
            <code class="sg-scale-val">${s.value}</code>
            <code class="sg-scale-px">${s.px}px</code>
          </div>`,
            )
            .join("")}
        </div>`,
      )}

      ${section(
        "Padding",
        `
        <p class="sg-prose">
          <code>p-N</code> for all sides, <code>px-N</code>/<code>py-N</code>
          for axes, <code>pt-N</code>/<code>pr-N</code>/<code>pb-N</code>/
          <code>pl-N</code> for individual sides.
        </p>
        ${preview(`
          <div class="sg-row-flex">
            <div class="sg-pad-demo p-2">p-2</div>
            <div class="sg-pad-demo p-4">p-4</div>
            <div class="sg-pad-demo p-6">p-6</div>
            <div class="sg-pad-demo p-8">p-8</div>
          </div>`)}
        ${code(`<div class="p-4">Padding on all sides</div>
<div class="px-6 py-2">Horizontal 6, vertical 2</div>
<div class="pt-4">Padding-top only</div>`)}`,
      )}

      ${section(
        "Margin",
        `
        <p class="sg-prose">
          Same shape as padding: <code>m-N</code>, <code>mx-N</code>/
          <code>my-N</code>, plus directional. Negative margins available as
          <code>-m-N</code>.
        </p>
        ${code(`<div class="m-4">Margin on all sides</div>
<div class="mx-auto">Horizontal auto (centered block)</div>
<div class="-mt-2">Negative margin-top</div>`)}`,
      )}

      ${section(
        "Gap",
        `
        <p class="sg-prose">
          Always prefer <code>gap</code> over margins between siblings.
          Cleaner cascade, no margin-collapse surprises, no last-child
          gymnastics.
        </p>
        ${preview(`
          <div class="sg-stack" style="gap: 8px">
            <div class="sg-gap-demo">
              <span class="badge">gap-2 (8px)</span>
              <span class="badge">item</span>
              <span class="badge">item</span>
            </div>
            <div class="sg-gap-demo" style="gap: 16px">
              <span class="badge">gap-4 (16px)</span>
              <span class="badge">item</span>
              <span class="badge">item</span>
            </div>
            <div class="sg-gap-demo" style="gap: 24px">
              <span class="badge">gap-6 (24px)</span>
              <span class="badge">item</span>
              <span class="badge">item</span>
            </div>
          </div>`)}
        ${code(`<div class="flex gap-2">...</div>
<div class="grid gap-4">...</div>`)}`,
      )}

      ${section(
        "Stack &amp; cluster",
        `
        <p class="sg-prose">
          Two layout primitives that capture 90% of real layouts. Both
          delegate spacing to <code>gap</code>.
        </p>
        ${code(`/* spacing.css */
.stack {
  display: flex;
  flex-direction: column;
  gap: 1rem;  /* default — override with gap-N */
}

.cluster {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
}`)}
        <p class="sg-prose">
          <code>stack</code> for vertical rhythm, <code>cluster</code> for
          horizontal grouping. Override the gap inline when needed:
          <code>${esc(`<div class="stack gap-6">`)}</code>.
        </p>`,
      )}

      ${section(
        "Rule of thumb",
        `
        <ul class="sg-list">
          <li>
            <strong>Inside a component</strong> — use even values (2, 4, 6, 8).
            Padding/margin/gap.
          </li>
          <li>
            <strong>Between sections</strong> — jump up the scale (8, 12, 16).
            Visual rhythm needs the gap.
          </li>
          <li>
            <strong>Never inline pixel values.</strong> If the scale doesn't
            have what you need, add a new step to the scale, not a one-off
            <code>${esc(`style="padding: 13px"`)}</code>.
          </li>
        </ul>`,
      )}
    </article>`;
}

function typographyPage() {
  /*
   * The five steps the package actually ships, in utilities.css. This table
   * used to list eight Tailwind-shaped tokens (text-base, text-2xl … up to
   * text-4xl) at Tailwind's pixel values — a leftover from the UnoCSS era.
   * Five of the eight had no rule behind them at all.
   */
  const typeScale = [
    { token: "text-xs", size: 12, rem: "0.75rem", usage: "Fine print, captions" },
    { token: "text-sm", size: 13, rem: "0.8125rem", usage: "Meta lines, dense UI" },
    { token: "text-md", size: 14, rem: "0.875rem", usage: "Body — the package default" },
    { token: "text-lg", size: 16, rem: "1rem", usage: "Lead paragraph" },
    { token: "text-xl", size: 18, rem: "1.125rem", usage: "Subhead" },
  ];

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
    <article>
      ${pageHeader({
        eyebrow: "Utilities",
        title: "Typography",
        lead: "Type scale, weights, line-height, tracking, color. Everything else inherits from these.",
      })}

      ${section(
        "Type scale",
        `
        <p class="sg-prose">
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
            <code class="sg-typescale-meta">${t.rem} · ${t.size}px · ${t.usage}</code>
          </div>`,
            )
            .join("")}
        </div>
        <p class="sg-prose">
          The samples above carry the real class, not an inline
          <code>font-size</code> — so if the utility stops working, this page
          shows it.
        </p>`,
      )}

      ${section(
        "Font weight",
        `
        <p class="sg-prose">
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
          </div>`,
            )
            .join("")}
        </div>`,
      )}

      ${section(
        "Text color",
        `
        <p class="sg-prose">
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
          </div>`,
            )
            .join("")}
        </div>
        ${code(`/* typography.css */
.text-body    { color: var(--ink); }
.text-muted   { color: var(--ink-mute); }
.text-primary { color: var(--color-primary); }
.text-info    { color: var(--color-info); }
.text-success { color: var(--color-success); }
.text-warning { color: var(--color-warning); }
.text-danger  { color: var(--color-danger); }`)}`,
      )}

      ${section(
        "Line height &amp; tracking",
        `
        <p class="sg-prose">
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
tracking-wide   /* 0.05em  — uppercase labels, badges */`)}`,
      )}

      ${section(
        "Alignment, leading and tracking are not shipped",
        `
        <p class="sg-prose">
          The three code samples above are Uno's, not the package's. There is no
          <code>.text-center</code>, <code>.leading-snug</code> or
          <code>.tracking-wide</code> rule in any file here — they were Uno
          shortcuts through v0.5 and were not replaced when the config was
          deleted. The package ships size and colour only.
        </p>
        <p class="sg-prose">
          Bring Uno for the rest (see <strong>Install</strong>), or write the two
          declarations. Documenting a class the package does not define is the
          exact failure this guide exists to prevent.
        </p>`,
      )}

      ${section(
        "Rule of thumb",
        `
        <ul class="sg-list">
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
        </ul>`,
      )}
    </article>`;
}
/* ══════════════════════════════════════════════════════════════════════
   3. Pages — Reference
   ══════════════════════════════════════════════════════════════════════ */

function cheatSheetPage() {
  const BASES = [
    {
      name: "chip",
      shortcut: "inline-flex items-center justify-center gap-1.5 whitespace-nowrap",
      preview: `<span class="chip">chip</span>`,
    },
    {
      name: "pill",
      shortcut: "chip rounded-full text-xs px-2 py-0.5",
      preview: `<span class="pill primary">pill</span>`,
    },
    {
      name: "badge",
      shortcut: "chip text-xs uppercase px-2 py-0.5 rounded",
      preview: `<span class="badge success">badge</span>`,
    },
    {
      name: "btn",
      shortcut: "chip rounded text-sm px-3.5 py-1.5 shadow-sm",
      preview: `<button class="btn">btn</button>`,
    },
    {
      name: "surface",
      shortcut: "block rounded-lg (visual base for cards, alerts, toasts, dialogs)",
      preview: `<span class="sg-cheat-mini-card">surface</span>`,
    },
    {
      name: "card",
      shortcut: "surface p-5",
      preview: `<span class="sg-cheat-mini-card">card</span>`,
    },
    {
      name: "alert",
      shortcut: "surface flex items-start gap-3 px-4 py-3",
      preview: `<span class="sg-cheat-mini-card">alert</span>`,
    },
    {
      name: "toast",
      shortcut: "surface fixed bottom-4 right-4 px-4 py-3 shadow-lg",
      preview: `<span class="sg-cheat-mini-card">toast</span>`,
    },
    {
      name: "popover",
      shortcut: "surface absolute px-3 py-2 text-sm shadow-md",
      preview: `<span class="sg-cheat-mini-card">popover</span>`,
    },
    {
      name: "drawer",
      shortcut: "surface fixed top-0 bottom-0 right-0 w-80 h-screen p-0",
      preview: `<span class="sg-cheat-mini-dialog">drawer</span>`,
    },
    {
      name: "dialog",
      shortcut: "surface p-0 (native <dialog>)",
      preview: `<span class="sg-cheat-mini-dialog">dialog</span>`,
    },
    {
      name: "field",
      shortcut: "block w-full px-3 py-2 text-sm rounded-md",
      preview: `<span class="sg-cheat-mini-field">field</span>`,
    },
    {
      name: "table",
      shortcut: "w-full border-collapse",
      preview: `<span class="sg-cheat-mini-table">table</span>`,
    },
  ];

  const sizes = [
    ["text-xs", "XS"],
    ["text-sm", "Small"],
    ["text-md", "Body"],
    ["text-lg", "Large"],
    ["text-xl", "XL"],
  ];

  const varGroups = [
    [
      "Global tokens",
      ["--color-primary", "--color-secondary", "--color-muted", "--color-info", "--color-success", "--color-warning", "--color-danger"],
    ],
    [
      "Surfaces &amp; ink",
      ["--surface", "--surface-raised", "--surface-sunken", "--ink", "--ink-soft", "--ink-mute", "--rule", "--rule-strong"],
    ],
    [
      "Focus &amp; shadows",
      ["--ring", "--ring-color", "--ring-width", "--ring-offset", "--shadow-sm", "--shadow-md", "--shadow-lg"],
    ],
    ["btn contract", ["--btn-radius", "--btn-font-weight", "--btn-text-transform", "--btn-letter-spacing"]],
    [
      "pill / badge",
      ["--pill-font-weight", "--pill-text-transform", "--pill-letter-spacing", "--badge-font-weight", "--badge-text-transform", "--badge-letter-spacing"],
    ],
    ["surface contract", ["--surface-bg", "--surface-color", "--surface-border", "--card-radius"]],
    ["field contract", ["--field-bg", "--field-color", "--field-border", "--field-radius"]],
    ["table contract", ["--table-bg", "--table-border", "--table-head-bg"]],
    ["dialog contract", ["--dialog-bg", "--dialog-border"]],
    ["typography", ["--font-primary", "--font-mono"]],
    ["tones (set by .primary, .info, …)", ["--bg-mix", "--on-bg-mix"]],
    ["tonal mixing (lighten/darken)", ["--bg-mix (input)", "--bg (derived)", "--color (derived)"]],
  ];

  const lightSteps = [80, 60, 40, 20];
  const darkSteps = [20, 40, 60, 80];

  return `
    <article>
      ${pageHeader({
        eyebrow: "Reference",
        title: "Cheat sheet",
        lead: "Every base, tone, variant, and size on one page. Grep-able, bookmark-able.",
      })}

      ${section(
        "Bases",
        `
        <div class="sg-cheat-bases">
          ${BASES.map(
            (b) => `
          <div class="sg-cheat-base">
            <div class="sg-cheat-base-preview">${b.preview}</div>
            <div class="sg-cheat-base-meta">
              <code class="sg-cheat-name">${b.name}</code>
              <code class="sg-cheat-shortcut">${esc(b.shortcut)}</code>
            </div>
          </div>`,
          ).join("")}
        </div>`,
      )}

      ${section(
        "Tones",
        `
        <p class="sg-prose">
          Set the var contract. Composable with any base.
        </p>
        <div class="sg-cheat-tones">
          ${SEMANTIC_COLORS.map(([token, value]) => {
            const name = token.replace("--color-", "");
            return `
          <div class="sg-cheat-tone">
            <span class="sg-cheat-swatch" style="background: ${value}"></span>
            <code class="sg-cheat-name">.${name}</code>
            <code class="sg-cheat-token">${token}</code>
            <code class="sg-cheat-val">${value}</code>
          </div>`;
          }).join("")}
        </div>`,
      )}

      ${section(
        "Button matrix",
        `
        <p class="sg-prose">
          Every tone × every variant. The system holds because tones only set
          vars and variants only read them.
        </p>
        <div class="sg-cheat-matrix">
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
          </div>`,
          ).join("")}
          <div class="sg-matrix-row">
            <div class="sg-matrix-label"><code>link</code></div>
            <div><button class="btn link">Link button</button></div>
            <div>—</div>
          </div>
        </div>`,
      )}

      ${section(
        "Table matrix",
        `
        <p class="sg-prose">
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
        </table>`,
      )}

      ${section(
        "Dialog",
        `
        <p class="sg-prose">
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
        <p class="sg-prose">
          Tones tint the header. Same vocabulary —
          <code>.dialog.danger</code>, <code>.dialog.success</code>, etc.
        </p>`,
      )}

      ${section(
        "Sizes",
        `
        <p class="sg-prose">
          Scale rides the type scale. <code>em</code> padding tracks
          <code> font-size</code>.
        </p>
        <div class="sg-cheat-sizes">
          ${sizes.map(([cls, label]) => `<button class="btn ${cls}">${label}</button>`).join("")}
        </div>`,
      )}

      ${section(
        "Card matrix",
        `
        <p class="sg-prose">
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
        </div>`,
      )}

      ${section(
        "Field states",
        `
        <p class="sg-prose">
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
        </div>`,
      )}

      ${section(
        "Tonal scale",
        `
        <p class="sg-prose">
          Any shade derives from <code>--bg-mix</code> with
          <code>color-mix()</code>. (The old <code>.lighten-N</code> /
          <code>.darken-N</code> classes were removed in v0.6 — they wrote
          variables nothing read.)
        </p>
        <div class="sg-cheat-tonal-strip" style="--sg-ramp: var(--color-primary); --color: var(--ink)">
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
        </div>`,
      )}

      ${section(
        "Themes",
        `
        <p class="sg-prose">
          Each theme is a class that re-binds the global tokens. Wrap any
          subtree.
        </p>
        <div class="sg-cheat-themes">
          ${Object.entries(THEMES)
            .map(
              ([key, t]) => `
          <div class="sg-cheat-theme">
            <span class="sg-cheat-theme-swatch" style="background: ${t.tokens["--color-primary"] || "var(--color-primary)"}"></span>
            <code class="sg-cheat-name">.theme-${key}</code>
            <span class="sg-cheat-theme-desc">${t.description}</span>
          </div>`,
            )
            .join("")}
        </div>`,
      )}

      ${section(
        "Status indicators",
        `
        <p class="sg-prose">
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
        </div>`,
      )}

      ${section(
        "CSS variables",
        `
        <div class="sg-cheat-vars">
          ${varGroups
            .map(
              ([title, vars]) => `
          <div class="sg-cheat-var-group">
            <div class="sg-cheat-var-title">${title}</div>
            ${vars.map((v) => `<code class="sg-cheat-var">${v}</code>`).join("")}
          </div>`,
            )
            .join("")}
        </div>`,
      )}

      ${section(
        "Common patterns",
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
</body>`),
      )}
    </article>`;
}
/* ══════════════════════════════════════════════════════════════════════
   3. Pages — Half 1, Structure
   ══════════════════════════════════════════════════════════════════════ */

const PRINCIPLES = [
  [
    "Minimal DOM",
    "Every element earns its place. If a wrapper isn't carrying layout, semantics, or a style hook, delete it.",
  ],
  [
    "Articles inside Sections, not Sections inside Sections",
    "A discrete self-contained unit inside a Section is an <article>, never a nested <section>. This is what decides the element for Card contents, Feed entries, Pane subsections, and Alert / Toast / Popover / View.",
  ],
  [
    "Heading levels carry structure, not size",
    'Outline the document with <h1>–<h6>; set visual size with a class. An <h4> that needs to look big gets class="h2", it does not become an <h2>.',
  ],
  [
    "Native elements over reinvention",
    "<dialog> for modals and drawers, <details> for disclosure, <button> for buttons. Focus trapping, Escape-to-close, top-layer stacking and keyboard toggling are already written and already correct.",
  ],
  [
    "Tone is a single signal",
    ".success OR .danger, never both. A tone is one variable (--bg-mix) and one meaning; two tones on one element is a contradiction, not a blend.",
  ],
  [
    "Components only for behavior",
    "Visual treatment is a class. Keyboard handling, focus management and ARIA state are a component. Most things people call components here are class-only.",
  ],
];

function principlesPage() {
  return `
      ${pageHeader({
        eyebrow: "Half 1 — Structure",
        title: "Principles",
        lead: "Six rules that decide what the HTML actually is. They resolve most element-choice arguments before they start.",
      })}

      ${section(
        "The six",
        `
        <div class="sg-principles">
          ${PRINCIPLES.map(
            ([title, body], i) => `
          <article class="card sg-principle">
            <div class="sg-principle-num">${i + 1}</div>
            <div>
              <strong class="sg-principle-title">${esc(title)}</strong>
              <p class="sg-principle-body">${esc(body)}</p>
            </div>
          </article>`,
          ).join("")}
        </div>`,
      )}

      ${section(
        "Principle 2 in practice",
        `
        <p class="sg-prose">
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
        <p class="sg-prose">
          The <strong>article-vs-div test</strong>: could you lift this out of the
          page and have it still make sense? Then it is an
          <code>&lt;article&gt;</code>. If it only exists to group things visually,
          it is a <code>&lt;div&gt;</code>.
        </p>`,
      )}`;
}

const VOCAB = [
  [
    "Frame",
    "The application shell. Persistent across navigation.",
    [
      ["App", "<body>", "The whole application surface"],
      ["Topbar", "<header>", "Global bar across the top"],
      ["Sidebar", "<nav>", "Primary navigation column"],
      ["Shell", "<div>", "The grid that positions Topbar + Sidebar + Screen"],
    ],
  ],
  [
    "Page",
    "What changes when you navigate.",
    [
      ["Screen", "<main>", "The routed page body"],
      ["Pane", "<section aria-labelledby>", "A labelled major subdivision of a Screen"],
      ["View", '<article role="tabpanel">', "One switchable view inside a Pane"],
    ],
  ],
  [
    "Region",
    "Grouping inside a Screen. No identity of its own.",
    [
      ["Section", "<section> / <article>", "<article> when nested inside a Section (Principle 2)"],
      ["Group", "<div>", "A visual cluster with no semantic identity"],
      ["Bar", "<div>", "A horizontal strip of controls"],
      ["Divider", "<hr>", "A labelled or plain break between groups"],
    ],
  ],
  [
    "Block",
    "Self-contained units of content.",
    [
      ["Card", "<article>", "A bounded unit of content on a surface"],
      ["Tile", "<article>", "A compact metric or stat unit"],
      ["Item", "<li>", "A lightweight list entry"],
      ["Row", "<li> / <tr>", "A record entry with trailing actions"],
      ["Feed", "<ol> + <li><article>", "A chronological stream"],
      ["Alert", "<article>", "An inline notification"],
      ["Steps", "<ol> + <li>", "A multi-stage flow indicator"],
      ["Facts", "<dl> + <dt>/<dd>", "A label/value list"],
      ["Code", "<pre> + <code>", "A block of code"],
    ],
  ],
  [
    "Inline",
    "Things that sit in a line of content.",
    [
      ["Button", "<button>", "An action"],
      ["Link", "<a>", "A navigation"],
      ["Pill", "<span>", "A count or very short datum"],
      ["Badge", "<span>", "A categorical status"],
      ["Field", "<input> / <select> / <textarea>", "A form control"],
      ["Heading", "<h1>–<h6>", "Outline structure (Principle 3)"],
      ["Text", "<p> / <span>", "Prose"],
      ["Icon", "<span aria-hidden>", "A decorative glyph"],
      ["Avatar", "<img> / <span>", "A person, org or bot marker"],
      ["Kbd", "<kbd>", "A key the user is meant to press"],
    ],
  ],
  [
    "Overlay",
    "Things that float above the Screen.",
    [
      ["Dialog", "<dialog>", "A modal, via showModal()"],
      ["Drawer", "<dialog>", "An off-canvas panel, also via showModal()"],
      ["Popover", "<article>", "An anchored floating unit"],
      ["Tooltip", '<div role="tooltip">', "An attachment, not a unit — stays a <div>"],
      ["Toast", "<article>", "A transient notification"],
    ],
  ],
];

function vocabularyPage() {
  const total = VOCAB.reduce((n, [, , rows]) => n + rows.length, 0);

  return `
      ${pageHeader({
        eyebrow: "Half 1 — Structure",
        title: "Vocabulary",
        lead: `${total} terms in six tiers. Each term fixes one answer: which element, what ARIA, how it nests. Naming a thing is how the argument ends.`,
      })}

      ${section(
        "Why a vocabulary at all",
        `
        <p class="sg-prose">
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
        </div>`,
      )}

      ${VOCAB.map(([tier, blurb, rows]) =>
        section(
          tier,
          `
        <p class="sg-prose">${blurb}</p>
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
            </tr>`,
              )
              .join("")}
          </tbody>
        </table>`,
        ),
      ).join("")}

      ${section(
        "Coverage",
        `
        <p class="sg-prose">
          As of v0.6 the Frame and Page tiers ship as CSS — App, Shell, Topbar,
          Sidebar, Screen, Pane and View all have classes. See
          <strong>App frame</strong>.
        </p>
        <div class="alert success">
          <div class="alert-icon" aria-hidden="true">&#10003;</div>
          <div class="alert-content">
            <strong>Coverage is complete.</strong>
            <p>
              Every one of the 35 terms ships CSS. v0.8 added the last six —
              Steps, Facts, Divider, Avatar, Kbd and Code — each with a rule and
              a test. The vocabulary is no longer a promissory note: if a term is
              in the table, there is a class for it, and a page in this guide.
            </p>
          </div>
        </div>`,
      )}`;
}

function tooltipPage() {
  return `
      ${pageHeader({
        eyebrow: "Components",
        title: "Tooltip",
        lead: "The last of the 29 vocabulary terms to ship CSS. An attachment to a control, not a unit — which is why it stays a &lt;div&gt;, not an &lt;article&gt;.",
      })}

      ${section(
        "Anatomy",
        `
        <p class="sg-prose">
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
        <p class="sg-prose">
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
            <p class="sg-prose">
              This is what actually announces it. A tooltip that is only a hover
              style is invisible to a screen reader — the visual is decoration,
              the attribute is the feature.
            </p>
          </article>
          <article class="card">
            <strong>2. Show on focus, not only hover.</strong>
            <p class="sg-prose">
              The CSS uses <code>:focus-within</code> alongside
              <code>:hover</code>, so a keyboard user gets the tooltip by tabbing
              to the control. A hover-only tooltip excludes everyone who does not
              use a mouse.
            </p>
          </article>
          <article class="card">
            <strong>3. Never put essential information only in a tooltip.</strong>
            <p class="sg-prose">
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
        <p class="sg-prose">
          At rest the tooltip is <code>opacity: 0</code> with
          <code>pointer-events: none</code> — invisible and unclickable, but
          still present so <code>aria-describedby</code> resolves against it.
        </p>
        <p class="sg-prose">
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
        <p class="sg-prose">
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
        <p class="sg-prose">
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
        <p class="sg-prose">
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
        <p class="sg-prose">
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
        <p class="sg-prose">
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
        <p class="sg-prose">
          This is the entire implementation:
        </p>
        ${code(`.field:user-invalid { --bg-mix: var(--color-danger); }`)}
        <p class="sg-prose">
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
        <p class="sg-prose">
          Opt into the positive case per form if you want it:
          <code>.field:user-valid &#123; --bg-mix: var(--color-success); &#125;</code>
        </p>`,
      )}`;
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
        <p class="sg-prose">
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
        <p class="sg-prose">
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
            <a class="page" href="#0" rel="prev" data-page="prev">Previous</a>
            <a class="page" href="#0" data-page="1">1</a>
            <a class="page" href="#0" data-page="2" aria-current="page">2</a>
            <a class="page" href="#0" data-page="3">3</a>
            <span class="page-gap" aria-hidden="true">&hellip;</span>
            <a class="page" href="#0" data-page="9">9</a>
            <a class="page" href="#0" rel="next" data-page="next">Next</a>
          </nav>`)}
        ${code(`<nav class="pagination" aria-label="Pagination">
  <a class="page" href="?p=1" rel="prev" aria-disabled="true">Previous</a>
  <a class="page" href="?p=1">1</a>
  <a class="page" href="?p=2" aria-current="page">2</a>
  <span class="page-gap" aria-hidden="true">…</span>
  <a class="page" href="?p=9">9</a>
</nav>`)}
        <p class="sg-prose">
          <code>.page</code> is in the <strong>chip lineage</strong>, so it gets
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
                    `<a class="page ${tone}" href="#0"${n === 2 ? ' aria-current="page"' : ""}>${n}</a>`,
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
        <p class="sg-prose">
          A trailing <code>.pill</code> or <code>.badge</code> is pushed to the
          end automatically, so counts line up down the column.
        </p>`,
      )}

      ${section(
        "Why aria-current and not .active",
        `
        <p class="sg-prose">
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
        <p class="sg-prose">
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
        <p class="sg-prose">
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
        <p class="sg-prose">
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
            <p class="sg-prose">
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
            <p class="sg-prose">
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
            <p class="sg-prose">
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
        <p class="sg-prose">
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
        <p class="sg-prose">
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
        <ul class="sg-list">
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
        <p class="sg-prose">
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
        <p class="sg-prose">
          <code>.tiles</code> is
          <code>repeat(auto-fit, minmax(var(--tile-min, 12rem), 1fr))</code>, so
          the column count follows the container and nobody has to pick a number.
          Set <code>--tile-min</code> to change the threshold.
        </p>`,
      )}

      ${section(
        "Tones apply where you put them",
        `
        <p class="sg-prose">
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
            <p class="sg-prose">
              A screen reader then hears &ldquo;Revenue, $48,290&rdquo; rather
              than a number with no subject. If you want the number visually on
              top, use <code>order: -1</code> on <code>.tile-value</code> instead
              of reordering the markup.
            </p>
          </article>
          <article class="card">
            <strong>Tabular figures on values and deltas.</strong>
            <p class="sg-prose">
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
        <p class="sg-prose">
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
        <p class="sg-prose">
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
        <p class="sg-prose">
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
        <p class="sg-prose">
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
        <p class="sg-prose">
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
        <p class="sg-prose">
          tokens.css forces
          <code>animation-duration: 0.01ms !important</code> on everything under
          <code>prefers-reduced-motion</code>. That is right for a toast slide or
          a skeleton shimmer — and wrong for a spinner, which frozen reads as a
          broken page rather than a working one.
        </p>
        <p class="sg-prose">
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
        lead: "The Frame and Page tiers — App, Shell, Topbar, Sidebar, Screen, Pane, View. Eleven vocabulary terms that were prose with no CSS until v0.6.",
      })}

      ${section(
        "Anatomy",
        `
        <p class="sg-prose">
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
        <p class="sg-prose">
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
            <p class="sg-prose">
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
            <p class="sg-prose">
              The shell is exactly one viewport and the Screen scrolls inside it,
              instead of the document scrolling. The app-like mode — it costs you
              document-level scroll restoration, so it is opt-in.
            </p>
            <p class="sg-prose">
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
        <p class="sg-prose">
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
        <p class="sg-prose">
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
    "Anatomy",
    "no — names a slot",
    "Names a position inside an Element. Nests, never chains.",
    ".alert-icon .alert-content  ·  .feed-item .feed-dot .feed-content  ·  .list-row .row-actions  ·  .disclosure-summary .disclosure-body  ·  .surface-header .surface-body .surface-footer",
  ],
];

function taxonomyPage() {
  return `
      ${pageHeader({
        eyebrow: "Half 2 — Style",
        title: "Kinds of class",
        lead: "Utility-first, one level up. Three kinds of class — and only two of them compose freely.",
      })}

      ${section(
        "One level above Tailwind",
        `
        <p class="sg-prose">
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
        </div>`,
      )}

      ${section(
        "The three kinds",
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
            </tr>`,
            ).join("")}
          </tbody>
        </table>
        <p class="sg-prose">
          Element and Anatomy are two ends of one relationship: several Element
          classes carry an <strong>anatomy contract</strong>. <code>.alert</code>
          expects an icon and a content slot, <code>.feed</code> expects items with
          dots, <code>.disclosure</code> expects a summary and a body.
          <strong>Chaining is for Treatments; Anatomy nests.</strong>
        </p>`,
      )}

      ${section(
        "The fourth group, said out loud",
        `
        <p class="sg-prose">
          Some classes read like Treatments and are not. <code>.icon</code> only
          works on <code>.btn</code>, <code>.removable</code> only on
          <code>.pill</code>, <code>.striped</code> and <code>.compact</code> only
          on <code>.table</code>, <code>.divided</code> and <code>.hover</code>
          only on <code>.rows</code>, <code>.menu</code> only on
          <code>.items</code>.
        </p>
        <p class="sg-prose">
          They are legitimate, but they are component modifiers living in a utility
          system. A short generic name promises free composition they do not have —
          which is exactly the naming problem still open in the system.
        </p>`,
      )}

      ${section(
        "Why this matters more than it sounds",
        `
        <p class="sg-prose">
          Until v0.6, <code>.muted</code> on a card silently did nothing. Each
          component enumerated the tones it accepted, and they all picked different
          subsets — five on surfaces, four on fields, four on tables. That is
          component thinking, and it made the utility claim false. The tone recipe
          now names no tones at all, so every Treatment works everywhere by
          construction.
        </p>`,
      )}`;
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
  ["utilities", "the escape hatch: .text-* size and colour"],
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
        <p class="sg-prose">
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
            <p class="sg-prose">
              Unlayered CSS beats every layer. Anything you write in your own app
              overrides this package by default — no <code>!important</code>, no
              specificity war, no <code>:not(:not(.x))</code> tricks.
            </p>
            ${code(`/* your app — plain, unlayered, wins */
td { background: var(--zebra); }`)}
          </article>
          <article class="card">
            <strong>Specificity still works inside a layer.</strong>
            <p class="sg-prose">
              The <code>:where()</code> bases in chip.css and surface.css sit at
              zero specificity, so composites override them normally. Layers settle
              cross-file conflicts; specificity settles in-file ones.
            </p>
          </article>
          <article class="card">
            <strong>
              <code>layout</code> sits before <code>components</code> on purpose.
            </strong>
            <p class="sg-prose">
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
        <p class="sg-prose">
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
        <p class="sg-prose">
          <strong>1. Sit inside a component the package owns.</strong> A bare
          <code>&lt;svg&gt;</code> in a <code>.btn</code>, a
          <code>.navlink</code>, an <code>.alert-icon</code> and about twenty
          others is sized automatically, so existing markup needs no new class.
        </p>
        <p class="sg-prose">
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
        <p class="sg-prose">
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
        <p class="sg-prose">
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
        <p class="sg-prose">
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
        <p class="sg-prose">
          There is no CSS for any of that — it is markup, and it is the half of
          the system that does not ship as a stylesheet.
        </p>`,
      )}

      ${section(
        "Why this is one rule now",
        `
        <p class="sg-prose">
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
        <p class="sg-prose">
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
        <p class="sg-prose">
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
  return `<p class="sg-prose sg-pattern-note">${body}</p>`;
}

function barPage() {
  return `
      ${pageHeader({
        eyebrow: "Patterns",
        title: "Bar",
        lead: "A horizontal strip of controls. Layout only — no surface, no background, no border.",
      })}

      ${section(
        "Default: split",
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
</div>`)}`,
      )}

      ${section(
        "Alignment modifiers",
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
<div class="bar end">    … </div>`)}`,
      )}

      ${section(
        "Bordered",
        `
        ${patternNote(`
          Adds padding and a bottom rule, for a contained toolbar above content.`)}
        ${preview(`
          <div class="bar bordered">
            <strong>Invoices</strong>
            <button class="btn primary">New</button>
          </div>`)}
        ${code(`<div class="bar bordered"> … </div>`)}`,
      )}`;
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
        <p class="sg-prose">
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
        lead: "A breakpoint scale, a container, and a scroll wrapper for tables. Until v0.6 the package contained exactly one media query — the reduced-motion guard.",
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
        <p class="sg-prose">
          The scale is Tailwind&rsquo;s, which is also UnoCSS&rsquo;s default. If
          you still run Uno for atomic utilities alongside this package, you get
          one set of breakpoints rather than two that nearly agree.
        </p>`,
      )}

      ${section(
        "Container",
        `
        <p class="sg-prose">
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
        <p class="sg-prose">
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
        <p class="sg-prose">
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
        <p class="sg-prose">
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
        <p class="sg-prose">
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
        <p class="sg-prose">
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
        <p class="sg-prose">
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
        <p class="sg-prose">
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
        <p class="sg-prose">
          Nine times out of ten an initials avatar is a fallback rendering of a
          name that is <em>already on screen</em> — beside the name in a list
          row, inside a cell whose row is labelled. Announcing "D O" there is
          noise, so the default is <code>aria-hidden</code>.
        </p>
        <p class="sg-prose">
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
        <p class="sg-prose">
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
        <p class="sg-prose">
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
        <p class="sg-prose">
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
        <p class="sg-prose">
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
        <p class="sg-prose">
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
        <p class="sg-prose">
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
        <p class="sg-prose">
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
        <p class="sg-prose">
          Two columns stop being worth it on a phone — the label column is
          either too narrow to read or too wide to leave room for the value. It
          stacks, and the pair spacing tightens so a stacked pair still reads as
          one unit rather than two rows. Narrow this window to see it.
        </p>
        ${code(`--fact-label-max: 40%;   /* how wide the label column may grow */`)}
        <p class="sg-prose">
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
        <p class="sg-prose">
          <code>&lt;ol&gt;</code> because a screen reader announcing "list of 3
          items" and a position is most of what a stepper communicates.
          <code>&lt;li&gt;</code> per step, so each is a Row in the vocabulary's
          sense, not a Card.
        </p>`,
      )}

      ${section(
        "The current step comes from ARIA — completion does not",
        `
        <p class="sg-prose">
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
        <p class="sg-prose">
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
        <p class="sg-prose">
          A tone on <code>.steps</code> travels down as
          <code>--step-accent</code>, the same inheriting-property trick tabs
          and tables use — <code>--bg-mix</code> is element-scoped and would not
          reach the markers.
        </p>`,
      )}

      ${section(
        "Vertical",
        `
        <p class="sg-prose">
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
        <p class="sg-prose">
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
        <p class="sg-prose">
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
        <p class="sg-prose">
          Inside a block, the inline treatment would double the background, so
          <code>.code &gt; code</code> resets it.
        </p>`,
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
        <p class="sg-prose">
          The heavier bottom border is the whole keycap effect. A
          <code>box-shadow</code> would be more literal but would not survive a
          dark theme, where the shadow disappears and the cap flattens — switch
          to Dark in the topbar and the border is still there.
        </p>
        <p class="sg-prose">
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
const PAGES = {
  // Start Here
  overview: overviewPage,
  principles: principlesPage,
  taxonomy: taxonomyPage,
  install: installPage,
  composition: compositionPage,
  conventions: conventionsPage,
  // Structure (Half 1)
  vocabulary: vocabularyPage,
  frame: framePage,
  // Foundation
  variables: variablesPage,
  tonal: tonalPage,
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
  tags: tagsPage,
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
  spacing: spacingPage,
  a11y: accessibilityPage,
  typography: typographyPage,
  // Reference
  cheatsheet: cheatSheetPage,
};

function topbar() {
  const theme = THEMES[state.theme];

  return `
    <header class="sg-topbar">
      <div class="sg-topbar-inner">
        <div class="sg-brand">
          <span class="sg-brand-mark"></span>
          <span class="sg-brand-name">ksite</span>
          <span class="sg-brand-sub">Design System</span>
        </div>
        <div class="sg-topbar-actions">
          <div class="sg-theme-menu">
            <button type="button" class="sg-theme-trigger" data-theme-menu>
              <span class="sg-theme-trigger-swatch" style="background: ${theme.tokens["--color-primary"] || "var(--color-primary)"}"></span>
              <span class="sg-theme-trigger-name">${theme.name}</span>
              <span class="sg-theme-trigger-arrow">⌄</span>
            </button>
            <div hidden data-theme-dropdown>
              <div class="sg-theme-backdrop" data-theme-close></div>
              <div class="sg-theme-dropdown">
                ${Object.entries(THEMES)
                  .map(
                    ([key, t]) => `
                <button type="button" class="sg-theme-option${key === state.theme ? " active" : ""}" data-theme="${key}">
                  <span class="sg-theme-option-swatch" style="background: ${t.tokens["--color-primary"] || "var(--color-primary)"}"></span>
                  <span class="sg-theme-option-text">
                    <span class="sg-theme-option-name">${t.name}</span>
                    <span class="sg-theme-option-desc">${t.description}</span>
                  </span>
                  ${key === state.theme ? `<span class="sg-theme-option-check">✓</span>` : ""}
                </button>`,
                  )
                  .join("")}
              </div>
            </div>
          </div>
          <button type="button" class="sg-config-trigger" data-config>
            <span class="sg-config-glyph">{ }</span>
            index.css
          </button>
          <span class="sg-version">v0.10.1</span>
        </div>
      </div>
    </header>`;
}

function sidebar() {
  return `
    <aside class="sg-sidebar">
      ${NAV.map(
        (group) => `
      <div class="sg-nav-group">
        <div class="sg-nav-group-title">${group.group}</div>
        <ul class="sg-nav-list">
          ${group.items
            .map(
              (item) => `
          <li>
            <a class="sg-nav-item${state.page === item.id ? " active" : ""}"
               href="#${item.id}" data-nav="${item.id}">${item.label}</a>
          </li>`,
            )
            .join("")}
        </ul>
      </div>`,
      ).join("")}
    </aside>`;
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
 *   utilities   the escape hatch — .text-* size and colour. After
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
`;

function configModal() {
  return `
    <div class="sg-modal-backdrop" role="dialog" aria-modal="true" data-modal>
      <div class="sg-modal">
        <header class="sg-modal-header">
          <div class="sg-modal-title">
            <span class="sg-modal-glyph">{ }</span>
            index.css
          </div>
          <div class="sg-modal-actions">
            <button type="button" class="sg-modal-btn" data-copy>Copy</button>
            <button type="button" class="sg-modal-close" data-modal-close aria-label="Close">×</button>
          </div>
        </header>
        <pre class="sg-modal-code"><code>${esc(INDEX_CSS)}</code></pre>
      </div>
    </div>`;
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
  $("#sg-topbar", app).innerHTML = topbar();
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
  const page = PAGES[state.page];
  const host = document.createElement("div");
  host.className = "sg-main-inner";
  host.id = "sg-page";

  host.innerHTML = page ? page() : comingSoon(getLabel(state.page));
  $("#sg-page", app).replaceWith(host);
  $(".sg-main", app).scrollTop = 0;

  $$("[data-nav]", app).forEach((a) =>
    a.classList.toggle("active", a.dataset.nav === state.page),
  );

  if (page && page.init) page.init(host);
}

function route() {
  const id = location.hash.slice(1);
  state.page = id || "buttons";
  renderPage();
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

  modal.addEventListener("click", (e) => {
    /* Backdrop only — a click inside the panel must not close it. */
    if (e.target === modal || e.target.closest("[data-modal-close]")) {
      modal.remove();
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
  app.innerHTML = `
    <div id="sg-topbar">${topbar()}</div>
    <div class="sg-shell">
      ${sidebar()}
      <main class="sg-main">
        <div class="sg-main-inner" id="sg-page"></div>
      </main>
    </div>`;

  applyTheme();

  /* Chrome behaviour, delegated once from the root — the topbar and the
   * sidebar are re-rendered as HTML, so nothing may hold a node reference. */
  app.addEventListener("click", (e) => {
    if (e.target.closest("[data-theme-menu]")) {
      const dropdown = $("[data-theme-dropdown]", app);
      dropdown.hidden = !dropdown.hidden;
      return;
    }

    if (e.target.closest("[data-theme-close]")) {
      $("[data-theme-dropdown]", app).hidden = true;
      return;
    }

    const themeOption = e.target.closest("[data-theme]");
    if (themeOption && themeOption.closest("[data-theme-dropdown]")) {
      setTheme(themeOption.dataset.theme);
      return;
    }

    if (e.target.closest("[data-config]")) {
      openConfig();
      return;
    }

    /* Demo links that go nowhere — every one of them is `href="#"` or
     * `href="#0"`, which would otherwise hijack the hash router. */
    const dead = e.target.closest('a[href="#"], a[href="#0"], a[data-noop]');
    if (dead) e.preventDefault();
  });

  window.addEventListener("hashchange", route);
  route();
}

boot();
