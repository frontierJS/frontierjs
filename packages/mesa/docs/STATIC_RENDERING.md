# Static rendering

Mesa renders components to HTML strings in Node. It is used for static site
generation, for email, and for any build step that needs markup without a
browser. There is no hydration yet — output is inert HTML plus whatever scripts
you attach to the page shell.

---

## Which entry point

| You have | Use | Module |
|---|---|---|
| A compiled component factory | `renderToHTML(Comp, props, options)` | `@frontierjs/mesa/render` |
| `.mesa` source or a file path | `renderComponent(src, opts)` / `renderFile(path, opts)` | `@frontierjs/mesa/render-component` |

`render-component.js` is the one you usually want: it compiles, resolves the
import tree, collects CSS, and supports `target: 'html' | 'email' | 'fragment' |
'js'`. It renders **through** `render.js`, so both share one renderer — there is
no second implementation to drift.

`render.js` is the layer beneath. Reach for it when the compilation step is
already yours: a bundler plugin that hands you compiled modules, or an SSG loop
that imports pages itself.

---

## Quick start

```js
import { initRenderer, renderToHTML } from '@frontierjs/mesa/render'

initRenderer()                                   // 1. install DOM globals
const { default: Page } = await import('./Page.mesa.js')   // 2. then import
const html = await renderToHTML(Page, { title: 'Hello' })  // 3. then render
```

**The order is not stylistic.** Compiled components call `htmlToFragment()` at
module-load time, so the DOM must exist before the `import()`, not merely before
the render. Import first and the module throws while evaluating, with an error
that points at the runtime rather than at the missing call.

Pass the component **function**, not the module namespace — `mod.default`, not
`mod`. Passing the namespace is a common enough slip that it gets its own error
message.

---

## What runs on the server

`initRenderer()` calls `setRenderEnvironment(true, false)`: the DOM is
available, but this is not a client. Those are two different questions, and
conflating them is what made every server render fire `$.onMount` before the
reactivity pass split them.

| | Server render |
|---|---|
| Effects, memos, derived `const` | **run** — this is how markup gets built |
| `{#if}`, `{#each}`, `{#key}`, `{@html}`, `{@render}` | **run** |
| `$.onMount` / `$onMounted` | inert (RULE 19) |
| `watchProxy`, `watchPath`, `localWatchProxy` | inert (RULE 19) |
| `{#await}` | renders `{:pending}` — nothing settles inside a synchronous render |
| `<mesa:mounted>` | renders its pending branch, for the same reason |
| `{#virtual each}` | **runs** — renders the first window plus its spacers. No viewport can be measured, so the window comes from the declared or fallback row height |
| Event handlers | attached to DOM that is then discarded; never fire |

Everything that does run is disposed before `renderToHTML` returns. See
*Lifetimes* below.

If a page needs data, resolve it **before** rendering and pass it as props.
There is no server-side `await` inside a component that the renderer will wait
for; a promise in the template renders as pending, permanently.

---

## Component children — two protocols

This is not SSR-specific, but it is where it bites hardest, so it is written down
here. Mesa has two unrelated ways to hand a component its children, and **nothing
bridges them**:

| Written as | Arrives as | Read by |
|---|---|---|
| `<Layout><Page /></Layout>` | third argument (`block`) | `<slot />`, `<slot name="x">` |
| `<Layout children={snippet} />` | the `children` prop | `{@render children?.()}` |

Both work in SSR and on the client — verified by agreement tests. What fails is
mixing them: a `<slot />` layout handed the prop form renders an empty slot, and a
`{@render children?.()}` layout handed element children does the same. **No error,
no warning, just missing content.** Both renderers behave identically, so this is a
protocol mismatch, not an SSR limitation.

If you generate wrapper source and cannot know which protocol a layout speaks —
which is the position any prerenderer is in — supply both:

```
{#snippet s0()}<Page {data} />{/snippet}
<L0 children={s0}>{@render s0()}</L0>
```

The element children render the same snippet rather than repeating it, so the page
is instantiated exactly once whichever protocol the layout reads. When nesting,
declare snippets innermost-first: `s0`'s body references `s1`, and the other order
throws `s1 is not defined` at render time. This is what
`packages/sierra/src/build/prerender.js` does.

Mesa's slot protocol is **lexical** — a component fills the slots of the component
that lexically encloses it. It cannot express "a page fills a slot in an ancestor
layout it is not nested inside"; that needs a framework-level mechanism (Sierra has
one, `provideSlot` / `page.slots`), or a build step that composes the two lexically.

