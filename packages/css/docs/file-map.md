# CSS — File map and deliverables

> Moved from `PROJECT_STATE.md` (2026-10-09). Version tags (vX.Y) refer to the package version when written.

## File map

Stylesheets live under **`src/`**, grouped into directories that mirror the
cascade layers declared in `index.css`, so the tree teaches the order rather
than competing with it. The package root holds only the manifest, the docs and
the tooling directories.

`src/` earns its name as of v0.11: `bun run build` bundles it into
`dist/frontier.css` + `.min.css` for consumers who want one file. The default
`import '@frontierjs/css'` is unchanged and still needs no build — the bundle
is a convenience artifact, not the product.

> Directories were tried once before, and are why v0.6 exists — every `@import`
> pointed at a `./themes/` and `./utilities/` that had never been created, so
> the entry point resolved nothing and the package did not load at all.
>
> Two tests make the layout safe now. **`meta: every @import in index.css
> resolved`** catches an import with no file (a failed `@import` is otherwise
> silent — the rule stays in place with a null `styleSheet`). **`meta: every
> shipped stylesheet is reachable from index.css`** catches the opposite: a
> file that exists and nothing imports, which is what a move makes easy and
> which breaks nothing loudly. Move a file, run `bun run test`.

```
@frontierjs/css/
├── package.json                   ← manifest; exports map hides src/ from the
│                                     public path (@frontierjs/css/themes/…)
├── build.js                       ← src/ → dist/, one file            (NEW v0.11)
│
└── src/
├── index.css                      ← single entry point (one import covers all)
├── utilities.css                  ← .text-* size + color; late layer, beats
│                                     components                        (v0.10.1)
│
├── foundation/ ─────────────────────────────────────────────────────
│   ├── tokens.css                 ← :root defaults + border-box + reduced-motion
│   ├── tones.css                  ← tone vocabulary (.primary, .danger, …)
│   ├── chip.css                   ← inline visual base (:where group)   (NEW v0.6)
│   ├── surface.css                ← block visual base (:where group)
│   └── layout.css                 ← stack / cluster / center / split + .container
│
├── themes/ ─────────────────────────────────────────────────────────
│   ├── default.css                ← blue brand + neutral surfaces
│   ├── sunset.css                 ← warm orange
│   ├── forest.css                 ← deep green
│   ├── midnight.css               ← purple accent
│   ├── dark.css                   ← neutral dark
│   └── elite.css                  ← navy + lime + Montserrat (real client theme)
│
├── components/ ─────────────────────────────────────────────────────
│   ├── frame.css                  ← Frame + Page tiers: app shell        (NEW v0.6)
│   ├── typography.css             ← h1-h6, .link, kbd, code
│   ├── icon.css                   ← THE icon sizing rule + .icon        (NEW v0.10)
│   ├── buttons.css                ← .btn (+ .square, .ghost, .raised)
│   ├── pills.css                  ← .pill (+ .removable / .pill-close)
│   ├── badges.css                 ← .badge
│   ├── cards.css                  ← .card
│   ├── tiles.css                  ← .tiles/.tile + label/value/delta     (NEW v0.6)
│   ├── avatar.css                 ← .avatar (chip lineage) + .avatars     (NEW v0.8)
│   ├── feedback.css               ← .spinner .progress .skeleton .empty  (NEW v0.6)
│   ├── alerts.css                 ← .alert
│   ├── toasts.css                 ← .toast
│   ├── popovers.css               ← .popover
│   ├── tooltips.css               ← .tooltip + .tooltip-anchor            (NEW v0.6)
│   ├── drawers.css                ← .drawer
│   ├── form-core.css              ← .field, .field-group, .field-hint,
│   │                                .field-check, .switch, .field-row/-addon
│   ├── tables.css                 ← .table + variants + row tones
│   └── dialogs.css                ← .dialog
│
├── patterns/ ───────────────────────────────────────────────────────
│   ├── bars.css                   ← .bar, .section-header, .divider-label (NEW v0.5)
│   ├── lists.css                  ← .items/.item, .rows/.list-row         (NEW v0.5)
│   ├── feed.css                   ← .feed/.feed-item/.feed-dot            (NEW v0.5)
│   ├── disclosure.css             ← .disclosure + summary/body            (NEW v0.5)
│   ├── facts.css                  ← <dl> label/value pairs                (NEW v0.8)
│   ├── steps.css                  ← .steps/.step + marker/label/hint      (NEW v0.8)
│   ├── tabs.css                   ← .tabs/.tablist/.tab                   (NEW v0.6)
│   └── nav.css                    ← .breadcrumb .pagination .navlist      (NEW v0.6)
│
└── a11y/ ───────────────────────────────────────────────────────────
    ├── focus.css                  ← THE focus ring — one recipe, all of it (NEW v0.7)
    └── a11y.css                   ← .visually-hidden, .skip-link          (NEW v0.6)

   guide/                          ← the interactive reference (52 pages)
   ├── index.html                  ← shell; <link>s the real ../index.css
   ├── guide.js                    ← data, page builders, hash router, ⌘K palette
   ├── decisions.js                ← the Learn wizard's routing tree      (v0.13)
   ├── search.js                   ← the search ranker + slugify          (NEW)
   └── guide.css                   ← chrome only (.sg-*)

   demo/                           ← a realistic SaaS admin, the first consumer
   test/                           ← the assertion suite                    (NEW v0.7)
   ├── run.js                      ← driver: builds a page, runs Chrome, reports
   ├── harness.js                  ← in-page assertions + computed-style rulers
   └── specs/*.spec.js             ← meta · focus · tables · tones · contrast ·
                                     layers · components · core-gaps · code ·
                                     decisions · overlays · search · space ·
                                     type · vocabulary · anatomy
```

