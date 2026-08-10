/*
 * vocabulary.js — the other half of the system, the half with no stylesheet.
 *
 * Structure is half of @frontierjs/css and Style is the other half. This file
 * is Structure: for each term, which element it is, and what it means. One
 * answer per concept, so "card" means the same thing on Monday and Thursday.
 *
 * ── Two exports, one subject ─────────────────────────────────────────
 *
 *   VOCAB      which element and which class each term is
 *   ANATOMY    which children it expects, and the markup — further down
 *
 * ── Four readers ─────────────────────────────────────────────────────
 *
 *   guide/guide.js            renders Vocabulary and Anatomy from them
 *   guide/search.js           term entries for the search index
 *   test/specs/vocabulary...  VOCAB against the real CSSOM
 *   test/specs/anatomy...     ANATOMY against it, in both directions
 *
 * It lives here rather than inside the guide so those readers can exist. A
 * vocabulary only the documentation knows about is one nothing can check,
 * and the check runs both ways: a term with no CSS is a documented
 * component that does not render, a class with no term is a component two
 * people will call two things.
 *
 * ── The shape ────────────────────────────────────────────────────────
 *
 *   [tier, blurb, [ [Term, element, meaning, class?] ... ]]
 *
 * `class` is optional and only present when the class name is not the
 * lowercased term: Button is `.btn`, Nav is `.navlist`, Row is `.list-row`.
 * `null` means the term is carried by an element and has no class of its own
 * (Heading is `<h1>`–`<h6>`; Text is `<p>`; Section and Group are
 * structural). A wrong value here is the one way to make the test lie.
 *
 * ── Adding a term ────────────────────────────────────────────────────
 *
 * New vocabulary is a design decision, not a class. Adding CSS for something
 * unnamed fails the suite: the choice is to name it here, or to declare it a
 * tone / treatment / anatomy / container in `test/specs/vocabulary.spec.js`
 * with a reason.
 */

