# Mesa SSR — spec for prerendering support

**Status:** **W1 done** · W2 premise wrong · **W3 done** · W4 answered — nothing in this
document is open in Mesa — **Written:** 2026-08-02 · **Audience:** a fresh session working in `packages/mesa`

> **Reviewed and verified 2026-08-02.** W1 and W3 hold as written. W2's premise
> does not, and W4 is answered — both are corrected in place below, and the
> `<slot />` case they describe is **fixed** with no Mesa change at all. Read
> the "Verified" note on each item before working from it.
>
> Summary of what changed:
>
> - **Mesa has a native `<slot>` element.** `<slot />`, `<slot name="x">`,
>   `<slot:x>`, fallback content and `slot="x"` on children all work, in SSR and
>   on the client. W2's stated cause — "Mesa has no `<slot>` element" — is wrong.
> - **The vanishing page was Sierra composing with the wrong protocol.**
>   `composeWrapper` emitted `<L0 children={s0} />` while on-disk layouts read
>   `<slot />`. Fixed in `packages/sierra/src/build/prerender.js`: the wrapper
>   now supplies children both ways, so a layout works whichever protocol it was
>   written against. Pinned by an end-to-end prerender test through a mixed
>   layout chain.
> - **W4 is not an SSR bug.** Element children into a `{@render children?.()}`
>   layout render nothing on the **client** too. Both renderers agree on every
>   slot form; it is a protocol mismatch, not an SSR limitation. Pinned by five
>   new agreement cases in `render-ssr.test.js`.

## Why this exists

Sierra's `target: 'static'` now prerenders routes to HTML at build time
(`packages/sierra/src/build/prerender.js`). It works, but only for a narrow shape of
layout. Four things in Mesa block the general case. Each is independently verifiable
with the repro snippets below — **run them first**; do not take this document's word
for anything.

Mesa is a true leaf: **zero workspace dependencies, and it must stay that way.** Nothing
here requires importing Sierra, Junction or Litestone. Everything is either a new option
on an existing function or additional output from the compiler.

## Baseline

```bash
cd packages/mesa
bun run test          # vitest — NOT `bun test`, which misreports vitest-authored files
```

At the time of writing: **869 passed, 27 skipped, 12 files passed | 1 skipped.**
After the 2026-08-02 review: **874 passed, 27 skipped.**

The relevant existing suite is `render-ssr.test.js` — **30 cases, not 15**; the
agreement cases are generated from a table in a loop, so `grep -c "it("` undercounts
them. It exists because `renderToHTML` was a documented export that threw on the
simplest component for months. Its "agreement tests" — the SSR renderer and the client
runtime must produce the same thing — are the right oracle to extend for anything
below, and extending them is what settled W4.

The public rendering API:

| Export | File | Shape |
|---|---|---|
| `renderComponent(source, options)` | `render-component.js:383` | `{ html, css, subject?, text?, exports }`, or `{ modules, entry, css }` for `target: 'js'` |
| `renderFile(filePath, options)` | `render-component.js:517` | thin wrapper over the above |
| `renderToHTML`, `wrapPage`, `renderAll` | `render.js` | lower level |

One API note worth keeping in mind: **`options.data` *is* the props object**, not a
prop named `data`. A component with `export let data` needs
`renderComponent(src, { data: { data: value } })`. That is surprising but load-bearing;
it is not part of this spec, though it deserves a doc line.

---

## W1 — `tmpDir` option on the renderer — **done 2026-08-03**

**Cost:** small · **Unblocks:** bare-specifier imports in rendered trees

> **Done.** `renderComponent` / `renderFile` take `options.tmpDir`; it is resolved
> per call (`defaultTmpDir()`, memoised, no longer a module-level `const`), created
> if missing, and threaded through the recursive `compileTree` path so one import
> graph cannot be split across two directories. The default is unchanged and stays
> `findMesaDir()` — a temp module carries `import '@frontierjs/mesa/runtime.js'`,
> which has to resolve from wherever it is written. Sierra's build states its own
> (`node_modules/.sierra/render`), which is what makes a prerendered layout
> importing `@frontierjs/sierra/router` render. Four cases in
> `render-component.test.js`, including the negative one: the same import must
> still fail under the default. Everything below is the original item.
>
> **Verified 2026-08-02 — holds as written.** `_tmpDir` is a module-level `const`
> (`render-component.js:102`), `makeTmpPath` uses it (`:105`), and temp modules land in
> Mesa's own package root, so Node resolves bare specifiers from there. The line numbers
> in this item are accurate.
>
> Two notes. The root cause is compile-to-disk-then-import; `tmpDir` is the right 80%
> fix, and keeping `findMesaDir()` as the default is correct. And this is independent of
> everything else in this spec — it was never what blocked `<slot />`.

