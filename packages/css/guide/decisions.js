/*
 * decisions.js — the routing tree behind the Learn page's wizard.
 *
 * The guide's other 48 pages are a reference: they answer "how does Badge
 * work" for someone who already knows they want a Badge. This file answers
 * the question that comes first and that nothing else in the package
 * answers — "I have a thing to build, which term is it?"
 *
 * ── What is here and what is deliberately not ─────────────────────────
 *
 * An outcome names a VOCABULARY TERM and nothing else about it. The
 * element, the class and the meaning are read out of ../vocabulary.js at
 * render time, because those are package facts and a second copy of a
 * package fact is a copy that goes stale silently. What lives here is only
 * what the reference cannot hold: the QUESTION that reaches a term, and
 * the near misses it is confused with.
 *
 * `instead` is the whole point of the exercise. Pill/Badge, Bar/Toolbar,
 * Alert/Toast/Dialog and Item/Row are each two terms that look alike and
 * promise different things, and every one of them has cost somebody an
 * afternoon. A reference page cannot state a distinction it does not own
 * half of; this file owns both halves.
 *
 * ── The contract with the vocabulary ──────────────────────────────────
 *
 * Both directions are checked by test/specs/decisions.spec.js:
 *
 *   every outcome names a term that exists  — or the wizard emits a class
 *                                             the stylesheet does not ship
 *   every term is reachable by some path    — or a component ships and the
 *                                             teacher never mentions it
 *
 * The second is the one nothing else would catch. EXCLUDED below is the
 * only escape, and it takes a reason.
 *
 * A classic script, like vocabulary.js and for the same reason: test/run.js
 * inlines the source into a page whose specs are classic scripts.
 */

/*
 * Terms that are deliberately not an outcome.
 *
 * Chip and Surface are the two LINEAGES — the shared base every Inline and
 * every Block term is built from. You never choose them; you choose a
 * Button and get the chip lineage with it. Offering them as an answer would
 * teach that `class="chip"` is a normal thing to write, and the one place
 * it is (a bare inline capsule with no term of its own) is rare enough that
 * the Composition page is the right place to learn it.
 */
var EXCLUDED = {
  Chip: 'a lineage, not a choice — you get it by choosing Button, Pill or Badge',
  Surface: 'a lineage, not a choice — you get it by choosing Card, Alert, Dialog…',
};

/* ── The tree ──────────────────────────────────────────────────────────
 *
 * A question's option either goes `to` another question or lands `on` an
 * outcome. Nothing else; a wizard whose steps can do more than one thing
 * is a wizard nobody can follow.
 */