const VOCAB = [
  [
    "Base",
    "Not a containment tier — the two shapes every Block and Inline term is built from. Both are writable on their own, and both are declared at zero specificity in a :where() that names every composite, so a leaf class always wins.",
    [
      ["Chip", "<span>", "The inline lineage: layout and alignment, no skin. Every Button, Pill and Badge is one"],
      ["Surface", "<div> / <article>", "The block lineage: background, border, radius, and the tonal tint recipe. Every Card, Alert, Toast, Popover, Drawer and Dialog is one"],
    ],
  ],
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
      ["Tabs", '<div> + <div role="tablist">', "The control that switches Views. The buttons are <button role=\"tab\">"],
    ],
  ],
  [
    "Region",
    "Grouping and wayfinding inside a Screen.",
    [
      ["Section", "<section> / <article>", "<article> when nested inside a Section (Principle 2)", null],
      ["Group", "<div>", "A visual cluster with no semantic identity", null],
      ["Prose", "<div>", "A region of authored long-form copy, styled by element — the one place the package touches a bare <p>. Sets measure, ink and list indentation only; a Heading or Code inside keeps its own term. Spacing is the parent's: compose with Stack"],
      ["Bar", "<div>", "A horizontal strip. Layout only — no role, no keyboard contract, contents are whatever you put there"],
      ["Toolbar", '<div role="toolbar">', "A strip whose contents are controls, presented as ONE tab stop. The role promises arrow-key movement and the app owes it (Principle 6) — if you are not providing the keys, use Bar"],
      ["Divider", "<hr>", "A labelled or plain break between groups"],
      ["Nav", "<ul> + <li> + <a>", "A list of navigation links. The link is .navlink; a heading above it is .navlist-label", "navlist"],
      ["Breadcrumb", '<nav aria-label="Breadcrumb"> + <ol>', "The trail back up. The current page carries aria-current"],
      ["Pagination", '<nav aria-label="Pagination">', "Page-by-page movement through a list. Each control is .pagination-link"],
    ],
  ],
  [
    "Block",
    "Self-contained units of content.",
    [
      ["Card", "<article>", "A bounded unit of content on a surface. Write it as an <a> or a <button> and it becomes interactive — cursor, a 1px lift and a tone-following border, no modifier"],
      ["Tile", "<article>", "A compact metric or stat unit. Interactive as an <a>/<button>, like Card"],
      ["Item", "<li>", "A lightweight list entry"],
      ["Row", "<li> / <tr>", "A record entry with trailing actions", "list-row"],
      ["Feed", "<ol> + <li><article>", "A chronological stream, plotted on a connecting timeline. Each entry carries a dot and the line runs between them — a stream with no marker column is Item"],
      ["Alert", "<article>", "An inline notification"],
      ["Steps", "<ol> + <li>", "A multi-stage flow indicator"],
      ["Facts", "<dl> + <dt>/<dd>", "A label/value list"],
      ["Code", "<pre> + <code>", "A block of code"],
      ["Table", "<table>", "Tabular data. Wrap it in .table-wrap so it scrolls in its own box rather than taking the page sideways"],
      ["Disclosure", "<details> + <summary>", "A section that collapses. The native element, so it works before the JS does"],
      ["Empty", "<div>", "The stand-in for a Block that has nothing in it yet"],
    ],
  ],
  [
    "Inline",
    "Things that sit in a line of content.",
    [
      ["Button", "<button>", "An action", "btn"],
      ["Link", "<a>", "A navigation"],
      ["Pill", "<span>", "A count or very short datum — never the status; that is Badge"],
      ["Badge", "<span>", "A categorical status — never the count; that is Pill. Elsewhere 'badge' often means the count"],
      ["Field", "<input> / <select> / <textarea>", "A form control"],
      ["Switch", '<input type="checkbox" role="switch">', "An on/off control that commits immediately — not a checkbox, which commits with the form"],
      ["Heading", "<h1>–<h6>", "Outline structure (Principle 3)", null],
      ["Text", "<p> / <span>", "Prose", null],
      ["Icon", "<span aria-hidden>", "A decorative glyph"],
      ["Avatar", "<img> / <span>", "A person, org or bot marker"],
      ["Kbd", "<kbd>", "A key the user is meant to press"],
      ["Progress", "<progress>", "Determinate completion. The native element announces value and max for free"],
      ["Spinner", "<span aria-hidden>", "Indeterminate waiting. Say what is loading in a role=\"status\" region beside it — the spinner itself announces nothing"],
      ["Skeleton", "<div aria-hidden>", "A placeholder for content still arriving. Put aria-busy on the container"],
    ],
  ],
  [
    "Overlay",
    "Things that float above the Screen.",
    [
      ["Dialog", "<dialog>", "A modal, via showModal()"],
      ["Drawer", "<dialog>", "An off-canvas panel, also via showModal()"],
      ["Popover", "<article>", "An anchored floating unit"],
      ["Tooltip", '<span role="tooltip">', "An attachment, not a unit. A span, because .tooltip-anchor is inline and a div is not phrasing content"],
      ["Toast", "<article>", "A transient notification"],
    ],
  ],
  [
    "Layout",
    "Composition helpers. They own one arrangement each and no skin, so they compose onto anything, including a term from another tier. The names are Every Layout's — the vocabulary people already have.",
    [
      ["Stack", "<div>", "Children flow down with an even gap"],
      ["Cluster", "<div>", "Children flow across, wrap, and stay centred"],
      ["Center", "<div>", "One child, dead centre in both axes"],
      ["Split", "<div>", "Two-up: first item left, last item right"],
      ["Container", "<div>", "A max-width column with responsive padding"],
    ],
  ],
];

/*
 * ── NOT_A_TERM ───────────────────────────────────────────────────────
 *
 * Every class the stylesheet ships that is deliberately NOT vocabulary,
 * grouped by what it is instead. A register of decisions, not a list of
 * exceptions: `vocabulary.spec.js` fails on a class that is neither a term
 * nor in here, so a new name cannot be waved through, and it fails again
 * when an entry names a class that is no longer shipped.
 *
 * It lived in the spec until the guide needed to answer "what kind of class
 * is this" for the cheat sheet's class index. A register only the tests can
 * read is one the documentation has to guess at.
 */