### Evidence

`render-component.js:102`

```js
const _tmpDir = await Promise.resolve(findMesaDir())
```

`makeTmpPath()` (`:105`) writes every compiled module to that directory — Mesa's own
package root. Node then resolves any **bare** import in the compiled output relative to
`packages/mesa/`, not relative to the app being rendered.

### Repro

```bash
# From a directory whose node_modules has @frontierjs/sierra but where mesa's does not.
# A layout containing `import { page } from '@frontierjs/sierra/router'` fails with:
#
#   Cannot find package '@frontierjs/sierra' imported from
#   /home/.../packages/mesa/__mesa_render__module.mesa_1785653168410_k8mb7wvxude.mjs
```

### What's needed

Accept `options.tmpDir` on `renderComponent` / `renderFile` and thread it into
`makeTmpPath`. Default stays `findMesaDir()` so current behavior is unchanged.

`_tmpDir` is currently a module-level `const`, so this is not purely additive — the
value has to become per-call. Watch for the recursive `compileTree` path, which also
creates temp files and must receive the same directory.

### Acceptance

- `renderComponent(src, { tmpDir })` writes temp modules under `tmpDir`.
- A component whose import graph contains a bare specifier resolvable from `tmpDir`
  renders successfully.
- Temp files are still cleaned up on both success and throw (`cleanTempFiles`).
- Omitting `tmpDir` behaves exactly as today.

---

## W2 — a source-transform seam for imported modules

**Cost:** medium · **Unblocks:** ~~`<slot />` in prerendered layouts~~ — nothing, as written