---

## Comment anchors

Compiled output carries comment nodes: a root anchor, plus a placeholder or
anchor per block directive. They are stripped from the output by default,
because nothing reads them yet.

```js
await renderToHTML(Comp)                          // <div><b>yes</b></div>
await renderToHTML(Comp, {}, { keepAnchors: true }) // <div><!----><b>yes</b></div>
```

When hydration lands (v1.1) it will need those anchors to locate blocks, and
`keepAnchors` is the switch. The stripping patterns live in one place —
`_ANCHOR_PATTERNS` in `render.js` — and are deliberately narrow: `<!--[if mso]>`
conditional comments survive, because email templates emit them through
`{@html}` on purpose.

---

## The page shell

`wrapPage(bodyHTML, options)` produces a complete document. `renderToHTML(...,
{ full: true, ...options })` renders and wraps in one call.

```js
const html = await renderToHTML(Page, props, {
  full: true,
  title: 'My Page',
  css: '/assets/site.css',
  scripts: ['/assets/app.js'],
  islandLoader: '/assets/islands.js',
  meta: { description: 'a page' },
})
```

`title` and `meta` values are escaped. `css`, `scripts` and `islandLoader` are
emitted as URLs verbatim — they are yours, not user input, and escaping them
would break query strings.

`islandLoader` is the hook for islands architecture: a module that finds
interactive regions in the static markup and mounts them on the client. Mesa
emits the tag; producing the loader is the framework's job (see *Status*).

---

## Concurrency

Renders are **serial**, and that is a design constraint rather than an
oversight. The happy-dom window is process-global and so is the reactive core
(`_owner`, `_listener`, the flush queue). Two interleaved renders would share
all of it.

`renderToHTML` is `async` in signature but synchronous end to end: there is no
`await` between its first line and its last. That is what makes `renderAll()`
safe — `Promise.all` collects results that have already settled, and no render
can begin before the previous finishes. A test asserts the non-interleaving
directly.

**If you add an `await` to `renderToHTML`, `renderAll` becomes a race.** For
genuine parallelism, run one worker process per window rather than sharing this
module.

---

## Lifetimes

A render is a scope with an end. `renderToHTML` runs the component inside
`createRoot()` and disposes it the moment the HTML is serialized.

This matters at SSG scale. Without it, every page leaves its render effects
subscribed to whatever module-scope state they read — a store module imported by
many pages — and each later write re-runs all of them against DOM that was
discarded pages ago. Measured before the fix: three renders, three live effect
sets, one write re-running all three.

`createRoot(fn)` is exported from the runtime for the same purpose anywhere
else there is no enclosing effect to own the work:

```js
const dispose = createRoot((dispose) => { /* build things */ ; return dispose })
```

It gives ownership without tracking — reads inside a root do not subscribe the
caller's effect.

---

## Status

Honest picture, as of 2026-08-01.

**Working:** `renderToHTML`, `renderAll`, `wrapPage`, `escapeHTML`,
`resetRenderer`, and the whole `render-component.js` pipeline on top of them.
Covered by `render-ssr.test.js` (25 tests) and `render-component.test.js` (29).

**Wired (2026-08-02):** Sierra's `static` target. `prerender.js` composes each
`render: static` route with its layout chain and renders it through
`renderComponent` from `closeBundle`, writing `<path>/index.html`. It supplies
children by both protocols (see above), so layouts written either way prerender
correctly.

**Not built:** hydration, island markers in SSR output and the loader that would
consume them (`SSR_SPEC.md` W3), per-worker windows. `renderComponent` also
resolves bare imports from Mesa's own package root, which breaks layouts that
import anything by package name (`SSR_SPEC.md` W1).

`renderToHTML` was broken for months before this was written — it called a
calling convention the compiler had stopped emitting, and nothing imported or
tested it, so nobody found out. The suite exists so that cannot recur silently.

---

## Testing

`render-ssr.test.js` ends with an **agreement suite**: eleven components
rendered both by `renderToHTML` and by mounting through the client runtime,
asserted identical.

That is the oracle available to a framework with no reference implementation to
diff against. Mesa cannot check itself against React's output, but it has two
renderers that must agree, and disagreement is always a bug in one of them.
Extend that suite when adding template features — a new block directive should
land with an agreement case, not just a client test.
