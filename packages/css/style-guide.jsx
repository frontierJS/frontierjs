import { useState, useRef } from "react";

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
    items: [{ id: "vocabulary", label: "Vocabulary" }],
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
      { id: "alerts", label: "Alerts" },
      { id: "toasts", label: "Toasts" },
      { id: "popovers", label: "Popovers" },
      { id: "drawers", label: "Drawers" },
      { id: "tables", label: "Tables" },
      { id: "dialogs", label: "Dialogs" },
      { id: "inputs", label: "Inputs" },
      { id: "tags", label: "Tags & Pills" },
      { id: "icons", label: "Icons" },
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
      { id: "disclosure", label: "Disclosure" },
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

function getLabel(id) {
  for (const g of NAV) {
    for (const item of g.items) {
      if (item.id === id) return item.label;
    }
  }
  return id;
}

export default function StyleGuide() {
  const [page, setPage] = useState("buttons");
  const [btnClasses, setBtnClasses] = useState("btn primary");
  const [configOpen, setConfigOpen] = useState(false);
  const [activeTheme, setActiveTheme] = useState("default");
  const themeStyle = THEMES[activeTheme].tokens;

  return (
    <>
      {/* The real system CSS — single source of truth, never a copy. */}
      <link rel="stylesheet" href="./index.css" />
      <style>{STYLESHEET}</style>
      <div className="sg-app" style={themeStyle}>
        <Topbar
          onOpenConfig={() => setConfigOpen(true)}
          activeTheme={activeTheme}
          setActiveTheme={setActiveTheme}
        />
        <div className="sg-shell">
          <Sidebar page={page} setPage={setPage} />
          <Main
            page={page}
            btnClasses={btnClasses}
            setBtnClasses={setBtnClasses}
            activeTheme={activeTheme}
            setActiveTheme={setActiveTheme}
          />
        </div>
        {configOpen && (
          <ConfigModal onClose={() => setConfigOpen(false)} />
        )}
      </div>
    </>
  );
}