var QUESTIONS = {
  root: {
    ask: 'What are you reaching for?',
    note: 'Start with where it lives on the page, not with what it looks like. The look is the last decision, not the first.',
    options: [
      { label: 'Something in a line of text', hint: 'a button, a status, a number, an avatar', to: 'inline' },
      { label: 'A block of content', hint: 'a card, a table, a list entry, a notification', to: 'block' },
      { label: 'Something floating above the page', hint: 'a modal, a menu, a toast', to: 'overlay' },
      { label: 'Navigation or wayfinding', hint: 'links, tabs, a breadcrumb, a strip of controls', to: 'nav' },
      { label: 'A form control', hint: 'anything that takes a value', to: 'form' },
      { label: 'Arrangement only, no skin', hint: 'spacing and alignment', to: 'layout' },
      { label: 'Text itself', hint: 'a heading or a paragraph', to: 'text' },
      { label: 'The application shell', hint: 'the frame the whole app sits in', to: 'frame' },
    ],
  },

  /* ── Inline ─────────────────────────────────────────────────────── */

  inline: {
    ask: 'What does it do?',
    options: [
      { label: 'Performs an action', hint: 'saves, deletes, opens something', on: 'Button' },
      { label: 'Goes somewhere', hint: 'another page, another site', on: 'Link' },
      { label: 'Shows a number', hint: '12, 99+, a count, a total', on: 'Pill' },
      { label: 'Shows a status or category', hint: 'active, overdue, draft', on: 'Badge' },
      { label: 'Identifies a person or org', on: 'Avatar' },
      { label: 'Names a key to press', hint: '⌘K, Esc', on: 'Kbd' },
      { label: 'Is a decorative glyph', hint: 'no meaning of its own', on: 'Icon' },
      { label: 'Says something is happening', to: 'waiting' },
    ],
  },

  waiting: {
    ask: 'How much do you know about the wait?',
    note: 'Three different answers, and picking the wrong one is an accessibility bug rather than a style choice — see each.',
    options: [
      { label: 'How far along it is', hint: 'a percentage, 7 of 12', on: 'Progress' },
      { label: 'Nothing — it is just working', on: 'Spinner' },
      { label: 'The shape of what is coming', hint: 'three rows of a table, a card', on: 'Skeleton' },
    ],
  },

  /* ── Block ──────────────────────────────────────────────────────── */

  block: {
    ask: 'What kind of block?',
    options: [
      { label: 'A bounded unit of content', hint: 'heading, body, maybe actions', to: 'unit' },
      { label: 'One entry in a list', to: 'entry' },
      { label: 'Something the user must notice', hint: 'and that stays until dealt with', on: 'Alert' },
      { label: 'Rows and columns of data', on: 'Table' },
      { label: 'Label and value pairs', hint: 'a summary, a spec sheet', on: 'Facts' },
      { label: 'Progress through a multi-stage flow', hint: 'checkout, onboarding', on: 'Steps' },
      { label: 'A chronological stream on a timeline', hint: 'activity, history, an audit trail', on: 'Feed' },
      { label: 'A section that collapses', on: 'Disclosure' },
      { label: 'Code', on: 'Code' },
      { label: 'Nothing yet — there is no content', on: 'Empty' },
      { label: 'A labelled major subdivision', hint: 'and it needs to be findable', to: 'grouping' },
    ],
  },

  unit: {
    ask: 'How much is inside it?',
    options: [
      { label: 'Content — a heading, prose, maybe actions', on: 'Card' },
      { label: 'One number and its label', hint: 'a metric, a stat', on: 'Tile' },
    ],
  },

  entry: {
    ask: 'Does the entry carry controls of its own?',
    note: 'The distinction is trailing actions, not length. An entry with a button on the right needs the space reserved for it.',
    options: [
      { label: 'No — it is text, maybe an icon', on: 'Item' },
      { label: 'Yes — a record with actions on the right', on: 'Row' },
    ],
  },

  grouping: {
    ask: 'Does it have a name a reader could jump to?',
    note: 'Principle 2: if it has a heading, it is a landmark and belongs in the accessibility tree. If it only exists to hold things together visually, it is a div and should stay one. The third answer is about what is INSIDE rather than what it is called — authored copy is styled by element, which is the one case the package touches a bare <p>.',
    options: [
      { label: 'Yes — it has a heading', on: 'Section' },
      { label: 'No — it is visual grouping only', on: 'Group' },
      { label: 'It holds written copy — paragraphs and lists', on: 'Prose' },
    ],
  },

  /* ── Overlay ────────────────────────────────────────────────────── */

  overlay: {
    ask: 'How does it behave?',
    options: [
      { label: 'Blocks the page until dealt with', to: 'modal' },
      { label: 'Anchored to whatever opened it', to: 'anchored' },
      { label: 'Appears, says one thing, leaves', on: 'Toast' },
    ],
  },

  modal: {
    ask: 'Where does it come from?',
    options: [
      { label: 'The middle of the screen', on: 'Dialog' },
      { label: 'An edge, sliding in', on: 'Drawer' },
    ],
  },

  anchored: {
    ask: 'Can the user interact with what is inside?',
    note: 'This one is a contract, not a look. A tooltip is a LABEL for the thing it is attached to; the moment it contains something clickable, a keyboard or touch user cannot reach it.',
    options: [
      { label: 'It is a list of commands to pick from', hint: 'a dropdown menu, an actions menu, a ⋯ menu', on: 'Popover' },
      { label: 'Yes — it holds other controls or content', on: 'Popover' },
      { label: 'No — it is a label on hover or focus', on: 'Tooltip' },
    ],
  },

  /* ── Navigation ─────────────────────────────────────────────────── */

  nav: {
    ask: 'What kind of wayfinding?',
    options: [
      { label: 'A list of destinations', hint: 'a sidebar, a menu', on: 'Nav' },
      { label: 'The trail back up', on: 'Breadcrumb' },
      { label: 'Page by page through a long list', on: 'Pagination' },
      { label: 'Switching views without leaving the page', on: 'Tabs' },
      { label: 'A horizontal strip holding things', to: 'strip' },
      { label: 'A break between groups', on: 'Divider' },
    ],
  },

  strip: {
    ask: 'Are its contents controls, and will you wire arrow keys?',
    note: 'Principle 6: a role is a promise the app has to keep. role="toolbar" tells a screen reader the strip is ONE tab stop and the arrow keys move within it — if nothing implements that, you have made the strip harder to use than a plain div.',
    options: [
      { label: 'Yes — controls, and I will provide the keys', on: 'Toolbar' },
      { label: 'No, or not sure', hint: 'mixed content, or no keyboard work planned', on: 'Bar' },
    ],
  },

  /* ── Forms ──────────────────────────────────────────────────────── */

  form: {
    ask: 'What does the control do?',
    options: [
      { label: 'Takes a value', hint: 'text, number, date, or a <select> — the plain dropdown of values', on: 'Field' },
      { label: 'Turns something on or off, immediately', hint: 'the change is saved as you flip it', on: 'Switch' },
      { label: 'Turns something on or off, with the form', hint: 'nothing happens until submit', on: 'Field' },
    ],
  },

  /* ── Layout ─────────────────────────────────────────────────────── */

  layout: {
    ask: 'What arrangement?',
    note: 'These own one arrangement each and no skin, so they compose onto anything — including a term from another tier.',
    options: [
      { label: 'Children flow down, evenly spaced', on: 'Stack' },
      { label: 'Children flow across and wrap', on: 'Cluster' },
      { label: 'One child, dead centre both ways', on: 'Center' },
      { label: 'Two things pushed to opposite ends', on: 'Split' },
      { label: 'A max-width page column', on: 'Container' },
    ],
  },

  /* ── Text ───────────────────────────────────────────────────────── */

  text: {
    ask: 'Which?',
    note: 'Principle 3: heading level is outline structure, not size. Pick the level the document needs and change the size with a class if you must.',
    options: [
      { label: 'A heading', hint: 'it names the section below it', on: 'Heading' },
      { label: 'Prose', on: 'Text' },
    ],
  },

  /* ── Frame ──────────────────────────────────────────────────────── */

  frame: {
    ask: 'Which part of the shell?',
    note: 'You get one of each of these per application, not per screen. They persist across navigation — that is what makes them Frame rather than Page.',
    options: [
      { label: 'The whole application surface', on: 'App' },
      { label: 'The grid holding the parts together', on: 'Shell' },
      { label: 'The bar across the top', on: 'Topbar' },
      { label: 'The navigation column', on: 'Sidebar' },
      { label: 'The routed page body', on: 'Screen' },
      { label: 'A labelled subdivision of that body', on: 'Pane' },
      { label: 'One switchable view inside it', on: 'View' },
    ],
  },
};