> **In the repo:** all 36 `*.css` files, `package.json`, `README.md`,
> `guide/`, and `test/`. **Not in the repo:** `frontier-demo.html` and
> `TicketDetail.svelte` — both predate v0.6 and describe the pre-Uno-removal
> system, so treat anything in them as stale until re-checked.

### Deliverables / artifacts

- **`test/`** (NEW v0.7) — the assertion suite. `bun run test`, or
  `bun run test focus tone` to filter, or `--keep` to leave the generated page
  on disk. 202 assertions in headless Chrome against real computed styles;
  zero dependencies (the page computes its own results and `--dump-dom` carries
  them back, so there is no puppeteer). `specs/meta.spec.js` tests the harness
  rather than the CSS — see the note about trusting your own ruler below.
- **`guide/`** — the docs site. Plain HTML + JS, no framework and no build step:
  `index.html` (shell), `guide.js` (data, 45 page builders, hash router),
  `guide.css` (chrome only). Open the file directly, or `bun run demo` and go to
  `/guide/`. It `<link>`s the real `../index.css`, so what it shows cannot drift.
  Converted from `style-guide.jsx` (a ~9,600-line single-file React site, retired
  2026-08-02 — it needed React and a bundler the package itself does not).
  Renders every component live with theme switching; nav groups: Start Here /
  Foundation / Structure / Components / Patterns / Utilities / Reference.
  - Start Here: Overview, Principles, Install, Composition, Conventions
  - Foundation: CSS Variables, Tonal, Themes, Colors
  - Structure: Vocabulary (29 terms, 6 groups)
  - Components: Buttons, Links, Headings, Cards, Alerts, Toasts, Popovers,
    Drawers, Tables, Dialogs, Inputs, Badges & Pills, Icons
  - Patterns (NEW v0.5): Bar, Section Header, Items, Rows, Feed, Disclosure, Divider
  - Utilities: Layouts, Spacing, Typography
  - Reference: Cheat sheet
- **`frontier-demo.html`** (NEW v0.5) — single self-contained HTML file with all
  CSS inlined (Uno shortcuts translated to plain CSS) + a full component gallery
  + theme switcher + TicketDetail marquee. Opens in any browser, no build step;
  also pasteable into CodePen. The standalone test/preview surface.
- **`TicketDetail.svelte`** — the dogfooded reference screen (v5/v6): Pane
  structure, article subsections per Principle 2, real heroicons, real Block
  patterns. Demonstrates the system end-to-end.
- **`frontierjs-layout-converter-prompt.md`** (NEW v0.5) — system prompt for a
  separate Claude Project that converts mockup images → **FJL** (FrontierJS
  Layout), an indented DSL that's the review layer between image and HTML.

---