function Topbar({ onOpenConfig, activeTheme, setActiveTheme }) {
  const [themeMenuOpen, setThemeMenuOpen] = useState(false);
  const theme = THEMES[activeTheme];

  return (
    <header className="sg-topbar">
      <div className="sg-topbar-inner">
        <div className="sg-brand">
          <span className="sg-brand-mark" />
          <span className="sg-brand-name">ksite</span>
          <span className="sg-brand-sub">Design System</span>
        </div>
        <div className="sg-topbar-actions">
          <div className="sg-theme-menu">
            <button
              type="button"
              className="sg-theme-trigger"
              onClick={() => setThemeMenuOpen(!themeMenuOpen)}
            >
              <span
                className="sg-theme-trigger-swatch"
                style={{ background: theme.tokens["--color-primary"] }}
              />
              <span className="sg-theme-trigger-name">{theme.name}</span>
              <span className="sg-theme-trigger-arrow">⌄</span>
            </button>
            {themeMenuOpen && (
              <>
                <div
                  className="sg-theme-backdrop"
                  onClick={() => setThemeMenuOpen(false)}
                />
                <div className="sg-theme-dropdown">
                  {Object.entries(THEMES).map(([key, t]) => (
                    <button
                      key={key}
                      type="button"
                      className={
                        "sg-theme-option" +
                        (key === activeTheme ? " active" : "")
                      }
                      onClick={() => {
                        setActiveTheme(key);
                        setThemeMenuOpen(false);
                      }}
                    >
                      <span
                        className="sg-theme-option-swatch"
                        style={{ background: t.tokens["--color-primary"] }}
                      />
                      <span className="sg-theme-option-text">
                        <span className="sg-theme-option-name">{t.name}</span>
                        <span className="sg-theme-option-desc">
                          {t.description}
                        </span>
                      </span>
                      {key === activeTheme && (
                        <span className="sg-theme-option-check">✓</span>
                      )}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
          <button
            type="button"
            className="sg-config-trigger"
            onClick={onOpenConfig}
          >
            <span className="sg-config-glyph">{`{ }`}</span>
            index.css
          </button>
          <span className="sg-version">v0.6</span>
        </div>
      </div>
    </header>
  );
}

function Sidebar({ page, setPage }) {
  return (
    <aside className="sg-sidebar">
      {NAV.map((group) => (
        <div className="sg-nav-group" key={group.group}>
          <div className="sg-nav-group-title">{group.group}</div>
          <ul className="sg-nav-list">
            {group.items.map((item) => (
              <li key={item.id}>
                <button
                  className={
                    "sg-nav-item" + (page === item.id ? " active" : "")
                  }
                  onClick={() => setPage(item.id)}
                >
                  {item.label}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </aside>
  );
}

/*
 * One map, not a router plus a parallel `defined` list. The old version kept
 * both and they fell out of sync — install/alerts/toasts/popovers/drawers/
 * layouts each rendered their real page AND a "coming soon" placeholder under
 * it. Deriving the fallback from the same object makes that unrepresentable.
 */
function Main({ page, btnClasses, setBtnClasses, activeTheme, setActiveTheme }) {
  const PAGES = {
    // Start Here
    overview: <Overview />,
    principles: <Principles />,
    taxonomy: <Taxonomy />,
    install: <Install />,
    composition: <Composition />,
    conventions: <Conventions />,
    // Structure (Half 1)
    vocabulary: <Vocabulary />,
    // Foundation
    variables: <Variables />,
    tonal: <Tonal />,
    layers: <Layers />,
    themes: <Themes activeTheme={activeTheme} setActiveTheme={setActiveTheme} />,
    colors: <Colors />,
    // Components
    buttons: <Buttons btnClasses={btnClasses} setBtnClasses={setBtnClasses} />,
    links: <Links />,
    headings: <Headings />,
    cards: <Cards />,
    alerts: <Alerts />,
    toasts: <Toasts />,
    popovers: <Popovers />,
    drawers: <Drawers />,
    tables: <Tables />,
    dialogs: <Dialogs />,
    inputs: <Inputs />,
    tags: <TagsAndPills />,
    icons: <Icons />,
    // Patterns (Block tier)
    bar: <BarPage />,
    sectionheader: <SectionHeaderPage />,
    divider: <DividerPage />,
    items: <ItemsPage />,
    rows: <RowsPage />,
    feed: <FeedPage />,
    disclosure: <DisclosurePage />,
    // Utilities
    layouts: <Layouts />,
    responsive: <Responsive />,
    spacing: <Spacing />,
    a11y: <Accessibility />,
    typography: <Typography />,
    // Reference
    cheatsheet: <CheatSheet />,
  };

  return (
    <main className="sg-main">
      <div className="sg-main-inner">
        {PAGES[page] || <ComingSoon label={getLabel(page)} />}
      </div>
    </main>
  );
}

function PageHeader({ eyebrow, title, lead }) {
  return (
    <header className="sg-page-header">
      {eyebrow && <div className="sg-eyebrow">{eyebrow}</div>}
      <h1 className="sg-h1">{title}</h1>
      {lead && <p className="sg-lead">{lead}</p>}
      <hr className="sg-divider" />
    </header>
  );
}

function Section({ title, children }) {
  return (
    <section className="sg-section">
      <h2 className="sg-h2">{title}</h2>
      {children}
    </section>
  );
}

function Preview({ children }) {
  return <div className="sg-preview-box">{children}</div>;
}

function Code({ children }) {
  return (
    <pre className="sg-code">
      <code>{children}</code>
    </pre>
  );
}

function Chip({ label, cls, onClick }) {
  return (
    <button
      className={cls}
      onClick={() => onClick && onClick(cls)}
      type="button"
    >
      {label}
    </button>
  );
}

function Overview() {
  return (
    <article>
      <PageHeader
        eyebrow="Start Here"
        title="A design system, not a component library."
        lead="Small, opinionated CSS conventions for Svelte applications. Class chains over component APIs. CSS variables over rewrites."
      />

      <Section title="The contract">
        <p className="sg-prose">
          Every styled element follows the same pattern. A base class declares
          its var contract and uses those vars to style itself. Modifiers and
          variants only set the vars — they never write styles directly.
        </p>
        <ul className="sg-list">
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
        </ul>
      </Section>

      <Section title="What this buys you">
        <p className="sg-prose">
          Per-client theming is a single var file, never a component rewrite.
          A new tone is one rule. Outlined, ghost, pill — anything that reads
          the existing vars composes with every tone you've defined, for free.
          The class chain reads in English: <code>btn primary outlined</code>.
        </p>
      </Section>
    </article>
  );
}

function Install() {
  const Q = "'"; // single quote, kept out of source so the artifact loader doesn't misread example imports as real dependencies
  return (
    <article>
      <PageHeader
        eyebrow="Start Here"
        title="Install"
        lead="One dependency, one import, one class on <body>. Plain CSS — no build step, no UnoCSS, no config."
      />

      <Section title="Prerequisites">
        <ul className="sg-list">
          <li>
            Anything that can load a stylesheet. Vite, SvelteKit, Next, Astro, a
            plain <code>&lt;link&gt;</code> tag — all fine.
          </li>
          <li>
            A browser from 2024 or later. The system uses{" "}
            <code>@property</code>, <code>color-mix()</code>, relative color
            syntax and cascade layers. Practically: Chrome 119+, Safari 16.4+,
            Firefox 128+.
          </li>
        </ul>
        <div className="alert info">
          <div className="alert-icon" aria-hidden="true">
            &#9432;
          </div>
          <div className="alert-content">
            <strong>UnoCSS is no longer required.</strong>
            <p>
              Through v0.5 the component shapes lived in <code>uno.config.ts</code>{" "}
              as shortcuts, so the package needed a build step to render anything.
              As of v0.6 that all moved into plain CSS and the config was deleted.
              Bring Uno if you want atomic utilities in your own markup — the
              system no longer cares either way.
            </p>
          </div>
        </div>
      </Section>

      <Section title="1. Add the package">
        <Code>{`# from the monorepo
bun add @frontierjs/css

# or just copy the folder — it is 25 plain .css files
cp -r packages/css src/styles`}</Code>
      </Section>

      <Section title="2. Import it">
        <p className="sg-prose">
          One import covers everything: tokens, all six themes, tones, the two
          lineage bases, layout helpers, components and patterns. The entry point
          assigns each file to a cascade layer as it goes.
        </p>
        <Code>{`// src/main.ts
import ${Q}@frontierjs/css${Q}

// or, without a bundler
<link rel="stylesheet" href="/styles/index.css">`}</Code>
        <p className="sg-prose">
          Want just a slice? Every file is individually importable —{" "}
          <code>@frontierjs/css/tokens.css</code>,{" "}
          <code>@frontierjs/css/buttons.css</code>. Import{" "}
          <code>tokens.css</code> and at least one theme first, or nothing will
          have colors.
        </p>
      </Section>

      <Section title="3. Pick a theme">
        <p className="sg-prose">
          Themes are a class on any ancestor — usually{" "}
          <code>&lt;body&gt;</code>. They nest, so you can scope a different theme
          to a header or a sidebar, because it is all custom property
          inheritance.
        </p>
        <Code>{`<body class="theme-default">
  <!-- whole app uses the default theme -->

  <header class="theme-midnight">
    <!-- but this header uses midnight -->
    <button class="btn">Sign in</button>
  </header>
</body>`}</Code>
      </Section>

      <Section title="4. Use it">
        <Code>{`<!-- Buttons: Element class first, then Treatments in any order -->
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
</div>`}</Code>
        <p className="sg-prose">
          That is the whole setup. See <strong>Kinds of class</strong> for the
          composition model and <strong>Principles</strong> for how to choose the
          elements.
        </p>
      </Section>

      <Section title="Overriding it">
        <p className="sg-prose">
          Everything the package ships lives in a cascade layer, and unlayered CSS
          beats every layer. So your own stylesheet wins by default — no{" "}
          <code>!important</code>, no specificity ladder.
        </p>
        <Code>{`/* your app.css — plain and unlayered, so it wins */
.btn { border-radius: 2px; }
td    { background: var(--zebra); }`}</Code>
      </Section>

      <Section title="Troubleshooting">
        <ul className="sg-list">
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
            rather than a Treatment — <code>.compact</code> only works on{" "}
            <code>.table</code>, <code>.icon</code> only on <code>.btn</code>. See{" "}
            <strong>Kinds of class</strong>.
          </li>
        </ul>
      </Section>
    </article>
  );
}

function Composition() {
  const branches = [
    {
      name: "pill",
      role: "Status & counts",
      adds: "rounded-full, smaller padding, tone fills",
      preview: <span className="pill primary">12</span>,
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
      preview: <span className="badge danger">New</span>,
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
      preview: <button className="btn primary">Save</button>,
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

  return (
    <article>
      <PageHeader
        eyebrow="Start Here"
        title="Composition"
        lead="A small base class supplies the bones. Everything else extends it. New visual languages plug in by sharing the same skeleton."
      />

      <Section title="The lineage">
        <p className="sg-prose">
          One core utility — <code>chip</code> — owns layout and alignment.
          Three classes inherit it and add their own visual treatment. Each
          declares its own var contract; nothing fights for the same name.
        </p>
        <div className="sg-lineage">
          <div className="sg-lineage-col">
            <div className="sg-lineage-card sg-lineage-root">
              <div className="sg-lineage-name">chip</div>
              <div className="sg-lineage-role">Core structure</div>
              <div className="sg-lineage-preview">
                <span className="chip">chip</span>
              </div>
            </div>
          </div>
          <div className="sg-lineage-arrow">
            <span>extends</span>
          </div>
          <div className="sg-lineage-col">
            {branches.map((b) => (
              <div className="sg-lineage-card" key={b.name}>
                <div className="sg-lineage-name">{b.name}</div>
                <div className="sg-lineage-role">{b.role}</div>
                <div className="sg-lineage-preview">{b.preview}</div>
              </div>
            ))}
          </div>
        </div>
      </Section>

      <Section title="chip — the base">
        <p className="sg-prose">
          <code>chip</code> only declares structure: inline-flex, alignment,
          gap, whitespace-nowrap. No color, no font weight. It lives as a
          Uno shortcut so every consumer composes it the same way.
        </p>
        <Preview>
          <span className="chip">I am a chip</span>
        </Preview>
        <Code>{`/* chip.css — the inline base, at zero specificity so every
   composite overrides it without a fight */
:where(.chip, .btn, .pill, .badge) {
  display:         inline-flex;
  align-items:     center;
  justify-content: center;
  gap:             0.375rem;
  white-space:     nowrap;
  text-align:      center;
}`}</Code>
      </Section>

      {branches.map((b) => (
        <Section title={`${b.name} — extends chip`} key={b.name}>
          <p className="sg-prose">
            <strong>{b.role}.</strong> Adds: {b.adds}.
          </p>
          <Preview>
            <div className="sg-row-flex">
              {b.preview}
              {b.name === "pill" && (
                <>
                  <span className="pill info">info</span>
                  <span className="pill success">3</span>
                  <span className="pill warning">!</span>
                  <span className="pill danger">99+</span>
                </>
              )}
              {b.name === "badge" && (
                <>
                  <span className="badge info">Info</span>
                  <span className="badge success">Active</span>
                  <span className="badge warning">Pending</span>
                  <span className="badge primary">Beta</span>
                </>
              )}
              {b.name === "btn" && (
                <>
                  <button className="btn">Default</button>
                  <button className="btn info">Info</button>
                  <button className="btn primary outlined">Outlined</button>
                </>
              )}
            </div>
          </Preview>
          <Code>{b.code}</Code>
        </Section>
      ))}

      <Section title="How extension resolves">
        <p className="sg-prose">
          Shortcuts compose by name. <code>badge</code>'s shortcut starts
          with <code>chip</code>, so Uno inlines <code>chip</code>'s utilities
          alongside <code>badge</code>'s own. Markup writes the leaf class only.
        </p>
        <div className="sg-resolve">
          <div className="sg-resolve-col">
            <div className="sg-resolve-label">Shortcut</div>
            <pre className="sg-code sg-code-inline">{`['badge',
  'chip text-xs uppercase
   tracking-wide font-semibold
   px-2 py-0.5 rounded']`}</pre>
          </div>
          <div className="sg-resolve-arrow">→</div>
          <div className="sg-resolve-col">
            <div className="sg-resolve-label">Resolved</div>
            <pre className="sg-code sg-code-inline">{`inline-flex items-center
justify-center gap-1.5
whitespace-nowrap text-center
text-xs uppercase tracking-wide
font-semibold px-2 py-0.5 rounded`}</pre>
          </div>
        </div>
        <p className="sg-prose">
          Source of truth is the CSS. Each composite owns one flat file —{" "}
          <code>buttons.css</code>, <code>cards.css</code> — and shares a
          zero-specificity <code>:where()</code> base: <code>chip.css</code>{" "}
          for the inline lineage, <code>surface.css</code> for the block one.
        </p>
      </Section>

      <Section title="The surface lineage — block primitives">
        <p className="sg-prose">
          Block primitives compound off a shared base too. <code>surface</code>{" "}
          owns the bg, border, radius, and tonal recipe. Composites add only
          what's unique to them — card adds padding, alert adds row layout,
          toast adds positioning, dialog adds modal sizing. The surface CSS
          file is the single source of truth for "what does a block surface
          look like."
        </p>
        <div className="sg-lineage">
          <div className="sg-lineage-base">
            <div className="sg-lineage-name">surface</div>
            <div className="sg-lineage-role">
              Block visual base: bg, border, radius, tonal recipe
            </div>
          </div>
          <div className="sg-lineage-arrow">
            <div className="sg-lineage-arrow-line" />
            <div className="sg-lineage-arrow-label">extends</div>
          </div>
          <div className="sg-lineage-children">
            <div className="sg-lineage-card">
              <div className="sg-lineage-name">card</div>
              <div className="sg-lineage-role">+ padding</div>
              <div className="sg-lineage-preview">
                <span className="sg-cheat-mini-card">card</span>
              </div>
            </div>
            <div className="sg-lineage-card">
              <div className="sg-lineage-name">alert</div>
              <div className="sg-lineage-role">+ row layout</div>
              <div className="sg-lineage-preview">
                <span className="sg-cheat-mini-card">alert</span>
              </div>
            </div>
            <div className="sg-lineage-card">
              <div className="sg-lineage-name">toast</div>
              <div className="sg-lineage-role">+ fixed + animation</div>
              <div className="sg-lineage-preview">
                <span className="sg-cheat-mini-card">toast</span>
              </div>
            </div>
            <div className="sg-lineage-card">
              <div className="sg-lineage-name">dialog</div>
              <div className="sg-lineage-role">+ native modal</div>
              <div className="sg-lineage-preview">
                <span className="sg-cheat-mini-dialog">dialog</span>
              </div>
            </div>
          </div>
        </div>
        <p className="sg-prose">
          The composition trick is a <code>:where()</code> selector group.
          Surface's CSS targets every composite class in one rule list — adding
          a new composite (popover, drawer, banner) means adding its name
          once, then writing only the unique behavior.
        </p>
        <Code>{`/* surface.css — shared by every block primitive */
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
}`}</Code>
      </Section>

      <Section title="Standalone block primitives">
        <p className="sg-prose">
          Not everything fits under surface. Forms and tables have their
          own structural needs — <code>field</code> owns input chrome,{" "}
          <code>table</code> owns border-collapse and cell layout. They
          read tones via <code>--bg-mix</code> like everything else, but
          they don't share surface's visual recipe.
        </p>
        <div className="sg-lineage">
          <div className="sg-lineage-children">
            <div className="sg-lineage-card">
              <div className="sg-lineage-name">field</div>
              <div className="sg-lineage-role">Form input base</div>
              <div className="sg-lineage-preview">
                <span className="sg-cheat-mini-field">field</span>
              </div>
            </div>
            <div className="sg-lineage-card">
              <div className="sg-lineage-name">table</div>
              <div className="sg-lineage-role">Tabular data</div>
              <div className="sg-lineage-preview">
                <span className="sg-cheat-mini-table">table</span>
              </div>
            </div>
          </div>
        </div>
      </Section>

      <Section title="Tones — the cross-cutting layer">
        <p className="sg-prose">
          One file, <code>tones.css</code>, owns every tone. Every base
          reads from it. Add a tone here once; buttons, pills, badges,
          cards, tables, dialogs, and fields all gain it automatically.
        </p>
        <Code>{`/* tones.css — the single source */
.primary   { --bg-mix: var(--color-primary);   --on-bg-mix: white; }
.secondary { --bg-mix: var(--color-secondary); --on-bg-mix: white; }
.muted     { --bg-mix: var(--color-muted);     --on-bg-mix: white; }
.info      { --bg-mix: var(--color-info);      --on-bg-mix: white; }
.success   { --bg-mix: var(--color-success);   --on-bg-mix: white; }
.warning   { --bg-mix: var(--color-warning);   --on-bg-mix: #1f2937; }
.danger    { --bg-mix: var(--color-danger);    --on-bg-mix: white; }`}</Code>
        <p className="sg-prose">
          The class works on its own too —{" "}
          <code>{`<span class="danger">7 days</span>`}</code> sets the vars
          even with no component attached. Any element using{" "}
          <code>var(--bg-mix)</code> picks them up.
        </p>
      </Section>

      <Section title="Why this compounds">
        <p className="sg-prose">
          Two leverage points working together:
        </p>
        <ul className="sg-list">
          <li>
            <strong>One layout fix updates everything.</strong> Change{" "}
            <code>gap</code> on <code>chip</code> and pills, badges, and
            buttons all line up the same.
          </li>
          <li>
            <strong>One tone class updates everything.</strong> The{" "}
            <code>.danger</code> class in <code>tones.css</code> sets{" "}
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
        </ul>
      </Section>
    </article>
  );
}

function Conventions() {
  return (
    <article>
      <PageHeader
        eyebrow="Start Here"
        title="Conventions"
        lead="The rules that let the system grow without rewrites."
      />

      <Section title="Class order doesn't matter">
        <p className="sg-prose">
          Within a chain, ordering is irrelevant. Specificity is identical
          across tone, variant, and modifier classes — the cascade does the
          work.
        </p>
        <Code>{`<button class="btn primary outlined">   ✓
<button class="btn outlined primary">   ✓
<button class="outlined primary btn">   ✓`}</Code>
      </Section>

      <Section title="Adding a new tone">
        <p className="sg-prose">
          One line in <code>tones.css</code>. Every component picks it up —
          buttons, pills, badges, cards, tables, dialogs, fields. No
          component file is touched.
        </p>
        <Code>{`/* tones.css */
.brand { --bg-mix: var(--color-brand); --on-bg-mix: white; }`}</Code>
      </Section>

      <Section title="Adding a new variant">
        <p className="sg-prose">
          Variants read the existing var contract and restructure. They never
          name specific tones — that's what makes them compose with every
          tone automatically.
        </p>
        <Code>{`.btn.ghost {
  background:   transparent;
  color:        var(--bg-mix, var(--color-primary));
  border-color: transparent;
}`}</Code>
      </Section>
    </article>
  );
}

function Variables() {
  return (
    <article>
      <PageHeader
        eyebrow="Foundation"
        title="CSS Variables"
        lead="Two scopes: global tokens on :root, and per-component contracts on each base class."
      />

      <Section title="Global tokens">
        <p className="sg-prose">
          Semantic color tokens live on <code>:root</code>. Every component
          references these — never raw hex.
        </p>
        <table className="sg-token-table">
          <thead>
            <tr>
              <th>Token</th>
              <th>Value</th>
            </tr>
          </thead>
          <tbody>
            {SEMANTIC_COLORS.map(([name, value]) => (
              <tr key={name}>
                <td>{name}</td>
                <td>
                  <span
                    className="sg-swatch"
                    style={{ background: value }}
                  />
                  {value}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title="Component contracts">
        <p className="sg-prose">
          Each base reads from a tiny set of vars. Tone classes set{" "}
          <code>--bg-mix</code> and <code>--on-bg-mix</code> elsewhere
          (tones.css); the component just consumes them.
        </p>
        <Code>{`/* buttons.css */
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
/* ... */`}</Code>
        <table className="sg-token-table">
          <thead>
            <tr>
              <th>Variable</th>
              <th>Role</th>
            </tr>
          </thead>
          <tbody>
            {BTN_VARS.map(([name, role]) => (
              <tr key={name}>
                <td>{name}</td>
                <td className="sg-td-prose">{role}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title="Scope rule">
        <p className="sg-prose">
          Variables defined at a more specific scope override the global ones.
          Wrap a subtree in a theme class and every component inside re-skins
          automatically — no component rewrites.
        </p>
        <Code>{`:root {
  --color-primary: #0d83dd;
}

.theme-sunset {
  --color-primary: #F98E2E;
  --color-success: #d4b609;
}`}</Code>
      </Section>
    </article>
  );
}

function Buttons({ btnClasses, setBtnClasses }) {
  return (
    <article>
      <PageHeader
        eyebrow="Components"
        title="Buttons"
        lead="The .btn class plus modifiers. Tones set the var contract. Outlined reads them and flips structure."
      />

      <Section title="Default">
        <p className="sg-prose">
          The bare <code>btn</code> class is your primary button — no extra
          modifier needed.
        </p>
        <Preview>
          <Chip label="Button" cls="btn" onClick={setBtnClasses} />
        </Preview>
        <Code>{`<button class="btn">Button</button>`}</Code>
      </Section>

      <Section title="Tones">
        <p className="sg-prose">
          The tone classes (<code>.primary</code>, <code>.danger</code>, …)
          live in one file — <code>tones.css</code> — and set{" "}
          <code>--bg-mix</code> + <code>--on-bg-mix</code>. The button reads
          those vars; same vocabulary works on pills, badges, cards, fields.
        </p>
        <Preview>
          <div className="sg-row-flex">
            {TONES.map(([cls, label]) => (
              <Chip
                key={cls}
                label={label}
                cls={`btn ${cls}`}
                onClick={setBtnClasses}
              />
            ))}
          </div>
        </Preview>
        <Code>
          {TONES.map(
            ([c, l]) => `<button class="btn ${c}">${l}</button>`
          ).join("\n")}
        </Code>
      </Section>

      <Section title="Outlined">
        <p className="sg-prose">
          Adding <code>outlined</code> reads the vars set by the tone and
          inverts the structure — background becomes surface; color and border
          become the tone hue.
        </p>
        <Preview>
          <div className="sg-row-flex">
            {TONES.map(([cls, label]) => (
              <Chip
                key={cls}
                label={label}
                cls={`btn ${cls} outlined`}
                onClick={setBtnClasses}
              />
            ))}
          </div>
        </Preview>
        <Code>{`<button class="btn primary outlined">Primary</button>`}</Code>
      </Section>

      <Section title="Sizes">
        <p className="sg-prose">
          Sizes ride the type scale. Padding is set in <code>em</code> so
          font-size carries the whole thing.
        </p>
        <Preview>
          <div className="sg-row-flex sg-row-baseline">
            {[
              ["text-sm", "Small"],
              ["text-base", "Base"],
              ["text-lg", "Large"],
              ["text-xl", "XL"],
              ["text-2xl", "2XL"],
            ].map(([cls, label]) => (
              <Chip
                key={cls}
                label={label}
                cls={`btn ${cls}`}
                onClick={setBtnClasses}
              />
            ))}
          </div>
        </Preview>
      </Section>

      <Section title="Link button">
        <p className="sg-prose">
          The <code>link</code> modifier strips structure and renders the
          button visually as a link, while keeping button semantics.
        </p>
        <Preview>
          <Chip label="Link Button" cls="btn link" onClick={setBtnClasses} />
        </Preview>
        <Code>{`<button class="btn link">Link Button</button>`}</Code>
      </Section>

      <Section title="Live editor">
        <p className="sg-prose">
          Compose the class chain yourself. Any example above populates this
          field.
        </p>
        <div className="sg-editor">
          <label className="sg-editor-label">Class chain</label>
          <input
            value={btnClasses}
            onChange={(e) => setBtnClasses(e.target.value)}
            placeholder="btn primary outlined"
            spellCheck={false}
          />
          <div className="sg-preview-box sg-preview-center">
            <button className={btnClasses || ""}>Example Button</button>
          </div>
        </div>
      </Section>
    </article>
  );
}

function Links() {
  return (
    <article>
      <PageHeader
        eyebrow="Components"
        title="Links"
        lead="The .link class for inline anchors. Same tone vocabulary as buttons."
      />

      <Section title="Default">
        <Preview>
          <a
            className="link"
            href="#"
            onClick={(e) => e.preventDefault()}
          >
            A normal link
          </a>
        </Preview>
        <Code>{`<a class="link" href="/">A normal link</a>`}</Code>
      </Section>

      <Section title="Button styled as link">
        <p className="sg-prose">
          A button that needs to read as a link uses <code>btn link</code>.
        </p>
        <Preview>
          <button className="btn link">Link button</button>
        </Preview>
        <Code>{`<button class="btn link">Link button</button>`}</Code>
      </Section>
    </article>
  );
}

function Tonal() {
  const tones = ["primary", "secondary", "muted", "info", "success", "warning", "danger"];

  return (
    <article>
      <PageHeader
        eyebrow="Foundation"
        title="Tones &amp; contrast"
        lead="A tone is one variable. Everything else — surface tints, borders, fills, text color — is derived from it, and none of the derivations know any tone names."
      />

      <Section title="The contract is one variable">
        <p className="sg-prose">
          A tone class sets <code>--bg-mix</code>. That is the entire tone. It
          used to set a second variable, <code>--on-bg-mix</code>, asserting the
          text color — that assertion is what failed WCAG on 15 of 35 tone × theme
          combinations, so it is now derived instead.
        </p>
        <Code>{`/* tones.css — the whole file, essentially */
.primary   { --bg-mix: var(--color-primary);   }
.danger    { --bg-mix: var(--color-danger);    }
/* …five more… */`}</Code>
        <div className="cluster">
          {tones.map((t) => (
            <button key={t} className={`btn ${t}`}>
              {t}
            </button>
          ))}
        </div>
      </Section>

      <Section title="Tones are element-scoped">
        <p className="sg-prose">
          Custom properties inherit, and <code>var(--bg-mix, fallback)</code> only
          reaches its fallback when the property is unset on the element{" "}
          <em>and</em> every ancestor. Unregistered, a tone bled into every
          descendant that read it — an untoned button inside a danger alert
          rendered red on red.
        </p>
        <Code>{`@property --bg-mix    { syntax: "*"; inherits: false; }
@property --on-bg-mix { syntax: "*"; inherits: false; }`}</Code>
        <Preview>
          <div className="alert danger" style={{ width: "100%" }}>
            <div className="alert-icon" aria-hidden="true">
              !
            </div>
            <div className="alert-content">
              <strong>Payment failed</strong>
              <p>
                The button and pill below are untoned. They keep their own
                defaults instead of inheriting the alert&rsquo;s danger tone.
              </p>
              <div className="cluster" style={{ marginTop: "8px" }}>
                <button className="btn">Retry</button>
                <span className="pill">3</span>
              </div>
            </div>
          </div>
        </Preview>
        <p className="sg-prose">
          The cost: a rule that reads <code>--bg-mix</code> must sit on the element
          carrying the tone class. Where a child needs the value — the tinted{" "}
          <code>&lt;td&gt;</code> in a toned row, the tinted header of a toned
          dialog — the toned element derives the result into a normal inheriting
          property and passes that down.
        </p>
      </Section>

      <Section title="The surface recipe names no tones">
        <p className="sg-prose">
          Each tint is computed from <code>--bg-mix</code>. When there is no tone,{" "}
          <code>--bg-mix</code> is guaranteed-invalid, so the{" "}
          <code>color-mix()</code> is invalid at computed-value time, so the tint
          variable is too — and the fallback on the next line supplies the untoned
          default. That is the whole mechanism, and it is why every tone works on
          every surface without anything enumerating them.
        </p>
        <Code>{`:where(.surface, .card, .alert, .toast, .dialog, .popover, .drawer) {
  --surface-tint-bg:     color-mix(in srgb, var(--bg-mix) 10%, var(--surface));
  --surface-tint-border: color-mix(in srgb, var(--bg-mix) 30%, var(--surface));
  --surface-tint-color:  color-mix(in srgb, var(--bg-mix) 55%, var(--ink));

  --surface-bg:     var(--surface-tint-bg,     var(--surface));
  --surface-border: var(--surface-tint-border, var(--rule));
  --surface-color:  var(--surface-tint-color,  var(--ink));
}`}</Code>
        <div className="stack">
          {tones.map((t) => (
            <article key={t} className={`card ${t}`}>
              <strong>.card .{t}</strong>
              <p style={{ margin: 0 }}>
                10% tint, 30% border, 55% text — derived, not declared.
              </p>
            </article>
          ))}
        </div>
        <div className="alert info">
          <div className="alert-icon" aria-hidden="true">
            &#9432;
          </div>
          <div className="alert-content">
            <strong>
              <code>.secondary</code> and <code>.muted</code> are in that list now.
            </strong>
            <p>
              Before v0.6 the recipe read{" "}
              <code>:is(.primary, .info, .success, .warning, .danger)</code> — so
              those two set a variable and nothing happened. Four files each
              enumerated a different subset of the seven tones.
            </p>
          </div>
        </div>
      </Section>

      <Section title="Contrast is derived, not asserted">
        <p className="sg-prose">
          For solid fills — button, pill, badge — both the fill and its text come
          from one number: the fill&rsquo;s relative luminance. The{" "}
          <code>y</code> channel of <code>xyz-d65</code> <em>is</em> WCAG&rsquo;s
          L, so there is no approximation involved.
        </p>
        <table className="table striped compact">
          <thead>
            <tr>
              <th style={{ width: "26%" }}>Regime</th>
              <th>What happens</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <strong>Bright</strong> <code>y &gt; 0.35</code>
              </td>
              <td>
                Keep the color exactly, use dark text. Contrast lands ≥ 8:1 and the
                brand hue survives — this is why Elite&rsquo;s lime stays lime.
              </td>
            </tr>
            <tr>
              <td>
                <strong>Everything else</strong>
              </td>
              <td>
                Keep white text, scale luminance down to 0.1783 — the point where
                white reaches 4.5:1. Uniform XYZ scaling is a scalar multiply on
                linear RGB, so hue is preserved exactly and it cannot leave gamut.
              </td>
            </tr>
          </tbody>
        </table>
        <Preview>
          <div className="cluster">
            {tones.map((t) => (
              <span key={t} className={`badge ${t}`}>
                {t}
              </span>
            ))}
          </div>
        </Preview>
        <p className="sg-prose">
          Verified across all 35 tone × theme combinations: <strong>0 AA
          failures, worst 4.58:1</strong>, with 25 of 35 brand colors completely
          untouched. Because it is derived rather than tabulated, it holds for
          hues no theme has defined yet — a new theme cannot reintroduce the bug.
        </p>
        <Code>{`/* chip.css — override per tone or theme if you want a specific text color */
.theme-x .warning { --on-bg-mix: #1f2937; }`}</Code>
      </Section>

      <Section title="Why not lighten-N / darken-N">
        <p className="sg-prose">
          Through v0.5 this page documented a <code>lighten-N</code> /{" "}
          <code>darken-N</code> scale from <code>uno.config.ts</code>. Those rules
          wrote <code>--bg</code> and <code>--color</code>, which{" "}
          <strong>no rule in the package ever read</strong> — they had never
          worked. They were removed in v0.6 along with the rest of the Uno config.
        </p>
        <p className="sg-prose">
          If you want a shade, use <code>color-mix()</code> directly. It is the
          same primitive the recipe above is built from, and it needs no build
          step.
        </p>
        <Code>{`background: color-mix(in srgb, var(--color-primary) 20%, var(--surface));`}</Code>
      </Section>
    </article>
  );
}

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
      "--ink-mute": "#8a8a8a",
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

function Themes({ activeTheme, setActiveTheme }) {
  const active = activeTheme;
  const setActive = setActiveTheme;
  const theme = THEMES[active];

  const themeCSS = `/* ${active}.css */
.theme-${active} {
${Object.entries(theme.tokens)
  .map(([k, v]) => `  ${k}: ${v};`)
  .join("\n")}
}`;

  return (
    <article>
      <PageHeader
        eyebrow="Foundation"
        title="Themes"
        lead="A theme is a set of CSS variables. Nothing else. Apply the theme class to any subtree and every component reskins, no rewriting required."
      />

      <Section title="Live switcher">
        <p className="sg-prose">
          Pick a theme. The vars cascade. Every button, badge, pill, and tonal
          surface below reskins instantly. No component code changes.
        </p>
        <div className="sg-theme-switcher">
          {Object.entries(THEMES).map(([key, t]) => (
            <button
              key={key}
              type="button"
              className={
                "sg-theme-tab" + (active === key ? " active" : "")
              }
              onClick={() => setActive(key)}
            >
              <span
                className="sg-theme-swatch"
                style={{ background: t.tokens["--color-primary"] }}
              />
              <div className="sg-theme-tab-text">
                <div className="sg-theme-tab-name">{t.name}</div>
                <div className="sg-theme-tab-desc">{t.description}</div>
              </div>
            </button>
          ))}
        </div>

        <div className="sg-theme-preview" style={theme.tokens}>
          <div className="sg-theme-block">
            <div className="sg-theme-label">Buttons</div>
            <div className="sg-row-flex">
              <button className="btn">Save</button>
              <button className="btn outlined">Cancel</button>
              <button className="btn success">Approve</button>
              <button className="btn warning">Review</button>
              <button className="btn danger outlined">Delete</button>
            </div>
          </div>

          <div className="sg-theme-block">
            <div className="sg-theme-label">Badges &amp; Pills</div>
            <div className="sg-row-flex">
              <span className="badge success">Active</span>
              <span className="badge warning">Pending</span>
              <span className="badge danger">Failed</span>
              <span className="pill primary">12</span>
              <span className="pill info">i</span>
              <span className="pill danger">99+</span>
            </div>
          </div>

          <div className="sg-theme-block">
            <div className="sg-theme-label">Tonal ramp</div>
            <div
              className="sg-theme-ramp"
              style={{
                "--bg-mix": "var(--color-primary)",
                "--color": "var(--ink)",
              }}
            >
              <div className="tonal" style={{ background: "color-mix(in srgb, var(--bg-mix) 80%, white)", color: "var(--ink)" }}>80</div>
              <div className="tonal" style={{ background: "color-mix(in srgb, var(--bg-mix) 60%, white)", color: "var(--ink)" }}>60</div>
              <div className="tonal" style={{ background: "color-mix(in srgb, var(--bg-mix) 40%, white)", color: "var(--ink)" }}>40</div>
              <div className="tonal" style={{ background: "color-mix(in srgb, var(--bg-mix) 20%, white)", color: "var(--ink)" }}>20</div>
              <div className="tonal sg-tonal-raw">raw</div>
              <div className="tonal" style={{ background: "color-mix(in srgb, var(--bg-mix) 20%, black)", color: "white" }}>−20</div>
              <div className="tonal" style={{ background: "color-mix(in srgb, var(--bg-mix) 40%, black)", color: "white" }}>−40</div>
              <div className="tonal" style={{ background: "color-mix(in srgb, var(--bg-mix) 60%, black)", color: "white" }}>−60</div>
              <div className="tonal" style={{ background: "color-mix(in srgb, var(--bg-mix) 80%, black)", color: "white" }}>−80</div>
            </div>
          </div>

          <div className="sg-theme-block">
            <div className="sg-theme-label">Form field</div>
            <div className="field-group">
              <label>Email address</label>
              <input
                className="field"
                type="email"
                defaultValue="you@example.com"
              />
            </div>
          </div>
        </div>
      </Section>

      <Section title="The active theme">
        <p className="sg-prose">
          This is everything that defines the <code>{active}</code> theme.
          One file. Seven tokens.
        </p>
        <Code>{themeCSS}</Code>
      </Section>

      <Section title="Scoping">
        <p className="sg-prose">
          Themes don't have to be global. Wrap any subtree to scope a theme
          to it — useful for previews, per-tenant headers, comparison views.
        </p>
        <Code>{`<body class="theme-default">
  <header class="theme-sunset">
    <!-- Header uses Sunset palette -->
    <button class="btn">Now orange</button>
  </header>

  <main>
    <!-- Body uses Default palette -->
    <button class="btn">Still blue</button>
  </main>
</body>`}</Code>
      </Section>

      <Section title="Adding a new theme">
        <p className="sg-prose">
          One <code>.css</code> file. Seven variable overrides. Done.
        </p>
        <Code>{`/* oceanic.css */
.theme-oceanic {
  --color-primary:   #0891b2;
  --color-secondary: #ecfeff;
  --color-muted:     #475569;
  --color-info:      #0284c7;
  --color-success:   #059669;
  --color-warning:   #ca8a04;
  --color-danger:    #be123c;
}`}</Code>
        <p className="sg-prose">
          No components touched. No shortcuts updated. Apply{" "}
          <code>theme-oceanic</code> to <code>html</code>, <code>body</code>,
          or any subtree.
        </p>
      </Section>
    </article>
  );
}

function Colors() {
  const tones = [
    {
      name: "primary",
      hex: "#0d83dd",
      role: "Brand. Default actions, links, focus rings.",
    },
    {
      name: "secondary",
      hex: "#E5E7EB",
      role: "Subtle backgrounds, low-emphasis surfaces.",
    },
    {
      name: "muted",
      hex: "#6b7280",
      role: "De-emphasized text, secondary controls.",
    },
    {
      name: "info",
      hex: "#2EA2C9",
      role: "Informational notices, tips.",
    },
    {
      name: "success",
      hex: "#16a34a",
      role: "Confirmations, positive state.",
    },
    {
      name: "warning",
      hex: "#d4b609",
      role: "Cautionary actions, pending state.",
    },
    {
      name: "danger",
      hex: "#F4403A",
      role: "Errors, destructive actions.",
    },
  ];

  return (
    <article>
      <PageHeader
        eyebrow="Foundation"
        title="Colors"
        lead="Seven semantic tones. Each one feeds a full tonal ramp via color-mix — one source-of-truth hue per role."
      />

      <Section title="The palette">
        <p className="sg-prose">
          One token per role. Components reference these by name (
          <code>--color-primary</code>, <code>--color-danger</code>) and never
          touch raw hex.
        </p>
        <div className="sg-palette">
          {tones.map((t) => (
            <div
              key={t.name}
              className="sg-palette-tile"
              style={{
                background: t.hex,
                color: t.hex === "#E5E7EB" ? "#1f2937" : "white",
              }}
            >
              <div className="sg-palette-name">{t.name}</div>
              <div className="sg-palette-hex">{t.hex}</div>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Tonal ramps">
        <p className="sg-prose">
          Every tone gets a free 11-step ramp from the{" "}
          <code>lighten</code>/<code>darken</code> utilities. No need to
          define 50/100/200/300… steps by hand.
        </p>
        <div className="sg-color-ramps">
          {tones.map((t) => (
            <div
              key={t.name}
              className="sg-color-ramp"
              style={{
                "--bg-mix": `var(--color-${t.name})`,
                "--color": "var(--ink)",
              }}
            >
              <div className="sg-color-ramp-meta">
                <code className="sg-color-ramp-name">{t.name}</code>
                <span className="sg-color-ramp-role">{t.role}</span>
              </div>
              <div className="sg-color-ramp-strip">
                <div className="tonal" style={{ background: "color-mix(in srgb, var(--bg-mix) 90%, white)", color: "var(--ink)" }}>90</div>
                <div className="tonal" style={{ background: "color-mix(in srgb, var(--bg-mix) 70%, white)", color: "var(--ink)" }}>70</div>
                <div className="tonal" style={{ background: "color-mix(in srgb, var(--bg-mix) 50%, white)", color: "var(--ink)" }}>50</div>
                <div className="tonal" style={{ background: "color-mix(in srgb, var(--bg-mix) 30%, white)", color: "var(--ink)" }}>30</div>
                <div className="tonal" style={{ background: "color-mix(in srgb, var(--bg-mix) 10%, white)", color: "var(--ink)" }}>10</div>
                <div className="tonal sg-tonal-raw">raw</div>
                <div className="tonal" style={{ background: "color-mix(in srgb, var(--bg-mix) 10%, black)", color: "white" }}>−10</div>
                <div className="tonal" style={{ background: "color-mix(in srgb, var(--bg-mix) 30%, black)", color: "white" }}>−30</div>
                <div className="tonal" style={{ background: "color-mix(in srgb, var(--bg-mix) 50%, black)", color: "white" }}>−50</div>
                <div className="tonal" style={{ background: "color-mix(in srgb, var(--bg-mix) 70%, black)", color: "white" }}>−70</div>
                <div className="tonal" style={{ background: "color-mix(in srgb, var(--bg-mix) 90%, black)", color: "white" }}>−90</div>
              </div>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Where to use each">
        <table className="sg-token-table">
          <thead>
            <tr>
              <th>Tone</th>
              <th>Typical use</th>
            </tr>
          </thead>
          <tbody>
            {tones.map((t) => (
              <tr key={t.name}>
                <td>
                  <span
                    className="sg-swatch"
                    style={{ background: t.hex }}
                  />
                  {t.name}
                </td>
                <td className="sg-td-prose">{t.role}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title="Picking new tones">
        <p className="sg-prose">
          A few rules that keep the palette working as it scales:
        </p>
        <ul className="sg-list">
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
        </ul>
      </Section>
    </article>
  );
}

function Headings() {
  return (
    <article>
      <PageHeader
        eyebrow="Components"
        title="Headings"
        lead="A six-step type scale. Element tags get the scale by default; matching .h1–.h6 classes let you borrow the look on other elements."
      />

      <Section title="The scale">
        <Preview>
          <div className="sg-stack">
            <span className="h1">Heading 1 — display</span>
            <span className="h2">Heading 2 — section</span>
            <span className="h3">Heading 3 — subsection</span>
            <span className="h4">Heading 4 — group</span>
            <span className="h5">Heading 5 — label</span>
            <span className="h6">Heading 6 — fine print</span>
          </div>
        </Preview>
        <Code>{`<h1 class="h1">Heading 1</h1>
<h2 class="h2">Heading 2</h2>
<h3 class="h3">Heading 3</h3>
<h4 class="h4">Heading 4</h4>
<h5 class="h5">Heading 5</h5>
<h6 class="h6">Heading 6</h6>`}</Code>
      </Section>

      <Section title="Source">
        <p className="sg-prose">
          Tag selectors paired with classes — write the right semantic tag,
          fall back to the class when the element doesn't match the role.
        </p>
        <Code>{`/* typography.css */
h1, .h1 { font-size: 2.25rem; font-weight: 700; letter-spacing: -0.02em;  line-height: 1.1; }
h2, .h2 { font-size: 1.75rem; font-weight: 700; letter-spacing: -0.015em; line-height: 1.2; }
h3, .h3 { font-size: 1.375rem; font-weight: 600; line-height: 1.3; }
h4, .h4 { font-size: 1.125rem; font-weight: 600; }
h5, .h5 { font-size: 1rem;     font-weight: 600; }
h6, .h6 { font-size: 0.875rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }`}</Code>
      </Section>

      <Section title="Borrowed styling">
        <p className="sg-prose">
          When semantic order matters more than visual weight — e.g. an{" "}
          <code>h2</code> visually styled as an h4 — apply the class:
        </p>
        <Preview>
          <div className="sg-stack">
            <span className="h4">An h2 that looks like an h4</span>
            <span className="h6">A small uppercase eyebrow on a span</span>
          </div>
        </Preview>
        <Code>{`<h2 class="h4">An h2 that looks like an h4</h2>
<span class="h6">A small uppercase eyebrow</span>`}</Code>
      </Section>
    </article>
  );
}

function Cards() {
  return (
    <article>
      <PageHeader
        eyebrow="Components"
        title="Cards"
        lead="A surface container. Card is its own base — a block primitive that sits alongside chip, not extending it."
      />

      <Section title="Default">
        <p className="sg-prose">
          The bare <code>.card</code> class — a flat surface with a soft
          border and consistent padding.
        </p>
        <Preview>
          <div className="card">
            A simple card. Contains text or any other content. Owns its
            padding, surface color, and border.
          </div>
        </Preview>
        <Code>{`<div class="card">
  A simple card.
</div>`}</Code>
      </Section>

      <Section title="Structured — header, body, footer">
        <p className="sg-prose">
          Three optional sub-components for cards that need internal sections.
          They share the card's border color so the dividers stay consistent.
        </p>
        <Preview>
          <div className="card">
            <div className="surface-header">Maid.Tech</div>
            <div className="surface-body">
              <p className="sg-card-text">
                A platform serving cleaning businesses. Manages booking,
                scheduling, and client communication.
              </p>
            </div>
            <div className="surface-footer">
              <button className="btn">View</button>
              <button className="btn outlined">Settings</button>
            </div>
          </div>
        </Preview>
        <Code>{`<div class="card">
  <div class="surface-header">Title</div>
  <div class="surface-body">...content...</div>
  <div class="surface-footer">
    <button class="btn">Action</button>
  </div>
</div>`}</Code>
      </Section>

      <Section title="Variants">
        <p className="sg-prose">
          Same vocabulary as buttons. Each variant only flips the var contract
          — same structure, different surface treatment.
        </p>
        <Preview>
          <div className="sg-card-grid">
            <div className="card">
              <strong>Default</strong>
              <p className="sg-card-text">Border + surface fill.</p>
            </div>
            <div className="card raised">
              <strong>Raised</strong>
              <p className="sg-card-text">Soft shadow, no border.</p>
            </div>
            <div className="card outlined">
              <strong>Outlined</strong>
              <p className="sg-card-text">Stronger border, transparent fill.</p>
            </div>
            <div className="card ghost">
              <strong>Ghost</strong>
              <p className="sg-card-text">No border, no fill — pure padding.</p>
            </div>
          </div>
        </Preview>
        <Code>{`<div class="card raised">...</div>
<div class="card outlined">...</div>
<div class="card ghost">...</div>`}</Code>
      </Section>

      <Section title="Toned">
        <p className="sg-prose">
          Tone modifiers set <code>--bg-mix</code>, and the card derives its
          surface, border, and text color from it. The mixing rules from the
          Tonal page do the work.
        </p>
        <Preview>
          <div className="sg-card-grid">
            <div className="card info">
              <strong>Info card</strong>
              <p className="sg-card-text">
                Informational notice. Soft fill, subtle border, readable text.
              </p>
            </div>
            <div className="card success">
              <strong>Success card</strong>
              <p className="sg-card-text">
                Confirmation message. Same shape, green tonal ramp.
              </p>
            </div>
            <div className="card warning">
              <strong>Warning card</strong>
              <p className="sg-card-text">
                Caution. Yellow tonal ramp with darker text for contrast.
              </p>
            </div>
            <div className="card danger">
              <strong>Danger card</strong>
              <p className="sg-card-text">
                Error state. Red tonal ramp without screaming saturation.
              </p>
            </div>
          </div>
        </Preview>
        <Code>{`<div class="card info">An informational card</div>
<div class="card success">Action completed</div>
<div class="card danger">Something failed</div>`}</Code>
      </Section>

      <Section title="As a container">
        <p className="sg-prose">
          Cards hold other components without restyling them. Buttons, badges,
          fields, and pills all read normally inside any card variant.
        </p>
        <Preview>
          <div className="card raised">
            <div className="surface-header">
              <span>Domain monitor</span>
              <span className="badge danger">7 days</span>
            </div>
            <div className="surface-body">
              <p className="sg-card-text">
                <code>greensweepnm.com</code> expires soon. Renew now to
                avoid downtime.
              </p>
              <div className="field-group" style={{ marginTop: 12 }}>
                <label>Renewal period</label>
                <select className="field">
                  <option>1 year</option>
                  <option>2 years</option>
                  <option>5 years</option>
                </select>
              </div>
            </div>
            <div className="surface-footer">
              <button className="btn">Renew now</button>
              <button className="btn outlined">Remind me later</button>
            </div>
          </div>
        </Preview>
      </Section>

      <Section title="Source">
        <Code>{`/* cards.css */
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
   tones, so every tone works on every surface automatically. */`}</Code>
      </Section>

      <Section title="When to use each">
        <ul className="sg-list">
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
        </ul>
      </Section>
    </article>
  );
}

function Alerts() {
  return (
    <article>
      <PageHeader
        eyebrow="Components"
        title="Alerts"
        lead="Inline notification banner. Extends the surface base, adds a row layout, reads tones like everything else."
      />

      <Section title="Default">
        <Preview>
          <div className="alert" style={{ maxWidth: 480 }}>
            <div className="alert-icon">ⓘ</div>
            <div className="alert-content">
              <strong>Heads up</strong>
              <p>Something happened that you might want to know about.</p>
            </div>
          </div>
        </Preview>
        <Code>{`<div class="alert">
  <div class="alert-icon">ⓘ</div>
  <div class="alert-content">
    <strong>Heads up</strong>
    <p>Something happened that you might want to know about.</p>
  </div>
</div>`}</Code>
      </Section>

      <Section title="Tones">
        <p className="sg-prose">
          Tone modifiers paint the alert via the shared surface recipe —
          same one cards and toasts use.
        </p>
        <Preview>
          <div className="stack" style={{ maxWidth: 480 }}>
            <div className="alert info">
              <div className="alert-icon">ⓘ</div>
              <div className="alert-content">
                <strong>FYI</strong>
                <p>Your trial expires in 7 days.</p>
              </div>
            </div>
            <div className="alert success">
              <div className="alert-icon">✓</div>
              <div className="alert-content">
                <strong>Saved</strong>
                <p>Your changes have been published.</p>
              </div>
            </div>
            <div className="alert warning">
              <div className="alert-icon">⚠</div>
              <div className="alert-content">
                <strong>Heads up</strong>
                <p>This site has 3 broken images.</p>
              </div>
            </div>
            <div className="alert danger">
              <div className="alert-icon">⨯</div>
              <div className="alert-content">
                <strong>Error</strong>
                <p>Couldn't connect to the API. Check your credentials.</p>
              </div>
            </div>
          </div>
        </Preview>
        <Code>{`<div class="alert info">…</div>
<div class="alert success">…</div>
<div class="alert warning">…</div>
<div class="alert danger">…</div>`}</Code>
      </Section>

      <Section title="With actions">
        <p className="sg-prose">
          Any action triggers (button, link) go in the right side. Just
          flex children — alert is <code>flex items-start gap-3</code> at
          its core.
        </p>
        <Preview>
          <div className="alert warning" style={{ maxWidth: 520 }}>
            <div className="alert-icon">⚠</div>
            <div className="alert-content">
              <strong>Unsaved changes</strong>
              <p>You have edits that haven't been published.</p>
            </div>
            <div className="cluster" style={{ alignSelf: "center" }}>
              <button className="btn outlined text-sm">Discard</button>
              <button className="btn text-sm">Publish</button>
            </div>
          </div>
        </Preview>
      </Section>

      <Section title="Source">
        <Code>{`/* alerts.css — 18 lines */
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

/* The bg/border/radius/tones all come from surface.css */`}</Code>
      </Section>
    </article>
  );
}

function Toasts() {
  const [toasts, setToasts] = useState([]);

  const fire = (tone, label) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t, { id, tone, label }]);
    setTimeout(() => {
      setToasts((t) => t.filter((x) => x.id !== id));
    }, 3000);
  };

  return (
    <article>
      <PageHeader
        eyebrow="Components"
        title="Toasts"
        lead="Transient feedback. Extends surface, adds fixed positioning and a slide-in animation. Stack multiple via toast-stack."
      />

      <Section title="Fire one">
        <p className="sg-prose">
          Click any tone to fire a real toast (bottom-right). Auto-dismisses
          after 3 seconds.
        </p>
        <Preview>
          <div className="cluster">
            <button className="btn primary" onClick={() => fire("primary", "Brand toast")}>
              Primary
            </button>
            <button className="btn info" onClick={() => fire("info", "Heads up")}>
              Info
            </button>
            <button className="btn success" onClick={() => fire("success", "Saved!")}>
              Success
            </button>
            <button className="btn warning" onClick={() => fire("warning", "Watch out")}>
              Warning
            </button>
            <button className="btn danger" onClick={() => fire("danger", "Something broke")}>
              Danger
            </button>
          </div>
        </Preview>
        <Code>{`<div class="toast success">Saved!</div>`}</Code>
      </Section>

      <Section title="Markup">
        <p className="sg-prose">
          A toast is just a surface with a fixed position and an animation.
          Fire and forget — or wrap in <code>toast-stack</code> for
          multiple.
        </p>
        <Code>{`<!-- Single toast -->
<div class="toast success">Saved!</div>

<!-- Multiple toasts -->
<div class="toast-stack">
  <div class="toast success">Saved 3 items</div>
  <div class="toast info">Sync complete</div>
</div>`}</Code>
      </Section>

      <Section title="Source">
        <Code>{`/* toasts.css — 22 lines */
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

/* Bg/border/radius/tones all come from surface.css */`}</Code>
      </Section>

      {/* Live render of the actual toasts */}
      {toasts.length > 0 && (
        <div className="toast-stack">
          {toasts.map((t) => (
            <div key={t.id} className={`toast ${t.tone}`}>
              {t.label}
            </div>
          ))}
        </div>
      )}
    </article>
  );
}

function Popovers() {
  const [openId, setOpenId] = useState(null);
  const toggle = (id) => setOpenId(openId === id ? null : id);

  return (
    <article>
      <PageHeader
        eyebrow="Components"
        title="Popovers"
        lead="Floating UI. Extends surface, adds absolute positioning and a slide-in animation. Positioning is the consumer's job — Uno utilities make it easy."
      />

      <Section title="Default">
        <p className="sg-prose">
          Click a button to toggle its popover. The popover positions itself
          via inline style (or Uno utilities like{" "}
          <code>class="popover absolute top-12 left-0"</code>).
        </p>
        <Preview>
          <div className="cluster">
            <div style={{ position: "relative" }}>
              <button
                className="btn outlined"
                onClick={() => toggle("a")}
              >
                Open popover
              </button>
              {openId === "a" && (
                <div
                  className="popover"
                  style={{ top: "calc(100% + 8px)", left: 0, minWidth: 220 }}
                >
                  <strong style={{ display: "block", marginBottom: 4 }}>
                    Quick note
                  </strong>
                  <p style={{ margin: 0, color: "var(--ink-soft)" }}>
                    Popovers carry short, contextual information.
                  </p>
                </div>
              )}
            </div>

            <div style={{ position: "relative" }}>
              <button
                className="btn outlined info"
                onClick={() => toggle("b")}
              >
                Info popover
              </button>
              {openId === "b" && (
                <div
                  className="popover info"
                  style={{ top: "calc(100% + 8px)", left: 0, minWidth: 240 }}
                >
                  <strong style={{ display: "block", marginBottom: 4 }}>
                    Heads up
                  </strong>
                  <p style={{ margin: 0 }}>
                    Tones work the same as everywhere else.
                  </p>
                </div>
              )}
            </div>

            <div style={{ position: "relative" }}>
              <button
                className="btn outlined warning"
                onClick={() => toggle("c")}
              >
                Warning popover
              </button>
              {openId === "c" && (
                <div
                  className="popover warning"
                  style={{ top: "calc(100% + 8px)", left: 0, minWidth: 240 }}
                >
                  <strong style={{ display: "block", marginBottom: 4 }}>
                    Careful
                  </strong>
                  <p style={{ margin: 0 }}>
                    This action will affect 3 records.
                  </p>
                </div>
              )}
            </div>
          </div>
        </Preview>
        <Code>{`<div style="position: relative">
  <button class="btn outlined" onclick="show()">Open</button>
  <div class="popover" style="top: 100%; left: 0">
    <strong>Quick note</strong>
    <p>Popovers carry short, contextual info.</p>
  </div>
</div>`}</Code>
      </Section>

      <Section title="Native Popover API">
        <p className="sg-prose">
          Modern browsers support the native{" "}
          <code>[popover]</code> attribute. Free toggle behavior, light
          dismiss, top-layer rendering — all platform-provided.
        </p>
        <Code>{`<button popovertarget="menu">Open menu</button>

<div id="menu" popover class="popover">
  <strong>Quick actions</strong>
  <p>Edit, duplicate, archive…</p>
</div>`}</Code>
      </Section>

      <Section title="Source">
        <Code>{`/* popovers.css — 12 lines */
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

/* Bg/border/radius/tones all come from surface.css */`}</Code>
      </Section>
    </article>
  );
}

function Drawers() {
  const rightRef = useRef(null);
  const leftRef = useRef(null);
  const bottomRef = useRef(null);

  return (
    <article>
      <PageHeader
        eyebrow="Components"
        title="Drawers"
        lead="Off-canvas panel. Built on native <dialog> so focus trap, backdrop, and Esc-to-close are platform-provided. Slides in from any edge."
      />

      <Section title="Edges">
        <p className="sg-prose">
          Add a <code>from-*</code> modifier to control the slide direction.
        </p>
        <Preview>
          <div className="cluster">
            <button
              className="btn"
              onClick={() => rightRef.current?.showModal()}
            >
              From right
            </button>
            <button
              className="btn outlined"
              onClick={() => leftRef.current?.showModal()}
            >
              From left
            </button>
            <button
              className="btn outlined"
              onClick={() => bottomRef.current?.showModal()}
            >
              From bottom
            </button>
          </div>
        </Preview>
        <Code>{`<dialog class="drawer from-right">…</dialog>
<dialog class="drawer from-left">…</dialog>
<dialog class="drawer from-top">…</dialog>
<dialog class="drawer from-bottom">…</dialog>`}</Code>
      </Section>

      <Section title="With sub-regions">
        <p className="sg-prose">
          Drawers use the same <code>surface-header</code>/
          <code>surface-body</code>/<code>surface-footer</code> as dialogs and
          cards. One vocabulary, every block primitive.
        </p>
        <Code>{`<dialog class="drawer from-right">
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
</dialog>`}</Code>
      </Section>

      <Section title="Source">
        <Code>{`/* drawers.css — 50 lines, mostly keyframes */
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

/* + keyframes for each direction, ::backdrop, reduced-motion */`}</Code>
      </Section>

      {/* Real drawers */}
      <dialog ref={rightRef} className="drawer from-right">
        <div className="surface-header">
          <strong>From the right</strong>
          <button
            className="dialog-close"
            onClick={() => rightRef.current?.close()}
          >
            ×
          </button>
        </div>
        <div className="surface-body">
          <p>This is a drawer sliding in from the right edge.</p>
          <p>
            Built on <code>&lt;dialog&gt;</code>, so Esc closes it and
            clicking the backdrop closes it too.
          </p>
        </div>
        <div className="surface-footer">
          <button
            className="btn outlined"
            onClick={() => rightRef.current?.close()}
          >
            Close
          </button>
          <button className="btn" onClick={() => rightRef.current?.close()}>
            Done
          </button>
        </div>
      </dialog>

      <dialog ref={leftRef} className="drawer from-left">
        <div className="surface-header">
          <strong>From the left</strong>
          <button
            className="dialog-close"
            onClick={() => leftRef.current?.close()}
          >
            ×
          </button>
        </div>
        <div className="surface-body">
          <p>Same component, opposite edge.</p>
        </div>
      </dialog>

      <dialog ref={bottomRef} className="drawer from-bottom">
        <div className="surface-header">
          <strong>From the bottom</strong>
          <button
            className="dialog-close"
            onClick={() => bottomRef.current?.close()}
          >
            ×
          </button>
        </div>
        <div className="surface-body">
          <p>Bottom drawers stretch full-width.</p>
          <p>Good for mobile action sheets or quick pickers.</p>
        </div>
      </dialog>
    </article>
  );
}

function Tables() {
  return (
    <article>
      <PageHeader
        eyebrow="Components"
        title="Tables"
        lead="The .table base. Var contract for surfaces, tone modifiers on rows, density variants — same conventions as everything else."
      />

      <Section title="Default">
        <p className="sg-prose">
          Header gets the sunken surface and uppercase label treatment;
          rows inherit the table's background.
        </p>
        <Preview>
          <table className="table">
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
                <td><span className="badge success">active</span></td>
                <td>2026-08-12</td>
              </tr>
              <tr>
                <td>Clean Affinity</td>
                <td>Pro</td>
                <td><span className="badge success">active</span></td>
                <td>2026-11-03</td>
              </tr>
              <tr>
                <td>greensweepnm.com</td>
                <td>Starter</td>
                <td><span className="badge warning">trial</span></td>
                <td>2026-06-01</td>
              </tr>
            </tbody>
          </table>
        </Preview>
        <Code>{`<table class="table">
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
</table>`}</Code>
      </Section>

      <Section title="Row states">
        <p className="sg-prose">
          Tone modifiers on the <code>&lt;tr&gt;</code> — same vocabulary as
          everywhere else. Derived from <code>--bg-mix</code> so they read as
          tints, not screaming saturation.
        </p>
        <Preview>
          <table className="table">
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
              <tr className="success">
                <td>cleanaffinity.com</td>
                <td>2027-02-22</td>
                <td>Renewed</td>
              </tr>
              <tr className="warning">
                <td>greensweepnm.com</td>
                <td>2026-06-01</td>
                <td>Expiring soon</td>
              </tr>
              <tr className="danger">
                <td>oldsite.example</td>
                <td>2026-05-15</td>
                <td>Expired</td>
              </tr>
            </tbody>
          </table>
        </Preview>
        <Code>{`<tr class="success">...</tr>
<tr class="warning">...</tr>
<tr class="danger">...</tr>`}</Code>
      </Section>

      <Section title="Variants">
        <p className="sg-prose">
          <code>striped</code> zebras rows; <code>hover</code> highlights on
          mouseover; <code>compact</code> tightens padding for dense data.
          Combinable.
        </p>
        <Preview>
          <table className="table striped hover compact">
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
                <td><span className="badge success">paid</span></td>
              </tr>
              <tr>
                <td>INV-1043</td>
                <td>Sparkle &amp; Co.</td>
                <td>$890.00</td>
                <td><span className="badge warning">pending</span></td>
              </tr>
              <tr>
                <td>INV-1044</td>
                <td>Bright Maid Services</td>
                <td>$2,150.00</td>
                <td><span className="badge success">paid</span></td>
              </tr>
              <tr>
                <td>INV-1045</td>
                <td>FreshClean LLC</td>
                <td>$680.00</td>
                <td><span className="badge danger">overdue</span></td>
              </tr>
            </tbody>
          </table>
        </Preview>
        <Code>{`<table class="table striped hover compact">...</table>`}</Code>
      </Section>

      <Section title="With actions">
        <Preview>
          <table className="table hover">
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
                <td className="table-actions">
                  <button className="btn text-sm outlined">Edit</button>
                  <button className="btn text-sm danger outlined">Remove</button>
                </td>
              </tr>
              <tr>
                <td>Jordan Lee</td>
                <td>Member</td>
                <td className="table-actions">
                  <button className="btn text-sm outlined">Edit</button>
                  <button className="btn text-sm danger outlined">Remove</button>
                </td>
              </tr>
            </tbody>
          </table>
        </Preview>
      </Section>

      <Section title="Source">
        <Code>{`/* tables.css */
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

/* Variants */
.table.striped tbody tr:nth-child(odd) td { background: var(--surface-sunken); }
.table.hover   tbody tr:hover           td { background: color-mix(in srgb, var(--ring) 5%, var(--table-bg)); }
.table.compact td,
.table.compact th { padding: 6px 10px; font-size: 13px; }

/* Row tones — same color-mix recipe; tones.css sets --bg-mix */
.table tr.info td,
.table tr.success td,
.table tr.warning td,
.table tr.danger td {
  background: color-mix(in srgb, var(--bg-mix) 8%, var(--table-bg));
}`}</Code>
      </Section>
    </article>
  );
}

function Dialogs() {
  const defaultRef = useRef(null);
  const structuredRef = useRef(null);
  const dangerRef = useRef(null);

  return (
    <article>
      <PageHeader
        eyebrow="Components"
        title="Dialogs"
        lead="Built on the native <dialog> element — focus trap, escape-to-close, scrollable overlay all handled by the platform. Class only owns the surface treatment."
      />

      <Section title="Default">
        <p className="sg-prose">
          A minimal dialog. Open via <code>showModal()</code>, close via{" "}
          <code>close()</code>.
        </p>
        <Preview>
          <button
            className="btn"
            onClick={() => defaultRef.current?.showModal()}
          >
            Open dialog
          </button>
          <dialog ref={defaultRef} className="dialog">
            <div className="surface-body">
              <p>This is a simple modal dialog.</p>
              <p>
                The platform handles focus management, scroll lock, and{" "}
                <kbd>Esc</kbd> to close.
              </p>
            </div>
            <div className="surface-footer">
              <button
                className="btn outlined"
                onClick={() => defaultRef.current?.close()}
              >
                Close
              </button>
            </div>
          </dialog>
        </Preview>
        <Code>{`<dialog class="dialog" id="confirm">
  <div class="surface-body">Are you sure?</div>
  <div class="surface-footer">
    <button class="btn outlined" onclick="confirm.close()">Cancel</button>
  </div>
</dialog>

<button onclick="confirm.showModal()">Open</button>`}</Code>
      </Section>

      <Section title="With header & footer">
        <p className="sg-prose">
          Same sub-component shape as cards — <code>.surface-header</code>,{" "}
          <code>.surface-body</code>, <code>.surface-footer</code>.
        </p>
        <Preview>
          <button
            className="btn"
            onClick={() => structuredRef.current?.showModal()}
          >
            Open structured dialog
          </button>
          <dialog ref={structuredRef} className="dialog">
            <div className="surface-header">
              <span>Renew domain</span>
              <button
                className="dialog-close"
                onClick={() => structuredRef.current?.close()}
                aria-label="Close"
              >
                ×
              </button>
            </div>
            <div className="surface-body">
              <p>
                <code>greensweepnm.com</code> expires in 7 days. Pick a
                renewal period.
              </p>
              <div className="field-group" style={{ marginTop: 12 }}>
                <label>Renewal period</label>
                <select className="field">
                  <option>1 year</option>
                  <option>2 years</option>
                  <option>5 years</option>
                </select>
              </div>
            </div>
            <div className="surface-footer">
              <button
                className="btn outlined"
                onClick={() => structuredRef.current?.close()}
              >
                Cancel
              </button>
              <button
                className="btn"
                onClick={() => structuredRef.current?.close()}
              >
                Renew
              </button>
            </div>
          </dialog>
        </Preview>
      </Section>

      <Section title="Danger confirmation">
        <p className="sg-prose">
          <code>.dialog.danger</code> tints the header. Use sparingly — only
          for destructive actions.
        </p>
        <Preview>
          <button
            className="btn danger outlined"
            onClick={() => dangerRef.current?.showModal()}
          >
            Delete account
          </button>
          <dialog ref={dangerRef} className="dialog danger">
            <div className="surface-header">
              <span>Delete account?</span>
            </div>
            <div className="surface-body">
              <p>
                This will permanently delete your account and all associated
                data. This action cannot be undone.
              </p>
            </div>
            <div className="surface-footer">
              <button
                className="btn outlined"
                onClick={() => dangerRef.current?.close()}
              >
                Cancel
              </button>
              <button
                className="btn danger"
                onClick={() => dangerRef.current?.close()}
              >
                Delete account
              </button>
            </div>
          </dialog>
        </Preview>
      </Section>

      <Section title="Source">
        <Code>{`/* dialogs.css */
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
}`}</Code>
      </Section>

      <Section title="Why <dialog>">
        <ul className="sg-list">
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
        </ul>
      </Section>
    </article>
  );
}

function Inputs() {
  return (
    <article>
      <PageHeader
        eyebrow="Components"
        title="Inputs"
        lead="One .field base class drives every form control. Tone modifiers and states share the same vocabulary as buttons."
      />

      <Section title="The field base">
        <p className="sg-prose">
          Declares its own var contract: <code>--field-bg</code>,{" "}
          <code>--field-border</code>, <code>--field-color</code>,{" "}
          <code>--field-radius</code>. Applies to inputs, textareas, and
          selects with the same class.
        </p>
        <Preview>
          <input
            className="field"
            placeholder="Type something..."
            type="text"
          />
        </Preview>
        <Code>{`<input type="text" class="field" placeholder="Type something...">`}</Code>
      </Section>

      <Section title="Field group">
        <p className="sg-prose">
          Label + input paired with consistent spacing.
        </p>
        <Preview>
          <div className="field-group">
            <label>Email address</label>
            <input
              className="field"
              type="email"
              placeholder="you@example.com"
              defaultValue=""
            />
            <small className="field-hint">
              We'll never share your email.
            </small>
          </div>
        </Preview>
        <Code>{`<div class="field-group">
  <label>Email address</label>
  <input type="email" class="field" placeholder="you@example.com">
  <small class="field-hint">We'll never share your email.</small>
</div>`}</Code>
      </Section>

      <Section title="Field types">
        <Preview>
          <div className="sg-stack">
            <div className="field-group">
              <label>Text</label>
              <input className="field" type="text" defaultValue="Hello" />
            </div>
            <div className="field-group">
              <label>Select</label>
              <select className="field">
                <option>Maid.Tech</option>
                <option>Clean Affinity</option>
                <option>ksite</option>
              </select>
            </div>
            <div className="field-group">
              <label>Textarea</label>
              <textarea
                className="field"
                rows={3}
                defaultValue="A few lines of text..."
              />
            </div>
          </div>
        </Preview>
      </Section>

      <Section title="States">
        <p className="sg-prose">
          Same tone vocabulary as buttons. <code>danger</code> indicates
          validation errors. <code>disabled</code> is handled via the
          attribute.
        </p>
        <Preview>
          <div className="sg-stack">
            <div className="field-group">
              <label>Default</label>
              <input className="field" defaultValue="Normal state" />
            </div>
            <div className="field-group">
              <label>Disabled</label>
              <input
                className="field"
                disabled
                defaultValue="Disabled state"
              />
            </div>
            <div className="field-group">
              <label>Danger (validation error)</label>
              <input className="field danger" defaultValue="Invalid value" />
              <small className="field-hint danger">
                This field is required.
              </small>
            </div>
          </div>
        </Preview>
        <Code>{`<input type="text" class="field danger" value="Invalid">
<small class="field-hint danger">This field is required.</small>`}</Code>
      </Section>

      <Section title="Checkbox & radio">
        <Preview>
          <div className="sg-stack">
            <label className="field-check">
              <input type="checkbox" defaultChecked />
              <span>Send me email updates</span>
            </label>
            <label className="field-check">
              <input type="checkbox" />
              <span>Subscribe to newsletter</span>
            </label>
            <div className="sg-stack-divider" />
            <label className="field-check">
              <input type="radio" name="sg-plan" defaultChecked />
              <span>Free plan</span>
            </label>
            <label className="field-check">
              <input type="radio" name="sg-plan" />
              <span>Pro plan</span>
            </label>
          </div>
        </Preview>
      </Section>

      <Section title="Source">
        <Code>{`/* form-core.css */
.field {
  --field-bg:     var(--surface);
  --field-border: var(--rule-strong);
  --field-color:  var(--ink);

  background: var(--field-bg);
  color:      var(--field-color);
  border:     1px solid var(--field-border);
}
.field:focus {
  outline:      none;
  border-color: var(--ring);
  box-shadow:   0 0 0 var(--ring-width) color-mix(in srgb, var(--ring) 18%, transparent);
}
.field:disabled {
  background: color-mix(in srgb, var(--ink) 4%, var(--surface));
  color:      var(--ink-mute);
  cursor:     not-allowed;
}

/* State tones — any tone class sets the border via --bg-mix */
.field.info,
.field.success,
.field.warning,
.field.danger {
  --field-border: var(--bg-mix);
}`}</Code>
      </Section>
    </article>
  );
}

function TagsAndPills() {
  return (
    <article>
      <PageHeader
        eyebrow="Components"
        title="Tags & Pills"
        lead="Two small surfaces that both extend chip. Pills carry counts and short data. Badges carry categorical status."
      />

      <Section title="Pill — counts & micro-data">
        <p className="sg-prose">
          Rounded ends, small fill, short content. Built for numbers and
          single-character indicators.
        </p>
        <Preview>
          <div className="sg-row-flex">
            <span className="pill">0</span>
            <span className="pill primary">12</span>
            <span className="pill info">i</span>
            <span className="pill success">3</span>
            <span className="pill warning">!</span>
            <span className="pill danger">99+</span>
          </div>
        </Preview>
        <Code>{`<span class="pill primary">12</span>
<span class="pill danger">99+</span>
<span class="pill warning">!</span>`}</Code>
      </Section>

      <Section title="Pill inside button">
        <p className="sg-prose">
          The most common use — counts inside a button or nav item.
        </p>
        <Preview>
          <div className="sg-row-flex">
            <button className="btn">
              Notifications <span className="pill danger">3</span>
            </button>
            <button className="btn outlined">
              Inbox <span className="pill primary">12</span>
            </button>
            <button className="btn muted">
              Drafts <span className="pill">2</span>
            </button>
          </div>
        </Preview>
        <Code>{`<button class="btn">
  Notifications <span class="pill danger">3</span>
</button>`}</Code>
      </Section>

      <Section title="Badge — categorical status">
        <p className="sg-prose">
          Uppercase, tracked, square corners. Reads as a label, not a count.
        </p>
        <Preview>
          <div className="sg-row-flex">
            <span className="badge">muted</span>
            <span className="badge primary">beta</span>
            <span className="badge info">info</span>
            <span className="badge success">active</span>
            <span className="badge warning">pending</span>
            <span className="badge danger">archived</span>
          </div>
        </Preview>
        <Code>{`<span class="badge success">active</span>
<span class="badge warning">pending</span>
<span class="badge danger">archived</span>`}</Code>
      </Section>

      <Section title="Inline with text">
        <p className="sg-prose">
          Both compose into running prose. Use sparingly — one signal per
          sentence keeps the eye honest.
        </p>
        <Preview>
          <div className="sg-stack sg-prose-preview">
            <p>
              The site <span className="badge success">live</span> launched yesterday.
            </p>
            <p>
              Update available <span className="pill info">v2</span> — released last week.
            </p>
            <p>
              Domain expires in <span className="badge danger">7 days</span>
            </p>
          </div>
        </Preview>
      </Section>

      <Section title="When to use which">
        <ul className="sg-list">
          <li>
            <strong>Pill</strong> — counts and very short data ("12", "99+", "v2"). Rounded shape reads as "a value".
          </li>
          <li>
            <strong>Badge</strong> — categorical status ("active", "pending", "archived"). Square + uppercase reads as "a label".
          </li>
        </ul>
      </Section>
    </article>
  );
}

function Layouts() {
  return (
    <article>
      <PageHeader
        eyebrow="Utilities"
        title="Layouts"
        lead="Four primitive layout shortcuts. Stack, cluster, center, split. Cover most of what most apps need."
      />

      <Section title="Stack — vertical rhythm">
        <p className="sg-prose">
          <code>stack</code> = <code>flex flex-col gap-4</code>. Children flow
          down with even spacing. The default gap can be overridden inline
          with a Uno utility — <code>stack gap-2</code>, <code>stack gap-8</code>.
        </p>
        <Preview>
          <div className="stack" style={{ minWidth: 280 }}>
            <div className="card">First card</div>
            <div className="card">Second card</div>
            <div className="card">Third card</div>
          </div>
        </Preview>
        <Code>{`<div class="stack">
  <div class="card">First card</div>
  <div class="card">Second card</div>
  <div class="card">Third card</div>
</div>

<!-- Adjust the gap inline -->
<div class="stack gap-2">…</div>`}</Code>
      </Section>

      <Section title="Cluster — horizontal flow">
        <p className="sg-prose">
          <code>cluster</code> = <code>flex flex-wrap items-center gap-2</code>.
          Children line up horizontally, wrap when they run out of room, stay
          baseline-centered. Use it for filter chips, tag rows, button groups,
          form actions.
        </p>
        <Preview>
          <div className="cluster">
            <span className="badge primary">Active</span>
            <span className="badge success">Verified</span>
            <span className="badge warning">Pending</span>
            <span className="badge danger">Flagged</span>
            <span className="badge muted">Archived</span>
          </div>
        </Preview>
        <Code>{`<div class="cluster">
  <span class="badge primary">Active</span>
  <span class="badge success">Verified</span>
  <span class="badge warning">Pending</span>
  <span class="badge danger">Flagged</span>
  <span class="badge muted">Archived</span>
</div>`}</Code>
      </Section>

      <Section title="Center — perfect centering">
        <p className="sg-prose">
          <code>center</code> = <code>grid place-items-center</code>. One
          line, no flex gymnastics. The child sits dead center in both axes.
        </p>
        <Preview>
          <div
            className="center"
            style={{
              height: 140,
              border: "1px dashed var(--rule-strong)",
              borderRadius: 8,
              background: "var(--surface-sunken)",
            }}
          >
            <button className="btn">Centered</button>
          </div>
        </Preview>
        <Code>{`<div class="center h-36">
  <button class="btn">Centered</button>
</div>`}</Code>
      </Section>

      <Section title="Split — space between">
        <p className="sg-prose">
          <code>split</code> ={" "}
          <code>flex justify-between items-center gap-4</code>. Two-up rows
          where the first child sits left, the rest pushes right. Built for
          headers and toolbars.
        </p>
        <Preview>
          <div
            className="split"
            style={{
              padding: "12px 16px",
              border: "1px solid var(--rule)",
              borderRadius: 8,
              background: "var(--surface)",
              minWidth: 360,
            }}
          >
            <strong>Inbox</strong>
            <div className="cluster">
              <button className="btn outlined text-sm">Archive</button>
              <button className="btn text-sm">Compose</button>
            </div>
          </div>
        </Preview>
        <Code>{`<header class="split p-3 border rounded">
  <strong>Inbox</strong>
  <div class="cluster">
    <button class="btn outlined text-sm">Archive</button>
    <button class="btn text-sm">Compose</button>
  </div>
</header>`}</Code>
      </Section>

      <Section title="When to use each">
        <table className="table">
          <thead>
            <tr>
              <th>Use case</th>
              <th>Reach for</th>
            </tr>
          </thead>
          <tbody>
            <tr><td>Form fields, list items, cards stacked</td><td><code>stack</code></td></tr>
            <tr><td>Tags, chips, button groups, filter rows</td><td><code>cluster</code></td></tr>
            <tr><td>Page header with title + actions</td><td><code>split</code></td></tr>
            <tr><td>Modal centered on screen, empty states</td><td><code>center</code></td></tr>
            <tr><td>Grids with N columns</td><td>Uno's <code>grid grid-cols-N</code></td></tr>
            <tr><td>Anything else</td><td>Compose Uno utilities directly</td></tr>
          </tbody>
        </table>
      </Section>

      <Section title="The shortcuts">
        <Code>{`/* layout.css */
.stack   { display: flex; flex-direction: column; gap: 1rem; }
.cluster { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; }
.center  { display: grid; place-items: center; }
.split   { display: flex; justify-content: space-between;
           align-items: center; gap: 1rem; }`}</Code>
        <p className="sg-prose">
          Four shortcuts. Two flex columns, one flex row, one grid. Together
          they cover ~80% of the layout work in a typical app. For the
          remaining 20%, drop down to raw Uno utilities (<code>grid-cols-3</code>,{" "}
          <code>flex-1</code>, <code>self-start</code>).
        </p>
      </Section>
    </article>
  );
}

function Spacing() {
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

  return (
    <article>
      <PageHeader
        eyebrow="Utilities"
        title="Spacing"
        lead="One 4-pixel scale drives every padding, margin, and gap. No one-off pixel values, no per-component nudging."
      />

      <Section title="The scale">
        <p className="sg-prose">
          Every step is a multiple of 4px (<code>0.25rem</code>). Most layouts
          only ever need six or seven values.
        </p>
        <div className="sg-scale">
          {scale.map((s) => (
            <div className="sg-scale-row" key={s.token}>
              <code className="sg-scale-token">{s.token}</code>
              <div className="sg-scale-track">
                <div
                  className="sg-scale-bar"
                  style={{ width: s.px + "px" }}
                />
              </div>
              <code className="sg-scale-val">{s.value}</code>
              <code className="sg-scale-px">{s.px}px</code>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Padding">
        <p className="sg-prose">
          <code>p-N</code> for all sides, <code>px-N</code>/<code>py-N</code>{" "}
          for axes, <code>pt-N</code>/<code>pr-N</code>/<code>pb-N</code>/
          <code>pl-N</code> for individual sides.
        </p>
        <Preview>
          <div className="sg-row-flex">
            <div className="sg-pad-demo p-2">p-2</div>
            <div className="sg-pad-demo p-4">p-4</div>
            <div className="sg-pad-demo p-6">p-6</div>
            <div className="sg-pad-demo p-8">p-8</div>
          </div>
        </Preview>
        <Code>{`<div class="p-4">Padding on all sides</div>
<div class="px-6 py-2">Horizontal 6, vertical 2</div>
<div class="pt-4">Padding-top only</div>`}</Code>
      </Section>

      <Section title="Margin">
        <p className="sg-prose">
          Same shape as padding: <code>m-N</code>, <code>mx-N</code>/
          <code>my-N</code>, plus directional. Negative margins available as{" "}
          <code>-m-N</code>.
        </p>
        <Code>{`<div class="m-4">Margin on all sides</div>
<div class="mx-auto">Horizontal auto (centered block)</div>
<div class="-mt-2">Negative margin-top</div>`}</Code>
      </Section>

      <Section title="Gap">
        <p className="sg-prose">
          Always prefer <code>gap</code> over margins between siblings.
          Cleaner cascade, no margin-collapse surprises, no last-child
          gymnastics.
        </p>
        <Preview>
          <div className="sg-stack" style={{ gap: 8 }}>
            <div className="sg-gap-demo">
              <span className="badge">gap-2 (8px)</span>
              <span className="badge">item</span>
              <span className="badge">item</span>
            </div>
            <div className="sg-gap-demo" style={{ gap: 16 }}>
              <span className="badge">gap-4 (16px)</span>
              <span className="badge">item</span>
              <span className="badge">item</span>
            </div>
            <div className="sg-gap-demo" style={{ gap: 24 }}>
              <span className="badge">gap-6 (24px)</span>
              <span className="badge">item</span>
              <span className="badge">item</span>
            </div>
          </div>
        </Preview>
        <Code>{`<div class="flex gap-2">...</div>
<div class="grid gap-4">...</div>`}</Code>
      </Section>

      <Section title="Stack & cluster">
        <p className="sg-prose">
          Two layout primitives that capture 90% of real layouts. Both
          delegate spacing to <code>gap</code>.
        </p>
        <Code>{`/* spacing.css */
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
}`}</Code>
        <p className="sg-prose">
          <code>stack</code> for vertical rhythm, <code>cluster</code> for
          horizontal grouping. Override the gap inline when needed:{" "}
          <code>{`<div class="stack gap-6">`}</code>.
        </p>
      </Section>

      <Section title="Rule of thumb">
        <ul className="sg-list">
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
            have what you need, add a new step to the scale, not a one-off{" "}
            <code>style="padding: 13px"</code>.
          </li>
        </ul>
      </Section>
    </article>
  );
}

function Typography() {
  const typeScale = [
    { token: "text-xs", size: 12, usage: "Fine print, captions" },
    { token: "text-sm", size: 14, usage: "Body text (compact)" },
    { token: "text-base", size: 16, usage: "Body text (default)" },
    { token: "text-lg", size: 18, usage: "Emphasized body, lead" },
    { token: "text-xl", size: 20, usage: "Subheadings" },
    { token: "text-2xl", size: 24, usage: "Section headings" },
    { token: "text-3xl", size: 30, usage: "Page headings" },
    { token: "text-4xl", size: 36, usage: "Display" },
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

  return (
    <article>
      <PageHeader
        eyebrow="Utilities"
        title="Typography"
        lead="Type scale, weights, line-height, tracking, color. Everything else inherits from these."
      />

      <Section title="Type scale">
        <p className="sg-prose">
          Geometric scale. Step up for emphasis, step down for de-emphasis —
          never inline a custom pixel value.
        </p>
        <div className="sg-typescale">
          {typeScale.map((t) => (
            <div className="sg-typescale-row" key={t.token}>
              <code className="sg-typescale-token">{t.token}</code>
              <div
                className="sg-typescale-sample"
                style={{ fontSize: t.size + "px" }}
              >
                The quick brown fox
              </div>
              <code className="sg-typescale-meta">
                {t.size}px · {t.usage}
              </code>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Font weight">
        <p className="sg-prose">
          Four weights cover everything. Heavier than bold reads as visual
          noise; lighter than regular fails on low-contrast displays.
        </p>
        <div className="sg-weights">
          {weights.map((w) => (
            <div className="sg-weight-row" key={w.token}>
              <code className="sg-weight-token">{w.token}</code>
              <div
                className="sg-weight-sample"
                style={{ fontWeight: w.value }}
              >
                {w.label} — {w.value}
              </div>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Text color">
        <p className="sg-prose">
          Semantic tokens, never raw hex. The same tone vocabulary as buttons
          and badges — set once on <code>:root</code>, used everywhere.
        </p>
        <div className="sg-color-grid">
          {colors.map((c) => (
            <div className="sg-color-row" key={c.token}>
              <code className="sg-color-token">{c.token}</code>
              <span
                className="sg-color-sample"
                style={{ color: c.value }}
              >
                The quick brown fox
              </span>
              <code className="sg-color-note">{c.note}</code>
            </div>
          ))}
        </div>
        <Code>{`/* typography.css */
.text-body    { color: var(--ink); }
.text-muted   { color: var(--ink-mute); }
.text-primary { color: var(--color-primary); }
.text-info    { color: var(--color-info); }
.text-success { color: var(--color-success); }
.text-warning { color: var(--color-warning); }
.text-danger  { color: var(--color-danger); }`}</Code>
      </Section>

      <Section title="Line height & tracking">
        <p className="sg-prose">
          Four leading steps and three tracking steps. Use them sparingly —
          most text is fine at default.
        </p>
        <Code>{`/* leading */
leading-tight   /* 1.2  */
leading-snug    /* 1.4  */
leading-normal  /* 1.6  */
leading-loose   /* 1.8  */

/* tracking */
tracking-tight  /* -0.02em — display headings */
tracking-normal /* 0       — default */
tracking-wide   /* 0.05em  — uppercase labels, badges */`}</Code>
      </Section>

      <Section title="Alignment">
        <Code>{`<p class="text-left">...</p>
<p class="text-center">...</p>
<p class="text-right">...</p>`}</Code>
      </Section>

      <Section title="Rule of thumb">
        <ul className="sg-list">
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
        </ul>
      </Section>
    </article>
  );
}

function CheatSheet() {
  const BASES = [
    {
      name: "chip",
      shortcut: "inline-flex items-center justify-center gap-1.5 whitespace-nowrap",
      preview: <span className="chip">chip</span>,
    },
    {
      name: "pill",
      shortcut: "chip rounded-full text-xs px-2 py-0.5",
      preview: <span className="pill primary">pill</span>,
    },
    {
      name: "badge",
      shortcut: "chip text-xs uppercase px-2 py-0.5 rounded",
      preview: <span className="badge success">badge</span>,
    },
    {
      name: "btn",
      shortcut: "chip rounded text-sm px-3.5 py-1.5 shadow-sm",
      preview: <button className="btn">btn</button>,
    },
    {
      name: "surface",
      shortcut: "block rounded-lg (visual base for cards, alerts, toasts, dialogs)",
      preview: <span className="sg-cheat-mini-card">surface</span>,
    },
    {
      name: "card",
      shortcut: "surface p-5",
      preview: <span className="sg-cheat-mini-card">card</span>,
    },
    {
      name: "alert",
      shortcut: "surface flex items-start gap-3 px-4 py-3",
      preview: <span className="sg-cheat-mini-card">alert</span>,
    },
    {
      name: "toast",
      shortcut: "surface fixed bottom-4 right-4 px-4 py-3 shadow-lg",
      preview: <span className="sg-cheat-mini-card">toast</span>,
    },
    {
      name: "popover",
      shortcut: "surface absolute px-3 py-2 text-sm shadow-md",
      preview: <span className="sg-cheat-mini-card">popover</span>,
    },
    {
      name: "drawer",
      shortcut: "surface fixed top-0 bottom-0 right-0 w-80 h-screen p-0",
      preview: <span className="sg-cheat-mini-dialog">drawer</span>,
    },
    {
      name: "dialog",
      shortcut: "surface p-0 (native <dialog>)",
      preview: <span className="sg-cheat-mini-dialog">dialog</span>,
    },
    {
      name: "field",
      shortcut: "block w-full px-3 py-2 text-sm rounded-md",
      preview: <span className="sg-cheat-mini-field">field</span>,
    },
    {
      name: "table",
      shortcut: "w-full border-collapse",
      preview: <span className="sg-cheat-mini-table">table</span>,
    },
  ];

  return (
    <article>
      <PageHeader
        eyebrow="Reference"
        title="Cheat sheet"
        lead="Every base, tone, variant, and size on one page. Grep-able, bookmark-able."
      />

      <Section title="Bases">
        <div className="sg-cheat-bases">
          {BASES.map((b) => (
            <div className="sg-cheat-base" key={b.name}>
              <div className="sg-cheat-base-preview">{b.preview}</div>
              <div className="sg-cheat-base-meta">
                <code className="sg-cheat-name">{b.name}</code>
                <code className="sg-cheat-shortcut">{b.shortcut}</code>
              </div>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Tones">
        <p className="sg-prose">
          Set the var contract. Composable with any base.
        </p>
        <div className="sg-cheat-tones">
          {SEMANTIC_COLORS.map(([token, value]) => {
            const name = token.replace("--color-", "");
            return (
              <div className="sg-cheat-tone" key={token}>
                <span
                  className="sg-cheat-swatch"
                  style={{ background: value }}
                />
                <code className="sg-cheat-name">.{name}</code>
                <code className="sg-cheat-token">{token}</code>
                <code className="sg-cheat-val">{value}</code>
              </div>
            );
          })}
        </div>
      </Section>

      <Section title="Button matrix">
        <p className="sg-prose">
          Every tone × every variant. The system holds because tones only set
          vars and variants only read them.
        </p>
        <div className="sg-cheat-matrix">
          <div className="sg-matrix-head">
            <div></div>
            <div>filled</div>
            <div>outlined</div>
          </div>
          <div className="sg-matrix-row">
            <div className="sg-matrix-label">
              <code>btn</code>
            </div>
            <div>
              <button className="btn">Button</button>
            </div>
            <div>
              <button className="btn outlined">Button</button>
            </div>
          </div>
          {TONES.map(([cls, label]) => (
            <div className="sg-matrix-row" key={cls}>
              <div className="sg-matrix-label">
                <code>{cls}</code>
              </div>
              <div>
                <button className={`btn ${cls}`}>{label}</button>
              </div>
              <div>
                <button className={`btn ${cls} outlined`}>{label}</button>
              </div>
            </div>
          ))}
          <div className="sg-matrix-row">
            <div className="sg-matrix-label">
              <code>link</code>
            </div>
            <div>
              <button className="btn link">Link button</button>
            </div>
            <div>—</div>
          </div>
        </div>
      </Section>

      <Section title="Table matrix">
        <p className="sg-prose">
          Variants stack — <code>striped hover compact</code> all on one
          table. Tone modifiers go on the <code>&lt;tr&gt;</code>.
        </p>
        <table className="table striped hover compact">
          <thead>
            <tr>
              <th>Variant / state</th>
              <th>Class</th>
            </tr>
          </thead>
          <tbody>
            <tr><td>Default</td><td><code>table</code></td></tr>
            <tr><td>Striped</td><td><code>table striped</code></td></tr>
            <tr><td>Hover highlight</td><td><code>table hover</code></td></tr>
            <tr><td>Compact density</td><td><code>table compact</code></td></tr>
            <tr className="info"><td>Info row</td><td><code>tr.info</code></td></tr>
            <tr className="success"><td>Success row</td><td><code>tr.success</code></td></tr>
            <tr className="warning"><td>Warning row</td><td><code>tr.warning</code></td></tr>
            <tr className="danger"><td>Danger row</td><td><code>tr.danger</code></td></tr>
          </tbody>
        </table>
      </Section>

      <Section title="Dialog">
        <p className="sg-prose">
          Native <code>&lt;dialog&gt;</code>. Open with <code>showModal()</code>,
          close with <code>close()</code>. Sub-components mirror cards.
        </p>
        <div className="sg-cheat-card-row">
          <div className="card sg-cheat-card">
            <strong>.dialog</strong>
            <p className="sg-card-text">native modal</p>
          </div>
          <div className="card sg-cheat-card">
            <strong>.surface-header</strong>
            <p className="sg-card-text">title + close</p>
          </div>
          <div className="card sg-cheat-card">
            <strong>.surface-body</strong>
            <p className="sg-card-text">content</p>
          </div>
          <div className="card sg-cheat-card">
            <strong>.surface-footer</strong>
            <p className="sg-card-text">actions</p>
          </div>
        </div>
        <p className="sg-prose">
          Tones tint the header. Same vocabulary —{" "}
          <code>.dialog.danger</code>, <code>.dialog.success</code>, etc.
        </p>
      </Section>

      <Section title="Sizes">
        <p className="sg-prose">
          Scale rides the type scale. <code>em</code> padding tracks
          <code> font-size</code>.
        </p>
        <div className="sg-cheat-sizes">
          {[
            ["text-sm", "Small"],
            ["text-base", "Base"],
            ["text-lg", "Large"],
            ["text-xl", "XL"],
            ["text-2xl", "2XL"],
          ].map(([cls, label]) => (
            <button key={cls} className={`btn ${cls}`}>
              {label}
            </button>
          ))}
        </div>
      </Section>

      <Section title="Card matrix">
        <p className="sg-prose">
          Variants flip the surface treatment; tones derive bg/border/text
          from <code>--bg-mix</code>.
        </p>
        <div className="sg-cheat-card-row">
          <div className="card sg-cheat-card">
            <strong>default</strong>
            <p className="sg-card-text">border + fill</p>
          </div>
          <div className="card raised sg-cheat-card">
            <strong>raised</strong>
            <p className="sg-card-text">shadow, no border</p>
          </div>
          <div className="card outlined sg-cheat-card">
            <strong>outlined</strong>
            <p className="sg-card-text">stronger border</p>
          </div>
          <div className="card ghost sg-cheat-card">
            <strong>ghost</strong>
            <p className="sg-card-text">no surface</p>
          </div>
        </div>
        <div className="sg-cheat-card-row">
          <div className="card info sg-cheat-card">
            <strong>info</strong>
            <p className="sg-card-text">informational</p>
          </div>
          <div className="card success sg-cheat-card">
            <strong>success</strong>
            <p className="sg-card-text">confirmation</p>
          </div>
          <div className="card warning sg-cheat-card">
            <strong>warning</strong>
            <p className="sg-card-text">caution</p>
          </div>
          <div className="card danger sg-cheat-card">
            <strong>danger</strong>
            <p className="sg-card-text">error</p>
          </div>
        </div>
      </Section>

      <Section title="Field states">
        <p className="sg-prose">
          Same tone vocabulary as buttons. Disabled via attribute.
        </p>
        <div className="sg-stack">
          <div className="field-group">
            <label>Default</label>
            <input className="field" defaultValue="Normal" />
          </div>
          <div className="field-group">
            <label>Disabled</label>
            <input className="field" disabled defaultValue="Disabled" />
          </div>
          <div className="field-group">
            <label>Danger</label>
            <input className="field danger" defaultValue="Invalid" />
            <small className="field-hint danger">Required field</small>
          </div>
        </div>
      </Section>

      <Section title="Tonal scale">
        <p className="sg-prose">
          Any shade derives from <code>--bg-mix</code> with{" "}
          <code>color-mix()</code>. (The old <code>.lighten-N</code> /{" "}
          <code>.darken-N</code> classes were removed in v0.6 — they wrote
          variables nothing read.)
        </p>
        <div
          className="sg-cheat-tonal-strip"
          style={{
            "--bg-mix": "var(--color-primary)",
            "--color": "var(--ink)",
          }}
        >
          <div className="tonal" style={{ background: "color-mix(in srgb, var(--bg-mix) 80%, white)", color: "var(--ink)" }}>80</div>
          <div className="tonal" style={{ background: "color-mix(in srgb, var(--bg-mix) 60%, white)", color: "var(--ink)" }}>60</div>
          <div className="tonal" style={{ background: "color-mix(in srgb, var(--bg-mix) 40%, white)", color: "var(--ink)" }}>40</div>
          <div className="tonal" style={{ background: "color-mix(in srgb, var(--bg-mix) 20%, white)", color: "var(--ink)" }}>20</div>
          <div className="tonal sg-tonal-raw">raw</div>
          <div className="tonal" style={{ background: "color-mix(in srgb, var(--bg-mix) 20%, black)", color: "white" }}>−20</div>
          <div className="tonal" style={{ background: "color-mix(in srgb, var(--bg-mix) 40%, black)", color: "white" }}>−40</div>
          <div className="tonal" style={{ background: "color-mix(in srgb, var(--bg-mix) 60%, black)", color: "white" }}>−60</div>
          <div className="tonal" style={{ background: "color-mix(in srgb, var(--bg-mix) 80%, black)", color: "white" }}>−80</div>
        </div>
      </Section>

      <Section title="Themes">
        <p className="sg-prose">
          Each theme is a class that re-binds the global tokens. Wrap any
          subtree.
        </p>
        <div className="sg-cheat-themes">
          {Object.entries(THEMES).map(([key, t]) => (
            <div className="sg-cheat-theme" key={key}>
              <span
                className="sg-cheat-theme-swatch"
                style={{ background: t.tokens["--color-primary"] }}
              />
              <code className="sg-cheat-name">.theme-{key}</code>
              <span className="sg-cheat-theme-desc">{t.description}</span>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Status indicators">
        <p className="sg-prose">
          Same tone vocabulary, smaller surfaces.
        </p>
        <div className="sg-cheat-row sg-cheat-row-inline">
          <span className="badge">muted</span>
          <span className="badge primary">primary</span>
          <span className="badge info">info</span>
          <span className="badge success">success</span>
          <span className="badge warning">warning</span>
          <span className="badge danger">danger</span>
        </div>
        <div className="sg-cheat-row sg-cheat-row-inline">
          <span className="pill">0</span>
          <span className="pill primary">12</span>
          <span className="pill info">i</span>
          <span className="pill success">3</span>
          <span className="pill warning">!</span>
          <span className="pill danger">99+</span>
        </div>
      </Section>

      <Section title="CSS variables">
        <div className="sg-cheat-vars">
          <div className="sg-cheat-var-group">
            <div className="sg-cheat-var-title">Global tokens</div>
            <code className="sg-cheat-var">--color-primary</code>
            <code className="sg-cheat-var">--color-secondary</code>
            <code className="sg-cheat-var">--color-muted</code>
            <code className="sg-cheat-var">--color-info</code>
            <code className="sg-cheat-var">--color-success</code>
            <code className="sg-cheat-var">--color-warning</code>
            <code className="sg-cheat-var">--color-danger</code>
          </div>
          <div className="sg-cheat-var-group">
            <div className="sg-cheat-var-title">Surfaces &amp; ink</div>
            <code className="sg-cheat-var">--surface</code>
            <code className="sg-cheat-var">--surface-raised</code>
            <code className="sg-cheat-var">--surface-sunken</code>
            <code className="sg-cheat-var">--ink</code>
            <code className="sg-cheat-var">--ink-soft</code>
            <code className="sg-cheat-var">--ink-mute</code>
            <code className="sg-cheat-var">--rule</code>
            <code className="sg-cheat-var">--rule-strong</code>
          </div>
          <div className="sg-cheat-var-group">
            <div className="sg-cheat-var-title">Focus &amp; shadows</div>
            <code className="sg-cheat-var">--ring</code>
            <code className="sg-cheat-var">--ring-width</code>
            <code className="sg-cheat-var">--shadow-sm</code>
            <code className="sg-cheat-var">--shadow-md</code>
            <code className="sg-cheat-var">--shadow-lg</code>
          </div>
          <div className="sg-cheat-var-group">
            <div className="sg-cheat-var-title">btn contract</div>
            <code className="sg-cheat-var">--btn-radius</code>
            <code className="sg-cheat-var">--btn-font-weight</code>
            <code className="sg-cheat-var">--btn-text-transform</code>
            <code className="sg-cheat-var">--btn-letter-spacing</code>
          </div>
          <div className="sg-cheat-var-group">
            <div className="sg-cheat-var-title">pill / badge</div>
            <code className="sg-cheat-var">--pill-font-weight</code>
            <code className="sg-cheat-var">--pill-text-transform</code>
            <code className="sg-cheat-var">--pill-letter-spacing</code>
            <code className="sg-cheat-var">--badge-font-weight</code>
            <code className="sg-cheat-var">--badge-text-transform</code>
            <code className="sg-cheat-var">--badge-letter-spacing</code>
          </div>
          <div className="sg-cheat-var-group">
            <div className="sg-cheat-var-title">surface contract</div>
            <code className="sg-cheat-var">--surface-bg</code>
            <code className="sg-cheat-var">--surface-color</code>
            <code className="sg-cheat-var">--surface-border</code>
            <code className="sg-cheat-var">--card-radius</code>
          </div>
          <div className="sg-cheat-var-group">
            <div className="sg-cheat-var-title">field contract</div>
            <code className="sg-cheat-var">--field-bg</code>
            <code className="sg-cheat-var">--field-color</code>
            <code className="sg-cheat-var">--field-border</code>
            <code className="sg-cheat-var">--field-radius</code>
          </div>
          <div className="sg-cheat-var-group">
            <div className="sg-cheat-var-title">table contract</div>
            <code className="sg-cheat-var">--table-bg</code>
            <code className="sg-cheat-var">--table-border</code>
            <code className="sg-cheat-var">--table-head-bg</code>
          </div>
          <div className="sg-cheat-var-group">
            <div className="sg-cheat-var-title">dialog contract</div>
            <code className="sg-cheat-var">--dialog-bg</code>
            <code className="sg-cheat-var">--dialog-border</code>
          </div>
          <div className="sg-cheat-var-group">
            <div className="sg-cheat-var-title">typography</div>
            <code className="sg-cheat-var">--font-primary</code>
            <code className="sg-cheat-var">--font-mono</code>
          </div>
          <div className="sg-cheat-var-group">
            <div className="sg-cheat-var-title">tones (set by .primary, .info, …)</div>
            <code className="sg-cheat-var">--bg-mix</code>
            <code className="sg-cheat-var">--on-bg-mix</code>
          </div>
          <div className="sg-cheat-var-group">
            <div className="sg-cheat-var-title">tonal mixing (lighten/darken)</div>
            <code className="sg-cheat-var">--bg-mix (input)</code>
            <code className="sg-cheat-var">--bg (derived)</code>
            <code className="sg-cheat-var">--color (derived)</code>
          </div>
        </div>
      </Section>

      <Section title="Common patterns">
        <Code>{`<!-- Buttons -->
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
</body>`}</Code>
      </Section>
    </article>
  );
}

/* ============================================================================
 * Half 1 — Structure
 * ==========================================================================*/

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
    "Outline the document with <h1>–<h6>; set visual size with a class. An <h4> that needs to look big gets class=\"h2\", it does not become an <h2>.",
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

function Principles() {
  return (
    <>
      <PageHeader
        eyebrow="Half 1 — Structure"
        title="Principles"
        lead="Six rules that decide what the HTML actually is. They resolve most element-choice arguments before they start."
      />
      <Section title="The six">
        <div className="sg-principles">
          {PRINCIPLES.map(([title, body], i) => (
            <article key={title} className="card sg-principle">
              <div className="sg-principle-num">{i + 1}</div>
              <div>
                <strong className="sg-principle-title">{title}</strong>
                <p className="sg-principle-body">{body}</p>
              </div>
            </article>
          ))}
        </div>
      </Section>

      <Section title="Principle 2 in practice">
        <p className="sg-prose">
          This is the one that comes up daily. A Pane is a labelled subdivision of
          a Screen, so it is a <code>&lt;section&gt;</code>. Anything discrete
          inside it — a card, a feed entry, a subsection you could lift out whole —
          is an <code>&lt;article&gt;</code>.
        </p>
        <Code>{`<section aria-labelledby="billing-h">
  <h2 id="billing-h">Billing</h2>

  <article class="card">        <!-- self-contained unit -->
    <h3>Current plan</h3>
  </article>

  <article class="card">
    <h3>Payment method</h3>
  </article>
</section>`}</Code>
        <p className="sg-prose">
          The <strong>article-vs-div test</strong>: could you lift this out of the
          page and have it still make sense? Then it is an{" "}
          <code>&lt;article&gt;</code>. If it only exists to group things visually,
          it is a <code>&lt;div&gt;</code>.
        </p>
      </Section>
    </>
  );
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
      ["View", "<article role=\"tabpanel\">", "One switchable view inside a Pane"],
    ],
  ],
  [
    "Region",
    "Grouping inside a Screen. No identity of its own.",
    [
      ["Section", "<section> / <article>", "<article> when nested inside a Section (Principle 2)"],
      ["Group", "<div>", "A visual cluster with no semantic identity"],
      ["Bar", "<div>", "A horizontal strip of controls"],
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
    ],
  ],
  [
    "Overlay",
    "Things that float above the Screen.",
    [
      ["Dialog", "<dialog>", "A modal, via showModal()"],
      ["Drawer", "<dialog>", "An off-canvas panel, also via showModal()"],
      ["Popover", "<article>", "An anchored floating unit"],
      ["Tooltip", "<div role=\"tooltip\">", "An attachment, not a unit — stays a <div>"],
      ["Toast", "<article>", "A transient notification"],
    ],
  ],
];

function Vocabulary() {
  const total = VOCAB.reduce((n, [, , rows]) => n + rows.length, 0);
  return (
    <>
      <PageHeader
        eyebrow="Half 1 — Structure"
        title="Vocabulary"
        lead={`${total} terms in six tiers. Each term fixes one answer: which element, what ARIA, how it nests. Naming a thing is how the argument ends.`}
      />

      <Section title="Why a vocabulary at all">
        <p className="sg-prose">
          Half of this system is deciding what the HTML <em>is</em>. If "card" can
          mean a <code>&lt;div&gt;</code> on Monday and an{" "}
          <code>&lt;article&gt;</code> on Thursday, nothing downstream can rely on
          it — not the CSS, not the screen reader, not the next person. The
          vocabulary is the half of the system that has no stylesheet.
        </p>
        <div className="alert info">
          <div className="alert-icon" aria-hidden="true">
            &#9432;
          </div>
          <div className="alert-content">
            <strong>Terms marked &lt;article&gt; are liftable.</strong>
            <p>
              That is the diagnostic. A term whose element is{" "}
              <code>&lt;article&gt;</code> is a self-contained unit you could move
              elsewhere intact. A <code>&lt;div&gt;</code> is infrastructure.
            </p>
          </div>
        </div>
      </Section>

      {VOCAB.map(([tier, blurb, rows]) => (
        <Section key={tier} title={tier}>
          <p className="sg-prose">{blurb}</p>
          <table className="table striped">
            <thead>
              <tr>
                <th style={{ width: "18%" }}>Term</th>
                <th style={{ width: "32%" }}>Element</th>
                <th>Meaning</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(([term, el, meaning]) => (
                <tr key={term}>
                  <td>
                    <strong>{term}</strong>
                  </td>
                  <td>
                    <code>{el}</code>
                  </td>
                  <td>{meaning}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      ))}

      <Section title="Not yet shipped as CSS">
        <p className="sg-prose">
          The Frame and Page tiers are contract-only today — Shell, Topbar,
          Sidebar, Screen, Pane and View have no classes yet, and neither do Tile
          or Tooltip. They are still binding on markup; they just have no styling
          to go with it.
        </p>
      </Section>
    </>
  );
}

/* ============================================================================
 * Half 2 — the class taxonomy
 * ==========================================================================*/

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

function Taxonomy() {
  return (
    <>
      <PageHeader
        eyebrow="Half 2 — Style"
        title="Kinds of class"
        lead="Utility-first, one level up. Three kinds of class — and only two of them compose freely."
      />

      <Section title="One level above Tailwind">
        <p className="sg-prose">
          Tailwind and UnoCSS utilities are <strong>one CSS property each</strong>.
          FrontierJS utilities are <strong>one UI concept each</strong>. Same
          composition model — chain single-purpose classes, no cascade fights, no
          per-page stylesheets — but the vocabulary sits at the element tier.
        </p>
        <Code>{`Tailwind / Uno   class="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded
                        border border-red-600 text-red-600 bg-white"

FrontierJS       class="btn outlined danger"`}</Code>
        <div className="alert warning">
          <div className="alert-icon" aria-hidden="true">
            !
          </div>
          <div className="alert-content">
            <strong>This is not a component framework.</strong>
            <p>
              In Bulma or Bootstrap, <code>is-primary</code> belongs to{" "}
              <code>.button</code> and means nothing anywhere else. Here{" "}
              <code>.danger</code> is free-standing — it works on a card, a{" "}
              <code>&lt;tr&gt;</code>, a field, a button, a link, a feed dot, and
              means the same thing on each. That property is the whole point.
            </p>
          </div>
        </div>
      </Section>

      <Section title="The three kinds">
        <table className="table">
          <thead>
            <tr>
              <th style={{ width: "14%" }}>Kind</th>
              <th style={{ width: "16%" }}>Composes</th>
              <th>What it is</th>
            </tr>
          </thead>
          <tbody>
            {KINDS.map(([kind, composes, what, examples]) => (
              <tr key={kind}>
                <td>
                  <strong>{kind}</strong>
                </td>
                <td>{composes}</td>
                <td>
                  {what}
                  <div className="sg-kind-examples">
                    <code>{examples}</code>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="sg-prose">
          Element and Anatomy are two ends of one relationship: several Element
          classes carry an <strong>anatomy contract</strong>. <code>.alert</code>{" "}
          expects an icon and a content slot, <code>.feed</code> expects items with
          dots, <code>.disclosure</code> expects a summary and a body.{" "}
          <strong>Chaining is for Treatments; Anatomy nests.</strong>
        </p>
      </Section>

      <Section title="The fourth group, said out loud">
        <p className="sg-prose">
          Some classes read like Treatments and are not. <code>.icon</code> only
          works on <code>.btn</code>, <code>.removable</code> only on{" "}
          <code>.pill</code>, <code>.striped</code> and <code>.compact</code> only
          on <code>.table</code>, <code>.divided</code> and <code>.hover</code>{" "}
          only on <code>.rows</code>, <code>.menu</code> only on{" "}
          <code>.items</code>.
        </p>
        <p className="sg-prose">
          They are legitimate, but they are component modifiers living in a utility
          system. A short generic name promises free composition they do not have —
          which is exactly the naming problem still open in the system.
        </p>
      </Section>

      <Section title="Why this matters more than it sounds">
        <p className="sg-prose">
          Until v0.6, <code>.muted</code> on a card silently did nothing. Each
          component enumerated the tones it accepted, and they all picked different
          subsets — five on surfaces, four on fields, four on tables. That is
          component thinking, and it made the utility claim false. The tone recipe
          now names no tones at all, so every Treatment works everywhere by
          construction.
        </p>
      </Section>
    </>
  );
}

/* ============================================================================
 * Foundation — cascade layers
 * ==========================================================================*/

const LAYERS = [
  ["tokens", ":root variable defaults, border-box, reduced-motion guard"],
  ["themes", ".theme-* overrides of those tokens"],
  ["tones", "the tone vocabulary — one variable per tone"],
  ["base", "the two lineage bases: chip (inline) and surface (block)"],
  ["layout", "composition helpers: stack, cluster, center, split"],
  ["components", "btn, pill, badge, card, field, table, dialog …"],
  ["patterns", "the Block tier: bar, list, feed, disclosure"],
];

function Layers() {
  return (
    <>
      <PageHeader
        eyebrow="Foundation"
        title="Cascade layers"
        lead="Layer order beats specificity. That turns 'don't reshuffle the imports' from a convention into a contract."
      />

      <Section title="The order">
        <Code>{`@layer tokens, themes, tones, base, layout, components, patterns;

@import './tokens.css' layer(tokens);
@import './tones.css'  layer(tones);
@import './chip.css'   layer(base);
...`}</Code>
        <table className="table striped compact">
          <thead>
            <tr>
              <th style={{ width: "18%" }}>Layer</th>
              <th>Holds</th>
            </tr>
          </thead>
          <tbody>
            {LAYERS.map(([name, holds]) => (
              <tr key={name}>
                <td>
                  <code>{name}</code>
                </td>
                <td>{holds}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title="What this buys you">
        <div className="stack">
          <article className="card">
            <strong>Your CSS always wins.</strong>
            <p className="sg-prose">
              Unlayered CSS beats every layer. Anything you write in your own app
              overrides this package by default — no <code>!important</code>, no
              specificity war, no <code>:not(:not(.x))</code> tricks.
            </p>
            <Code>{`/* your app — plain, unlayered, wins */
td { background: var(--zebra); }`}</Code>
          </article>
          <article className="card">
            <strong>Specificity still works inside a layer.</strong>
            <p className="sg-prose">
              The <code>:where()</code> bases in chip.css and surface.css sit at
              zero specificity, so composites override them normally. Layers settle
              cross-file conflicts; specificity settles in-file ones.
            </p>
          </article>
          <article className="card">
            <strong>
              <code>layout</code> sits before <code>components</code> on purpose.
            </strong>
            <p className="sg-prose">
              <code>.center</code> sets <code>display: grid</code> and{" "}
              <code>.bar</code> sets <code>display: flex</code>. Both are single
              class selectors, so specificity cannot separate them — the layer order
              does, and <code>.bar</code> wins.
            </p>
          </article>
        </div>
      </Section>
    </>
  );
}

/* ============================================================================
 * Components — Icons
 * ==========================================================================*/

function Icons() {
  return (
    <>
      <PageHeader
        eyebrow="Components"
        title="Icons"
        lead="The package sizes icons. It does not ship them."
      />

      <Section title="Who supplies the glyphs">
        <div className="alert info">
          <div className="alert-icon" aria-hidden="true">
            &#9432;
          </div>
          <div className="alert-content">
            <strong>Supplying icons is the consumer's job as of v0.6.</strong>
            <p>
              The package dropped its UnoCSS dependency, so it no longer ships the
              heroicons preset. It only <em>sizes</em> what it finds: a child{" "}
              <code>&lt;svg&gt;</code> or any class starting{" "}
              <code>i-heroicons</code> inside <code>.btn.icon</code> gets{" "}
              <code>1.15em</code>. Use Uno's preset-icons, Iconify, or inline SVG.
            </p>
          </div>
        </div>
      </Section>

      <Section title="Icon-only buttons">
        <p className="sg-prose">
          <code>.btn.icon</code> makes the button square via{" "}
          <code>aspect-ratio</code> with equal padding, so it scales with
          font-size. An icon-only button <strong>must</strong> carry an{" "}
          <code>aria-label</code> — there is no text for a screen reader to read.
        </p>
        <Preview>
          <div className="cluster">
            <button className="btn icon" aria-label="Add item">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 5v14M5 12h14" strokeLinecap="round" />
              </svg>
            </button>
            <button className="btn icon danger" aria-label="Delete item">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
              </svg>
            </button>
            <button className="btn icon outlined" aria-label="Settings">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="3" />
                <path d="M12 2v3M12 19v3M2 12h3M19 12h3" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        </Preview>
        <Code>{`<button class="btn icon" aria-label="Add item">
  <span class="i-heroicons:plus" aria-hidden="true"></span>
</button>`}</Code>
      </Section>

      <Section title="Decorative icons are hidden">
        <p className="sg-prose">
          An icon next to a text label adds nothing for a screen reader, so it gets{" "}
          <code>aria-hidden="true"</code>. The label already says what the button
          does.
        </p>
        <Preview>
          <div className="cluster">
            <button className="btn success">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" style={{ width: "1.1em", height: "1.1em" }}>
                <path d="M20 6L9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Approve
            </button>
            <button className="btn outlined">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" style={{ width: "1.1em", height: "1.1em" }}>
                <path d="M21 12a9 9 0 11-6.2-8.6" strokeLinecap="round" />
              </svg>
              Retry
            </button>
          </div>
        </Preview>
        <Code>{`<button class="btn success">
  <span class="i-heroicons:check" aria-hidden="true"></span>
  Approve
</button>`}</Code>
      </Section>
    </>
  );
}

/* ============================================================================
 * Patterns — the Block tier
 * ==========================================================================*/

function PatternNote({ children }) {
  return <p className="sg-prose sg-pattern-note">{children}</p>;
}

function BarPage() {
  return (
    <>
      <PageHeader
        eyebrow="Patterns"
        title="Bar"
        lead="A horizontal strip of controls. Layout only — no surface, no background, no border."
      />
      <Section title="Default: split">
        <PatternNote>
          Action bars usually carry navigation on one side and actions on the
          other, so the default is <code>space-between</code>. Wrap each side in a{" "}
          <code>.cluster</code>.
        </PatternNote>
        <Preview>
          <div className="bar">
            <div className="cluster">
              <button className="btn outlined">Back</button>
              <span className="badge muted">Draft</span>
            </div>
            <div className="cluster">
              <button className="btn ghost">Discard</button>
              <button className="btn primary">Publish</button>
            </div>
          </div>
        </Preview>
        <Code>{`<div class="bar">
  <div class="cluster"> … left group … </div>
  <div class="cluster"> … right group … </div>
</div>`}</Code>
      </Section>

      <Section title="Alignment modifiers">
        <PatternNote>
          <code>.start</code>, <code>.center</code> and <code>.end</code> re-align
          a bar that has only one group.
        </PatternNote>
        <Preview>
          <div className="stack">
            <div className="bar start">
              <div className="cluster">
                <button className="btn outlined">Filter</button>
                <button className="btn outlined">Sort</button>
              </div>
            </div>
            <div className="bar center">
              <div className="cluster">
                <button className="btn outlined">Prev</button>
                <button className="btn outlined">Next</button>
              </div>
            </div>
            <div className="bar end">
              <button className="btn primary">Save</button>
            </div>
          </div>
        </Preview>
        <Code>{`<div class="bar start">  … </div>
<div class="bar center"> … </div>
<div class="bar end">    … </div>`}</Code>
      </Section>

      <Section title="Bordered">
        <PatternNote>
          Adds padding and a bottom rule, for a contained toolbar above content.
        </PatternNote>
        <Preview>
          <div className="bar bordered">
            <strong>Invoices</strong>
            <button className="btn primary">New</button>
          </div>
        </Preview>
        <Code>{`<div class="bar bordered"> … </div>`}</Code>
      </Section>
    </>
  );
}

function SectionHeaderPage() {
  return (
    <>
      <PageHeader
        eyebrow="Patterns"
        title="Section header"
        lead="A heading paired with one trailing affordance. The canonical 'Tags [+]' pattern."
      />
      <Section title="Anatomy">
        <Preview>
          <div style={{ width: "100%" }}>
            <div className="section-header">
              <h3 id="tags-h">Tags</h3>
              <button className="btn icon" aria-label="Add tag">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M12 5v14M5 12h14" strokeLinecap="round" />
                </svg>
              </button>
            </div>
            <div className="cluster">
              <span className="pill info">design</span>
              <span className="pill success">shipped</span>
              <span className="pill muted">v2</span>
            </div>
          </div>
        </Preview>
        <Code>{`<section aria-labelledby="tags-h">
  <div class="section-header">
    <h3 id="tags-h">Tags</h3>
    <button class="btn icon" aria-label="Add tag">…</button>
  </div>
  <ul class="items"> … </ul>
</section>`}</Code>
        <PatternNote>
          The heading keeps its real level for the outline (Principle 3) and the{" "}
          <code>id</code> is what the surrounding <code>&lt;section&gt;</code>{" "}
          points at with <code>aria-labelledby</code>.
        </PatternNote>
      </Section>
    </>
  );
}

function DividerPage() {
  return (
    <>
      <PageHeader
        eyebrow="Patterns"
        title="Divider label"
        lead="A centered label on a horizontal rule. Day separators, 'OR' between options, section breaks."
      />
      <Section title="Usage">
        <Preview>
          <div className="stack" style={{ width: "100%" }}>
            <div className="divider-label">
              <span>Thursday 05/21</span>
            </div>
            <div className="cluster">
              <span className="badge success">Paid</span>
              <span>Invoice #1042</span>
            </div>
            <div className="divider-label">
              <span>OR</span>
            </div>
            <button className="btn outlined">Continue with email</button>
          </div>
        </Preview>
        <Code>{`<div class="divider-label"><span>Thursday 05/21</span></div>`}</Code>
        <PatternNote>
          The rules are <code>::before</code> and <code>::after</code> pseudo
          elements that flex to fill, so the label stays centered at any width.
        </PatternNote>
      </Section>
    </>
  );
}

function ItemsPage() {
  return (
    <>
      <PageHeader
        eyebrow="Patterns"
        title="Items"
        lead="Lightweight list entries — contact methods, nav links, metadata. Minimal chrome."
      />
      <Section title="Plain items">
        <Preview>
          <ul className="items" style={{ width: "100%" }}>
            <li className="item">
              <span className="badge info">Email</span>
              <span>ops@example.com</span>
            </li>
            <li className="item">
              <span className="badge muted">Phone</span>
              <span>+1 555 0134</span>
            </li>
            <li className="item">
              <span className="badge success">Site</span>
              <a className="link" href="#0">
                example.com
              </a>
            </li>
          </ul>
        </Preview>
        <Code>{`<ul class="items">
  <li class="item"> … </li>
</ul>`}</Code>
      </Section>

      <Section title="Menu variant">
        <PatternNote>
          <code>.items.menu</code> adds padding, a radius and a hover background —
          for interactive lists inside a popover or sidebar.
        </PatternNote>
        <Preview>
          <ul className="items menu" style={{ width: "260px" }}>
            <li className="item">Duplicate</li>
            <li className="item">Move to&hellip;</li>
            <li className="item">Archive</li>
          </ul>
        </Preview>
        <Code>{`<ul class="items menu">
  <li class="item">Duplicate</li>
</ul>`}</Code>
        <div className="alert warning">
          <div className="alert-icon" aria-hidden="true">
            !
          </div>
          <div className="alert-content">
            <strong>Interactive means focusable.</strong>
            <p>
              <code>.items.menu .item</code> only sets <code>cursor</code> and a
              hover background — an <code>&lt;li&gt;</code> is not focusable and
              takes no keyboard input. If the entries are actionable, put a{" "}
              <code>&lt;button&gt;</code> or <code>&lt;a&gt;</code> inside, or give
              the list real <code>role="menu"</code> behavior in a component
              (Principle 6).
            </p>
          </div>
        </div>
      </Section>
    </>
  );
}

function RowsPage() {
  return (
    <>
      <PageHeader
        eyebrow="Patterns"
        title="Rows"
        lead="Record entries with a content area and trailing actions. Checklists, settings rows, admin lists."
      />
      <Section title="Naming">
        <PatternNote>
          The vocabulary term is <strong>Row</strong>, but the class is{" "}
          <code>.list-row</code> — <code>.row</code> would collide with Bootstrap's
          grid. The concept and the class name diverge on purpose.
        </PatternNote>
      </Section>

      <Section title="Divided">
        <Preview>
          <ul className="rows divided" style={{ width: "100%" }}>
            {["Ship the release notes", "Rotate API keys", "Archive Q3 invoices"].map(
              (label, i) => (
                <li className="list-row" key={label}>
                  <label className="field-check">
                    <input type="checkbox" defaultChecked={i === 0} />
                    <span>{label}</span>
                  </label>
                  <div className="row-actions">
                    <button className="btn icon ghost" aria-label={`Edit ${label}`}>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M4 20h4L20 8l-4-4L4 16v4z" strokeLinejoin="round" />
                      </svg>
                    </button>
                  </div>
                </li>
              )
            )}
          </ul>
        </Preview>
        <Code>{`<ul class="rows divided">
  <li class="list-row">
    <label class="field-check"> … </label>
    <div class="row-actions">
      <button class="btn icon ghost" aria-label="Edit">…</button>
    </div>
  </li>
</ul>`}</Code>
      </Section>

      <Section title="Hover">
        <PatternNote>
          <code>.rows.hover</code> highlights on hover, for rows that are
          themselves clickable. Same caveat as Items — make the target a real
          control.
        </PatternNote>
        <Preview>
          <ul className="rows hover" style={{ width: "100%" }}>
            <li className="list-row">
              <span>Billing</span>
              <span className="badge success">Active</span>
            </li>
            <li className="list-row">
              <span>Notifications</span>
              <span className="badge muted">Off</span>
            </li>
          </ul>
        </Preview>
        <Code>{`<ul class="rows hover"> … </ul>`}</Code>
      </Section>
    </>
  );
}

function FeedPage() {
  const entries = [
    ["success", "2 days ago", "Form response added"],
    ["info", "3 days ago", "Assigned to Dana"],
    ["warning", "5 days ago", "SLA warning raised"],
    ["muted", "1 week ago", "Ticket created"],
  ];
  return (
    <>
      <PageHeader
        eyebrow="Patterns"
        title="Feed"
        lead="A chronological event stream plotted on a connecting timeline."
      />
      <Section title="Anatomy">
        <PatternNote>
          An <code>&lt;ol&gt;</code>, because chronological order is semantically
          meaningful. Each entry is wrapped in an <code>&lt;article&gt;</code>{" "}
          because each is a self-contained event (Principle 2). The dot reads{" "}
          <code>--bg-mix</code>, so any tone class colors it.
        </PatternNote>
        <Preview>
          <ol className="feed" style={{ width: "100%" }}>
            {entries.map(([tone, when, what]) => (
              <li key={what}>
                <article className="feed-item">
                  <span className={`feed-dot ${tone}`} aria-hidden="true" />
                  <div className="feed-content">
                    <div className="text-muted text-sm">{when}</div>
                    <div>{what}</div>
                  </div>
                </article>
              </li>
            ))}
          </ol>
        </Preview>
        <Code>{`<ol class="feed">
  <li>
    <article class="feed-item">
      <span class="feed-dot success" aria-hidden="true"></span>
      <div class="feed-content">
        <div class="text-muted text-sm">2 days ago</div>
        <div>Form response added</div>
      </div>
    </article>
  </li>
</ol>`}</Code>
      </Section>

      <Section title="The connecting line">
        <PatternNote>
          The line is an <code>::after</code> on <code>.feed-item</code>, hidden on
          the last entry. Its geometry is tuned to the dot — worth eyeballing if
          entry heights vary a lot, or in the Elite theme where radii are zero.
        </PatternNote>
      </Section>
    </>
  );
}

function DisclosurePage() {
  return (
    <>
      <PageHeader
        eyebrow="Patterns"
        title="Disclosure"
        lead="Expand and collapse on native <details> / <summary>. Keyboard, focus and toggle state are all platform-provided."
      />
      <Section title="Usage">
        <Preview>
          <div className="stack" style={{ width: "100%" }}>
            <details className="disclosure" open>
              <summary className="disclosure-summary">
                <span>To Do</span>
                <span className="text-muted">1 / 3</span>
              </summary>
              <div className="disclosure-body">
                <ul className="rows divided">
                  <li className="list-row">
                    <label className="field-check">
                      <input type="checkbox" defaultChecked />
                      <span>Draft the changelog</span>
                    </label>
                  </li>
                  <li className="list-row">
                    <label className="field-check">
                      <input type="checkbox" />
                      <span>Tag the release</span>
                    </label>
                  </li>
                </ul>
              </div>
            </details>
            <details className="disclosure">
              <summary className="disclosure-summary">
                <span>Archived</span>
                <span className="text-muted">12</span>
              </summary>
              <div className="disclosure-body">Nothing to see here.</div>
            </details>
          </div>
        </Preview>
        <Code>{`<details class="disclosure" open>
  <summary class="disclosure-summary">
    <span>To Do</span>
    <span class="text-muted">1 / 3</span>
  </summary>
  <div class="disclosure-body"> … </div>
</details>`}</Code>
      </Section>

      <Section title="Principle 4 in one component">
        <p className="sg-prose">
          No JavaScript, no <code>aria-expanded</code> to keep in sync, no focus
          management, no keyboard handler. The caret is a CSS-drawn box rotated on{" "}
          <code>[open]</code>, so there is no icon dependency either. This is what
          "native elements over reinvention" buys.
        </p>
      </Section>
    </>
  );
}

/* ============================================================================
 * Utilities — Responsive & Accessibility
 * ==========================================================================*/

const BREAKPOINTS = [
  ["sm", "640px", "large phone, landscape"],
  ["md", "768px", "tablet — container gutter steps to 1.5rem"],
  ["lg", "1024px", "small laptop"],
  ["xl", "1280px", "desktop — container gutter steps to 2rem"],
  ["2xl", "1536px", "wide desktop"],
];

function Responsive() {
  return (
    <>
      <PageHeader
        eyebrow="Utilities"
        title="Responsive"
        lead="A breakpoint scale, a container, and a scroll wrapper for tables. Until v0.6 the package contained exactly one media query — the reduced-motion guard."
      />

      <Section title="The scale">
        <table className="table striped compact">
          <thead>
            <tr>
              <th style={{ width: "12%" }}>Name</th>
              <th style={{ width: "16%" }}>Min width</th>
              <th>Used for</th>
            </tr>
          </thead>
          <tbody>
            {BREAKPOINTS.map(([n, w, use]) => (
              <tr key={n}>
                <td>
                  <code>{n}</code>
                </td>
                <td>
                  <code>{w}</code>
                </td>
                <td>{use}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="alert warning">
          <div className="alert-icon" aria-hidden="true">
            !
          </div>
          <div className="alert-content">
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
        <p className="sg-prose">
          The scale is Tailwind&rsquo;s, which is also UnoCSS&rsquo;s default. If
          you still run Uno for atomic utilities alongside this package, you get
          one set of breakpoints rather than two that nearly agree.
        </p>
      </Section>

      <Section title="Container">
        <p className="sg-prose">
          Centers content, holds it to a readable width, and steps its gutters up
          at <code>768px</code> and <code>1280px</code>. What <em>is</em> themable
          is the outcome — <code>--container-max</code>,{" "}
          <code>--container-narrow</code> and <code>--container-pad</code> are
          ordinary tokens, so a theme can change the page width without touching
          a media query.
        </p>
        <Code>{`<div class="container">        <!-- page width, 1280px cap -->
<div class="container narrow"> <!-- prose width, 768px cap -->
<div class="container wide">   <!-- full bleed, gutters only -->`}</Code>
        <Preview>
          <div style={{ width: "100%", display: "grid", gap: "8px" }}>
            <div className="container" style={{ background: "var(--surface-sunken)", paddingBlock: "10px" }}>
              <span className="badge muted">container</span>
            </div>
            <div className="container narrow" style={{ background: "var(--surface-sunken)", paddingBlock: "10px" }}>
              <span className="badge muted">narrow</span>
            </div>
          </div>
        </Preview>
        <Code>{`:root {
  --container-max:    1280px;
  --container-narrow: 768px;
  --container-pad:    1rem;
}
@media (min-width: 768px)  { .container { --container-pad: 1.5rem; } }
@media (min-width: 1280px) { .container { --container-pad: 2rem;   } }`}</Code>
      </Section>

      <Section title="Tables need a wrapper">
        <p className="sg-prose">
          A <code>&lt;table&gt;</code> cannot scroll itself — <code>overflow</code>{" "}
          on a table does nothing, and forcing <code>display: block</code> to make
          it work destroys the table layout algorithm. So the scroll lives on a
          wrapper, which is why <code>.table-wrap</code> is an{" "}
          <strong>Anatomy</strong> class and not a modifier on{" "}
          <code>.table</code>.
        </p>
        <Code>{`<div class="table-wrap">
  <table class="table"> … </table>
</div>`}</Code>
        <div className="alert danger">
          <div className="alert-icon" aria-hidden="true">
            !
          </div>
          <div className="alert-content">
            <strong>Without it, a wide table takes the page with it.</strong>
            <p>
              The table overflows its parent, the parent overflows the body, and
              the whole layout scrolls sideways on mobile. This was the single
              most likely way the system broke on a phone.
            </p>
          </div>
        </div>
      </Section>
    </>
  );
}

function Accessibility() {
  return (
    <>
      <PageHeader
        eyebrow="Utilities"
        title="Accessibility"
        lead="Two primitives the system had none of: hide something visually but not from a screen reader, and let a keyboard user skip the chrome."
      />

      <Section title="Visually hidden">
        <p className="sg-prose">
          For text a screen reader must read and a sighted user must not see: the
          real label on an icon-only control, a table caption, a status region,
          the word &ldquo;current&rdquo; in a breadcrumb.
        </p>
        <Code>{`<button class="btn icon">
  <svg aria-hidden="true">…</svg>
  <span class="visually-hidden">Delete invoice</span>
</button>`}</Code>
        <div className="alert danger">
          <div className="alert-icon" aria-hidden="true">
            !
          </div>
          <div className="alert-content">
            <strong>
              Not <code>display: none</code>, not{" "}
              <code>visibility: hidden</code>.
            </strong>
            <p>
              Both of those remove the element from the accessibility tree as
              well as the screen, which defeats the entire purpose. The class
              uses a clipped 1&times;1 box that still participates in the a11y
              tree.
            </p>
          </div>
        </div>
        <Code>{`.visually-hidden {
  position:    absolute;
  width:       1px;
  height:      1px;
  padding:     0;
  margin:      -1px;
  border:      0;
  overflow:    hidden;
  clip-path:   inset(50%);   /* not the deprecated clip: rect(…) */
  white-space: nowrap;
}`}</Code>
        <p className="sg-prose">
          It lives in the <code>a11y</code> layer, declared after every other
          layer, so nothing in the package can outrank it on
          position/size/clip — which is why it needs no{" "}
          <code>!important</code>. Your own unlayered CSS still overrides it, and
          that is correct: if you deliberately restyle it, you should win.
        </p>
      </Section>

      <Section title="Reveal on focus">
        <p className="sg-prose">
          Add <code>.focusable</code> for content that should stay hidden until a
          keyboard user reaches it. Tab into the preview below.
        </p>
        <Preview>
          <span className="visually-hidden focusable" tabIndex={0}>
            You found me — I was visually hidden until focused.
          </span>
          <span className="text-muted text-sm">
            (tab here — a hidden element sits to the left)
          </span>
        </Preview>
        <Code>{`<span class="visually-hidden focusable" tabindex="0"> … </span>`}</Code>
      </Section>

      <Section title="Skip link">
        <p className="sg-prose">
          The first focusable thing in the document, so a keyboard user can jump
          past the Topbar and Sidebar instead of tabbing through them on every
          page. Off-screen until focused, then it slides in.
        </p>
        <Code>{`<body>
  <a class="skip-link" href="#main">Skip to content</a>
  …
  <main id="main" tabindex="-1"> … </main>`}</Code>
        <div className="alert info">
          <div className="alert-icon" aria-hidden="true">
            &#9432;
          </div>
          <div className="alert-content">
            <strong>
              The <code>tabindex="-1"</code> on the target matters.
            </strong>
            <p>
              Without it some browsers move the visual viewport but not the
              focus, so the next Tab resumes from the skip link instead of the
              content — which makes the skip link do nothing useful.
            </p>
          </div>
        </div>
      </Section>

      <Section title="What is still missing">
        <p className="sg-prose">
          Honest gaps: four components use four different focus-ring recipes,
          and <code>.items.menu .item</code> is styled to look clickable on a
          non-focusable <code>&lt;li&gt;</code>. Both are on the list.
        </p>
      </Section>
    </>
  );
}

function ConfigModal({ onClose }) {
  const [copied, setCopied] = useState(false);

  const content = `/* index.css — the single entry point.
 * Plain CSS. No build step, no UnoCSS, no config file.
 *
 * Layer order beats specificity, so this list is the contract:
 * anything later wins, and your own unlayered CSS beats all of it. */

@layer tokens, themes, tones, base, layout, components, patterns;

@import './tokens.css' layer(tokens);

/* Themes */
@import './default.css'  layer(themes);
@import './sunset.css'   layer(themes);
@import './forest.css'   layer(themes);
@import './midnight.css' layer(themes);
@import './dark.css'     layer(themes);
@import './elite.css'    layer(themes);

/* Foundation */
@import './tones.css'   layer(tones);
@import './chip.css'    layer(base);     /* inline lineage: btn, pill, badge */
@import './surface.css' layer(base);     /* block lineage: card, alert, ... */
@import './layout.css'  layer(layout);   /* stack, cluster, center, split   */

/* Components */
@import './typography.css' layer(components);
@import './buttons.css'    layer(components);
@import './pills.css'      layer(components);
@import './badges.css'     layer(components);
@import './cards.css'      layer(components);
@import './alerts.css'     layer(components);
@import './toasts.css'     layer(components);
@import './popovers.css'   layer(components);
@import './drawers.css'    layer(components);
@import './form-core.css'  layer(components);
@import './tables.css'     layer(components);
@import './dialogs.css'    layer(components);

/* Block-tier patterns */
@import './bars.css'       layer(patterns);
@import './lists.css'      layer(patterns);
@import './feed.css'       layer(patterns);
@import './disclosure.css' layer(patterns);
`;

  function copy() {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(content).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      });
    }
  }

  function onBackdropClick(e) {
    if (e.target === e.currentTarget) onClose();
  }

  return (
    <div
      className="sg-modal-backdrop"
      onClick={onBackdropClick}
      role="dialog"
      aria-modal="true"
    >
      <div className="sg-modal">
        <header className="sg-modal-header">
          <div className="sg-modal-title">
            <span className="sg-modal-glyph">{`{ }`}</span>
            uno.config.js
          </div>
          <div className="sg-modal-actions">
            <button
              type="button"
              className="sg-modal-btn"
              onClick={copy}
            >
              {copied ? "Copied" : "Copy"}
            </button>
            <button
              type="button"
              className="sg-modal-close"
              onClick={onClose}
              aria-label="Close"
            >
              ×
            </button>
          </div>
        </header>
        <pre className="sg-modal-code">
          <code>{content}</code>
        </pre>
      </div>
    </div>
  );
}

function ComingSoon({ label }) {
  return (
    <div className="sg-coming">
      <strong>{label}</strong>
      <span> — not yet defined.</span>
    </div>
  );
}

/*
 * Guide chrome only.
 *
 * This used to carry a full copy of the design system CSS, which drifted two
 * versions behind the real files (it still had the pre-v0.3 --card-color and
 * the old 10/30/45%-black tone recipe). The package is plain CSS with no build
 * step as of v0.6, so the guide now <link>s ./index.css directly and that
 * class of drift is gone for good.
 *
 * What remains here is chrome (.sg-*) plus a few utilities the previews use
 * that UnoCSS used to provide (.text-sm, .p-4, .gap-2 …).
 */
const STYLESHEET = `

@import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600&family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500&family=Montserrat:wght@400;500;600;700;800&family=IBM+Plex+Mono:wght@400;500&display=swap');

:root {
  --color-primary: #0d83dd;
  --color-secondary: #E5E7EB;
  --color-muted: #6b7280;
  --color-info: #2EA2C9;
  --color-success: #16a34a;
  --color-warning: #d4b609;
  --color-danger: #F4403A;

  --btn-radius: 6px;
  --card-radius: 8px;
  --field-radius: 6px;

  --btn-font-weight: 600;
  --btn-text-transform: none;
  --btn-letter-spacing: normal;

  --pill-font-weight: 600;
  --pill-text-transform: none;
  --pill-letter-spacing: normal;

  --badge-font-weight: 600;
  --badge-text-transform: uppercase;
  --badge-letter-spacing: 0.04em;

  --shadow-sm: 0 1px 2px rgba(0,0,0,0.06);
  --shadow-md: 0 1px 3px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04);
  --shadow-lg: 0 1px 3px rgba(0,0,0,0.1), 0 4px 12px rgba(0,0,0,0.06);

  --ring: var(--color-primary);
  --ring-width: 3px;

  --font-primary: 'Geist', system-ui, sans-serif;
  --font-mono: 'Geist Mono', monospace;

  --paper: #faf8f2;
  --surface: #ffffff;
  --surface-raised: #ffffff;
  --surface-sunken: #f3f1e9;
  --ink: #1c1b18;
  --ink-soft: #5a564e;
  --ink-mute: #8b867b;
  --rule: #e7e3d8;
  --rule-strong: #d4cfc0;
  --accent: #0d83dd;
  --code-bg: #f3f1e9;
  --code-text: #3b372e;
}

.sg-app {
  font-family: 'Geist', system-ui, sans-serif;
  background: var(--paper);
  color: var(--ink);
  min-height: 100vh;
  font-size: 15px;
  line-height: 1.65;
  -webkit-font-smoothing: antialiased;
}

.sg-topbar-actions {
  display: flex;
  align-items: center;
  gap: 14px;
}

.sg-theme-menu {
  position: relative;
}
.sg-theme-trigger {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-family: 'Geist', system-ui, sans-serif;
  font-size: 13px;
  color: var(--ink-soft);
  background: var(--surface);
  border: 1px solid var(--rule-strong);
  border-radius: 6px;
  padding: 6px 10px 6px 8px;
  cursor: pointer;
  transition: border-color 120ms, color 120ms;
}
.sg-theme-trigger:hover {
  color: var(--ink);
  border-color: var(--accent);
}
.sg-theme-trigger-swatch {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 1px solid rgba(0,0,0,0.1);
  flex-shrink: 0;
}
.sg-theme-trigger-name {
  font-weight: 500;
  color: var(--ink);
}
.sg-theme-trigger-arrow {
  color: var(--ink-mute);
  font-size: 12px;
  margin-left: 2px;
}
.sg-theme-backdrop {
  position: fixed;
  inset: 0;
  z-index: 50;
}
.sg-theme-dropdown {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 51;
  min-width: 260px;
  background: var(--surface);
  border: 1px solid var(--rule-strong);
  border-radius: 8px;
  padding: 4px;
  box-shadow: 0 10px 30px rgba(0,0,0,0.12);
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.sg-theme-option {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  background: transparent;
  border: none;
  border-radius: 5px;
  cursor: pointer;
  text-align: left;
  font-family: inherit;
  width: 100%;
  transition: background 80ms;
}
.sg-theme-option:hover {
  background: rgba(0,0,0,0.04);
}
.sg-theme-option.active {
  background: rgba(13, 131, 221, 0.08);
}
.sg-theme-option-swatch {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: 1px solid rgba(0,0,0,0.1);
  flex-shrink: 0;
}
.sg-theme-option-text {
  display: flex;
  flex-direction: column;
  gap: 1px;
  flex: 1;
  min-width: 0;
}
.sg-theme-option-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--ink);
}
.sg-theme-option-desc {
  font-size: 11px;
  color: var(--ink-mute);
}
.sg-theme-option-check {
  color: var(--accent);
  font-size: 14px;
  margin-left: auto;
}

.sg-config-trigger {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-family: 'Geist Mono', monospace;
  font-size: 12px;
  color: var(--ink-soft);
  background: var(--surface);
  border: 1px solid var(--rule-strong);
  border-radius: 6px;
  padding: 6px 10px;
  cursor: pointer;
  transition: border-color 120ms, color 120ms, background 120ms;
}
.sg-config-trigger:hover {
  color: var(--ink);
  border-color: var(--accent);
  background: var(--paper);
}
.sg-config-glyph {
  font-size: 13px;
  color: var(--accent);
  font-weight: 600;
}
.sg-version {
  font-family: 'Geist Mono', monospace;
  font-size: 12px;
  color: var(--ink-mute);
}

.sg-modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(28, 27, 24, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
  padding: 32px;
  backdrop-filter: blur(2px);
}
.sg-modal {
  background: var(--paper);
  border: 1px solid var(--rule-strong);
  border-radius: 10px;
  width: 100%;
  max-width: 780px;
  max-height: 85vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.25);
  overflow: hidden;
}
.sg-modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 18px;
  border-bottom: 1px solid var(--rule);
  background: var(--paper);
}
.sg-modal-title {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  font-family: 'Geist Mono', monospace;
  font-size: 14px;
  font-weight: 500;
  color: var(--ink);
}
.sg-modal-glyph {
  color: var(--accent);
  font-weight: 600;
}
.sg-modal-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.sg-modal-btn {
  font-family: 'Geist', sans-serif;
  font-size: 13px;
  font-weight: 500;
  color: white;
  background: var(--accent);
  border: 1px solid var(--accent);
  border-radius: 5px;
  padding: 5px 14px;
  cursor: pointer;
  transition: filter 120ms;
  min-width: 64px;
}
.sg-modal-btn:hover { filter: brightness(1.05); }
.sg-modal-close {
  background: transparent;
  border: none;
  font-size: 22px;
  line-height: 1;
  color: var(--ink-mute);
  cursor: pointer;
  padding: 2px 8px;
  border-radius: 4px;
  transition: color 120ms, background 120ms;
}
.sg-modal-close:hover {
  color: var(--ink);
  background: rgba(0, 0, 0, 0.04);
}
.sg-modal-code {
  margin: 0;
  padding: 20px 24px;
  background: var(--code-bg);
  font-family: 'Geist Mono', monospace;
  font-size: 13px;
  line-height: 1.7;
  color: var(--code-text);
  overflow: auto;
  flex: 1;
}
.sg-modal-code code { font-family: inherit; }

.sg-topbar {
  border-bottom: 1px solid var(--rule);
  background: var(--paper);
  position: sticky;
  top: 0;
  z-index: 10;
}
.sg-topbar-inner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 28px;
  max-width: 1400px;
  margin: 0 auto;
}
.sg-brand { display: flex; align-items: center; gap: 12px; }
.sg-brand-mark {
  width: 22px; height: 22px;
  background: var(--accent);
  border-radius: 5px;
  display: inline-block;
  transform: rotate(-8deg);
}
.sg-brand-name {
  font-family: 'Fraunces', serif;
  font-weight: 600;
  font-size: 18px;
  letter-spacing: -0.01em;
}
.sg-brand-sub {
  font-size: 13px;
  color: var(--ink-mute);
  border-left: 1px solid var(--rule-strong);
  padding-left: 12px;
}

.sg-shell {
  display: grid;
  grid-template-columns: 240px 1fr;
  max-width: 1400px;
  margin: 0 auto;
}

.sg-sidebar {
  border-right: 1px solid var(--rule);
  padding: 32px 20px 32px 28px;
  position: sticky;
  top: 53px;
  height: calc(100vh - 53px);
  overflow-y: auto;
}
.sg-nav-group { margin-bottom: 24px; }
.sg-nav-group-title {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--ink-mute);
  padding: 0 8px 6px;
}
.sg-nav-list { list-style: none; padding: 0; margin: 0; }
.sg-nav-item {
  display: block;
  width: 100%;
  text-align: left;
  background: transparent;
  border: none;
  padding: 6px 8px;
  font-size: 14px;
  color: var(--ink-soft);
  border-radius: 4px;
  cursor: pointer;
  font-family: inherit;
  transition: color 100ms, background 100ms;
}
.sg-nav-item:hover {
  color: var(--ink);
  background: rgba(0,0,0,0.03);
}
.sg-nav-item.active {
  color: var(--accent);
  background: rgba(13, 131, 221, 0.09);
  font-weight: 500;
}

.sg-main { padding: 48px 56px 96px; }
.sg-main-inner { max-width: 760px; }

.sg-page-header { margin-bottom: 40px; }
.sg-eyebrow {
  font-size: 12px;
  font-weight: 500;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--accent);
  margin-bottom: 14px;
}
.sg-h1 {
  font-family: 'Fraunces', serif;
  font-weight: 500;
  font-size: 44px;
  line-height: 1.05;
  letter-spacing: -0.025em;
  margin: 0 0 14px;
  font-variation-settings: "opsz" 144;
  color: var(--ink);
}
.sg-lead {
  font-size: 18px;
  line-height: 1.5;
  color: var(--ink-soft);
  margin: 0;
  max-width: 60ch;
}
.sg-divider {
  border: none;
  border-top: 1px solid var(--rule);
  margin: 32px 0 0;
}

.sg-section { margin: 0 0 56px; }
.sg-h2 {
  font-family: 'Fraunces', serif;
  font-weight: 500;
  font-size: 26px;
  letter-spacing: -0.01em;
  margin: 0 0 16px;
  font-variation-settings: "opsz" 60;
}
.sg-prose {
  color: var(--ink-soft);
  margin: 0 0 18px;
  max-width: 64ch;
}
.sg-prose code,
.sg-list code,
.sg-td-prose code {
  font-family: 'Geist Mono', monospace;
  font-size: 0.875em;
  background: var(--code-bg);
  padding: 1px 6px;
  border-radius: 4px;
  color: var(--code-text);
}
.sg-list {
  margin: 0 0 18px;
  padding-left: 22px;
  color: var(--ink-soft);
  max-width: 64ch;
}
.sg-list li { margin-bottom: 8px; }

.sg-preview-box {
  background: var(--surface);
  border: 1px solid var(--rule);
  border-radius: 8px;
  padding: 28px 24px;
  margin-bottom: 12px;
}
.sg-preview-center {
  display: flex; align-items: center; justify-content: center;
  min-height: 64px;
}
.sg-row-flex {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
}
.sg-row-flex.sg-row-baseline { align-items: baseline; }

.sg-code {
  background: var(--code-bg);
  border-radius: 8px;
  padding: 16px 18px;
  font-family: 'Geist Mono', monospace;
  font-size: 13px;
  line-height: 1.65;
  color: var(--code-text);
  overflow-x: auto;
  margin: 0 0 12px;
}
.sg-code code { font-family: inherit; }

.sg-editor { margin-top: 4px; }
.sg-editor-label {
  display: block;
  font-size: 12px;
  font-weight: 500;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--ink-mute);
  margin-bottom: 8px;
}
.sg-editor input {
  width: 100%;
  font-family: 'Geist Mono', monospace;
  font-size: 14px;
  padding: 11px 14px;
  border: 1px solid var(--rule-strong);
  border-radius: 8px;
  background: var(--surface);
  color: var(--ink);
  margin-bottom: 14px;
  transition: border-color 120ms, box-shadow 120ms;
}
.sg-editor input:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px rgba(13,131,221,0.14);
}

.sg-token-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 14px;
  margin: 0 0 12px;
}
.sg-token-table th {
  text-align: left;
  font-weight: 500;
  color: var(--ink-mute);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  padding: 10px 14px;
  border-bottom: 1px solid var(--rule);
}
.sg-token-table td {
  padding: 12px 14px;
  border-bottom: 1px solid var(--rule);
  font-family: 'Geist Mono', monospace;
  font-size: 13px;
  vertical-align: middle;
}
.sg-token-table tr:last-child td { border-bottom: none; }
.sg-td-prose {
  font-family: 'Geist', sans-serif !important;
  font-size: 13px !important;
  color: var(--ink-soft);
}
.sg-swatch {
  display: inline-block;
  width: 18px;
  height: 18px;
  border-radius: 4px;
  border: 1px solid rgba(0,0,0,0.08);
  vertical-align: middle;
  margin-right: 10px;
}

.sg-coming {
  background: var(--surface);
  border: 1px dashed var(--rule-strong);
  border-radius: 8px;
  padding: 64px 24px;
  text-align: center;
  color: var(--ink-mute);
}

/* ── Chrome for the Principles / Taxonomy / Patterns pages ───────────── */
.sg-principles { display: grid; gap: 12px; }
.sg-principle {
  display: grid;
  grid-template-columns: 2rem 1fr;
  gap: 14px;
  align-items: start;
}
.sg-principle-num {
  display: grid;
  place-items: center;
  width: 2rem;
  height: 2rem;
  border-radius: 999px;
  background: color-mix(in srgb, var(--color-primary) 12%, var(--surface));
  color: color-mix(in srgb, var(--color-primary) 70%, var(--ink));
  font-weight: 700;
  font-size: 13px;
}
.sg-principle-title { display: block; margin-bottom: 4px; }
.sg-principle-body  { margin: 0; line-height: 1.55; color: var(--ink-soft); }
.sg-kind-examples {
  margin-top: 8px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--ink-mute);
  word-break: break-word;
}
.sg-pattern-note { color: var(--ink-soft); }

/* ===== The showcased system itself ===== */

/* Respect prefers-reduced-motion */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}

/* Lineage diagram */
.sg-lineage {
  display: grid;
  grid-template-columns: minmax(180px, 1fr) auto minmax(220px, 1.3fr);
  gap: 28px;
  align-items: center;
  background: var(--paper);
  border: 1px solid var(--rule);
  border-radius: 8px;
  padding: 28px 24px;
  margin-bottom: 16px;
}
/* Vertical variant — used by surface lineage (base → many children) */
.sg-lineage:has(.sg-lineage-base) {
  grid-template-columns: 1fr;
  gap: 12px;
  justify-items: center;
}
.sg-lineage-base {
  border: 1px solid var(--accent);
  border-radius: 6px;
  padding: 14px 18px;
  background: var(--surface);
  text-align: center;
  min-width: 240px;
  box-shadow: 0 0 0 3px rgba(13, 131, 221, 0.08);
}
.sg-lineage-arrow-line {
  width: 1px;
  height: 24px;
  background: var(--rule-strong);
}
.sg-lineage-arrow-label {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--ink-mute);
  font-weight: 500;
}
.sg-lineage-children {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 12px;
  width: 100%;
}
.sg-lineage-col {
  display: grid;
  gap: 12px;
}
.sg-lineage-card {
  border: 1px solid var(--rule-strong);
  border-radius: 6px;
  padding: 12px 14px;
  background: var(--surface);
}
.sg-lineage-root {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px rgba(13, 131, 221, 0.08);
}
.sg-lineage-name {
  font-family: 'Geist Mono', monospace;
  font-size: 14px;
  font-weight: 500;
  color: var(--ink);
  margin-bottom: 2px;
}
.sg-lineage-role {
  font-size: 12px;
  color: var(--ink-mute);
}
.sg-lineage-preview {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px dashed var(--rule);
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 32px;
}
.sg-lineage-arrow {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--ink-mute);
  font-weight: 500;
  position: relative;
}
.sg-lineage-arrow::before {
  content: '';
  width: 32px;
  height: 1px;
  background: var(--rule-strong);
}
.sg-lineage-arrow::after {
  content: '→';
  font-size: 16px;
  line-height: 1;
  color: var(--ink-mute);
}

.sg-resolve {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  gap: 16px;
  align-items: stretch;
  margin: 0 0 18px;
}
.sg-resolve-col {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.sg-resolve-label {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--ink-mute);
  font-weight: 500;
}
.sg-code-inline {
  margin: 0;
  flex: 1;
  font-size: 12px;
}
.sg-resolve-arrow {
  align-self: center;
  font-size: 18px;
  color: var(--ink-mute);
}

.sg-card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 12px;
}
.sg-card-text {
  margin: 0;
  font-size: 14px;
  line-height: 1.5;
  color: inherit;
  opacity: 0.85;
}
.sg-card-text code {
  font-family: 'Geist Mono', monospace;
  font-size: 0.9em;
  background: rgba(0,0,0,0.05);
  padding: 1px 5px;
  border-radius: 3px;
}

/* Themes page */
.sg-theme-switcher {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 8px;
  margin-bottom: 20px;
}
.sg-theme-tab {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  background: var(--surface);
  border: 1px solid var(--rule);
  border-radius: 8px;
  cursor: pointer;
  text-align: left;
  font-family: inherit;
  transition: border-color 120ms, box-shadow 120ms;
}
.sg-theme-tab:hover {
  border-color: var(--rule-strong);
}
.sg-theme-tab.active {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px rgba(13, 131, 221, 0.12);
}
.sg-theme-swatch {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  flex-shrink: 0;
  border: 1px solid rgba(0,0,0,0.1);
}
.sg-theme-tab-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.sg-theme-tab-name {
  font-size: 14px;
  font-weight: 500;
  color: var(--ink);
}
.sg-theme-tab-desc {
  font-size: 12px;
  color: var(--ink-mute);
}

.sg-theme-preview {
  background: var(--surface);
  border: 1px solid var(--rule);
  border-radius: 10px;
  padding: 20px 24px;
  margin-bottom: 12px;
  display: flex;
  flex-direction: column;
  gap: 24px;
  transition: background 200ms;
  font-family: var(--font-primary);
}
.sg-theme-block {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.sg-theme-label {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--ink-mute);
  font-weight: 500;
}
.sg-theme-ramp {
  display: grid;
  grid-template-columns: repeat(9, 1fr);
  gap: 0;
  border-radius: 6px;
  overflow: hidden;
}
.sg-theme-ramp .tonal {
  border-radius: 0;
  min-height: 44px;
  font-size: 10px;
  padding: 6px 2px;
}

/* Colors page */
.sg-palette {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 8px;
  margin-bottom: 12px;
}
.sg-palette-tile {
  border-radius: 8px;
  padding: 16px 14px;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  min-height: 96px;
  border: 1px solid rgba(0,0,0,0.06);
}
.sg-palette-name {
  font-family: 'Geist Mono', monospace;
  font-size: 13px;
  font-weight: 500;
}
.sg-palette-hex {
  font-family: 'Geist Mono', monospace;
  font-size: 11px;
  opacity: 0.85;
  margin-top: 24px;
}

.sg-color-ramps {
  display: grid;
  gap: 12px;
}
.sg-color-ramp {
  background: var(--surface);
  border: 1px solid var(--rule);
  border-radius: 8px;
  padding: 14px 16px;
}
.sg-color-ramp-meta {
  display: flex;
  align-items: baseline;
  gap: 12px;
  margin-bottom: 10px;
}
.sg-color-ramp-name {
  font-family: 'Geist Mono', monospace;
  font-size: 13px;
  font-weight: 500;
  color: var(--ink);
  background: transparent;
  padding: 0;
}
.sg-color-ramp-role {
  font-size: 12px;
  color: var(--ink-mute);
}
.sg-color-ramp-strip {
  display: grid;
  grid-template-columns: repeat(11, 1fr);
  gap: 0;
  border-radius: 6px;
  overflow: hidden;
  border: 1px solid var(--rule);
}
.sg-color-ramp-strip .tonal {
  border-radius: 0;
  min-height: 38px;
  font-size: 10px;
  padding: 6px 2px;
}

/* Tonal mixing */
.tonal {
  background: var(--bg);
  color: var(--color);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 14px 16px;
  border-radius: 4px;
  font-family: 'Geist Mono', monospace;
  font-size: 11px;
  font-weight: 500;
  min-height: 44px;
  text-align: center;
}

.sg-tonal-strip {
  display: grid;
  grid-template-columns: repeat(11, 1fr);
  gap: 0;
  margin-bottom: 12px;
  border-radius: 6px;
  overflow: hidden;
  border: 1px solid var(--rule);
}
.sg-tonal-strip .tonal {
  border-radius: 0;
  min-height: 56px;
  font-size: 10px;
  padding: 8px 4px;
}
.sg-tonal-raw {
  background: var(--bg-mix) !important;
  color: white !important;
}

.sg-tonal-chip {
  min-width: 110px;
}

.sg-tonal-strip-row {
  display: grid;
  grid-template-columns: repeat(9, 1fr);
  gap: 4px;
}
.sg-tonal-step {
  min-height: 42px;
  border-radius: 4px;
  font-size: 10px;
  padding: 6px 2px;
}

.sg-tonal-matrix {
  display: grid;
  gap: 4px;
}
.sg-tonal-matrix-row {
  display: grid;
  grid-template-columns: 70px repeat(9, 1fr);
  gap: 4px;
  align-items: stretch;
}
.sg-tonal-matrix-label {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  padding: 0 8px;
  font-family: 'Geist Mono', monospace;
  font-size: 11px;
  color: var(--ink-soft);
  background: transparent;
}
.sg-tonal-cell {
  min-height: 36px;
  font-size: 10px;
  border-radius: 3px;
  padding: 4px 2px;
}

/* Stack helper for previews */
.sg-stack {
  display: flex;
  flex-direction: column;
  gap: 12px;
  align-items: flex-start;
}
.sg-stack > * { width: 100%; }
.sg-stack-divider {
  height: 1px;
  background: var(--rule);
  margin: 4px 0;
}
.sg-prose-preview p {
  margin: 0;
  color: var(--ink);
}

/* Spacing page */
.sg-scale {
  display: grid;
  gap: 6px;
  margin-bottom: 12px;
}
.sg-scale-row {
  display: grid;
  grid-template-columns: 36px 1fr 80px 60px;
  align-items: center;
  gap: 14px;
  padding: 6px 12px;
  background: var(--surface);
  border: 1px solid var(--rule);
  border-radius: 6px;
}
.sg-scale-token {
  font-family: 'Geist Mono', monospace;
  font-size: 13px;
  color: var(--ink);
  background: transparent;
  padding: 0;
  text-align: center;
}
.sg-scale-track {
  display: flex;
  align-items: center;
  height: 18px;
}
.sg-scale-bar {
  height: 14px;
  background: var(--accent);
  border-radius: 2px;
  min-width: 0;
}
.sg-scale-val,
.sg-scale-px {
  font-family: 'Geist Mono', monospace;
  font-size: 12px;
  color: var(--ink-mute);
  background: transparent;
  padding: 0;
  text-align: right;
}

.sg-pad-demo {
  background: rgba(13, 131, 221, 0.08);
  border: 1px solid var(--accent);
  border-radius: 6px;
  font-family: 'Geist Mono', monospace;
  font-size: 12px;
  color: var(--accent);
  font-weight: 500;
}
.p-2 { padding: 8px; }
.p-4 { padding: 16px; }
.p-6 { padding: 24px; }
.p-8 { padding: 32px; }

.sg-gap-demo {
  display: flex;
  align-items: center;
  padding: 8px;
  background: var(--surface);
  border: 1px dashed var(--rule-strong);
  border-radius: 6px;
}

/* Typography page */
.sg-typescale {
  display: grid;
  gap: 8px;
  margin-bottom: 12px;
}
.sg-typescale-row {
  display: grid;
  grid-template-columns: 80px 1fr auto;
  align-items: baseline;
  gap: 18px;
  padding: 10px 14px;
  background: var(--surface);
  border: 1px solid var(--rule);
  border-radius: 6px;
}
.sg-typescale-token {
  font-family: 'Geist Mono', monospace;
  font-size: 12px;
  color: var(--ink-soft);
  background: transparent;
  padding: 0;
}
.sg-typescale-sample {
  color: var(--ink);
  line-height: 1.2;
  font-weight: 500;
  letter-spacing: -0.01em;
}
.sg-typescale-meta {
  font-family: 'Geist Mono', monospace;
  font-size: 11px;
  color: var(--ink-mute);
  background: transparent;
  padding: 0;
  text-align: right;
  align-self: center;
}

.sg-weights {
  display: grid;
  gap: 6px;
  margin-bottom: 12px;
}
.sg-weight-row {
  display: grid;
  grid-template-columns: 140px 1fr;
  gap: 18px;
  align-items: center;
  padding: 8px 14px;
  background: var(--surface);
  border: 1px solid var(--rule);
  border-radius: 6px;
}
.sg-weight-token {
  font-family: 'Geist Mono', monospace;
  font-size: 12px;
  color: var(--ink-soft);
  background: transparent;
  padding: 0;
}
.sg-weight-sample {
  color: var(--ink);
  font-size: 16px;
}

.sg-color-grid {
  display: grid;
  gap: 6px;
  margin-bottom: 12px;
}
.sg-color-row {
  display: grid;
  grid-template-columns: 130px 1fr 100px;
  gap: 16px;
  align-items: center;
  padding: 8px 14px;
  background: var(--surface);
  border: 1px solid var(--rule);
  border-radius: 6px;
}
.sg-color-token {
  font-family: 'Geist Mono', monospace;
  font-size: 12px;
  color: var(--ink-soft);
  background: transparent;
  padding: 0;
}
.sg-color-sample {
  font-weight: 500;
  font-size: 15px;
}
.sg-color-note {
  font-family: 'Geist Mono', monospace;
  font-size: 11px;
  color: var(--ink-mute);
  background: transparent;
  padding: 0;
  text-align: right;
}

/* Cheat sheet */
.sg-cheat-bases {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 12px;
  margin: 0 0 12px;
}
.sg-cheat-base {
  display: flex;
  gap: 14px;
  align-items: center;
  padding: 12px 14px;
  background: var(--surface);
  border: 1px solid var(--rule);
  border-radius: 8px;
}
.sg-cheat-base-preview {
  flex-shrink: 0;
  min-width: 56px;
  display: flex;
  justify-content: center;
}
.sg-cheat-base-meta {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  flex: 1;
}
.sg-cheat-name {
  font-family: 'Geist Mono', monospace;
  font-size: 13px;
  color: var(--ink);
  font-weight: 500;
  background: transparent;
  padding: 0;
}
.sg-cheat-shortcut {
  font-family: 'Geist Mono', monospace;
  font-size: 11px;
  color: var(--ink-mute);
  background: var(--code-bg);
  padding: 4px 6px;
  border-radius: 4px;
  word-break: break-word;
  line-height: 1.5;
}

.sg-cheat-tones {
  display: grid;
  gap: 6px;
  margin-bottom: 12px;
}
.sg-cheat-tone {
  display: grid;
  grid-template-columns: 24px auto 1fr auto;
  align-items: center;
  gap: 14px;
  padding: 8px 12px;
  background: var(--surface);
  border: 1px solid var(--rule);
  border-radius: 6px;
}
.sg-cheat-swatch {
  width: 20px;
  height: 20px;
  border-radius: 4px;
  border: 1px solid rgba(0,0,0,0.08);
}
.sg-cheat-token {
  font-family: 'Geist Mono', monospace;
  font-size: 12px;
  color: var(--ink-soft);
  background: transparent;
  padding: 0;
}
.sg-cheat-val {
  font-family: 'Geist Mono', monospace;
  font-size: 12px;
  color: var(--ink-mute);
  background: transparent;
  padding: 0;
}

.sg-cheat-matrix {
  background: var(--surface);
  border: 1px solid var(--rule);
  border-radius: 8px;
  padding: 16px 20px;
}
.sg-matrix-head,
.sg-matrix-row {
  display: grid;
  grid-template-columns: 100px 1fr 1fr;
  gap: 16px;
  align-items: center;
}
.sg-matrix-row {
  padding: 8px 0;
  border-top: 1px solid var(--rule);
}
.sg-matrix-head {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--ink-mute);
  padding-bottom: 8px;
  font-weight: 500;
}
.sg-matrix-label code {
  font-family: 'Geist Mono', monospace;
  font-size: 12px;
  color: var(--ink-soft);
  background: transparent;
  padding: 0;
}

.sg-cheat-sizes {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: baseline;
  padding: 16px 20px;
  background: var(--surface);
  border: 1px solid var(--rule);
  border-radius: 8px;
}

.sg-cheat-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 8px;
}
.sg-cheat-row-inline {
  padding: 12px 16px;
  background: var(--surface);
  border: 1px solid var(--rule);
  border-radius: 8px;
  align-items: center;
}

.sg-cheat-vars {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 12px;
}
.sg-cheat-var-group {
  background: var(--surface);
  border: 1px solid var(--rule);
  border-radius: 8px;
  padding: 14px 16px;
}
.sg-cheat-var-title {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--ink-mute);
  font-weight: 500;
  margin-bottom: 8px;
}
.sg-cheat-var {
  display: block;
  font-family: 'Geist Mono', monospace;
  font-size: 12px;
  color: var(--ink-soft);
  padding: 3px 0;
  background: transparent;
}

.sg-cheat-mini-card {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--surface);
  border: 1px solid var(--rule);
  border-radius: 4px;
  padding: 6px 12px;
  font-family: 'Geist Mono', monospace;
  font-size: 11px;
  color: var(--ink-soft);
  min-width: 50px;
}
.sg-cheat-mini-field {
  display: inline-flex;
  align-items: center;
  background: var(--surface);
  border: 1px solid var(--rule-strong);
  border-radius: 4px;
  padding: 4px 10px;
  font-family: 'Geist Mono', monospace;
  font-size: 11px;
  color: var(--ink);
  min-width: 50px;
}
.sg-cheat-mini-table {
  display: inline-block;
  background: var(--surface);
  border: 1px solid var(--rule);
  border-radius: 3px;
  padding: 4px 10px;
  font-family: 'Geist Mono', monospace;
  font-size: 11px;
  color: var(--ink-soft);
  border-top: 3px double var(--rule-strong);
  min-width: 50px;
  text-align: center;
}
.sg-cheat-mini-dialog {
  display: inline-block;
  background: var(--surface-raised);
  border: 1px solid var(--rule-strong);
  border-radius: 4px;
  padding: 4px 10px;
  font-family: 'Geist Mono', monospace;
  font-size: 11px;
  color: var(--ink-soft);
  box-shadow: var(--shadow-md);
  min-width: 50px;
  text-align: center;
}

.sg-cheat-card-row {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
  margin-bottom: 8px;
}
.sg-cheat-card {
  padding: 12px;
  font-size: 12px;
}
.sg-cheat-card > strong {
  font-size: 13px;
  margin-bottom: 2px;
}
.sg-cheat-card .sg-card-text {
  font-size: 11px;
  margin: 0;
}

.sg-cheat-tonal-strip {
  display: grid;
  grid-template-columns: repeat(9, 1fr);
  gap: 0;
  border-radius: 6px;
  overflow: hidden;
  border: 1px solid var(--rule);
}
.sg-cheat-tonal-strip .tonal {
  border-radius: 0;
  min-height: 40px;
  font-size: 10px;
  padding: 6px 2px;
}

.sg-cheat-themes {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 6px;
}
.sg-cheat-theme {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  background: var(--surface);
  border: 1px solid var(--rule);
  border-radius: 6px;
}
.sg-cheat-theme-swatch {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  flex-shrink: 0;
  border: 1px solid rgba(0,0,0,0.08);
}
.sg-cheat-theme-desc {
  font-size: 11px;
  color: var(--ink-mute);
  margin-left: auto;
}

/* Generic text-size utilities (in real apps, Uno provides these) */
.text-xs   { font-size: 12px; }
.text-sm   { font-size: 13px; }
.text-base { font-size: 14px; }
.text-lg   { font-size: 16px; }
.text-xl   { font-size: 18px; }
.text-2xl  { font-size: 22px; }
.text-3xl  { font-size: 28px; }
.text-4xl  { font-size: 36px; }
.gap-2   { gap: 8px; }
.gap-8   { gap: 32px; }
.h-36    { height: 144px; }
`;