> **Verified 2026-08-02 — the premise below is wrong, and the problem it
> describes is fixed elsewhere.**
>
> **Mesa has a native `<slot>` element.** `compiler.js:3097` handles `<slot />`,
> `<slot name="x">`, `<slot:x>`, fallback content, and `slot="x"` on children,
> compiling to `attachNamedSlot(__block, …)` — which reads the third argument,
> exactly where element children arrive. Measured, SSR and client alike:
>
> ```
> Layout.mesa:  <div class="shell"><nav>nav</nav><slot /></div>
> App.mesa:     <Layout><h1>hello</h1></Layout>
>   →  <div class="shell"><nav>nav</nav><h1>hello</h1></div>
>
> Named + fallback, and a 2-deep chain wrapping a component with props, both work too.
> ```
>
> **The real cause of the vanishing page** was on the Sierra side:
> `composeWrapper` emitted `<L0 children={s0} />` — the prop protocol — while
> on-disk layouts using `<slot />` read the block protocol. Neither renderer
> bridges them, so the layout rendered and the page inside it did not.
>
> Fixed in `packages/sierra/src/build/prerender.js` by supplying children both
> ways, since the prerenderer cannot know which protocol a given layout speaks
> and both are legitimate (Sierra's own fixtures use the prop form):
>
> ```
> {#snippet s0()}<Page {data} />{/snippet}
> <L0 children={s0}>{@render s0()}</L0>
> ```
>
> The element children render the same snippet rather than repeating it, so the
> page is instantiated exactly once either way. Snippets must be declared
> innermost-first — `s0`'s body references `s1`, and the other order throws
> `s1 is not defined` at render. Pinned end-to-end by a prerender test over a
> mixed chain (outer `<slot />`, inner `{@render children?.()}`).
>
> **What survives of W2.** Mesa's slot protocol is *lexical*, so it cannot
> express Sierra's page-fills-an-ancestor-layout's-named-slot case, which is
> what `provideSlot` / `page.slots` exists for. But the prerenderer *generates*
> the wrapper, so it composes lexically by construction and could hoist a page's
> `<mesa:slot name="x">` blocks into the wrapper as `slot="x"` children —
> Sierra-side work on a rewrite Sierra already owns.
>
> If a Mesa seam is still wanted after that, reconsider the shape:
> `transform(source, path)` makes Mesa a plugin host so Sierra can keep a
> dialect Mesa already implements natively. Cheaper alternative — Sierra
> materializes transformed sources to a temp dir and points Mesa at the entry;
> Mesa reads from disk already, so the seam exists. If a hook goes in anyway,
> `load(path) → source | null` is strictly more useful than `transform` for the
> same effort: it also serves virtual modules and avoids a double read.

### Evidence (as originally written — the conclusion in the last paragraph is wrong)

`renderComponent` takes **source** for the entry module only. Every import is read from
disk by `compileTree` (`render-component.js:~151`, `readFile(canonical, 'utf8')`).

Sierra rewrites `.mesa` source before Mesa sees it — `slot-rewrite.js` turns
`<slot />` into `{@render children?.()}` and injects the `children` prop declaration,
and there is an auto-import pass too. On the Vite path those run in `mesa-plugin.js`.
On the prerender path they cannot run at all for imported files, so a layout using
`<slot />` reaches the compiler raw. Mesa has no `<slot>` element, so it renders nothing
and **the page content silently disappears** — the layout emits, the page inside it does
not.

### Repro

```
Layout.mesa:  <div class="shell"><nav>nav</nav><slot /></div>
Page.mesa:    <h1>hello</h1>

Rendered via a composed wrapper →
  <div class="shell"><nav>nav</nav></div>      ← page content gone, no error
```

Replace `<slot />` with `{@render children?.()}` and it renders correctly. That is the
current workaround, and it is why Sierra's prerenderer only supports layouts written in
Mesa's native form.

### What's needed

A hook that lets the caller transform source before compilation, applied to **every**
module in the tree, not just the entry. Something like:

```js
renderComponent(src, {
  transform: (source, filePath) => transformedSource,   // sync or async
})
```

Called for the entry and for each file `compileTree` reads. Absent, behavior is
unchanged.

### Acceptance

- `transform` is invoked once per module, receiving absolute path and raw source.
- Returning the input unchanged produces byte-identical output to no `transform`.
- An async transform is awaited.
- A transform that throws surfaces with the offending file path in the message.
- Covered by an agreement test: a component transformed to a known-equivalent form
  renders identically to the untransformed original.

---

## W3 — island markers in SSR output — **DONE 2026-08-02**

**Cost:** large, own project · **Unblocks:** the chosen client model for static pages

> **Implemented 2026-08-02.** Opt in with `{ islands: true }`. 11 cases in
> `render-ssr.test.js` (`islands — client:* markers in SSR output`); mesa is
> 902 pass / 0 fail / 27 skipped, up from 891. The acceptance list below is met
> in full; two things were decided differently from the sketch, both because
> measurement contradicted it.
>
> **The marker is comment-delimited, not a `<mesa-island>` element.**
>
> ```
> <!--mesa-island {"component":"Counter","directive":"load","props":{"start":3}}-->
> <button>3</button>
> <!--/mesa-island-->
> ```
>
> An element wrapper fails two ways that produce no error. The HTML parser
> foster-parents a non-table element out of `<tbody>`, so an island rendering
> rows has its marker relocated away from the markup it identifies before any
> loader runs — verified in headless Chrome, where the comment marker stays in
> `TBODY`. And a wrapper element takes part in `>` selectors and in flex/grid
> layout, so a page styles differently prerendered than client-rendered;
> `display: contents` fixes the layout half and nothing fixes the selector half.
> Comments are legal wherever content is and match Mesa's own convention — every
> block directive already delimits itself with comment anchors, and
> `renderToHTML({ keepAnchors: true })` exists to preserve them.
>
> **The marker carries the props as rendered, not the statically-analysable
> ones.** `ctx.islands` is a compile-time view and sees only literal attributes:
> `start={2 + 3}` contributes nothing to it. The marker is written during the
> render, where the real value exists, so it says `{"start":5}` — which is what
> a loader needs to remount in the state the page was prerendered in. Both
> views ship: `ctx.islands` (now flattened onto `renderComponent`'s result as
> `.islands`, each entry tagged with the file it was written in) is the
> build-time list a bundler needs to map a component *name* onto a module;
> the marker is the runtime one.
>
> **Two guards, deliberately.** `{ islands: true }` switches emission — omitting
> it is byte-identical to before, so RULE 26 holds by default. The environment
> then decides whether a marker is written: `island()` calls the component
> directly on a real client, so client DOM is unchanged even when the flag is
> on. Neither guard alone is sufficient — the flag is what a meta-framework
> controls, the environment check is what keeps markers out of a live DOM no
> loader reads.
>
> **Replacement, as recommended.** Nothing adopts prerendered markup, because
> hydration still does not exist. Mounting needs no new protocol: clear the
> range, then `mount(openComment, Comp, { props })` — `mount` inserts its anchor
> immediately after the node given, so the component lands exactly in the
> vacated range. It must be `mount`, not `Comp(anchor, props, null)`: a direct
> call renders the right markup and registers no delegation root, so the island
> comes back **inert**. That is the same trap that made all 59 REPL examples
> render and respond to nothing; a click in `render-ssr.test.js` pins it.
>
> **Two traps for whoever writes the loader.**
> - `createTreeWalker(root, NodeFilter.SHOW_COMMENT)` is the right
>   implementation and works in Chrome (verified). Under **happy-dom 14.12.3**
>   it filters to nothing — `SHOW_ALL` does surface comments — so a loader
>   tested only against this repo's SSR harness would silently find zero
>   islands.
> - The payload escapes every `-` and `>` out of the JSON. Only `-->`
>   terminates a comment per spec, but happy-dom ends one at the **first `>`**,
>   which split a marker in two and made `JSON.parse` throw on the fragment. A
>   prop value of `a --> b <!-- c > d` now round-trips exactly through both
>   parsers.
>
> **Still open, and still Sierra's:** the loader itself, per-island bundling,
> and name→module resolution. `sierraContext.islandMap` remains unconsumed —
> what changed is that there is now something in the HTML for it to point at.

### Evidence

The compiler already extracts islands. `compiler.js:6213–6242`, with a comment that
names the consumer explicitly:

```js
// Exposed as ctx.islands for meta-frameworks like Sierra.
// ctx.islands: Array<{
//   component: string,          // PascalCase name, e.g. 'Counter'
//   directive: string,          // 'idle' | 'load' | 'visible' | 'media' | 'static'
//   media?: string,             // for client:media="(...)"
//   props: Record<string, any>, // static prop values at the call site
// }>
```

Sierra collects this into `sierraContext.islandMap` (`mesa-plugin.js:211`) and, like
`http.cors` in Junction, **consumes it nowhere**.

The gap is on the render side. SSR emits an island's markup inline with nothing to
identify it:

```
Island.mesa:  <article><p>static</p><Counter client:load /></article>
SSR output:   <article><p>static</p><button>0</button></article>
                                     ^^^^^^^^^^^^^^^^^^^ no marker
```

A client loader has nothing to find, and no boundary to mount into. There is also no
hydration — `render.js:113` says so directly ("hydration does not exist yet (v1.1)"),
and `runtime.js:4013` carries a `pop()` no-op reserved for it.

### What's needed

Wrap island output in a marker carrying enough for a loader to mount it: component
identity, directive, and the static props already captured in `ctx.islands`. Shape is
open; something like

```html
<mesa-island data-component="Counter" data-directive="load" data-props='{"start":0}'>
  <button>0</button>            <!-- prerendered markup, replaced or adopted on mount -->
</mesa-island>
```

`wrapPage()` already accepts an `islandLoader` script src, so the shell side is
anticipated.

Decide explicitly whether mounting **replaces** the marker's contents (simple, a visible
swap for anything stateful) or **adopts** them (needs the hydration that does not exist).
Replacement is the tractable v1 and matches the current runtime.