const NOT_A_TERM = {
  /*
   * Tones. One variable each, free-standing, working on anything that takes
   * one. tones.css owns the names and no component may repeat them — see
   * `tone: no component file names a tone` in tones.spec.js.
   */
  tone: ['primary', 'secondary', 'muted', 'info', 'success', 'warning', 'danger'],

  /*
   * Treatments. Orthogonal, compose onto anything, name no component.
   */
  treatment: ['raised', 'outlined', 'ghost', 'bordered'],

  /*
   * Density. The third axis, and the only one that INHERITS — a tone is a
   * fact about one element, density is a fact about a region, so `dense`
   * on a Pane reaches every Card, Row and Field inside it. That is why
   * these are not Treatments despite reading like them, and why there is
   * no `.btn-sm`: the axis is named once instead of per component.
   */
  density: ['dense', 'roomy'],

  /*
   * Scoped modifiers — the fourth group the Kinds-of-class page warns about.
   * They read like Treatments and are not: each only works on one Element.
   * `striped` only on Table, `circle` only on Skeleton and Avatar, `menu`
   * only on Items. Naming them as vocabulary would imply they compose.
   */
  modifier: [
    'bottom', 'circle', 'compact', 'complete', 'disabled', 'divided', 'end',
    'focusable', 'hover', 'loading', 'menu', 'narrow', 'pills', 'removable',
    'square', 'start', 'stretch', 'striped', 'text', 'vertical', 'viewport',
    'wide', 'wrap',
  ],

  /*
   * Containers for a term. The plural holds the singular and carries no
   * meaning of its own — `items` is where Items go. Naming both would double
   * the vocabulary to say one thing.
   */
  container: ['avatars', 'items', 'rows', 'tiles'],

  /*
   * Anatomy that happens to have no hyphen, so the rule above misses it.
   * Each is a part of a term, not a term: `tab` and `tablist` belong to Tabs,
   * `step` to Steps, `navlink` to Nav.
   */
  anatomy: ['tab', 'tablist', 'step', 'navlink'],

  /*
   * The Heading term is carried by the elements; the classes exist only for
   * markup that cannot use them (Principle 3 — level is outline, not size).
   */
  heading: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'],

  /*
   * The escape hatch. Every other utility the package ships is hyphenated
   * and answers for itself in NOT_ANATOMY; `relative` is the one that is a
   * bare word and so has to be classified here. It establishes a containing
   * block and places nothing — the package still ships no positioning
   * ladder, which is why this is not a group that will grow.
   */
  utility: ['relative'],
};


/*
 * ── ANATOMY ──────────────────────────────────────────────────────────
 *
 * The other half of the structure question, and the half that was prose.
 *
 * VOCAB answers "which element and which class" for all 54 terms, and a
 * spec has checked both directions of that against the real CSSOM since
 * v0.12. It has never answered "which children" — that lived in nine of
 * the guide's 51 pages as hand-written markup, in a comment on the
 * taxonomy page, and in a convention: `vocabulary.spec.js` treated any
 * hyphenated class as Anatomy and waved it through. That convention
 * accepts `.alert-anything`, and it mislabels five real classes —
 * `.code-inline` is an alias for the element, `.sidebar-first` is a
 * modifier on Shell, `.skip-link` and `.visually-hidden` are a11y
 * utilities, `.list-row` is the Row term's own class.
 *
 * So: which parts each term owns, and one canonical markup block per
 * term. 20 terms have an anatomy; the other 34 are a single element.
 *
 * ── The shape ─────────────────────────────────────────────────────────
 *
 *   Term: {
 *     markup: '…',                     the copy-pasteable answer
 *     parts:  [[selector, meaning, 'optional'?] …],   what it OWNS
 *     uses:   ['surface-header', …]                   what it BORROWS
 *   }
 *
 * `parts` and `uses` are the distinction that makes this checkable. Every
 * anatomy class ships from exactly one file and is owned by exactly one
 * term; Card, Dialog, Drawer and Popover all borrow the Surface
 * sub-regions rather than declaring their own, which is the lineage claim
 * the package makes everywhere else. Listing them as parts on all five
 * would say there are five headers.
 *
 * A part's selector is a class (`.alert-icon`) or an element (`dt`) where
 * the part is carried by the tag and has no class — Facts is the whole
 * point of that: it ships no anatomy classes on purpose.
 *
 * ── Adding one ────────────────────────────────────────────────────────
 *
 * Ship a hyphenated class and `anatomy.spec.js` fails until it is either a
 * part of some term or listed in NOT_ANATOMY with a reason. The markup is
 * rendered by the same spec and every part must match a node in it, so a
 * block that drifts from its own parts list is caught rather than read.
 */