/* ── The outcomes ──────────────────────────────────────────────────────
 *
 * `term`      the vocabulary term. The element and class come from there.
 * `page`      the reference page to send someone to next.
 * `lead`      one sentence: what you have just decided.
 * `markup`    a function of the assembled class chain. A function rather
 *             than a string because the compound terms are compound —
 *             a Table is four elements and teaching it as one is a lie.
 * `tones`     may it carry a tone.
 * `treatments`which treatments apply to THIS term. Not all of them apply
 *             to all of it, and offering one that does nothing teaches
 *             that treatments are decorative.
 * `states`    what carries state. Almost always a platform attribute
 *             rather than a class, which is the lesson.
 * `instead`   the near misses. `term` must also exist in the vocabulary.
 * `live`      false when the markup cannot render in a preview box: a
 *             <body>, a <dialog> that needs showModal(), or a fixed-position
 *             stack that would cover the page it is being explained on.
 *             Absent means it previews.
 */

var OUTCOMES = {
  /* ── Inline ─────────────────────────────────────────────────────── */

  Button: {
    page: 'buttons',
    lead: 'An action, taken now, on this page.',
    markup: function (c) { return '<button class="' + c + '" type="button">Save changes</button>' },
    tones: true,
    treatments: ['outlined', 'ghost', 'raised', 'link', 'square'],
    states: [
      { label: 'Disabled', apply: 'disabled', why: 'the native attribute — it removes the button from the tab order too' },
      { label: 'Busy', apply: 'aria-busy="true"', cls: 'loading', why: '.loading paints the spinner; aria-busy is what announces it' },
    ],
    instead: [
      { term: 'Link', when: 'it navigates — even when it is styled as a button. Right-click, middle-click and "open in new tab" all depend on it being an <a>' },
      { term: 'Switch', when: 'it toggles a setting and the change commits immediately' },
    ],
  },

  Link: {
    page: 'links',
    lead: 'A navigation. It has an href and it goes somewhere.',
    markup: function (c) { return '<a class="' + c + '" href="/settings">Account settings</a>' },
    tones: true,
    treatments: [],
    states: [
      { label: 'Current page', apply: 'aria-current="page"', why: 'the platform carries it, so no .active class exists to forget' },
    ],
    instead: [
      { term: 'Button', when: 'it acts on this page rather than going somewhere. `.btn.link` is a BUTTON that looks like a link, which is a different thing again' },
    ],
  },

  Pill: {
    page: 'badges',
    lead: 'A number. A count, a total, an unread tally.',
    markup: function (c) { return '<span class="' + c + '">12</span>' },
    tones: true,
    treatments: [],
    note: 'There is no .pill.outlined — outlined is a Button treatment. A quieter pill is a quieter tone.',
    states: [],
    instead: [
      { term: 'Badge', when: 'the content is a word rather than a number. This is the pair the industry disagrees with us about: elsewhere "badge" usually means the count' },
    ],
  },

  Badge: {
    page: 'badges',
    lead: 'A categorical status. One word, drawn from a fixed set.',
    markup: function (c) { return '<span class="' + c + '">Active</span>' },
    tones: true,
    treatments: [],
    note: 'There is no .badge.outlined — outlined is a Button treatment. Reach for a different tone instead.',
    states: [],
    instead: [
      { term: 'Pill', when: 'the content is a number' },
      { term: 'Alert', when: 'the status needs a sentence and an action, not a word' },
    ],
  },

  Avatar: {
    page: 'avatar',
    lead: 'A person, an org or a bot, as a marker.',
    markup: function (c) { return '<img class="' + c + '" src="/u/12.jpg" alt="Dana Ortiz">' },
    tones: false,
    treatments: [],
    note: 'Square it off with --avatar-radius rather than a class, so a theme can do it globally. Size the same way, with --avatar-size.',
    states: [],
    instead: [
      { term: 'Icon', when: 'the glyph is decorative and names nobody' },
    ],
  },

  Kbd: {
    page: 'code',
    lead: 'A key the reader is meant to press.',
    markup: function (c) { return '<kbd class="' + c + '">⌘</kbd><kbd class="' + c + '">K</kbd>' },
    tones: false,
    treatments: [],
    states: [],
    instead: [
      { term: 'Code', when: 'it is a command to run rather than a key to press' },
    ],
  },

  Icon: {
    page: 'icons',
    lead: 'A decorative glyph. The package ships none — it sizes what you bring.',
    markup: function (c) { return '<span class="' + c + '" aria-hidden="true">…</span>' },
    tones: false,
    treatments: [],
    states: [],
    instead: [
      { term: 'Avatar', when: 'it identifies somebody' },
    ],
  },

  Progress: {
    page: 'feedback',
    lead: 'Determinate completion — you know the number.',
    markup: function (c) { return '<progress class="' + c + '" value="70" max="100">70%</progress>' },
    tones: true,
    treatments: [],
    states: [],
    instead: [
      { term: 'Spinner', when: 'you do not know how far along it is' },
    ],
  },

  Spinner: {
    page: 'feedback',
    lead: 'Indeterminate waiting.',
    markup: function (c) {
      return '<span class="' + c + '" aria-hidden="true"></span>\n<span role="status">Loading orders…</span>'
    },
    tones: true,
    treatments: [],
    states: [],
    instead: [
      { term: 'Progress', when: 'there is a percentage to show' },
      { term: 'Skeleton', when: 'you know the shape of what is arriving — it is less jarring than a spinner that swaps for a full layout' },
    ],
  },

  Skeleton: {
    page: 'feedback',
    lead: 'A placeholder in the shape of the content still arriving.',
    markup: function (c) {
      return '<div aria-busy="true">\n  <div class="' + c + '"></div>\n  <div class="' + c + '"></div>\n</div>'
    },
    tones: false,
    treatments: ['circle'],
    states: [],
    instead: [
      { term: 'Empty', when: 'nothing is coming — the list is genuinely empty' },
    ],
  },

  /* ── Block ──────────────────────────────────────────────────────── */

  Card: {
    page: 'cards',
    lead: 'A bounded unit of content that stands on its own.',
    markup: function (c) {
      return '<article class="' + c + '">\n  <h3>Invoice #4021</h3>\n  <p>Due in 6 days.</p>\n</article>'
    },
    tones: true,
    treatments: ['raised', 'outlined'],
    states: [],
    instead: [
      { term: 'Tile', when: 'it is one number and a label' },
      { term: 'Group', when: 'it needs no border and no identity — it is just holding things together' },
    ],
  },

  Tile: {
    page: 'tiles',
    lead: 'One metric, its label, and optionally its movement.',
    markup: function (c) {
      return '<article class="' + c + '">\n  <span class="tile-label">Revenue</span>\n  <span class="tile-value">£48,120</span>\n</article>'
    },
    tones: true,
    treatments: ['raised', 'outlined'],
    states: [],
    instead: [
      { term: 'Card', when: 'there is prose in it' },
      { term: 'Facts', when: 'you have several label/value pairs rather than one headline number' },
    ],
  },

  Item: {
    page: 'items',
    lead: 'A lightweight list entry. Text, maybe an icon.',
    markup: function (c) {
      return '<ul class="items">\n  <li class="' + c + '">Deploy to production</li>\n  <li class="' + c + '">Rotate credentials</li>\n</ul>'
    },
    tones: false,
    treatments: [],
    note: 'menu goes on the CONTAINER — <ul class="items menu"> — not on the entry. It is a property of the list, not of one row in it. It is also half of a dropdown menu: put this list inside a Popover, and put a real <button> or <a> inside each row, because an <li> takes no keyboard. When an entry needs more than one line — a title with a category under it, as a search result or a palette row does — item-text stacks them and item-lead is the gutter in front; the row aligns to the baseline on its own once there is a lead.',
    states: [],
    instead: [
      { term: 'Row', when: 'the entry has controls on the right' },
    ],
  },

  Row: {
    page: 'rows',
    lead: 'A record with trailing actions.',
    markup: function (c) {
      return '<ul class="rows divided">\n  <li class="' + c + '">\n    <span>api-gateway</span>\n    <button class="btn ghost square" aria-label="Options">⋯</button>\n  </li>\n</ul>'
    },
    tones: false,
    treatments: [],
    note: 'hover and divided go on the CONTAINER — <ul class="rows divided hover">. Both are statements about the list, and divided is about the gap BETWEEN two entries, which one entry cannot own.',
    states: [],
    instead: [
      { term: 'Item', when: 'there are no trailing controls' },
      { term: 'Table', when: 'the entries have several aligned columns a reader will compare down' },
    ],
  },

  Alert: {
    page: 'alerts',
    lead: 'An inline notification that stays until it is dealt with.',
    markup: function (c) {
      return '<article class="' + c + '" role="alert">\n  <div class="alert-icon" aria-hidden="true">!</div>\n  <div class="alert-content">\n    <strong>Payment failed</strong>\n    <p>Update the card on file to continue.</p>\n  </div>\n</article>'
    },
    tones: true,
    treatments: [],
    states: [],
    instead: [
      { term: 'Toast', when: 'it is transient — it should leave on its own' },
      { term: 'Dialog', when: 'the user must answer before doing anything else' },
      { term: 'Badge', when: 'a single status word would say it' },
    ],
  },

  Table: {
    page: 'tables',
    lead: 'Tabular data — rows a reader compares down columns.',
    markup: function (c) {
      return '<div class="table-wrap">\n  <table class="' + c + '">\n    <thead><tr><th>Service</th><th>Status</th></tr></thead>\n    <tbody><tr><td>api-gateway</td><td><span class="badge success">Healthy</span></td></tr></tbody>\n  </table>\n</div>'
    },
    tones: false,
    treatments: ['striped', 'hover', 'compact'],
    states: [],
    instead: [
      { term: 'Facts', when: 'it is one record’s label/value pairs rather than many records' },
      { term: 'Row', when: 'there is one column of content plus actions' },
    ],
    note: 'The .table-wrap is not optional. Without it one long row pushes its grid track wider than the viewport and takes the whole page sideways.',
  },

  Facts: {
    page: 'facts',
    lead: 'Label and value pairs about one thing.',
    markup: function (c) {
      return '<dl class="' + c + '">\n  <dt>Region</dt><dd>eu-west-2</dd>\n  <dt>Instance</dt><dd>t3.medium</dd>\n</dl>'
    },
    tones: false,
    treatments: ['divided'],
    states: [],
    instead: [
      { term: 'Table', when: 'you have many records with the same fields' },
    ],
  },

  Steps: {
    page: 'steps',
    lead: 'Where the user is in a flow with a known number of stages.',
    markup: function (c) {
      /* The empty .step-marker numbers itself from its position — the disc
         and the connector between discs are both drawn off it, so a step
         without one is an unstyled list item. */
      return '<ol class="' + c + '" aria-label="Checkout progress">\n  <li class="step complete"><span class="step-marker"></span><span class="step-label">Cart</span></li>\n  <li class="step" aria-current="step"><span class="step-marker"></span><span class="step-label">Payment</span></li>\n  <li class="step"><span class="step-marker"></span><span class="step-label">Confirm</span></li>\n</ol>'
    },
    tones: true,
    treatments: ['vertical'],
    states: [
      { label: 'Current stage', apply: 'aria-current="step"', why: 'on the <li>. The style follows the attribute, so there is no second source of truth' },
    ],
    instead: [
      { term: 'Progress', when: 'the stages have no names' },
      { term: 'Tabs', when: 'the user may move between them freely — steps imply an order' },
    ],
  },

  Feed: {
    page: 'feed',
    lead: 'A chronological stream on a connecting timeline — activity, history, an audit trail. The dot column and the line between entries are the Feed; a stream without them is a list of Items.',
    markup: function (c) {
      /* Two entries, because the connecting line is drawn by
         `:not(:last-child)` — a one-entry sample renders a dot and no
         timeline, which is the shape this term exists to distinguish. */
      return '<ol class="' + c + '">\n  <li>\n    <article class="feed-item">\n      <span class="feed-dot success" aria-hidden="true"></span>\n      <div class="feed-content">\n        <time class="text-muted text-sm" datetime="2026-08-08T09:14">09:14</time>\n        <p><strong>Dana</strong> deployed <code>api-gateway</code></p>\n      </div>\n    </article>\n  </li>\n  <li>\n    <article class="feed-item">\n      <span class="feed-dot" aria-hidden="true"></span>\n      <div class="feed-content">\n        <time class="text-muted text-sm" datetime="2026-08-08T08:02">08:02</time>\n        <p><strong>Ola</strong> opened a rollback window</p>\n      </div>\n    </article>\n  </li>\n</ol>'
    },
    tones: false,
    treatments: [],
    states: [],
    instead: [
      { term: 'Item', when: 'the entries have no time and no order — or they do, but you do not want the dot-and-line column' },
    ],
  },

  Disclosure: {
    page: 'disclosure',
    lead: 'A section that collapses. The native element, so it works before your JavaScript does.',
    markup: function (c) {
      return '<details class="' + c + '">\n  <summary class="disclosure-summary">Advanced settings</summary>\n  <div class="disclosure-body">\n    <p>Nothing here needs changing.</p>\n  </div>\n</details>'
    },
    tones: false,
    treatments: [],
    states: [
      { label: 'Open', apply: 'open', why: 'the native attribute; the browser owns the toggle and the keyboard' },
    ],
    instead: [
      { term: 'Drawer', when: 'it should cover the page rather than push it down' },
    ],
  },

  Code: {
    page: 'code',
    lead: 'A block of code.',
    markup: function (c) { return '<pre class="' + c + '"><code>bun run test</code></pre>' },
    tones: false,
    treatments: [],
    states: [],
    instead: [
      { term: 'Kbd', when: 'it is a key to press' },
    ],
    note: 'The nested <code> is not decoration — it is what says "this is code" rather than "this is preformatted text".',
  },

  Empty: {
    page: 'feedback',
    lead: 'The stand-in for a Block that has nothing in it.',
    markup: function (c) {
      return '<div class="' + c + '">\n  <div class="empty-icon" aria-hidden="true">◎</div>\n  <h3 class="empty-title">No deployments yet</h3>\n  <p class="empty-text">Ship one and it will show up here.</p>\n  <div class="empty-actions">\n    <button class="btn primary" type="button">Deploy</button>\n  </div>\n</div>'
    },
    tones: false,
    treatments: [],
    states: [],
    instead: [
      { term: 'Skeleton', when: 'content IS coming — it just has not arrived' },
    ],
  },

  Section: {
    page: 'sectionheader',
    lead: 'A labelled subdivision. It has a heading, so it is a landmark.',
    markup: function () {
      return '<section aria-labelledby="billing-h">\n  <h2 id="billing-h">Billing</h2>\n  …\n</section>'
    },
    tones: false,
    treatments: [],
    states: [],
    instead: [
      { term: 'Group', when: 'there is no heading — a landmark nobody can name is noise in the accessibility tree' },
      { term: 'Pane', when: 'it is one of the major subdivisions of a whole Screen' },
    ],
    note: 'No class. The element and the aria-labelledby are the whole term — Principle 2.',
  },

  Group: {
    page: 'layouts',
    lead: 'Visual grouping with no semantic identity.',
    markup: function () { return '<div class="stack">\n  …\n</div>' },
    tones: false,
    treatments: [],
    states: [],
    instead: [
      { term: 'Section', when: 'it has a heading' },
      { term: 'Card', when: 'it needs a border and a background of its own' },
    ],
    note: 'No class of its own. A Group is a <div> plus whichever Layout term arranges it.',
  },

  Prose: {
    page: 'layouts',
    lead: 'A region of authored copy, styled by element.',
    markup: function () {
      return '<div class="prose stack">\n  <p>…</p>\n  <ul>\n    <li>…</li>\n  </ul>\n</div>'
    },
    tones: false,
    treatments: [],
    states: [],
    instead: [
      { term: 'Text', when: 'it is one paragraph — a lone <p> does not need a region around it' },
      { term: 'Card', when: 'the copy needs a surface of its own rather than just a measure' },
    ],
    note: 'The one place the package styles a bare <p>, and only inside a box that opted in by name. It sets measure, ink and list indent — nothing a Heading, Code or Link already owns — so it can wrap a whole region without arguing with what is in it. Spacing between blocks is the parent\'s: compose with Stack.',
  },

  /* ── Overlay ────────────────────────────────────────────────────── */

  Dialog: {
    live: false,
    page: 'dialogs',
    lead: 'A modal. The page waits.',
    markup: function (c) {
      return '<dialog class="' + c + '" id="confirm">\n  <h2>Delete workspace?</h2>\n  <p>This cannot be undone.</p>\n  <form method="dialog">\n    <button class="btn ghost">Cancel</button>\n    <button class="btn danger">Delete</button>\n  </form>\n</dialog>'
    },
    tones: true,
    treatments: [],
    states: [],
    instead: [
      { term: 'Drawer', when: 'it should slide in from an edge' },
      { term: 'Alert', when: 'the page does not need to stop' },
    ],
    note: 'Open it with showModal(), never by setting the open attribute — showModal() is what gives you the focus trap, the backdrop and Esc.',
  },

  Drawer: {
    live: false,
    page: 'drawers',
    lead: 'An off-canvas panel, from an edge.',
    markup: function (c) {
      return '<dialog class="' + c + ' from-right">\n  <h2>Filters</h2>\n  …\n</dialog>'
    },
    tones: true,
    treatments: [],
    states: [],
    instead: [
      { term: 'Dialog', when: 'it belongs in the middle of the screen' },
      { term: 'Sidebar', when: 'it is persistent navigation rather than a temporary panel' },
    ],
  },

  Popover: {
    page: 'popovers',
    lead: 'An anchored floating unit you can interact with. A dropdown menu is this, plus a list.',
    markup: function (c) {
      return (
        '<button class="btn" popovertarget="actions">Actions</button>\n\n' +
        '<article class="' + c + '" id="actions" popover>\n' +
        '  <ul class="items menu" role="menu">\n' +
        '    <li role="none"><button class="item" role="menuitem" type="button">Rename</button></li>\n' +
        '    <li role="none"><button class="item" role="menuitem" type="button">Duplicate</button></li>\n' +
        '  </ul>\n' +
        '</article>'
      )
    },
    tones: true,
    treatments: [],
    states: [],
    instead: [
      { term: 'Tooltip', when: 'it is only a label and holds nothing clickable' },
      { term: 'Dialog', when: 'the rest of the page should be unreachable while it is open' },
      { term: 'Field', when: 'it is a plain <select> — a dropdown of VALUES to submit, not commands to run' },
    ],
    note: 'There is no Menu term and no .menu component, because a menu is three things and only two of them are CSS: this popover is the surface, .items.menu is the list, and role="menu" plus arrow-key movement is owed by whatever opens it. Naming it would promise the keyboard — the same reason Bar and Toolbar are two terms. Note the buttons: .items.menu styles a row to look clickable, and an <li> is not focusable, so the control goes INSIDE the row.',
  },

  Tooltip: {
    page: 'tooltips',
    lead: 'A label for the thing it is attached to. Not a unit.',
    markup: function (c) {
      return '<span class="tooltip-anchor">\n  <button class="btn ghost square" aria-describedby="tip">?</button>\n  <div class="' + c + '" id="tip" role="tooltip">Rotates every 90 days</div>\n</span>'
    },
    tones: false,
    treatments: [],
    states: [],
    instead: [
      { term: 'Popover', when: 'anything inside it can be clicked — a tooltip’s contents are unreachable by keyboard and touch' },
    ],
  },

  Toast: {
    live: false,
    page: 'toasts',
    lead: 'Transient. It appears, says one thing, and leaves.',
    markup: function (c) {
      return '<div class="toast-stack">\n  <article class="' + c + '" role="status">Saved.</article>\n</div>'
    },
    tones: true,
    treatments: [],
    states: [],
    instead: [
      { term: 'Alert', when: 'it must stay until acted on. Anything a user has to act on must not be able to time out' },
    ],
  },

  /* ── Navigation ─────────────────────────────────────────────────── */

  Nav: {
    page: 'nav',
    lead: 'A list of destinations.',
    markup: function (c) {
      return '<nav aria-label="Main">\n  <ul class="' + c + '">\n    <li><a class="navlink" href="/apps" aria-current="page">Apps</a></li>\n    <li><a class="navlink" href="/servers">Servers</a></li>\n  </ul>\n</nav>'
    },
    tones: false,
    treatments: [],
    states: [
      { label: 'Current page', apply: 'aria-current="page"', why: 'on the <a>. There is no .active class in this package' },
    ],
    instead: [
      { term: 'Tabs', when: 'it switches a region of this page rather than navigating' },
      { term: 'Breadcrumb', when: 'it shows where you are rather than where you can go' },
    ],
  },

  Breadcrumb: {
    page: 'nav',
    lead: 'The trail back up the hierarchy.',
    markup: function (c) {
      return '<nav class="' + c + '" aria-label="Breadcrumb">\n  <ol>\n    <li><a href="/">Home</a></li>\n    <li><a href="/apps">Apps</a></li>\n    <li aria-current="page">api-gateway</li>\n  </ol>\n</nav>'
    },
    tones: false,
    treatments: [],
    states: [
      { label: 'Where you are', apply: 'aria-current="page"', why: 'on the last item, which is not a link' },
    ],
    instead: [
      { term: 'Nav', when: 'the items are siblings rather than ancestors' },
    ],
  },

  Pagination: {
    page: 'nav',
    lead: 'Page-by-page movement through a long list.',
    markup: function (c) {
      return '<nav class="' + c + '" aria-label="Pagination">\n  <a class="pagination-link" href="?p=1">1</a>\n  <a class="pagination-link" href="?p=2" aria-current="page">2</a>\n  <a class="pagination-link" href="?p=3">3</a>\n</nav>'
    },
    tones: false,
    treatments: [],
    states: [
      { label: 'Current page', apply: 'aria-current="page"', why: 'again the platform, again no class' },
    ],
    instead: [
      { term: 'Steps', when: 'the stages are named and ordered' },
    ],
  },

  Tabs: {
    page: 'tabs',
    lead: 'Switching between views without leaving the page.',
    markup: function (c) {
      return '<div class="' + c + '">\n  <div class="tablist" role="tablist" aria-label="Environment">\n    <button class="tab" role="tab" aria-selected="true">Production</button>\n    <button class="tab" role="tab" aria-selected="false">Staging</button>\n  </div>\n  <article class="view" role="tabpanel">…</article>\n</div>'
    },
    tones: false,
    treatments: ['vertical'],
    note: 'The tone and the pills/stretch treatments go on the TABLIST, not on .tabs — --bg-mix is element-scoped, so a tone on the wrapper never reaches the tabs. Only vertical is a property of the whole component.',
    states: [
      { label: 'Selected tab', apply: 'aria-selected="true"', why: 'the style follows the attribute — set the attribute and the look follows' },
    ],
    instead: [
      { term: 'Nav', when: 'choosing changes the URL and the whole Screen' },
      { term: 'Steps', when: 'the order matters and you cannot skip ahead' },
    ],
  },

  Bar: {
    page: 'bar',
    lead: 'A horizontal strip. Layout only — no role, no promises.',
    markup: function (c) {
      return '<div class="' + c + '">\n  <h2>Deployments</h2>\n  <button class="btn primary" type="button">New</button>\n</div>'
    },
    tones: false,
    treatments: ['start', 'center', 'end', 'bordered'],
    states: [],
    instead: [
      { term: 'Toolbar', when: 'the contents are controls AND you will wire arrow-key movement' },
    ],
  },

  Toolbar: {
    page: 'bar',
    lead: 'A strip of controls presented as one tab stop.',
    markup: function (c) {
      return '<div class="' + c + '" role="toolbar" aria-label="Formatting">\n  <button class="btn ghost square" type="button">B</button>\n  <button class="btn ghost square" type="button">I</button>\n</div>'
    },
    tones: false,
    treatments: ['start', 'center', 'end', 'bordered'],
    states: [],
    instead: [
      { term: 'Bar', when: 'you are not implementing arrow-key movement. The role is a promise, and an unkept one leaves the strip harder to use than a plain div' },
    ],
  },

  Divider: {
    page: 'divider',
    lead: 'A break between groups, labelled or plain.',
    markup: function (c) { return '<hr class="' + c + '">' },
    tones: false,
    treatments: [],
    states: [],
    instead: [
      { term: 'Section', when: 'what you actually want is a heading' },
    ],
  },

  /* ── Forms ──────────────────────────────────────────────────────── */

  Field: {
    page: 'inputs',
    lead: 'A form control that takes a value.',
    markup: function (c) {
      return '<div class="field-group">\n  <label for="email">Email</label>\n  <input class="' + c + '" id="email" type="email" required>\n  <p class="field-hint">We only use this for receipts.</p>\n</div>'
    },
    tones: true,
    treatments: [],
    states: [
      { label: 'Invalid', apply: ':user-invalid', why: 'a pseudo-class, not a class — it fires only after the user has interacted, so an empty untouched form is not painted red' },
      { label: 'Disabled', apply: 'disabled', why: 'the native attribute' },
    ],
    instead: [
      { term: 'Switch', when: 'it is on/off and commits immediately' },
    ],
    note: 'No JavaScript sets the error tone. Native validation drives it through :user-invalid.',
  },

  Switch: {
    page: 'formcontrols',
    lead: 'On or off, committed the moment it moves.',
    markup: function (c) {
      return '<label class="field-check">\n  <input class="' + c + '" type="checkbox" role="switch" checked>\n  <span>Email notifications</span>\n</label>'
    },
    tones: true,
    treatments: [],
    states: [
      { label: 'On', apply: 'checked', why: 'the native property; role="switch" is what makes a screen reader say "on" rather than "checked"' },
    ],
    instead: [
      { term: 'Field', when: 'it is a checkbox that commits with the form. A switch that needs a Save button is lying about when it took effect' },
    ],
  },

  /* ── Layout ─────────────────────────────────────────────────────── */

  Stack: {
    page: 'layouts',
    lead: 'Children flow down with an even gap.',
    markup: function (c) { return '<div class="' + c + '">\n  <p>One</p>\n  <p>Two</p>\n</div>' },
    tones: false,
    treatments: [],
    states: [],
    instead: [{ term: 'Cluster', when: 'they should flow across and wrap' }],
  },

  Cluster: {
    page: 'layouts',
    lead: 'Children flow across, wrap, and stay aligned.',
    markup: function (c) {
      return '<div class="' + c + '">\n  <span class="badge success">Healthy</span>\n  <span class="badge warning">Degraded</span>\n</div>'
    },
    tones: false,
    treatments: [],
    states: [],
    instead: [{ term: 'Stack', when: 'they should flow down' }],
  },

  Center: {
    page: 'layouts',
    lead: 'One child, dead centre in both axes.',
    markup: function (c) { return '<div class="' + c + '" style="min-height: 12rem">\n  <span class="spinner"></span>\n</div>' },
    tones: false,
    treatments: [],
    states: [],
    instead: [{ term: 'Split', when: 'you have two things going to opposite ends' }],
  },

  Split: {
    page: 'layouts',
    lead: 'First item left, last item right.',
    markup: function (c) {
      return '<div class="' + c + '">\n  <h2>Servers</h2>\n  <button class="btn primary" type="button">Add</button>\n</div>'
    },
    tones: false,
    treatments: [],
    states: [],
    instead: [
      { term: 'Bar', when: 'you also want the vertical rhythm and optional border of a strip' },
    ],
  },

  Container: {
    page: 'layouts',
    lead: 'A max-width column with responsive padding.',
    markup: function (c) { return '<div class="' + c + '">\n  …\n</div>' },
    tones: false,
    treatments: ['narrow', 'wide'],
    states: [],
    instead: [{ term: 'Screen', when: 'you mean the routed page body itself' }],
  },

  /* ── Text ───────────────────────────────────────────────────────── */

  Heading: {
    page: 'headings',
    lead: 'Outline structure. The level says where you are in the document, not how big the text is.',
    markup: function () { return '<h2>Billing</h2>\n\n<h2 class="h4">Same level, smaller</h2>' },
    tones: false,
    treatments: [],
    states: [],
    instead: [
      { term: 'Text', when: 'it names nothing below it' },
    ],
    note: 'The .h1–.h6 classes exist for markup that cannot use the element. Pick the level the outline needs; change the size with the class.',
  },

  Text: {
    page: 'typography',
    lead: 'Prose.',
    markup: function () { return '<p>Deployments run on the primary region first.</p>' },
    tones: false,
    treatments: [],
    states: [],
    instead: [
      { term: 'Heading', when: 'it names the section under it' },
    ],
  },

  /* ── Frame ──────────────────────────────────────────────────────── */

  App: {
    live: false,
    page: 'frame',
    lead: 'The whole application surface. One per app.',
    markup: function (c) { return '<body class="' + c + ' theme-default">\n  …\n</body>' },
    tones: false,
    treatments: [],
    states: [],
    instead: [{ term: 'Shell', when: 'you mean the grid inside it' }],
  },

  Shell: {
    live: false,
    page: 'frame',
    lead: 'The grid that positions Topbar, Sidebar and Screen.',
    markup: function (c) {
      return '<div class="' + c + '">\n  <header class="topbar">…</header>\n  <nav class="sidebar">…</nav>\n  <main class="screen">…</main>\n</div>'
    },
    tones: false,
    treatments: ['sidebar-first', 'viewport'],
    states: [],
    instead: [{ term: 'App', when: 'you mean the outermost surface' }],
  },

  Topbar: {
    live: false,
    page: 'frame',
    lead: 'The global bar across the top. Persists across navigation.',
    markup: function (c) { return '<header class="' + c + '">\n  …\n</header>' },
    tones: false,
    treatments: [],
    states: [],
    instead: [{ term: 'Bar', when: 'it is a strip inside a Screen rather than the app frame' }],
  },

  Sidebar: {
    live: false,
    page: 'frame',
    lead: 'The primary navigation column.',
    markup: function (c) { return '<nav class="' + c + '" aria-label="Main">\n  …\n</nav>' },
    tones: false,
    treatments: [],
    states: [],
    instead: [{ term: 'Drawer', when: 'it is temporary and slides over the page' }],
  },

  Screen: {
    live: false,
    page: 'frame',
    lead: 'The routed page body — what changes when you navigate.',
    markup: function (c) { return '<main class="' + c + '">\n  …\n</main>' },
    tones: false,
    treatments: [],
    states: [],
    instead: [{ term: 'Container', when: 'you only want a max-width column' }],
    note: 'It sets min-inline-size: 0, which is what stops one wide table dragging the whole grid sideways.',
  },

  Pane: {
    live: false,
    page: 'frame',
    lead: 'A labelled major subdivision of a Screen.',
    markup: function (c) {
      return '<section class="' + c + '" aria-labelledby="fleet-h">\n  <h2 id="fleet-h">Fleet</h2>\n  …\n</section>'
    },
    tones: false,
    treatments: [],
    states: [],
    instead: [{ term: 'Section', when: 'it is a subdivision within a Pane rather than of the Screen' }],
  },

  View: {
    live: false,
    page: 'frame',
    lead: 'One switchable view inside a Pane.',
    markup: function (c) { return '<article class="' + c + '" role="tabpanel">\n  …\n</article>' },
    tones: false,
    treatments: [],
    states: [],
    instead: [{ term: 'Tabs', when: 'you mean the control that switches between them' }],
  },
};

var DECIDE = { start: 'root', questions: QUESTIONS, outcomes: OUTCOMES, excluded: EXCLUDED };
