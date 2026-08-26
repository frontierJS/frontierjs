# The Mesa REPL

A browser playground for the Mesa language: write `.mesa` (or `.md`) source on
the left, see it compiled and **running** on the right. It is also Mesa's
working documentation — 66 examples across 22 groups, and a test that fails if a
documented language feature has no example.

Two files, no build step:

| File | What it is |
|---|---|
| `index.html` | The whole app — editor, compiler wiring, preview, output panes |
| `examples.js` | The example corpus: `EXAMPLES`, `EXAMPLE_GROUPS`, `DEFAULT_EXAMPLE` |

## Running it

```bash
cd packages/mesa
npm run serve          # npx serve ../..  — serves the MONOREPO ROOT
```

then open **`/packages/mesa/example/`**.

The server root is the monorepo root, not this package, and that is deliberate.
The REPL reaches two siblings:

- `@ui/…` imports → `packages/ui`, so the **UI Library** example mounts the real
  `@frontierjs/ui` components rather than copies of them
- `packages/css/dist/frontier.css` → the design system those components are
  written in

Everything else works from any server root. Those two degrade to a console
warning and unstyled components — the warning names the fix.

Two features need network (both from a CDN, both non-fatal): **share URLs**
(`lz-string`) and utility classes in examples that use them (Tailwind Play).

## How it works

The REPL imports the compiler and runtime straight from the source it is
documenting — `../src/compiler.js` and `../src/runtime.js`. No bundling, so
an edit to the compiler shows up on reload.

Each compile:

1. `compileSource(src, { css: false, debug: false })`
2. extra example files (`files:` below) and `@ui/` imports are compiled and
   passed in as `userImports`
3. `mount(label, Component, { props, root })` inside a `createRoot`, so
   switching examples disposes the previous one's effects

**Mount through `mount()`, never by calling the component.** Delegation roots
are registered by `mount()` alone, so a hand-rolled `Comp(anchor, {}, null)`
renders perfectly and responds to no event.

### Styles

`css: false` means the compiler does **not** emit `$$runtime.addStyles(...)` — it
hands the scoped CSS back on `ctx.css.result` and the caller must inject it.
`previewStyles` in `index.html` owns those `<style>` tags and drops them on
teardown, which is why one example's `:global(...)` rules cannot leak into the
next.

The preview has base styles so an example with no `<style>` block still looks
like something. They are `:where(#pv-container:not(.self-styled)) …` — zero
specificity, and skipped entirely once a component ships any CSS of its own.
**A component that styles itself owns its look.**

Scoping stops at the component boundary. A rule `.chip` compiles to
`.chip.HASH` with *your* hash, and a child component's elements carry the
child's — so passing a class into a child delivers the **name** and none of the
styling. Rules for classes you hand to a child must be `:global(...)`; the
`classSystem` example shows both halves.

### `@ui/` resolution

`@ui/forms/Button.mesa` → `packages/ui/components/forms/Button.mesa`.
`loadUiModule()` resolves each component's own imports relative to it and loads
recursively — `Input` pulls in `Field.mesa` and `../../utils.js` — caching the
promise so a shared dependency compiles once. A plain `.js` dependency is handed
to the browser's own `import()`.

## Adding an example

Add an entry to `EXAMPLES` in `examples.js`:

```js
myExample: {
  file: 'MyExample.mesa',       // must end .mesa or .md
  group: 'Template',            // must appear in EXAMPLE_GROUPS
  src: `<script> … </script> …`,
  files: [                      // optional — extra editor tabs
    { name: 'store.js', content: `export const user = { name: 'Alice' }` },
  ],
}
```

`files:` is how an example shows imports: `store.js`, a child `.mesa`
component, anything the main file imports. `slots`, `classSystem`,
`autoEffect` and `contextIsolation` use it today.

**Order matters** — extra files compile in the order listed, each seeing only
the ones before it, so a child must precede the component that imports it.

Examples must compile with **zero errors and zero warnings** — the suite
enforces it.

## What the tests check

`../test/repl.test.js`, 9 tests, run by `npm test` in `packages/mesa`:

- every name `index.html` imports from a local module actually **exists** — a
  missing export is an ESM *link* error, so the whole script module never runs
  and the page is blank with one console error
- all 66 examples compile with no errors or warnings, and their output **parses**
  as JavaScript (a clean compile is not proof of valid JS)
- all 37 tracked language features appear in at least one example — the ratchet
- the preview mounts via `mount()` so delegated events fire, and disposing an
  instance stops its effects

## Gotchas

- **A `<style>` block must be at the top level of a component.** One nested in a
  `{#snippet}`, `{#if}` or `{#each}` is dropped and its rules never reach the
  page. The compiler warns now; it used to be silent.
- **Every selector in `index.html`'s own CSS must be anchored** to an id or a
  namespaced class. The preview renders *into* this page, so a bare `.panel`
  rule matches an example's `<div class="panel">` as readily as the REPL's own
  tab pane — and that particular rule is `display: none`, which is how the Slots
  example came to render perfect DOM into a blank pane. Write
  `#tab-content > .panel`, never `.panel`.
- **`getComputedStyle` goes stale in headless Chrome** after a class change, so
  automated checks against this page should read the rules that match an element
  (`el.matches`, `document.styleSheets`) rather than its computed style.
- The **Open standalone ↗** button builds a self-contained HTML document with
  the compiled component and a blob-URL runtime, and opens it in a new tab.