const ANATOMY = {
  Surface: {
    markup: `<article class="surface raised">
  <div class="surface-header">Title</div>
  <div class="surface-body">Body</div>
  <div class="surface-footer">
    <button class="btn">Save</button>
  </div>
</article>`,
    parts: [
      ['.surface-header', 'A title strip. Shares the surface border colour, so dividers stay consistent', 'optional'],
      ['.surface-body', 'The content, padded independently of the header and footer', 'optional'],
      ['.surface-footer', 'Actions. Where a Button row goes', 'optional'],
    ],
  },

  Card: {
    markup: `<article class="card">
  <div class="surface-header">Maid.Tech</div>
  <div class="surface-body">
    <p>A platform serving cleaning businesses.</p>
  </div>
  <div class="surface-footer">
    <button class="btn">View</button>
  </div>
</article>`,
    parts: [],
    /* The bleed is Card's, not the sub-region's: .card > .surface-header
       cancels the card's own padding with the same rung it was set with. */
    uses: ['surface-header', 'surface-body', 'surface-footer'],
  },

  Alert: {
    markup: `<article class="alert info">
  <div class="alert-icon" aria-hidden="true">&#9432;</div>
  <div class="alert-content">
    <strong>Heads up.</strong>
    <p>What happened, and what to do about it.</p>
  </div>
</article>`,
    parts: [
      ['.alert-icon', 'The glyph. aria-hidden, because a colour and a symbol are not the message', 'optional'],
      ['.alert-content', 'Everything else — a strong title, then prose'],
    ],
  },

  Empty: {
    markup: `<div class="empty">
  <div class="empty-icon" aria-hidden="true">&#128230;</div>
  <div class="empty-title">No invoices yet</div>
  <div class="empty-text">Create one and it will show up here.</div>
  <div class="empty-actions">
    <button class="btn">New invoice</button>
  </div>
</div>`,
    parts: [
      ['.empty-icon', 'A glyph or illustration. aria-hidden', 'optional'],
      ['.empty-title', 'What is missing, in a phrase'],
      ['.empty-text', 'Why, and what to do next', 'optional'],
      ['.empty-actions', 'The way out. Anatomy rather than a bare Button row, because the gap is the empty state’s, not the buttons’', 'optional'],
    ],
  },

  Tile: {
    markup: `<article class="tile">
  <div class="tile-label">Revenue</div>
  <div class="tile-value">&pound;48,210</div>
  <div class="tile-delta success">+12.4%</div>
</article>`,
    parts: [
      ['.tile-label', 'What is being measured'],
      ['.tile-value', 'The number, at display size'],
      ['.tile-delta', 'The change. Takes a tone, which is the only place the colour is decided', 'optional'],
    ],
  },

  Feed: {
    markup: `<ol class="feed">
  <li>
    <article class="feed-item">
      <span class="feed-dot success" aria-hidden="true"></span>
      <div class="feed-content">
        <div class="text-muted text-sm">2 hours ago</div>
        <div>Invoice #1042 was paid.</div>
      </div>
    </article>
  </li>
</ol>`,
    parts: [
      ['.feed-item', 'One event. An <article> because each entry is self-contained'],
      ['.feed-dot', 'The timeline marker. Reads --bg-mix, so any tone colours it'],
      ['.feed-content', 'When, and what'],
    ],
  },

  Steps: {
    markup: `<ol class="steps">
  <li class="step complete">
    <span class="step-marker"></span>
    <span class="step-label">Details</span>
  </li>
  <li class="step" aria-current="step">
    <span class="step-marker"></span>
    <span class="step-label">Payment</span>
    <span class="step-hint">Card or transfer</span>
  </li>
</ol>`,
    parts: [
      ['.step', 'One step. The current one is keyed off aria-current, never a class'],
      ['.step-marker', 'The numbered disc. An empty one numbers itself from its position'],
      ['.step-label', 'The step name'],
      ['.step-hint', 'A second line under the label', 'optional'],
    ],
  },

  Disclosure: {
    markup: `<details class="disclosure">
  <summary class="disclosure-summary">Advanced settings</summary>
  <div class="disclosure-body">
    <p>Anything that should start folded away.</p>
  </div>
</details>`,
    parts: [
      ['.disclosure-summary', 'The clickable row. A real <summary>, so the open state is the browser’s'],
      ['.disclosure-body', 'What unfolds. Animated by ::details-content, not by a class'],
    ],
  },

  Table: {
    markup: `<div class="table-wrap">
  <table class="table striped">
    <thead>
      <tr><th>Invoice</th><th>Client</th><th></th></tr>
    </thead>
    <tbody>
      <tr>
        <td>#1042</td>
        <td>Maid.Tech</td>
        <td class="table-actions">
          <button class="btn ghost square" aria-label="Edit">&hellip;</button>
        </td>
      </tr>
    </tbody>
  </table>
</div>`,
    parts: [
      ['.table-wrap', 'The scroll box. Without it a wide table takes the whole page sideways', 'optional'],
      ['.table-actions', 'A trailing cell of controls, right-aligned and tight', 'optional'],
    ],
  },

  Field: {
    markup: `<div class="field-group">
  <label for="email">Email</label>
  <input class="field" id="email" type="email" required>
  <div class="field-hint">We only use this for receipts.</div>
</div>`,
    parts: [
      ['.field-group', 'Label, control and hint as one unit. The label is a real <label for>', 'optional'],
      ['.field-hint', 'Help text under the control', 'optional'],
      ['.field-row', 'A control with addons welded to it — the group loses its gaps and the corners join', 'optional'],
      ['.field-addon', 'A prefix or suffix inside a .field-row: a currency mark, a unit', 'optional'],
      ['.field-check', 'A checkbox or Switch beside its own label. The <label> is the box', 'optional'],
    ],
  },

  Dialog: {
    markup: `<dialog class="dialog">
  <div class="surface-header">
    <strong>Delete invoice</strong>
    <button class="dialog-close" aria-label="Close">&times;</button>
  </div>
  <div class="surface-body">
    <p>This cannot be undone.</p>
  </div>
  <div class="surface-footer">
    <button class="btn outlined">Cancel</button>
    <button class="btn danger">Delete</button>
  </div>
</dialog>`,
    parts: [
      ['.dialog-close', 'The dismiss control in the header', 'optional'],
    ],
    uses: ['surface-header', 'surface-body', 'surface-footer'],
  },

  Drawer: {
    markup: `<dialog class="drawer from-right">
  <div class="surface-header">
    <strong>Settings</strong>
    <button class="dialog-close" aria-label="Close">&times;</button>
  </div>
  <div class="surface-body">
    <p>Anything a Dialog would hold.</p>
  </div>
  <div class="surface-footer">
    <button class="btn">Save</button>
  </div>
</dialog>`,
    parts: [],
    uses: ['surface-header', 'surface-body', 'surface-footer', 'dialog-close'],
  },

  Popover: {
    markup: `<article class="popover">
  <div class="surface-header"><strong>Quick note</strong></div>
  <div class="surface-body">Short, contextual information.</div>
</article>`,
    parts: [],
    uses: ['surface-header', 'surface-body'],
  },

  Tabs: {
    markup: `<div class="tabs">
  <div class="tablist" role="tablist" aria-label="Invoice sections">
    <button class="tab" role="tab" id="t-1" aria-selected="true" aria-controls="v-1">Summary</button>
    <button class="tab" role="tab" id="t-2" aria-selected="false" aria-controls="v-2" tabindex="-1">History</button>
  </div>
  <article class="view" role="tabpanel" id="v-1" aria-labelledby="t-1">
    The selected panel.
  </article>
</div>`,
    parts: [
      ['.tablist', 'The strip. role="tablist", and the indicator rides it'],
      ['.tab', 'One tab. Selection comes from aria-selected, never a class'],
    ],
  },

  Nav: {
    markup: `<nav class="sidebar">
  <div class="navlist-label">Workspace</div>
  <ul class="navlist">
    <li><a class="navlink" href="#" aria-current="page">Invoices</a></li>
    <li><a class="navlink" href="#">Clients <span class="badge">4</span></a></li>
  </ul>
</nav>`,
    parts: [
      ['.navlink', 'One destination. The active one carries aria-current="page"'],
      ['.navlist-label', 'A group heading above a run of links', 'optional'],
    ],
  },

  Pagination: {
    markup: `<nav class="pagination" aria-label="Pagination">
  <a class="pagination-link" href="#" aria-disabled="true">Previous</a>
  <a class="pagination-link" href="#" aria-current="page">1</a>
  <a class="pagination-link" href="#">2</a>
  <span class="pagination-gap" aria-hidden="true">&hellip;</span>
  <a class="pagination-link" href="#">9</a>
</nav>`,
    parts: [
      ['.pagination-link', 'One control — a number, or Previous/Next. Current is aria-current="page", unavailable is aria-disabled'],
      ['.pagination-gap', 'The elision between runs. aria-hidden — it is punctuation', 'optional'],
    ],
  },

  Pill: {
    markup: `<span class="pill primary removable">
  Design
  <button class="pill-close" aria-label="Remove Design">&times;</button>
</span>`,
    parts: [
      ['.pill-close', 'The remove control. Needs .removable on the Pill to make room for it', 'optional'],
    ],
  },

  Divider: {
    markup: `<hr class="divider">
<div class="divider-label">or continue with</div>`,
    parts: [
      ['.divider-label', 'The labelled form. A <div> rather than an <hr>, because an <hr> cannot hold text', 'optional'],
    ],
  },

  Item: {
    markup: `<ul class="items menu">
  <li class="item">
    <span class="item-lead">section</span>
    <span class="item-text">
      <span class="item-title">Below 640px it stacks</span>
      <span class="item-sub">Facts</span>
    </span>
  </li>
</ul>`,
    parts: [
      ['.item-lead', 'A fixed gutter before the text — a kind, a category, a shortcut. The row aligns to the baseline when one is present', 'optional'],
      ['.item-text', 'The stacked text block. Shrinkable, so a long title ellipses rather than pushing the row wider', 'optional'],
      ['.item-title', 'The line the entry is about', 'optional'],
      ['.item-sub', 'What it belongs to, or where it came from', 'optional'],
    ],
  },

  Row: {
    markup: `<ul class="rows divided">
  <li class="list-row">
    <label class="field-check">
      <input type="checkbox">
      <span>Send the invoice</span>
    </label>
    <div class="row-actions">
      <button class="btn ghost square" aria-label="Edit">&hellip;</button>
    </div>
  </li>
</ul>`,
    parts: [
      ['.row-actions', 'The trailing controls. Pushed right by the row, not by a margin', 'optional'],
    ],
  },

  Section: {
    markup: `<section aria-labelledby="s-1">
  <div class="section-header">
    <h2 id="s-1" class="h4">Recent invoices</h2>
    <button class="btn outlined">New</button>
  </div>
  <div class="stack">&hellip;</div>
</section>`,
    parts: [
      ['.section-header', 'A heading with its own actions beside it', 'optional'],
    ],
  },

  Toast: {
    markup: `<div class="toast-stack">
  <article class="toast success">Invoice sent.</article>
</div>`,
    parts: [
      ['.toast-stack', 'The corner they queue in. One per app, not one per Toast', 'optional'],
    ],
  },

  Tooltip: {
    markup: `<span class="tooltip-anchor">
  <button class="btn square" aria-label="Delete" aria-describedby="tip-1">&times;</button>
  <span class="tooltip" role="tooltip" id="tip-1">Delete invoice</span>
</span>`,
    parts: [
      ['.tooltip-anchor', 'The positioning context. The Tooltip is absolute inside it'],
    ],
  },

  Shell: {
    markup: `<div class="shell">
  <header class="topbar">
    <button class="btn ghost square sidebar-toggle" aria-label="Open navigation" aria-expanded="false">&#9776;</button>
  </header>
  <nav class="sidebar">&hellip;</nav>
  <main class="screen">&hellip;</main>
</div>`,
    parts: [
      ['.sidebar-toggle', 'The control that reveals the Sidebar below 768px. The Shell decides when it exists; opening it is the app’s job', 'optional'],
    ],
  },

  Facts: {
    /*
     * The entry that proves a part need not be a class. Facts ships no
     * anatomy classes at all — the <dl> styles its own <dt>/<dd> — and
     * saying so here is what stops someone adding `.fact-label` to make
     * the pattern look like the others.
     */
    markup: `<dl class="facts divided">
  <dt>Invoice</dt>
  <dd>#1042</dd>
  <dt>Status</dt>
  <dd><span class="badge success">Paid</span></dd>
</dl>`,
    parts: [
      ['dt', 'The label. A real <dt> — no class, on purpose'],
      ['dd', 'The value, on the same baseline as its label'],
    ],
  },

  Code: {
    markup: `<pre class="code"><code>const total = items.reduce(sum, 0)</code></pre>`,
    parts: [
      ['code', 'The code itself. Inside a <pre class="code"> it drops the inline box'],
    ],
  },
};