### Acceptance

- A component with a `client:*` directive renders inside a marker; one without renders
  exactly as today.
- The marker carries component name, directive, and static props.
- Nested islands work, or are rejected with a clear error.
- `client:media` preserves its query.
- The prerendered markup inside the marker matches what the client runtime produces for
  the same props — an agreement test, in the spirit of the existing suite.

**Out of scope here:** the client loader itself and per-island bundling. Those belong to
Sierra, and cannot start until the marker exists.

---

## W4 — ~~investigate:~~ **answered** — children as `block` in SSR

**Cost:** none — closed 2026-08-02

**Answer: this is not an SSR bug, and the `block` path does work server-side.**

The original table's Client column was wrong. Measured, with the same compiled
component driven through `renderToHTML` and through `mount()`:

| Layout consumes | Call site | SSR | Client |
|---|---|---|---|
| `{@render children?.()}` | `<Layout><Page /></Layout>` | empty | **empty** |
| `{@render children?.()}` | `<Layout children={snippet} />` | works | works |
| `<slot />` | `<Layout><Page /></Layout>` | **works** | works |
| `<slot name="x">` | `<X slot="x">` | **works** | works |

Server and client agree on every form, which is what the agreement oracle is for.
So the answer to "is the `block` path meant to work server-side?" is **yes, and it
does** — through `<slot />`, the syntax that reads `__block`. What does not work,
on either renderer, is element children into a layout that reads the `children`
*prop*. Two protocols, nothing bridging them:

```
<slot />                → third argument (element children)
{@render children?.()}  → `children` prop
```

Mixing them yields empty output and no error, which is how this cost Sierra an
afternoon and this spec an incorrect diagnosis.

Now documented where it will be found: five cases in `render-ssr.test.js`
(`component children — protocols, and the cost of mixing them`) pin both
protocols and both mismatches in both renderers, and `prerender.js`'s header
explains which one it supplies and why it supplies both.

---

## Suggested order

~~Original order: W1 → W4 → W2 → W3.~~ Revised 2026-08-02, after W4 was answered
and W2's premise fell:

1. ~~**W4**~~ — **done.** Answered by measurement; no code in Mesa.
2. ~~`<slot />` layouts prerender~~ — **done**, in Sierra's `composeWrapper`, not in Mesa.
3. **Decide the slot protocol.** Is Sierra's router-mediated `page.slots` system meant
   to replace Mesa's native slots or complement them? Everything left in W2 depends on
   that answer, and it is a Sierra architecture decision, not a Mesa feature request.
4. ~~**W1**~~ — **done 2026-08-03.** `options.tmpDir`, defaulting exactly as before.
   It was the last item in this document open in Mesa; what is left of this spec is
   Sierra's, at item 3.
5. ~~**W3**~~ — **done 2026-08-02.** See the note on the item. What is left of it
   is Sierra's: the loader, per-island bundling, and name→module resolution.

## Constraints

- **No workspace dependencies.** Mesa is consumed by Sierra and jetty and must stay a leaf.
- **Every item is opt-in.** Omitting the new option must produce byte-identical output.
- **Extend `render-ssr.test.js`.** Its agreement tests — SSR output vs client runtime
  output — are the only oracle available for a renderer with no reference implementation,
  and they are what would have caught the `<slot />` hole.
- Verify by running, not by reading. Several things in this repo were documented
  accurately and wired to nothing; `ctx.islands` is one of them.

## Consumer contract

The caller is `packages/sierra/src/build/prerender.js`, invoked from `closeBundle` in
`packages/sierra/src/build/index.js` when `target: 'static'`. It composes a synthetic
wrapper module per route (page + layout chain), calls `renderComponent`, and writes
`<path>/index.html`. Its tests are `packages/sierra/tests/prerender.test.js`.

There is one unrelated Sierra-side blocker, listed here only so it is not mistaken for a
Mesa problem: **`@frontierjs/sierra/router` cannot be imported in Node** — it pulls in
`RouterView.mesa` and dies with `Unknown file extension ".mesa"`. Layouts commonly import
`page` from it, and `slot-rewrite` injects that import for named slots. That needs an
SSR-safe router entry on the Sierra side and is not fixable from Mesa.

*(2026-08-02: narrower than it looks. Layouts depend on `page` **because**
`slot-rewrite` puts it there — it rewrites `<slot />` to `{@render children?.()}` and
named slots to `page.slots.*`. A layout left in Mesa's native `<slot />` form imports
nothing and prerenders fine, so this blocks only the named-slot path, and only for
layouts that were rewritten. It is the same question as W2's remainder: which slot
protocol Sierra intends to own.)*