/*
 * Hyphenated classes that are not anatomy, and why.
 *
 * The list exists because the rule it replaces was "a hyphen means
 * anatomy", which is wrong five times and unfalsifiable the rest. Each
 * entry here is a decision; `anatomy.spec.js` fails on a hyphenated class
 * that is neither a part above nor named below, so a new one cannot be
 * waved through, and it fails again when an entry names a class the
 * stylesheet has stopped shipping.
 */
const NOT_ANATOMY = {
  'code-inline': 'An alias for the <code> element, for markup that cannot use the tag. Not a part of Code — it IS Code, spelled differently',
  'sidebar-first': 'A modifier on Shell: it swaps the grid so the Sidebar runs full height. Nothing to do with the Sidebar element',
  'skip-link': 'An a11y utility. It belongs to no term — every app has one and it sits above the Shell',
  'visually-hidden': 'An a11y utility, and the most composable class in the package',
  'list-row': 'The Row term’s own class. `.row` would collide with Bootstrap’s grid, so the concept and the class name diverge',
  'from-top': 'A direction modifier on Drawer',
  'from-right': 'A direction modifier on Drawer',
  'from-bottom': 'A direction modifier on Drawer',
  'from-left': 'A direction modifier on Drawer',
  'text-xs': 'A size utility', 'text-sm': 'A size utility', 'text-md': 'A size utility',
  'text-lg': 'A size utility', 'text-xl': 'A size utility',
  'gap-0': 'A gap utility', 'gap-3xs': 'A gap utility', 'gap-2xs': 'A gap utility',
  'gap-xs': 'A gap utility', 'gap-sm': 'A gap utility', 'gap-md': 'A gap utility',
  'gap-lg': 'A gap utility', 'gap-xl': 'A gap utility', 'gap-2xl': 'A gap utility',
  'gap-3xl': 'A gap utility', 'gap-4xl': 'A gap utility', 'gap-5xl': 'A gap utility',
  'gap-6xl': 'A gap utility',
  'clamp-1': 'A line-clamp utility', 'clamp-2': 'A line-clamp utility',
  'clamp-3': 'A line-clamp utility',
  'text-body': 'A colour utility', 'text-muted': 'A colour utility',
  'text-primary': 'A colour utility', 'text-info': 'A colour utility',
  'text-success': 'A colour utility', 'text-warning': 'A colour utility',
  'text-danger': 'A colour utility',
  'theme-default': 'A theme', 'theme-dark': 'A theme', 'theme-midnight': 'A theme',
  'theme-forest': 'A theme', 'theme-sunset': 'A theme', 'theme-elite': 'A theme',
  'theme-basecamp': 'A theme', 'theme-notebook': 'A theme',
};

/*
 * The class a row names, or null for a term carried by its element.
 *
 * The rule is stated in the header above and was being applied in three
 * places — the coverage spec, the guide's search index, and prose. It is a
 * two-branch rule with a trap in it: `row[3]` is absent when the class is
 * the lowercased term and explicitly `null` when there is no class, so a
 * truthiness check reads "Heading" as `.heading` and quietly invents a
 * class the stylesheet does not ship. One reading, asked rather than
 * copied.
 */
function vocabClass(row) {
  return row.length > 3 ? row[3] : row[0].toLowerCase()
}

/*
 * No export. This is a classic script and both readers take it as one: the
 * guide with <script src>, the test runner by inlining the source into its
 * generated page. A top-level `const` in a classic script lands in the
 * global lexical environment, so every later script sees `VOCAB`.
 *
 * It cannot be an ES module — the guide needs it to run BEFORE guide.js, and
 * module scripts are deferred until after every classic one. It cannot be CJS
 * either: the package is "type": "module".
 */

