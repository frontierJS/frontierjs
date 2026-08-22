# Changes — @frontierjs/mesa

## 2026-08-19 — click an element, open the line that wrote it

`data-fjs-loc="src/pages/Home.mesa:12:3"` on every template element in a dev
build, and a client the Vite plugin injects that reads it: hold Alt and the
element under the pointer is outlined with its location, click and Vite's own
`/__open-in-editor` opens the file. `Alt`+`Z` does the same to whatever has
focus, for the keyboard.

**An attribute rather than a runtime map**, which is where this differs from the
Svelte plugin it is modelled on. Svelte builds a DOM element at a time and can
hang `__svelte_meta` on each one; Mesa clones a template, so an element with no
binding has no runtime reference for a map to be keyed by — and those are most
of them. The attribute goes into the template string, so it costs nothing at
mount and reaches every element.

The compiler option is `loc`, defaulting to whatever `dev` is, with `locRoot`
naming the prefix the stamped path is relative to. `inspect: false` on either
plugin turns off the injection AND the attribute: the client is its only reader.
A production build stamps nothing.

Both plugins serve one implementation — `mesa-vite/inspect-client.js` as a
string, the way the HMR client is served, each at an id of its own (`FJS-D16`).
Sierra's surface is the same. Jetty passes `loc: false`: an extension page is
not the app's dev server and serves no client to read it.

Proven in the Vite drive (`test/browser/vite/specs/inspect.spec.mjs`, 11
assertions), which is the only place the chain is visible — the attribute
graded against the FILE rather than a literal line number, the alt-click
reaching the inspector, and the app's own click handler NOT running while it
does.

## 2026-08-18 — a snippet parameter may be a destructuring pattern, and the read is where it happens

`{#snippet row([name, q])}` compiled and could not work. A snippet argument is
passed lazily — `{@render row(p)}` emits `$$snippet_row(el, () => (p()))` — and
the compiler rewrites reads of a plain identifier parameter into a call. A
pattern cannot be rewritten that way, so the parameter list kept the pattern and
destructured the accessor FUNCTION: `TypeError: function is not iterable`, thrown
from the compiled file with no mention of the snippet, the whole enclosing block
rendering nothing. The output was valid JS, so [Invariant 15](../../CLAUDE.md)
did not catch it either.

`{#each}` answers the same question by unwrapping the item and destructuring
that, and **it does not transfer**. A block re-runs per item; a snippet's DOM is
built once. Unwrapping at the top of the body would compile, run, and freeze
every bound name at its first value — the frozen-argument bug the getters exist
to prevent (`VISION` §9.5), which is what made a kit Table draw its first rows
and then ignore the store.

So the destructuring moves into the read. One getter arrives as `$$arg0`, and
each name the pattern binds compiles to its own path through it — `$$arg0()[0]`,
`$$arg0().id`, `$$arg0().label` for `{ id, label }` — so each keeps a
subscription of its own inside whichever binding effect reads it. A default
value, a rest element and a nested pattern are refused by name at compile time,
because none of the three can be read lazily.

**The fix landed on the same trap one layer down.** `_isReactive` decides
whether a binding becomes an effect or a one-time assignment, and its bare-call
pattern excludes `$`-prefixed identifiers — so every new read was classed
STATIC and written once. The first render was correct and every reassignment
was ignored: the frozen-argument bug, arriving through its own fix. The function
already carried a comment recording the identical miss for `{@const}`, where an
attribute kept its first value while the class beside it tracked state.

What caught it is the assertion shape, not the coverage: a spec that reads the
DOM after the first paint passes under both fixes. `test/browser/runtime`'s new
`snippet-pattern` spec clicks and asserts what the reassignment reached — array
pattern, object pattern with renaming, a hole, an attribute, and a snippet
rendered once per `{#each}` item, which is the shape it was found in.
`packages/basecamp`'s Hub carries `{#snippet row([queue, depth])}` again;
its *Queue depths* card had been rendering nothing at all (`FJS-339`).

## 2026-08-18 — `render-component` created a fixture directory nothing used, and wrote into one nothing created

Seven tests wrote `.mesa` fixtures into `/tmp/mesa` and every `cwd:` in the file
pointed there, but `beforeAll` created `/tmp/mesa-render-test-<timestamp>` — a
per-run directory no test ever referenced. On a machine where `/tmp/mesa`
survived from something else the suite passed; on one where it did not, all
seven died with `ENOENT: no such file or directory`.

Nothing here could see it. Every local run was on a machine that had already
made the directory, so this was the first defect a CI runner found that no local
run can (`FJS-009`). Read off the check-run ANNOTATIONS rather than the logs,
which need admin rights on the repository even when it is public.

`FIXTURES` is `/tmp/mesa` now and `beforeAll` creates it. 34/34 with the
directory deleted first.


## 2026-08-17 — `waitSettled` answers whether anything is still MOVING

The probe asked `getAnimations({ subtree: true })` for an empty list. An
animation with `fill: 'forwards'` never leaves it — it is still in effect,
holding its last frame — so on any page that has one the probe polled to its
own timeout and answered `false`, four seconds later, every time. Both of
`@frontierjs/ui`'s dropdown calls were doing exactly that, which is eight
seconds of a run spent proving nothing, and a gate a spec was told to put
before a coordinate click that was not a gate at all.

It filters to `playState === 'running'` now, which is the question the name
asks.

## 2026-08-17 — a comment inside a tag no longer eats the attributes after it (`FJS-330`)

`<button id="a" <!-- note --> data-n={n} aria-label="hi">` emitted the comment
verbatim into the template. The `>` that ends `-->` read as the end of the tag,
so the element closed there and everything after it became a text node —
`` ` data-n=1 aria-label="hi" >x` `` — with no error, no warning, and JS that
still parsed. The attributes simply did not apply.

`parseAttributes` consumes it now. **Dropped rather than refused**: HTML has no
comment inside a tag either, so there is no markup to preserve and a strip
cannot get anything wrong, while a comment explaining the attribute below it is
a reasonable thing to want to write. An **unterminated** one is refused by name,
because eating to the end of the file is the same silent failure wearing a
different hat.

Six cases, and the one that constrains the fix is that `<!--` inside an
attribute VALUE is untouched: it is read as a string before the loop can see
it, and there it is content rather than markup.

## 2026-08-17 — an unkeyed `{#each}` is keyed by INDEX (`FJS-325` closed)

`eachDefaultKey` was `(item) => item`, so a list with no key expression was
keyed by its own values. That is unique only when the values are, and two
ordinary shapes are not: a list of repeated primitives, and an array-like,
whose every item is `undefined` — the shape a calendar grid is built from. A
collision did not degrade. Measured in a real browser over `['a','b','a']`, the
first render was right, reordering to `['b','a','a']` rendered `ab` and threw
`NotFoundError: insertBefore …` out of `_moveBlock`, and every assignment after
that threw again and rendered less. The runtime's *duplicate keys corrupt the
reconciler* warning was the whole of the protection.

It is now `(_item, index) => index`, which cannot collide and therefore always
renders the array it was handed. **The trade is node identity across a
reorder** — a moved item is rebound into the node already at that position, so
DOM state a row owns (focus, an uncontrolled input, a running animation) stays
with the POSITION. An author who needs identity states a key, and `(item)` is
still how you ask for the old behaviour where the values really are unique.
`$$virtualEach` already keyed by index with no key function, so the two forms
now agree.

`each-unkeyed.spec.mjs` was pinned as still-broken and now asserts the fix,
including the trade: the rows after a reorder are the nodes that were already
there, stamped before the click.

## 2026-08-17 — the HMR DOM swap is a module, and the client is served assembled

`mesa-vite/swap.js` (`@frontierjs/mesa/vite/swap`) is the swap a hot update
performs — clear between the two markers, seed `__setMark`, re-call, count. It
was ~30 lines inside `client.js` and ~30 identical lines inside jetty's own dev
client (`FJS-259`). **It carries no `import.meta` and imports nothing**, which
is a constraint rather than a style: jetty bundles it into MV3 content scripts,
which are classic scripts, and one `import.meta` token anywhere in such a bundle
is a parse error before a line of it runs.

**That split a serving problem out with it.** Both Vite plugins that serve this
client — this package's and Sierra's, each at a virtual id of its own
(`FJS-D16`) — hand Vite a STRING, and a virtual id resolves no relative import.
`mesa-vite/client-source.js` is the one owner of the join, fails closed if
either shape it edits stops matching, and is what Sierra asks for by path the
way it asks for the compiler. Serving `client.js` alone would be a 200 that dies
in the browser and puts every component back on the full-reload path — asserted
against now on both sides, as *the swap is inlined and no relative import is
left behind*.


## 2026-08-17 — the devtools relay, asked across two tabs (`FJS-024` closed)

`BroadcastChannel` is same-origin and cross-document by definition, so a single
page posts and never hears itself — the relay between an app and the devtools
panel was the one part of the plugin a one-tab drive could not reach.

`openChrome` gained `newPage(url, ready)`: a second target with its own
`evaluate`, `navigate` and `close`, whose errors collect into the SAME array, so
a throw in the other tab still fails the spec that opened it. The devtools spec
now opens the panel beside the app and asserts that `App`, `Counter` and
`Sibling` arrive in its sidebar with their files and signal counts — which also
proves the dev instrumentation the plugin turns on with `dev: isDev`.

That was the last named gap in `FJS-024`.

## 2026-08-17 — the derivation layer settles outside-in (`FJS-303`)

The flush drained derivations to quiescence before anything that builds DOM
ran. That is what makes renders read derivations which have stopped moving, and
it is also how a memo three blocks deep recomputed in the same breath as the
top-level derivation the guard above it was still waiting on:

    {#if calendar[week]}
      {@const day = calendar[week][day]}   ← recomputed first, read undefined[day]

The throw comes out of a click handler, so it surfaces as a component that
quietly stops responding and nothing points at the guard.
`@frontierjs/ui`'s `DatePicker` hit it on every month change with fewer weeks
(`FJS-300`) and was fixed by iterating the real rows, which was an avoidance.

**It now settles one DOM-depth at a time, shallowest first**, and within a
level it skips anything whose owning block is already queued — decidable there,
because the block was woken by the shallower derivation that just ran, where
one turn earlier it was not pending at all. Nothing else changes: a surviving
memo still recomputes and still notifies, one pass later, and a memo left dirty
recomputes on the next READ, so a branch that lives gets a fresh value and one
that dies is disposed before anyone asks.

`createEffect`'s own comment had stated this invariant for renders since it was
written — *an ifBlock's condition has to run before the renders inside its
branch*. The derived tier was added ahead of both passes and did not honour it.

**Reproducing it needed three things at once, which is the diagnosis.** The
guarded value must be DERIVED, the outer loop FIXED, and the read a MEMO rather
than a text interpolation. A plain array behind a guard never failed, and four
fixtures passed before the fifth one threw.

A first attempt handed control to the DOM tier whenever any block was pending.
That cost an extra observation in a glitch-freedom test — the tell that the
condition had to be about OWNERSHIP rather than about anything being pending.

## 2026-08-17 — `<slot>` refuses an attribute, and the docs stop recommending the impossible form (`FJS-304`)

`<slot tipId={tipId} />` compiled with no error and no warning, and the
attribute vanished from the emission entirely. There is no `let:` directive to
read one with either, so the spelling was a feature that did not exist wearing
the face of one that did. It is refused by name now — the same call as an
unknown `mesa:*` element (`FJS-023`): a typo and a missing feature must not be
the same event. The message names the attribute and points at the form that can
actually pass a value.

**The documentation was half the defect.** VISION §9.6 called
`export let children` + `{@render children?.()}` *legacy for new code* while it
is the only mechanism that takes parameters — so the recommended path was the
one that could not do the job. §9.6 now says plainly that a slot carries
content in and never a value out, shows the snippet form for the other
direction, and RULE 35a is rewritten with RULE 35b beside it.

Eight cases in `test/slot-attributes.test.js`, five of them the legitimate
spellings — a refusal that also refuses those is worse than the silence it
replaces.

## 2026-08-17 — three browser drives, and three defects only a browser could see

`test/browser/` runs this package in a real Chrome, which nothing here had ever
done: every other suite is happy-dom (`FJS-025`), and the Vite plugin was
tested everywhere but a browser (`FJS-024`).

**The harness is shared and lives here** because mesa is the leaf.
`test/browser/drive.mjs` is Chrome over CDP, real input, the spec runner and
the report; `test/browser/probes.js` is the in-page DOM half. `@frontierjs/ui`
now reads both by relative path instead of carrying its own copy — one CDP
client, so a trap learned in one drive is fixed for both. The extraction is
behaviour-identical: 631 assertions, 65/65 components, unchanged.

**`runtime/` — the language against a real DOM.** 39 assertions over six
fixtures: the delegation root and the five events that do not bubble,
`{@attach}` on a connected element with an animation that actually holds its
end value, scoped rules that win in a real cascade and stop at a child
component, `{#each}` node identity across a reorder, `$context` reaching
content an `{#if}` or an `{#each}` builds later.

**`vite/` — the plugin in a real dev server.** 31 assertions. HMR was proven up
to the frame Vite sends and no further; this watches a component swap in place,
twice, with the neighbour's state intact and no navigation, plus a style-only
edit, the devtools panel booting, and both compile-error routes. The fixture
app is copied to a temp directory and edited there, because an edit is what an
HMR update IS and a drive that mutates tracked files leaves the tree dirty when
it crashes.

**`repl/` — the REPL itself, and it needs the network.** `example/index.html`
loads nineteen things from the internet — Tailwind, lz-string, and an importmap
of seventeen esm.sh entries including the compiler's own acorn and astring — so
this drive is gated on reachability, kept out of `bun run test` and out of CI,
and run by hand when the REPL is touched. No network is a named skip;
`FJS_REQUIRE_NETWORK=1` makes that skip a failure. The offline work is
`FJS-326`. 19 assertions: it boots, CodeMirror mounts, 73 examples resolve, the
default compiles and **answers a real click** — which is the only thing that
separates *rendered* from *mounted*, and one of the two ways this page has
broken before — plus the drawer, its filter, and the share hash round-tripped
through a real navigation rather than encoded and read back.

**Fixed: *Open standalone* had never worked.** It fetches the runtime as source
text to inline it, from `./runtime.js` — relative to the page, so
`example/runtime.js`, which does not exist. Neither does a re-export at the
package root, though this package's own `CLAUDE.md` layout claimed one; that
line is gone too. It is `../src/runtime.js`.

**Fixed: a parse failure raised no overlay and no message at all.**
`formatError` did not set `stack`, and Vite's error overlay renders the stack
with file linking — a regex over `undefined` — so the overlay threw inside its
own constructor. The developer saw nothing: no overlay, no console line, the
page still showing the previous content. Only a browser could see it, which is
the point.

**Also found, not fixed: `FJS-325`.** An `{#each}` with no key is keyed by the
ITEM, so a repeated value throws out of `_moveBlock` on the first reorder and
the list never recovers. Keying by index is the fix and it is a semantics
decision, so it is pinned as still-broken in `each-unkeyed.spec.mjs` rather
than patched here.

**Two harness traps, both measured.** Two writes to one file within a few tens
of milliseconds produce ONE watch event — 23ms apart, the second edit fired no
`change` and arrived only when a later edit flushed it — so every write in the
Vite drive waits for the file to settle. And a file-watch → compile → socket →
re-render round trip is seconds, not milliseconds, so `eventually` takes a
timeout.

## 2026-08-16 — a delegated handler now reads `currentTarget` as its own element (`FJS-321`)

Under `addEventListener`, `currentTarget` is the element the listener is on,
and `e.target === e.currentTarget` is how anyone asks *was this element itself
clicked* — it is what `on:click|self` compiles to.

Delegation puts one listener on the root and passes the raw event down, so
every delegated handler read the ROOT. The comparison was false for exactly the
events `|self` exists to admit, and true for none of them: a modifier that
never fired, and any hand-written comparison beside it.

`_makeDelegatedHandler` defines `currentTarget` on the event per node before
calling that node's handler, and drops the override in a `finally` — a native
listener further up the same dispatch still reads its own. Two tests, one of
them for that last part.

Found under `@frontierjs/ui`'s command palette, whose backdrop could not be
clicked away (`FJS-322`).

## 2026-08-16 — a local declaration could shadow a reactive `let` into invalid JS (`FJS-319`)

`function f(ts) { const d = new Date(ts) }`, in a component whose script also
declared a top-level `let d`, compiled to:

    const $runtime.get($$sig_d) = new Date(ts)

The local declaration was rewritten as a read of the outer signal, inside its
own declaration. Nothing reported it — Invariant 15, and this time the compiler
rather than the emitter.

A function **parameter** of the same name was already handled: the walker in
`rewriteExpr` extended its scope with `collectParams` and with nothing else. So
the hole only opened when a shadow was DECLARED rather than received, which is
why no component in the repo had hit it.

The walker now collects what a scope declares as well as what it receives:
`var` across the whole function body, `let`/`const`/`function` per block, and a
`for` head's own binding. Per block rather than per function deliberately —
skipping the rewrite for a whole function because a nested block happens to
declare the name would leave a real reactive read pointing at a stale local.
Five tests, one of them that exact case.

## 2026-08-16 — `$context` reaches content a block creates later (`FJS-311`)

`_contextStack` is synchronous setup-time state: a component pushes its map,
runs `init`, pops. That is correct for everything built inside `init` — and
wrong for everything a block builds afterwards.

An `{#if}` that flips, an `{#each}` row that arrives, an `{#await}` that
resolves, a `{#key}` rebuild, a portal: each instantiates its content from
inside a reactive effect, by which time the stack has unwound to the flush's
depth. A `$context` read in there walks a stack the provider is no longer on
and gets `null`.

**Every compound component whose parts live behind a conditional was broken by
this.** `@frontierjs/ui`'s `<DropdownMenu>` provides `close()` and renders its
items inside `{#if open}`, so `DropdownItem` read `undefined` and choosing an
item never closed the menu — the contract its own docblock states, failing
silently because `close?.()` on undefined is a no-op. `<Accordion>` escaped
only because its items render on the first pass.

`captureContext()` snapshots the stack where a block is DECLARED and reinstates
it around every later instantiation. Seven call sites — `ifBlock`,
`$$eachBlock` (rows and `{:else}`), `keyBlock`, `awaitBlock`, `boundaryBlock`,
`portal`, `$$virtualEach` — because fixing one says nothing about the others.

Five tests, one per block kind plus *the nearest provider still wins*, and each
was **checked against a negative control**: with `captureContext` neutered to
`fn => fn()` all five fail.

## 2026-08-16 — RULE 23's message names the right prop, and is tested (`FJS-054`)

`on:event` on a component has always been a compiler error, and both Vite
plugins fail the transform on it — so the filed claim that it fails silently
was stale. Two real things were behind it.

The message said `Use onclick={fn}` **whatever the event was**, so the advice
for a component's own event was a second wrong guess. `on:paid` now says
`onpaid={fn}`. A modifier form adds that a modifier has nowhere to go: the
child decides what it passes, so `preventDefault` is the callback's business.

And the rule had **no test at all** — it is one `.filter()` over a component's
attributes, and losing that filter compiles the directive to a prop the child
never declared, silently, because the handler is then simply never called.
Five cases pin it, three of them the shapes that must stay legal: a directive
on an element, `onclick` as a prop, and `mesa:window`.

## 2026-08-16 — five events that do not bubble were being delegated

Every handler is routed through one listener on the delegation root, and the
list of events that cannot go there was missing `close`, `cancel`, `toggle`,
`beforetoggle` and `invalid`. A miss in that list fails in the worst available
way: the handler is bound to a root the event never reaches, so the element
renders, the browser does its half, and the component's half silently never
runs.

`@frontierjs/ui`'s `Modal` and `Drawer` are both `<dialog on:close on:cancel>`.
Escape closed the dialog natively, `handleClose` never ran, `bind:open` was
never written back — and the caller's state said *open* for the rest of the
page's life, so **the overlay could not be reopened**. Nothing threw.
`example`'s `verify:ui` had covered `Modal` since it was written; it asserted
focus going in, and never the way out. It took the kit getting a browser drive
of its own to see it (`FJS-297`).

Bubbling is now measured rather than assumed —
`ui/test/browser/specs/events.spec.mjs` reads `event.bubbles` off the
dispatched event in a real browser — and pinned against the compiler by five
cases in `compiler.test.js`.

Second fix from the same drive (`FJS-298`): a `{#snippet children}` passed to a
component built around `<slot />` reached `{...$attributes}`, and
`spreadAttributes` assigned it to `el.children`, which is a getter on
`Element` — a TypeError out of an effect that took the whole render with it.
`children` is slot content and now joins `class`/`$class` in `restProps`'s skip
set, and a function whose property is a getter with no setter is skipped rather
than assigned. **The test is a getter WITHOUT a setter, not the absence of a
setter**: an event-handler property is a plain own property in some DOM
implementations, and refusing to assign where no descriptor exists stopped
`onclick` being forwarded at all.

## 2026-08-16 — `{#virtual each}`'s documented options could not compile

**`height=N` and `viewport="500px"` are in VISION §9.7 and required by RULE 34,
and the compiler put them in the item binding.** The `as` half was matched as
`(.+)$`, so `rows as row height=48` bound the identifier list `row height=48`
and the component died as `Unexpected identifier 'height'` — naming neither the
block, nor the option, nor what was actually wrong. Every use written from the
documentation failed; the only shape that worked was the one the package's own
tests use, which declares no options.

They parse now. Options come last, after the optional `(key)`, and are scanned
at **bracket depth 0** so a destructuring default (`as { name = 'anon' }`) and an
`=` inside a key expression stay part of the binding. An unrecognised option is
refused by name with the list of the ones that exist — the rule this package
already applies to `mesa:*` — and a `height` that is not a positive number of
pixels is refused the same way, rather than reaching the runtime as `NaN` and
sizing every spacer to nothing.

Both options do something the runtime could not do without them. `height` skips
measurement, which matters because the first row is measured before a stylesheet
has sized it — happy-dom returns 0 for every row, and a real first paint often
does too, leaving the 40px fallback and a scrollbar that jumps once. `viewport`
sizes the block's own element and gives it `overflow-y` unless the caller wrote
one inline: **that element IS the scroller** — the rows and both spacers are
appended into it — which the documentation described as a viewport div the
directive creates, and it never created anything.

**Also corrected: seven places said `{#virtual each}` renders nothing on the
server.** It renders a window. `renderToHTML` sets `isBrowser` true, so the
block runs; there is simply no viewport to measure, so the window comes from the
row height and the bottom spacer carries the rest. Measured on a 1000-row list:
25 rows and a 39000px spacer. A prerendered page therefore gets its first screen
of rows, which is better than the `{:static}` fallback `FJS-067` was filed
asking for. 8 tests, both halves mutation-checked.


## 2026-08-16 — the Vite plugin is tested, and one of its features has never been able to run

**Sixty-one cases across four files, which is `FJS-024` down to its last claim.**
`test/vite-plugin.test.js` covers what the plugin decides on its own — which
files it claims, when the HMR boundary is injected, what happens to a warning,
what it serves at its virtual ids, `transformIndexHtml`, `handleHotUpdate`.
`test/vite-devtools.test.js` covers `/__mesa/devtools` and the BroadcastChannel
relay, run against **both** implementations of that route: the plugin's own and
`mesaDevtools()`, which exists for an app on Sierra's plugin and had never been
executed. `test/vite-compiler-resolution.test.js` covers sibling-vs-`compilerPath`
and the two defensive branches no real compiler output can reach — a warning
containing a newline, an error carrying `details`.

**And `test/vite-server.test.js` starts a real Vite dev server**, middleware mode
on port 0, and asks it for what a browser asks for. That is the only file that
can see a hook which is never REACHED — a middleware installed behind Vite's SPA
fallback, a virtual id another plugin resolves first, `enforce: 'pre'` losing a
race — and none of it is visible from a hand-rolled plugin context. It settled
two things the direct tests had guessed wrong: a browser fetches
`/src/Counter.mesa?import`, not the bare path (a bare GET is served as SOURCE,
because `.mesa` is not an extension Vite knows), and the virtual HMR client
arrives as `/@id/__x00__@frontierjs/mesa-client`.

**`FJS-291`, found by the first test to ask about CSS, and closed the same day.**
The compiler's `css` is a DESTINATION, not a switch: truthy inlines the scoped
rules as `$runtime.addStyles(id, …)`, falsy extracts them onto `ctx.css.result`
for the caller to place. The plugin passed its own option straight through and
then read the answer as if the word meant the same thing on both sides, so
`if (css && ctx.css?.result)` was a condition no compiler could satisfy — `true`
never leaves a result, `false` never asks. The `?mesa-css` virtual module,
`cssCache`, its `resolveId`/`load` pair and the CSS invalidation in
`handleHotUpdate` had therefore never run at all, and `css: false` silently
dropped a component's styles.

**The route is deleted rather than repaired.** Inlining is the one way styles
reach a page here, and it is the way Sierra's plugin does it for the same file —
the ids are content-addressed, which is what lets a prerendered page and the
client agree about which styles are already there (Invariant 12), and a second
route would have made one `.mesa` file's CSS arrive differently depending on
which plugin compiled it. `css: false` now means what it says: the block is
compiled and dropped, said in the option doc, the README and a test rather than
left as the silent consequence of an unreachable branch. Its one live victim was
`mesa-bench`, whose config set `css: false` to avoid virtual CSS modules and so
rendered every bench component unstyled.

Two smaller things: the plugin's `configureServer` printed four debug lines on
every dev-server start, now gone; and a plugin test must declare
`// @vitest-environment node`, because happy-dom's global `URL` makes
`fileURLToPath(new URL(…, import.meta.url))` — how the devtools route finds its
own HTML — throw `must be of scheme file` against a path that is fine in a real
dev server.

## 2026-08-15 — `FJS-D18` ruled, and the plugin that ignored the answer

**Braces mean *run code*; parentheses mean *watch*.** `$: (a, b)` is a
multi-path watch, `$: { (a, b) }` is a compile error. The two parse to the same
AST, so the parens are the only separator and the check reads them from source
position. Already implemented (`_isInertBlock`), already in the spec (VISION
§4.4/§4.8, RULES 14b/50/52) and pinned by `test/inert-block.test.js`; the ruling
is now recorded in `DECISIONS.md` § UI substrate and `FJS-D18` is closed.

**And the diagnostic reached nobody through this package's own Vite plugin.**
`compileSource` collects into `analysis.errors` and throws only on a parse
failure; `mesa-vite/index.js` had a `catch` for the throw and read `warnings`
alone otherwise, so every diagnostic the compiler DID catch — an inert `$: { }`,
a `bind:` on a non-`let` — was dropped and the half-compiled module served.
Sierra's plugin has failed the transform on `analysis.errors` since 2026-08-05;
this one now agrees, failing the build through `this.error` and returning a
throwing module in dev so the overlay fires. RULE 53 said the opposite — that
diagnostics are warnings and the build still produces output — and is rewritten
to what ships: the compiler reports, the build decides.

`test/vite-errors.test.js` is the first test this plugin has (`FJS-024` is about
the rest of it), and it checks the dev branch's message survives interpolation
into a template literal.

## 2026-08-15 — the HMR boundary is exported, and the copy of it was ahead of the original

`injectHMR` was module-private in `mesa-vite/index.js`, so Sierra — which
reimplements the PLUGIN and has no reason to reimplement the boundary — copied
it, along with the client it imports. `FJS-D16` closes that: `mesa-vite/hmr.js`
is now `@frontierjs/mesa/vite/hmr`, `injectHMR(js, id, root, clientId)` takes the
client id because each plugin serves the client at a virtual id of its own, and
Sierra deleted both of its files.

**The copy was better in three ways, which is the argument for merging rather
than picking a side.** All three came back here:

- **`canInject` fails closed.** The two patterns the wrap depends on are shapes
  of the compiler's own OUTPUT, and this plugin ran the `.replace()` calls
  unconditionally — a pattern that stops matching is silent, so the file shipped
  half a boundary. It is now asked before injecting.
- **`__setMark` lands on the NEW function.** The accept handler set it on the old
  module's `__mesaOrigFn` while passing the new one to `__mesa_hot_update`; the
  client reads it off the function it was handed, so the mark was never applied.
  The first update then registered with `hmrMark: undefined` and the SECOND
  dropped the entry as stale — **HMR worked once per page load and then reported
  no connected instances.**
- **A miss falls back to a reload.** `__mesa_hot_update` warned and returned,
  losing the edit; it now calls `import.meta.hot?.invalidate?.()`, escalating to
  the full reload Vite would have done anyway.

Also: a filename's apostrophe is escaped in the emitted comment, where it landed
unescaped inside a single-quoted string.

**Nothing tested any of this in either package**, which is how the second bug
survived. `test/vite-hmr.test.js` runs the real compiler and wraps its real
output — a fixture would keep passing after the shape it describes stopped being
emitted — and parses the result with acorn (Invariant 15).

## 2026-08-15 — the forked highlighter is deleted; fences use `@frontierjs/toolbelt/glow`

`src/glow.js` was a 211-line copy of the 371-line highlighter in the shared
package, and it was the copy without the fixes — so both defects that package
records as *fixed* were live in mesa's Markdown compiler. `compiler-md.js` now
imports the real one and the fork is gone (`FJS-191`).

What that changes for a fenced code block:

- **A rule matching more than one character is encoded.** The fork encoded per
  token, in `elem()`, and only a lone `<` or `>` — so a multi-character token
  went to the page raw.
- **A comment that opens mid-line is a token, not a block.** The fork had no
  `isTrailingComment()`, so `const a = 1 /* why */` rendered as one comment and
  a live line read as a dead one.

**Mesa now has a workspace dependency, and it is still a leaf.** `FJS-D26` ruled
`@frontierjs/toolbelt` substrate — below the dependency graph rather than a
member of it — precisely so that this import is not the thing Invariant 1
forbids. Nothing else changed about what mesa may depend on.

**Release order: toolbelt first.** `workspace:*` publishes as the exact version
it resolved to, and `@frontierjs/toolbelt@0.1.0` is a name npm has never seen —
so a mesa release that goes out ahead of it installs a dependency that does not
exist. Nothing in the workspace can catch that: `bun install` answers from
`packages/toolbelt/` and never consults the registry.

Deleting the fork exposed a second, older defect and it is fixed in the same
pass — **`FJS-261`**. rehype writes `<` as `&#x3C;` and `&` as `&#x26;`;
`compiler-md.js`'s decode table knew neither, so both survived into `glow()`,
which tokenised `&`, `#` and `;` as three separate punctuation tokens in three
`<i>` elements — which is also why no browser could put them back together. A
```html``` fence reading `<div>x</div>` reached the reader as `&#x3C;div>x…`,
and `a && b` as `a &#x26;&#x26; b`. Every fence in every `.md` page mesa
compiles was affected.

`decodeEntities()` replaces the table: **one pass over named, decimal and
hexadecimal forms alike**, never a chain of replaces. The chain is what made the
old table unfixable by extension — decode the numeric forms first and the named
ones second, and a source line that literally writes `&lt;` (`&#x26;lt;` on the
wire) comes out as a `<` nobody typed. A single pass cannot decode its own
output. The other half of the fix is in `@frontierjs/toolbelt`: `glow` escaped
`<` and `>` and not `&`, so decoding `&#x26;` alone would have put a bare
ampersand on the page.

Five cases in `test/compiler.test.js` pin the fence path — markup stays text, a
mid-line comment does not swallow the line, braces are still escaped for Mesa,
`<` and `&` arrive as themselves, and a fence that literally writes `&lt;` keeps
it written.

## 2026-08-15 — a slot made only of comments is not content

`$slots.default` was true for a component whose only child was an HTML comment.
Comments are dropped from the output unless `preserveComments` is on, so that
block rendered nothing and still answered *yes, the caller passed children* —
and a component that BRANCHES on the answer turned itself off because somebody
explained themselves above the buttons.

Found by `@frontierjs/ui`'s `<Form>`, which generates its field list when the
caller wrote no controls. The page read:

```
<Form resource={orders} …>
  <!-- why the buttons are in a named slot -->
  <Button slot="actions" type="submit">Create order</Button>
</Form>
```

and every field vanished. Nothing errored, nothing warned, and the server-side
render of the same component without the comment was correct — which is the
worst shape a defect can have.

Both slot kinds now test for content rather than for length: a named slot whose
body is comments only is likewise not passed. With `preserveComments` on, a
comment IS content and both behave as before, since the block then renders.

## 2026-08-10 — `externalSignals` has no callers left, and its replacement needed strict

No compiler change. Recorded here because the design records live in this package
and both are now settled: `EXTERNAL_REACTIVITY.md` and `PLAIN_OBJECT_STATE.md`.

Sierra stopped exporting module-level signals and stopped passing an
`externalSignals` map (`FJS-060`, closed in sierra's `CHANGES.md`). The map
survives as an app-facing escape hatch for a third-party package that does export
one; nothing in this repo uses it.

**What is worth carrying forward is what the migration nearly got wrong.** Plain
objects remove the *declaration* problem and keep the *failure*: a member read
with no `$:` watch is hoisted out of the render block and assigned once at mount,
exactly as a missed signal rewrite was. And the path-watch tier's default
confidence is **quieter** than the signal tier it replaced — it reports an
uncovered read only when the file already watches some other path on the same
import, so it says nothing about a component that watches nothing, which is the
shape the original bug had. `externalReactivityHints: 'strict'` is therefore the
end state rather than a migration aid, and the docs now say so.

Measured against the 218 `.mesa` files in the FrontierJS repo: strict reports 0.

## 2026-08-10 — a component can expose a method, and an element can have a dynamic tag

Two features the docs described and the compiler did not have. Both failed the
same way — by emitting nothing and saying nothing — which is why both survived
a suite of 1052 tests and two apps.

**`export function` was deleted from the output** (`FJS-087`). The emitter
skipped every `ExportNamedDeclaration`, and only `export let` had been handled
before it, so the declaration vanished while every reference to it survived: a
component calling its own exported function from its template threw
`ReferenceError` on the first interaction. **No render test can catch that** —
SSR dispatches no events, so the component renders perfectly and fails when a
user touches it. `@frontierjs/ui` had four components declaring `export function
focus()` and none of them had one.

It is now emitted as the plain declaration it is, with assignments rewritten
through the signal setters like any other function body, plus one
`registerExports({…})` call.

**`bind:this` on a component handed over the anchor** — a comment node — where
VISION §10.2 and RULE 36 promise the exported interface. So `ref.focus()` was a
TypeError and `ref.count` was `undefined`, both silently. It is now
`componentApi(anchor)`: methods from `export function`, and props as accessors
onto the child's own signals, so `ref.count` is the current value rather than a
snapshot taken at mount and `ref.count = 2` writes it. `bind:this` on a DOM
element is unchanged. `Form.mesa` dropped the `onready` workaround it carried
for this (`onready` stays for apps that already use it).

**`<mesa:element this={tag}>` now exists** (`FJS-023`). A tag cannot be
interpolated into a template string — the string is parsed once, and the parse
is what decides the element — so the element is compiled under the placeholder
tag `mesa-dynamic-element` and `$runtime.dynamicElement` transplants it onto an
element built from the live expression: attributes copied, children moved. The
whole ordinary element path runs over the placeholder first, so `class`, `on:`,
`style:`, `bind:` and `{@attach}` all work. Wrapped in a `keyBlock` on the tag,
because an element's tag is not writable and the alternative is an `<h2>` that
answers to `h3` for every selector on the page. The one limit: a **tag**
selector in a scoped `<style>` cannot match it, since the scoper runs on the
parsed template where the tag is still the placeholder — match on a class.

`@frontierjs/ui`'s `SectionHeader` replaced its explicit `h1`–`h6` `{#if}`
ladder with one line.

**And every other unknown `mesa:*` name is now an error naming what exists.**
That silence is what made `<mesa:element>` indistinguishable from a typo: the
element and all its children were dropped from the output, so the component
rendered without them and the build stayed green. A nested `<mesa:mounted>` —
which gates nothing anywhere but the top level — says so rather than vanishing.

## 2026-08-10 — `happy-dom` was a devDependency the SSR exports import at load

Publish prep found it, and only an isolated install could: `src/render.js` and
`src/css-inliner.js` open with `import { Window } from 'happy-dom'` — a static,
top-level import in shipped code — while `happy-dom` sat in `devDependencies`.
That resolves inside the workspace and nowhere else, so `@frontierjs/mesa/render`,
`/render-component` and `/css-inliner` (six specifiers with their aliases) would
have thrown `Cannot find package 'happy-dom'` on every installed copy. Now a
real dependency.

Worth keeping the method rather than the fix: a probe that installs the whole
family together **cannot see this** — happy-dom is present because something
else pulled it in. It only appears when the package is installed alone. Same
shape as auth's `../junction` imports: correct by adjacency, broken on arrival.

Also prepped for publishing: `files` (`src`, **`mesa-vite`** — it is a declared
export, so it must ship despite being the nested directory `FJS-026` says the
`packages/*` glob cannot see — README, LICENSE), `publishConfig.access`, a
`LICENSE`, and `repository` + `directory`. 1052 tests unchanged.

## 2026-08-10 — the Vite plugin is a subpath, and it could never find the compiler

`mesa-vite/` had its own `package.json`, which made it a package the workspace
glob could not see: `packages/*` is one level deep, so it installed nowhere, no
importer could resolve it by name, and nothing had ever loaded it. It is now
`@frontierjs/mesa/vite` (and `@frontierjs/mesa/vite/client`), two entries in
mesa's exports map. `vite` is an optional peer dependency — mesa stays a leaf
with zero workspace dependencies.

**What being uninstalled had hidden.** The plugin resolves the compiler lazily,
and its candidate list was `@mesa/compiler`, `node_modules/mesa/compiler.js`,
then two guesses relative to the project root. The first name was never
published; the second is an unrelated package that genuinely exists on npm, so
the plugin was one `npm install mesa` away from importing a stranger's code.
Neither names `@frontierjs/mesa`. It only ever worked at all through the root
guess, which requires the consumer's cwd to be mesa's own directory.

The compiler is now a sibling, resolved as one relative path from
`import.meta.url`. Relative is also the rule for every in-repo consumer of mesa:
`bun install` resolves a `workspace:*` dependency to a copy under
`node_modules/.bun/`, so reaching the compiler by package name would serve a
snapshot that goes stale on the next compiler edit. `options.compilerPath` still
wins, for a consumer testing a build that is not this one.

**A smoke import now compiles a real `.mesa` through the plugin** — the first
line of code that has ever loaded it. That is a floor, not a suite: HMR, the
error overlay and the devtools route remain unproven (`FJS-024`). The same
loading found `mesa-bench/vite.config.js` importing `./mesa-vite/index.js`, one
directory too shallow, broken for as long as it had existed.

## 2026-08-10 — three defects a suite that renders every component found

1052 tests (was 1044). `FJS-146`, `FJS-147`, `FJS-148` fixed. All three were
found by `@frontierjs/ui`'s new `test/attributes.mjs`, which renders all 64 kit
components — the first thing in the repo that renders every one. None was
reachable from a compile test, and two had been shipping for months.

**`{#each}` accepted only a real array, and said so badly.** The block called
`.map()` on whatever it was handed, so anything else died as `array.map is not
a function` — no block, no expression, nothing to search for. The case that
bit is the array-LIKE: `{#each { length: 6 } as _, i}` is how a fixed-size grid
is written, and `DatePicker` built both of its calendar panes that way, so the
component **threw on first render and had never rendered at all**, in any
environment, while compiling perfectly.

`eachItems()` is now the one definition of what an `{#each}` may iterate: an
array as-is, anything iterable (a Set, a Map, a NodeList, a string) or
array-like through `Array.from`, `null`/`undefined` as empty. A number or a
plain object is **refused by name** — both are typos with an obvious intent,
and converting one produces an empty list where the author expected rows; the
number's message says to write `{ length: n }` instead. `{#virtual each}` reads
the same getter and gets the same contract.

**An `{@attach}` ran during a server render.** `renderToHTML` renders against
happy-dom, which implements no Web Animations API, so an attachment that
animates threw `el.animate is not a function` and took the whole render with
it. The rule was already written and simply not applied here: an attachment
runs when the element MOUNTS (VISION §10.6), and a server render has no mount —
which is why `$onMount`, `watchProxy` and path watches are already no-ops under
`setRenderEnvironment(true, false)`. `attach()` and `applyAttachments()` now
return early on `!_isClient`, beside the six guards that already say it.

**A `style:` directive resolving to `null` wrote the string `null`.** For
`position` and `z-index` but not `color` or `top` — same element, same render,
because `setProperty` was handed the null and the answer was the DOM
implementation's. Every conditional style in the repo is
`style:x={cond ? 'v' : null}`. A browser ignores the invalid declaration, so
the cost was never the paint: the server's attribute and the client's
disagreed, which is what hydration compares. `null`, `undefined` and `''` now
remove the property.

Mutation-checked: reverting the three turns 1, 4 and 16 tests red.
`example` `verify` 37/37, `verify:ui` 27/27, `verify:public` 21/21; sierra 810,
email-kit 34, `@frontierjs/ui` 64 compile / 26 render / 60 attributes / 7 form.

## 2026-08-10 — a destructuring assignment writes through the setters

1044 tests (was 1035). `FJS-021` fixed; `FJS-022` closed as no longer real.

`[a, b] = [b, a]` to two reactive lets emitted

```js
[$runtime.get($$sig_a), $runtime.get($$sig_b)] = [$runtime.get($$sig_b), …]
```

— an assignment to a call, so the module did not parse. Clean compile, empty
`analysis.errors`, and the failure surfaced as *contains invalid JS syntax*
from Vite. Both rewriters recognised only a bare `Identifier` on the left, so a
pattern fell through to the generic descent and every target was rewritten as a
READ.

The pattern is now mirrored into temps and each target written back through
whatever it is — a setter for a reactive let, an ordinary assignment for
anything else, so a pattern may mix them:

```js
[a, plain, o.x] = triple
  → (($$dv) => { let [$$d0, $$d1, $$d2] = $$dv
                 $$set_a($$d0); plain = $$d1; o.x = $$d2; return $$dv })(triple)
```

Reproducing the pattern rather than rebuilding it is what keeps holes, rest
elements and nesting working without the rewriter having to understand them —
only the leaves move. Two exceptions it does have to know about: a **shorthand**
property is expanded (`{a}` → `{a: $$d0}`), because the identifier there is both
the key and the target and only the target moves, and a **default** is an
ordinary expression that may read a signal, so it is rewritten in place. The
IIFE answers the right-hand value, which is what an assignment expression
evaluates to, so `x = ([a, b] = pair)` keeps its meaning. A pattern naming
nothing reactive is left exactly as written.

**Both rewriters needed it and neither could borrow the other's.** A handler in
the script goes through `rewriteAssignments`, the same handler written inline on
the element goes through `rewriteExpr`; they index into different strings and
disagree about what is reactive — `rewriteExpr` knows the local scope. So the
shape they share is passed in (`source`, `setterFor`, `rewriteSub`) and the
walk is written once. Fixing only the script path passes a compile test and
leaves every inline handler broken, which is how this stayed open.

**`FJS-022` — `{@const}` inside `{#each}` calling the index — does not
reproduce and is closed.** It was real while the loop index was a plain number;
the index is a signal in its own right since 2026-08-04 (the fix for stale
indices after a keyed move), so `idx()` is now the correct emission. Probed
plain, keyed, destructured, nested, after a mutation, after a reorder, and
through SSR. It is pinned in `emission.test.js` because the two halves are
owned in different files — the compiler decides to CALL it, the runtime decides
to hand over a getter — and either one moving alone brings back `idx is not a
function`.

Proven by `example`: `verify` 37/37 and `verify:public` 21/21. In the kit,
`DatePicker` drops its temp-variable swap and `Breadcrumbs` loses a comment that
had become false.

## 2026-08-07 — a component's anchor is a node of its own

1035 tests (was 1027). `FJS-110`.

Two components separated only by whitespace shared one anchor:

```mesa
{#if open}
  <Button disabled={busy || !picked}>Attach</Button>
  <Button onclick={cancel}>Cancel</Button>
{/if}
```

A pending label request is satisfied by the next text node, and `tpl` keeps
those as separate entries while the emitted template is one **string** — where
adjacent text parses as a single DOM `Text` node. So both `Button`s resolved
their anchor to the same whitespace.

**The DOM was correct.** Each component inserts before that node, in source
order, so it rendered, laid out and clicked exactly as written. But the
component registry is keyed BY ANCHOR: the second `registerComponentAnchor`
replaced the first, and the first component **never received another prop push
for the life of the page**. Attach stayed disabled forever while a plain
`<button>` two lines up, carrying the identical expression, followed the pick —
because an attribute binding writes its node directly and needs no registry at
all.

A component invocation now always pushes an anchor comment of its own rather
than adopting the text beside it. Several templates got *smaller* as a result:
`<div><><><></div>` became `<div><><></div>`, since a component no longer needs
a filler comment plus a separately-resolved label.

Eight shapes are pinned — `{#if}`, `{:else}`, `{#each}`, inside an element, at
component root, adjacent with and without whitespace, and three in a row. Four
fail if the fix is reverted, checked.

**The eight probes that missed it are the lesson.** Every one of them put a
static element between the two components while "reducing" the case — which is
precisely the thing that made the anchors distinct. Reproduce by adding to the
real screen, not by simplifying it.

## 2026-08-06 — an attachment runs on an element that is in the document

1027 tests (was 1024). `FJS-114`.

VISION §10.6 says `{@attach}`'s function "is called when the element mounts".
It was called when the element was **built** — before anything inserts it — so
every attachment in the repo saw `isConnected === false` and, for a root
element, `parentNode === null`.

Everything an attachment is for needs a connected node. `focus()` is a no-op,
`getBoundingClientRect()` is all zeros, an IntersectionObserver never fires.
One case is worse than useless:

```js
el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 100, fill: 'forwards' })
```

On a disconnected element that returns an animation with `startTime: null`
which **never starts, even after the element is connected**, and which is not
even listed in `el.getAnimations()`. The element paints at keyframe 0 for good.

So `@frontierjs/ui`'s CommandPalette — `position: fixed; inset: 0; z-index:
9000`, with an entrance fade — was a **completely invisible full-screen
backdrop that swallowed every click on the page**. Reported as "clicking Search
⌘K does nothing and the whole app freezes". Toast, Popover, DropdownMenu,
ConfirmationPopover and AlertProvider all use the same pattern.

The attachment is now deferred to a microtask — the queue `$onMount` already
uses — when the element is not yet connected. An element that IS already
connected still runs synchronously, so nothing that was ordered correctly
before is reordered, and a detached element that never gets inserted still runs
one tick later rather than silently never running. Cleanup is registered
synchronously either way, so it lands on the effect's own owner.

3 tests here, plus `example`'s `verify:ui`, which now opens the palette by
CLICKING the header button — only ⌘K had ever been driven — and asserts
computed opacity, hit-testing and size. Both fail if the fix is reverted,
checked by reverting it.

## 2026-08-06 — the extension decides the language, and a clone invents nothing

1024 tests (was 1015). Two fixes, both found by prerendering a real page in
`example/` rather than by a test — `FJS-106` and `FJS-107`.

**A `.mesa` file with frontmatter was compiled as MARKDOWN.** `compileSource`
routed any source beginning with `---` to `compileMd`, whatever its extension.
A `---` block is how every Sierra route states its title and its render mode, so
that heuristic said "this component is Markdown" about most route files in
existence. Markdown escapes what it does not recognise:

```mesa
<CatalogList client:load products={data?.products ?? []} />
```

came out as a PARAGRAPH OF ESCAPED TEXT with the props stringified into it,
while `<LiveStock />` beside it — no attributes, so a raw HTML block — compiled
as a component and mounted correctly.

It stayed hidden because it only bites a caller who hands the compiler a raw
file. Sierra's Vite path strips frontmatter before calling `compile()`, so dev
and the SPA build were right and only the PRERENDERER, which imports the `.mesa`
off disk through `renderComponent`, was wrong. One file, two languages,
depending on which build read it.

Now: `.md` → Markdown, anything else → Mesa, which is what VISION's file-type
table always said. `compile()` strips a leading `---` block, exposes it as
`ctx.frontmatter`, and replaces it with the same number of blank lines so a
warning still points at the line the author wrote. Mesa's three Markdown REPL
examples are named `.md` now, which is what they are.

**Every server-rendered `<input>` carried `formaction="http://localhost/"`.**
happy-dom's `cloneNode` does not copy an input's attributes — it re-derives some
of them from default PROPERTIES — so each clone of a cached template gained
`formaction` (the build machine's own URL) and `formmethod=""`, and an authored
relative `formaction="/search"` came back absolutised.

Not cosmetic: `formaction` overrides its form's action, so a prerendered form
posted to whatever machine built the site, with that machine's localhost URL in
a public file. `template()` now PARSES per instance on the server rather than
cloning a cached parse — the same path that produced the original, so what ships
is what was written. The client still clones; the cost is one parse per instance
of a page that is rendered once.

## 2026-08-06 — a `.mesa` import may name a package

1013 tests. Two fixes for the same shape of caller: somebody rendering a
component tree that is not their own.

**A bare specifier resolves.** `compileTree` did `path.resolve(dirname(importer),
spec)` for every `.mesa` import, so

```mesa
import Email from '@frontierjs/email-kit/components/Email.mesa'
```

— the usage that package's README documents — became
`…/api/emails/@frontierjs/email-kit/components/Email.mesa` and ENOENT'd. It
worked inside the kit only because its own templates import `../components/…`
relatively. Bare specifiers now go through `import.meta.resolve` from the
importing file, with the old path join kept as the fallback so a genuinely
missing file still names what the author wrote.

**A `subject` export may be a function.** `<script module>` runs once at import,
before props exist, so `export const subject` could only ever be a constant —
and a receipt's subject names the record. Module exports already came back as
values; what stood in the way was the email document wrapper calling
`subject.replace()` to build its `<title>`, which threw
`subject.replace is not a function` out of the renderer. The title is now taken
only when the export is a string, and `result.subject` hands back exactly what
was exported for the caller to apply.


## 2026-08-06 — `prop=""` on a component is an empty string, not `true`

1015 tests (was 1013 — two new).

`<Component prop="">` compiled to `prop={true}`. `inspectProp` decided the
boolean form by testing the value for falsiness, and an explicit empty string is
falsy — so the one spelling every `@frontierjs/ui` component documents for
"suppress this" produced the opposite of nothing.

The parser had never lost the distinction: a valueless attribute is
`{ value: undefined, type: 'attribute' }` and `prop=""` is
`{ value: '', type: 'text' }`. The test is now `value === undefined`.
`<Table striped>` is unchanged, which the existing tests already pin.

Found by wiring `<Select placeholder="">` into `packages/basecamp`'s workspace
switcher: the placeholder was suppressed in the source and rendered anyway, as
an `<option>` whose visible text was the word **`true`**. Silent everywhere it
could have been caught — a valid prop of the wrong type, a clean compile, and a
component that rendered.

Only component props go through this path; element attributes are emitted
separately, so `<option value="">` was never affected.

1013 tests (was 1012 — one new, and it is the point of this entry).

`renderComponent()` compiles to a temp `.mjs` and imports it, so that file has to
sit somewhere Node can resolve `@frontierjs/mesa/runtime.js` from. `findMesaDir()`
found that directory by testing `dirname(import.meta.url)` for a `package.json`
— which stopped being true the moment this file moved into `src/`. The fallback
then searched up from **`process.cwd()`**, so it worked only when the process
happened to be started inside `packages/mesa`, and any other caller hit the last
resort: the OS temp dir, where the emitted `import '@frontierjs/mesa/runtime.js'`
cannot resolve at all.

It now walks up from its own location to the nearest `package.json`, which is
correct whatever the layout.

Invisible from here, and total from outside: **every one of
`@frontierjs/email-kit`'s 34 tests was failing**, and that package's own state
file said "34 tests green". Found while sweeping the `mesa-email` → `email-kit`
rename. The comment above `findMesaDir` already stated the requirement this
broke; the code had quietly stopped meeting it.

**Why no test here caught it, and what now does.** Every test in this package
runs from the mesa package root — the one working directory where the broken
lookup still found the right answer. So the new case renders in a **child
process with its cwd outside the repo**, which is what a consuming package
does. Reverting the fix fails it with
`Cannot find package '@frontierjs/mesa' imported from /tmp/__mesa_render_…`;
that was checked by reverting it.

The last-resort branch **warns** now rather than silently writing temp modules
to a directory where the runtime import cannot resolve. Landing there is a
misconfiguration, and it should not have to be diagnosed from a stack trace that
points at `/tmp`.


## 2026-08-05 — `<mesa:boundary>` watches what its body reads

1012 tests (was 1003).

A boundary watched **every** async-derived value in the component, whatever its
body referenced — the compiler said so in a comment:

    // Get all async-derived vars — boundary watches all $async state objects

So a boundary around a city dropdown stayed in `pending` while an unrelated
reports fetch was in flight, and one `await` that never resolved held content
that did not use it, forever. Two boundaries in the same component watched the
same union and therefore always showed and hid together, which made the
multiple-boundaries-per-component capability VISION §12.5 advertises
functionally single.

The watch set is now the async values the body reads — through an
interpolation, a block header, an attribute, a component prop or an `@const`,
all of which are pinned by tests. The collection deliberately over-approximates
(it scans the subtree's expression sources for identifiers) because
under-watching is the dangerous direction: it would show content before its
data arrived.

Two cases keep the whole-component union:

- **The body reads no async value.** That is how you say "gate this region on
  everything", and it is the only way to say it.
- **The body renders a snippet defined elsewhere** (`{@render foo()}`), whose
  reads are not in this subtree.

Emission is otherwise unchanged — same `boundaryBlock` call, same snippet
resolution, narrower first argument.

Repo register: `ISSUES.md` FJS-073.

## 2026-08-05 — `bind:files` threw on mount in a real browser

1003 tests (was 997). Verified in headless Chrome, because none of this is
observable in the test DOM.

`input.files` is **not** read-only — the IDL attribute is `FileList?`, and the
setter is there in every current browser. What it will not take is anything
that is not a FileList. The generic property path ran
`el.files = get() ?? ''`, so a component mounting with an unset `let picked`
assigned the **empty string** and Chrome threw
`Failed to set the 'files' property on 'HTMLInputElement': Failed to convert
value to 'FileList'` before the component finished rendering. happy-dom's setter
accepts any value at all, so the suite saw nothing.

`bind:files` now has its own path:

- **undefined** is "no value yet", not "clear" — it leaves a selection the user
  just made alone.
- **A FileList** is assigned straight through, recognised by shape rather than
  `instanceof`: a FileList from an iframe is a different constructor and fails
  the instanceof check, and so does a shimmed DOM's.
- **An array of File objects** is converted through a `DataTransfer`. The DOM
  refuses one — `el.files = [file]` throws — and a DataTransfer is the only way
  to build a FileList, which is not something every caller should have to learn.
- **null** clears. This is the one thing assigning `files` cannot do: Chrome
  accepts `el.files = null` and then ignores it — a two-file input still holds
  both — so the clear goes through `el.value = ''`, which measurably works.
- Anything else warns and leaves the input untouched, instead of throwing a DOM
  TypeError from inside an effect.

Svelte binds a FileList here too and tells you to build one with a DataTransfer
yourself; the array conversion and the working `null` are where this goes
further. Solid has no `bind:` at all, so there was nothing to match.

New `fileInput` example — reads the selection, adds a File built in code (the
array path), and clears. Driven end to end.

## 2026-08-05 — unknown `{@tag}`s now warn, and `<select>` binds properly

997 tests (was 988).

**An unknown `{@tag}` was dropped in silence.** The branch that did it carried a
comment reading *"other @directives fall through silently"*, and it meant
`{@debug n}` and `{@nonsense n}` compiled to byte-identical output: no error, no
warning, no emission. A typo like `{@rendr items}` cost you the markup and told
you nothing. It warns now, names the tags Mesa does have ({@render}, {@html},
{@const}, and {@attach} inside an element tag), and points `{@debug}` at
`$inspect`, which is the thing the author actually wanted. The four supported
forms stay silent — pinned by a test.

**`<select>` was bound as if it were an `<input>`.** `bindInput` did
`el[name] = value` / `set(el[name])`, which for a multi-select meant writing
`el.value = ['a','c']` — coerced to `"a,c"`, matching no option, clearing the
selection — and reading back a string that replaced the caller's array, so the
next render of it threw `picked.join is not a function`. Two directions, both
wrong, no diagnostic.

A select now binds through its options:

- `<select multiple>` reads an **array** of the selected option values, and
  writing an array sets the selection.
- A single select resolves through `selectedIndex` rather than per-option
  flags — a single select must always hold exactly one selection, so clearing
  the old one and setting the new one as two writes is a state the element
  quietly repairs behind you.
- Option values no longer have to be strings. `<option value={obj}>` stashes the
  real value on the element (`__value`, set by `set_attribute`) beside the
  attribute, and the binding hands that back. Before, an object option reached
  the DOM as `"[object Object]"` with no way home — which was already broken for
  single selects, quietly, and matches what `bind:group` has always done for
  checkbox and radio groups.

Two things the browser taught on the way in, both now written into the code:
`el.options` is a **live** collection and writing `selected` re-derives it, so
iterating it directly reads entries that have already moved — it is snapshotted.
And a select inside a detached fragment reports **no options at all**, so the
initial selection is applied again on the microtask after mount; with static
options the first pass already did the work and the second is a no-op.

`selectBindings` gained a multi-select and an object-valued select, both driven
end to end. The feature ratchet gained both.

## 2026-08-05 — three more dead features, found by writing their examples

988 tests (was 975), 72 REPL examples (was 66). Same shape as the `{#each …, i}`
entry below: features fully implemented, documented in VISION, and never once
executed.

**`$: obj.path, handler` on a local `let` threw on mount.** The two roots
produce different shapes of watch signal — `watchPath()` returns a read
FUNCTION for a proxied import or a local `const`/`var`, `track()` returns a
tracked OBJECT for a local `let`. The compiler emitted `$$watch_o_a()` for both,
so any component with a local path watch died with
`$$watch_o_a is not a function`. It emits `$runtime.get(…)` now, which already
reads either shape.

**`$: { dep, () => … }` threw on mount.** `orderedGroup` read its deps with a
bare `dep()`, and the compiler passes tracked objects for local signals — the
emit site's own comment says "pass the signal object itself". It reads through
`get()` now. The whole ordered-group feature was dead, and the example named
`orderedGroup` does not use `$: { }` at all, so the name in the sidebar was the
only thing covering it.

**`{#each xs as x, i}` rendered stale indices after any reorder.** The
reconciler re-pointed a surviving block at its new item only when the ITEM had
changed — but a move, a reverse or a splice hands the same object to a block at
a new position, so the index signal was never written and two rows could show
the same `i`. `_sync(block, item, index)` owns that comparison now, for all
three diff paths. Strictly invisible before the fix below: an indexed `{#each}`
threw on mount, so nobody got far enough to see a stale index.

**`{...$attributes}` stringified event handlers into the DOM.**
`spreadAttributes` looked for a setter on `Object.getPrototypeOf(el)` — one
level. `value` is on `HTMLInputElement.prototype` and was found; `onclick` is on
`HTMLElement.prototype` and `id` on `Element.prototype`, and both fell through
to `setAttribute`, so a forwarded handler reached the page as
`onclick="() => $$set_clicks(…)"` and never fired. The lookup walks the whole
chain now (cached per prototype), and a function value always takes the property
path — a function is never a useful attribute string.

**Six new examples**, each for a feature that had none: `attributeForwarding`
(`$attributes`/`$props`/`$slots` + spread), `maskedInput` (`bind:value|mask`,
including a reactive pattern), `internalSlotValues` (Map/Set/Date under RULE 49,
plus `delete` under a watch), `objectPathWatch`, `orderedWatchBlock`, and
`nestedEach` (keyed `{#each}` inside keyed `{#each}`, both using the index).

Two things they taught on the way in, now written into the examples themselves:
replacing a watched object re-proxies it and fires **every** watch on it,
changed or not; and an *enumeration* does not subscribe — a template reading
only `Object.keys(flags)` never re-renders, while `{...flags}` does, because
spread reads every key.

The `inspect` example was **broken as shipped** — it imports `./store.js` and
carried no such file, so the REPL resolved it to an empty mock and the example
died on mount with `Invalid value used as weak map key`. It has its store now.

The mount ratchet grew to match: multi-file examples are compiled into
`userImports` exactly as `index.html` does, so **all 68 runnable examples mount
and render**, not just the self-contained ones. Only an example importing a bare
specifier (`@ui/…`, fetched over the network by the real REPL) stays out of
reach.

## 2026-08-04 — portals were unclickable, and five more from building screens

975 tests (was 967). A second pass over `example/`, adding the screens that use
the kit's *behavioural* components — an order detail with tabs and a confirm
dialog, a products filter bar, a settings screen, a ⌘K palette. Everything
below compiled clean and failed in a browser.

**1 — a click inside `<mesa:portal>` never reached its handler.** Delegated
handlers are `__click` properties, found by walking from the event target up to
a REGISTERED delegation root, and `mount()` registers only the app's own
container. A portal appends to `document.body`, outside it, so nothing
dispatched: every menu item, command-palette row and toast dismiss button in
`@frontierjs/ui` was inert — no error, correct markup, correct ARIA, and a
click that did nothing at all. `portal()` now registers its target as a
delegation root, reference-counted so two open portals sharing `document.body`
cannot tear each other's listener down.

**2 — an assignment inside a component prop compiled to a signal READ.**
`<Modal onclick={() => open = false}>` emitted
`() => $runtime.get($$sig_open) = false` — `Invalid left-hand side in
assignment` at click time. `on:click` on an ELEMENT has always passed
`ctx.setters` to `rewriteExpr`; the component-prop path did not.

**3 — `$: fn(), handler` emitted spliced garbage.** The post-call hook parsed
the handler at offset 0 and let `rewriteAssignments` slice `ctx.script.source`
with those offsets — two coordinate systems. `$: rows(), () => { high = ceiling }`
came out as `$$set_high(sa'`, taken from the middle of an import statement, and
Vite reported only "contains invalid JS syntax" with no line. Both handler
paths now share `rewriteFragmentAssignments`.

**4 — the same hook threw at mount when the function was a `const`.**
`$: rows(), …` where `rows` came from `const { get: rows } = useStore(store)`
compiled fine and threw `Assignment to constant variable` before anything
rendered — the hook works by replacing the binding. Now a compile error that
says so and suggests watching a value instead.

**5 — an attribute depending only on a `{@const}` was written once.** The
static/reactive split tests the emitted expression, and a reactive `{@const}`
reads as `$$_const_name()`, which the bare-call pattern deliberately excludes
(`$` lookbehind). In the kit's Steps, the step's CLASS tracked the state and
its `aria-current` did not, so a completed step went on announcing itself as
the current one.

**6 — a hyphenated prop was an unquoted object key.** `<C aria-label="x">`
emitted `{aria-label: 'x'}` — a syntax error in generated code, reported
nowhere.

**Also: `$attributes` now means what VISION §12 says it means** — what the
caller passed that the component did NOT declare, with `class` excluded (it
arrives as `$class` and is merged, not replaced). It used to be `$option.props`
unfiltered, identical to `$props`, so forwarding it wrote `tone="danger"
variant="ghost"` onto the DOM node. This is what lets a component kit accept
`id`, `aria-label`, `title` and `data-*` without enumerating them.

## 2026-08-04 — snippet props: documented, never implemented

967 tests (was 960). All three found in an afternoon by reskinning `example/`
with `@frontierjs/ui`, whose entire composition API is snippet props. Each one
compiled clean, threw nothing, and produced a page that looked plausible.

**1 — a snippet inside a component tag never reached the component.** VISION
§9.5 says "named snippets defined directly inside a component tag are
automatically passed as same-name props". They were not: a `{#snippet}` child
fell through to the default slot, where `buildBlock` hoisted it as a local
function inside the *slot's* scope, and nothing ever called it. So

```svelte
<Table {columns} {rows}>
  {#snippet row(r)}<tr><td>{r.name}</td></tr>{/snippet}
</Table>
```

drew a table with a head and an empty body. No error — the child's
`{@render row?.(r)}` optional-chained away over an undefined prop. Snippet
children are now compiled in the calling scope under a unique name
(`$$snip<N>_row`, so two components in one block can each take a `row`) and
passed as props. Same bug shape as `bind:` on a component in the 08-02 entry:
documented, unused in-repo, so never exercised.

**2 — a snippet's arguments were read once and frozen.** With (1) fixed the
table drew its rows and then ignored the store: `{@render row(r)}` read `r`
while building the block, and a snippet's DOM is built once. Arguments are now
passed as **getters** — `row(anchor, () => r)` — and read inside the body
through `r()`, so the read happens inside each binding's own effect and
subscribes to whatever signal the caller's expression touched. No DOM churn,
same fine-grained model as everything else. `mesa:boundary`'s `failed` snippet
passes its error the same way.

**3 — a valueless attribute on a component was a variable reference.**
`<Table striped>` compiled to `striped: striped` rather than `striped: true`,
so it threw `striped is not defined` — or, when the caller happened to have a
local of that name, silently passed that local's value. The boolean form is
now `true`; the braced `{striped}` is still the pass-the-variable shorthand.

Pinned in `test/emission.test.js` (7 new tests, all of which fail against the
prior compiler).

## 2026-08-04 — every `{#each xs as x, i}` threw on first render

957 tests (was 955). Reported from the REPL against the SVG bar-chart example
(`i is not defined` in the console); it was not that example's fault, and not
SVG's. **Every indexed `{#each}` in the language was dead.**

`$$eachBlock` creates two signals per row and calls
`makeItem(getItem, getIndex)`. The compiler emits the matching row callback —
`($parentElement, bar, i) => …` — and calls `i()` inside it. Between them,
`makeBlock(fr, fn)` returned `(v) => { … fn?.($el, v) }`: **one parameter, one
forwarded argument**. The index getter was dropped on the floor, so `i` was
`undefined` and the first `render()` threw `i is not a function`.

Fixed by forwarding it: `(v, i) => fn?.($el, v, i)`. The virtual-list path had
the same one-arg call (`makeRow(getItem)`) and is fixed with it.

**Why the suite was green.** `test/runtime.test.js` calls `$$eachBlock` with a
hand-written `makeItem`, never through `makeBlock`, so the runtime's two halves
were each tested and their seam was not. `test/repl.test.js` compiled all 66
examples and checked the output *parsed* — the emission was correct, so it did.
Nothing ran a compiled component with a row index in it.

The ratchet is in `repl.test.js`: **all 61 self-contained examples now mount and
render**, not just compile (plus a narrow pin on the indexed-each contract). Two
harness gaps had to be closed to get there — happy-dom has no `el.animate`, now
stubbed for the run, and the test file's transcription of index.html's
`execCompiled` was missing the `<script module>` export-strip, so
`moduleContext` could never have run under it.

## 2026-08-04 — `x = x` forces a notify on local state too

955 tests (was 952). Follows the entry below, and the interesting part is that
**the idiom already existed** — it just only worked on one side of the boundary.

For a `$:`-watched **import**, `themeNew = themeNew` has always compiled to
`$$fire_themeNew()`, with a comment in `rewriteAssignments` calling it *"the
developer's way of saying I mutated this object externally, please force a
re-render"*. It has to be rewritten there because ES module bindings are
read-only, so the assignment could never have been literal.

For a **local** `let` the same source compiled to an ordinary `$$set_user(user)`,
and signals write through `Object.is` — so the identical reference was skipped
and nothing happened. One idiom, two behaviours, no diagnostic. Now both force.

**Per-write, not per-signal.** `track()` has carried an unused `_alwaysNotify`
flag since before this that would have made a binding *always* notify; that is
the wrong shape, because it discards the equality optimisation for every
ordinary write to that binding. `createSignal`'s `write(next, force)` and
`set(tracked, value, force)` take the flag per call, and only the
self-assignment call site passes it. Nothing else changes: an equal write is
still skipped, and a bare mutation with no assignment is still inert (RULE 43).

Three tests pin it, including one asserting `write(1)` after `write(1)` still
does not notify while `write(1, true)` does. `replaceNotMutate` now demonstrates
all three routes — replace, mutate-then-`x = x`, and `$:` watch — verified in
the REPL: `score 0 → 5` by mutation+self-assign, `→ 15` by replacement, and
light→dark by watched mutation.

Recorded in `DECISIONS.md` and VISION **RULE 43**.

## 2026-08-04 — `replaceNotMutate` only taught half the rule

Not a bug — a documentation gap, found by someone editing the example to try
`user.score += 10; user = user` and asking why nothing updated.

`set()` writes through `Object.is` (`if (eq(value, next)) return`), so assigning
the **same reference** is skipped entirely. The mutation already happened; there
is simply nothing to notify. Measured:

| written | result |
|---|---|
| `user.score += 10; user = user` | no update |
| `user = { ...user, score: user.score + 10 }` | updates |
| `user.score += 10; user = { ...user }` | updates |
| mutation alone | no update |
| `$: user` + mutation alone | **updates** |
| `$: user.score` + mutation alone | **updates** |

The example said "Mutating a property silently does nothing. Replace the whole
value." — true, and only half of RULE 43, which ends *"unless a `$:` path watch
covers it"*. Nothing in the corpus demonstrated that half for a **local**
object, so the obvious next guess is the Svelte reflex `x = x`, which is exactly
the one thing that cannot work here.

The example now names why `user = user` is skipped, and adds the second route:
a `prefs` object with a bare `$: prefs` watch, mutated in place by a Toggle
theme button. Both halves are demonstrated rather than asserted. Verified in the
REPL — every button, including light↔dark on a mutation with no copying.

## 2026-08-04 — the REPL's own CSS could hide an example's markup

The Slots example rendered a blank preview. Its DOM was **perfect** — both
panels, filled slots, fallbacks, no errors, no warnings, and it mounted
correctly outside the REPL. `.panel` was `display: none`.

`Panel.mesa` renders `<div class="panel">`. So does the REPL: its tab panes are
`<div class="panel" id="panel-preview">`, styled by a bare `.panel { display:
none }` / `.panel.active { display: flex }` pair. **A preview renders into this
page**, so an example's markup are siblings of the REPL's own DOM under one
stylesheet, and any bare chrome selector matches example content too.

Most of the chrome CSS was already anchored to an id or a namespaced class
(`.ex-item.active`, `#group-bar.visible`, `.cm-*`, `.rx-*`). Eleven selectors
were not, and the generic ones are exactly the names an example would pick:
`.panel`, `.tab`, `.pip`, `.plbl`, `.legend-item`, `.legend-dot`,
`.view-toggle`. All are anchored now — `#tab-content > .panel`,
`#tab-bar .tab`, `.ph .pip` — with a comment at the tab-content rules saying
why it is load-bearing rather than tidiness. The example keeps `class="panel"`
on purpose: it is the canary if a bare rule ever comes back.

Two follow-ons from actually looking at the result:

- **`Panel.mesa` had no styles at all.** It named `.panel` and `.body` and
  styled neither, so even once visible it read as loose text. It has a scoped
  `<style>` now — which also demonstrates the boundary, since the markup the
  host passes into a slot carries the *host's* scope and Panel cannot reach it.
- **`.self-styled` was too blunt about inherited properties.** Turning the
  preview's base rules off (correct — a component that styles itself owns its
  look) left text inheriting the REPL chrome's purple monospace, so an example
  that styles only some of its elements looked broken rather than plain.
  `#pv-container` now sets `color`, `font-family`, `font-size` and
  `line-height` on the **container**, so they are inherited defaults a
  component rule still beats for any element it targets.

Checked across counter, slots, scopedCSS, classSystem, contextIsolation,
uiComponents and kitchenSink: no errors, and **zero elements that carry text
and measure 0×0** — the assertion that would have caught this one.

## 2026-08-04 — reactive `$context` never worked, and the example that would have shown it was faked

952 tests (was 950).

**The bug.** A `$context` read returned the right value on first render and
**`undefined` on every render after that**. `contextRead` walks `_contextStack`,
which only exists between `push_component` and `pop_component` — i.e. while a
component is being constructed. Both consume forms compiled the lookup *inside*
the derived body:

```js
const n = trackDerived(() => { const $g = $ctxRead('n'); return $g ? $g() : undefined })
```

A derived recomputes later, from an effect, when that stack is empty — so the
second evaluation found nothing. The lookup is hoisted out now and only the
**call** stays inside, which is what subscribes; the key a component resolves to
cannot change for its lifetime, so resolving once is correct. Both `const x =
$context.k` and `let x = $context.k` were affected. `var` was not — it samples
during construction.

So *"descendants auto-update when these change"*, which `contextBasic`'s own
comments have claimed all along, was false.

**Why it survived.** Every `$context` test asserted on emitted text —
`expect(out).toContain("$ctxRead('theme')")` — and the emitted text was fine.
Nothing mounted a provider with a child and changed the value. Two tests do now,
including one that mounts the same provider twice and checks the instances stay
independent. They use `runtime.mount()` rather than this file's `mount()`
helper, which calls the component directly and therefore registers no delegation
root — no click would ever fire through it.

**And the example.** `contextIsolation` demonstrated instance isolation with
`countA`/`countB` in a single component and a comment saying *"in a real app,
Counter.mesa would have…"* — it used no context at all. It is three real files
now, using the multi-file example support: `Display.mesa` reads
`$context.count`, `Counter.mesa` provides it and renders a `Display`, and the
main file mounts two `<Counter>`s. Nothing is simulated, and the comments
describe what the code does instead of what a real app would do.

Verified in the REPL itself: `[0,0]` → A `+1 +1 ×2` → `[4,0]` → B `+1` →
`[4,1]` → A `reset` → `[0,1]`, with each instance rendering its own accent
colour delivered through context.

## 2026-08-04 — the classSystem example taught a pattern that cannot work

It passed `class="chip chip--ok"` into a child component and declared `.chip`,
`.chip--ok`, `.field` in its own scoped `<style>`. Since RULE 55 (2026-08-03)
those compile to `.chip.mPARENT`, and the child's elements carry the *child's*
hash — never the parent's. **The class names crossed the boundary and none of
the styling did**, so the chips rendered as bare text while the source looked
exactly like a working styling API.

The `{class}` passthrough itself is fine — verified end to end, static and
dynamic parent values both arrive and merge. Only the CSS was unreachable.

Fixed by making the handed-down rules `:global(...)`, which is the documented
escape, and by saying so in the example's own prose: the class *name* crosses
the boundary, the *styling* does not, and going global means you are styling
markup you do not own, so keep the names specific. The example now also keeps
one ordinary scoped rule (`h2`) so both halves are visible side by side.

Pinned in `test/compiler.test.js`: a scoped `.chip` rule produces
`.chip.HASH`, the child's `<span class="chip">` does **not** match it, and
`:global(.chip)` does. Verified in the browser too — the chip now computes
`#dcfce7` / `#166534` at 999px, and the scoped `h2` rule still applies.

One note for anyone probing this page: `mount()` inserts a `<span>` label, so
`querySelector('span')` returns the label, not your component's first span.
That produced a convincing false positive here — an "empty class" that looked
like a broken passthrough. Remove the label or query something specific.

## 2026-08-04 — the UI Library example mounts the real `@frontierjs/ui`

It had been dead since `ui-v2/` became `packages/ui` on 2026-08-03. The REPL
resolved `@ui/Button.mesa` by fetching `./ui/Button.mesa` — a directory inside
this package that the move deleted — so all four imports 404'd and the preview
read `Runtime error: Card is not a function`.

`@ui/forms/Button.mesa` now resolves to `packages/ui/components/forms/Button.mesa`:
the actual package, not a copy, so the showcase cannot drift from it again.
Three things had to change together.

- **Reach.** `packages/ui` is a *sibling* of this package. `npm run serve` roots
  at the **monorepo root** now (`npx serve ../..`); the REPL is at
  `/packages/mesa/example/`.
- **Module graph.** The old resolver was a single flat `fetch` — fine for the
  four hand-written stubs it was built for, useless for real components, which
  import `../../utils.js` (39 of the 63 do) and each other (`Input` → `Field`).
  `loadUiModule()` resolves relative specifiers against the importing file and
  loads recursively, caching the *promise* so a diamond dependency compiles
  once. A plain `.js` dependency is handed to the browser's own `import()`
  rather than the REPL's export-stripping path — it is a real ES module, so it
  gets real module semantics and brings its own graph.
- **Styling.** `@frontierjs/ui` carries no colours; it is written in the
  `@frontierjs/css` vocabulary (`btn primary`), so without that stylesheet it
  renders structurally perfect and completely unstyled — the failure mode this
  file has three entries about. `packages/css/dist/frontier.css` is linked, and
  the preview goes `.self-styled` when a `@ui/` import resolves. **That second
  half is not optional:** `frontier.css` is *fully* layered (everything outside
  `@layer` is comments), and unlayered rules beat layered ones at any
  specificity — so the preview's own `:where(#pv-container) .btn`-class base
  rules would have overridden the entire design system.

The same property is why linking it is safe: this page's chrome is unlayered,
so `frontier.css` cannot reach it. Verified by A/B — computed `color`,
`background`, `font-size` and `padding` for `body`, `#pv-container`, `.panel`,
`#editor`, `.ex-item` and `select` are **identical** with and without the link,
and the default example's preview styling is unchanged to the pixel.

Verified in headless Chrome from the monorepo root: zero warnings, no runtime
error, `.self-styled` on, buttons rendering as `class="btn primary"` with a real
background, and 11 `.btn` / 6 `.badge` / 3 `.card` / 2 `input` on the page —
which also proves the recursive resolution, since `Input` only renders once
`Field.mesa` and `utils.js` have both loaded.

## 2026-08-04 — invisible button labels, and a `<style>` that vanished

Follow-up to the entry below, from looking at the fixed `scopedCSS` example.
949 tests (was 948).

**Button labels were white on white.** Overrides are per *property*, and the
example declares `button { background: white; border: … }` with no `color` — so
the component won `background` while the REPL's preview base kept `color: #fff`.
Lowering the base to `:where(...)` in the previous entry is what exposed it:
before that the base won outright and the buttons were simply dark. There is no
CSS way to ask "did the component style this element", so the REPL answers it in
JS — `previewStyles` toggles `.self-styled` on the preview container, and the
whole base block is gated on `:not(.self-styled)`. **A component that ships CSS
owns its look; one with no `<style>` block still gets the base styling.**
Verified across all twelve styled examples by walking every text-bearing element
and comparing its computed `color` against its nearest opaque background: zero
invisible elements, and the unstyled default still renders dark buttons.

**`<style>` nested inside a block was silently dropped.** Style blocks are
extracted from the **top level** of a component — that filter does not recurse —
so a `<style>` inside a `{#snippet}`, `{#if}` or `{#each}` was neither collected
as component CSS nor left in the template. It vanished: no error, no warning,
empty `ctx.css.result`. The `mesaMounted` example had its spinner `@keyframes`
in a `{#snippet}`, so the spinner never turned and looked fine sitting still.
The compiler now warns, the example declares the keyframes at the top level, and
a scan of all 126 `.mesa` files in the repo found no other instance.

Not a bug: the active-state highlight. Chasing it turned up that
**`getComputedStyle` returns stale values in headless Chrome** after a class
change — `el.matches('.active')` and `document.styleSheets` reported the new
state while computed styles stayed frozen at the pre-click values, making the
highlight look inverted. Forcing layout did not help. Read the *rules* that
match an element rather than its computed style when checking a post-interaction
change there; this is the same class of limitation as the `IntersectionObserver`
one in the root `CLAUDE.md`.

## 2026-08-04 — every styling example in the REPL rendered unstyled

Reported by looking at the REPL. **Three independent causes**, each sufficient
on its own; the first two are REPL bugs and the third is a compiler bug that
affects every Mesa app. 948 tests (was 946).

**1. The REPL threw the CSS away.** All three `compileSource` calls pass
`css: false`, which tells the compiler *not* to emit `$runtime.addStyles(...)`
and to hand the scoped CSS back on `ctx.css.result` instead. Nothing read that
property. So the twelve examples with a `<style>` block compiled correctly,
applied the scope class to every element, and injected no rules to match it.
`index.html` now owns a `previewStyles` collector — main component, extra
`.mesa` files and `@ui/` imports — and drops the tags on teardown.
`css: false` is still correct here: `addStyles` writes to `document.head` and
`mount().destroy()` only reclaims styles for a ShadowRoot root, so letting the
compiler inject would leak every example's rules — `:global(...)` included —
into every example viewed afterwards.

**2. The REPL's own preview styles outranked the component's.** `#pv-container p`
is specificity (1,0,1); a Mesa scoped rule is `p.mHASH`, (0,1,1). The preview
base styles therefore beat the component for every element they had an opinion
about — headings, paragraphs, buttons, inputs, labels, hr, strong, em. They are
`:where(#pv-container) p` now, (0,0,1), which any component rule beats.

That exposed a **third-party ordering bug** underneath: the page sets
`window.tailwind.config = { corePlugins: { preflight: false } }` *before* the
Play CDN script, and the CDN assigns its own `window.tailwind` on load, so the
config was discarded and **preflight had been live all along**. It is a global
reset at (0,0,1) injected after this page's `<style>`, so it won every tie —
including `button,input,… { margin: 0; padding: 0 }` over the preview's own
button styling. Moving the config below the CDN script fixes it; verified in
Chrome by counting preflight rules that match a preview button (was ≥1, now 0).

**3. A dynamic `class` attribute wiped the scope class** (`src/compiler.js`).
It was emitted as `bindAttribute` → `set_attribute(el, 'class', …)`, which
**replaces** the attribute — and the scope class RULE 55's selectors match lives
in the template. So `<div class="card {theme}">` — which is what any variant API
looks like — lost every style its own component declared for it. The static
classes are folded into the expression, so the only thing the template
contributes there is the scope class; merging is exactly right. Every dynamic
class now routes through `bindClassPassthrough`, the same merging binder the
`{class}` passthrough has used since 2026-08-03. **This is the same bug as that
one, in the other half of the feature.**

Same failure signature all three times, and it is the one to remember: nothing
threw, nothing warned, `analysis.errors` was empty, and the component rendered
with correct markup and none of its CSS.

Pinned by two new tests in `test/compiler.test.js` — one on the emitted output,
one asserting the scope class is still in `classList` after `mount()`. The
existing `class on HTML elements is NOT remapped` asserted `toContain("'class'")`,
which was checking the *mechanism* (a `set_attribute(…, 'class', …)` literal)
rather than the property it names; it now asserts no `className` remap and the
merging binder.

Verified in headless Chrome against the real REPL, not just the suite: `.card`
carries `[mHASH card blue md]` with `background: #eff6ff` from its own `.blue`
rule, `p` is `#6b7280`, `button.active` is `#1e1e2e`/white — and an example with
no `<style>` block still gets the preview base styling.

Also corrected in `README.md`: the compiler-API table said `css: true` emits
`ctx.css.result`. It is the opposite — `css: true` (the default) emits the
`addStyles` call, `css: false` hands the CSS back for the caller to inject.
Documenting it backwards is plausibly how cause 1 survived.

## 2026-08-04 — the REPL moved to `example/`

Completes the layout pass below. `index.html` and `examples.js` are the browser
REPL — an app, not library source — and are now `example/index.html` and
`example/examples.js`. The package root holds only the four markdown files,
three config files, and `src/ test/ example/ docs/ mesa-vite/ mesa-bench/`.

`npm run serve` is **unchanged and still serves the package root**, because the
REPL now imports the library from `../src/`. Open `/example/` rather than `/`.

`test/repl.test.js` needed two fixes, and the second is the interesting one:

- Specifiers in `index.html` resolve from `example/`, not the package root, so
  the existence check and the dynamic import go through
  `path.resolve(REPL_DIR, spec)` + `pathToFileURL`.
- **Its scraping regex only matched `'./…'`.** Once the REPL imported
  `'../src/compiler.js'`, that import stopped matching, and a test whose entire
  job is to catch a broken module graph would have quietly stopped looking at
  the compiler and the runtime. Only the `arrayContaining` guard at the end
  would have failed. The pattern is `'(\.\.?\/[^']+)'` now.

Verified beyond the suite: served over HTTP and loaded in headless Chrome —
zero console errors, and the preview pane mounts the default example
(`<h2>Counter</h2>`, `count: 0 — even`, status `running`). That is the failure
this suite exists for: a missing export is an ESM *link* error, so the whole
script module never runs and the page is simply blank.

## 2026-08-04 — the component function name may not collide

946 tests (was 941). Fixes two ways the compiler emitted a module that would
not parse, both of which compiled cleanly, ran in dev, and failed only at
`vite build`.

The component function is named after the file. That name was sanitised for
invalid *characters* and nothing else, so it could be:

- **a reserved word** — `new.mesa` → `export default function new(…)`. Known
  since 2026-08-03 and worked around by renaming the route.
- **already declared at module scope** — `leads.mesa` carrying
  `export const leads = …` in `<script module>`, emitted right above
  `export default function leads(…)`. A redeclaration.

The second is the one that mattered: it is the *ordinary* case for a Sierra
resource, since a resource file is named after the thing it exports, and repo
invariant 18 made resources `.mesa` files. `packages/sierra/example` hit it the
moment its `leads.js` became `leads.mesa`.

**Fix.** The emitted identifier is now checked against JS reserved words and
against the bindings `<script module>` introduces (declarations, imports,
exports, including destructuring patterns), and falls back to
`<name>_Component` when either is taken. The *display* name passed to
`push_component()` in dev builds is unchanged, so devtools still show `leads`.

Five regression tests in `test/emission.test.js` — the suite whose whole
premise is that a clean compile is not proof of valid JS (repo invariant 15).

## 2026-08-04 — package layout: `test/` and `src/`

Structural only — no behaviour change. 941 tests, `spec-check.mjs` and
typecheck were green before and after each step.

- **All 16 test files moved to `test/`**, and `vitest.config.js` `include`
  narrowed to `test/**` (it was `**/*`).
- **The seven library modules moved to `src/`** — `compiler.js`,
  `compiler-md.js`, `runtime.js`, `render.js`, `render-component.js`,
  `css-inliner.js`, `glow.js`. `index.html` and `examples.js` stayed at the
  root: the REPL is an app, not library source.
- **Public import specifiers are unchanged.** The exports map now points into
  `src/`, so `@frontierjs/mesa/runtime` and the `'@frontierjs/mesa/runtime.js'`
  the compiler emits into every compiled component resolve exactly as before.

Three things a bare find-and-replace on import paths would have broken, all of
which are the reason this is worth a changelog entry:

- **Fixture strings are not imports.** The suites are full of
  `` `<script>import { user } from './store.js'</script>` `` — that is `.mesa`
  source being handed to the compiler. Only specifiers naming real Mesa modules
  were rewritten.
- **Two suites write a compiled temp module into `process.cwd()`** — the
  package root, not beside the test — and rewrite the runtime specifier *inside
  the emitted file*. Those became `'./src/runtime.js'`, not `'../src/…'`, and
  the two subdirectory variants in `render-ssr.test.js` became `'../src/…'`.
- **`repl.test.js` scraped `index.html`'s imports with `path.basename()`.**
  Once the REPL imported from `./src/`, a basename looked one directory too
  high, every module-graph check silently `continue`d, and only the
  arrayContaining guard at the end would have caught it. It now keeps the
  relative path.

Consumers reach into Mesa by filesystem path in four places — Mesa's exports
map cannot help any of them — so each was updated to try `src/` first and the
flat path second (`bun install` copies a `workspace:*` dep rather than
symlinking it, so a node_modules copy taken before the move is still flat):
`findMesaFile()` and `buildStart` in `packages/sierra/src/build/mesa-plugin.js`,
`buildStart` in `packages/jetty/src/build/mesa-plugin.js`, and the two harnesses
in `packages/ui/test/`.

Verified end to end: a real `vite build` of `tests/fixtures/island-site` loads
the compiler through Sierra's resolver, and `verify.mjs` passes in headless
Chrome. Sierra 724/724, ui 63/63 + 25/25, jetty 422 pass / 1 fail (the
pre-existing `phase8` `import.meta` failure).

## 2026-08-03 — htmlToText produced unusable plain-text email

Found by rendering `@frontierjs/email-kit`'s WelcomeEmail, which now lives at
`packages/email-kit`. Four faults, all in the `target: 'email'` text
alternative — the half of a multipart email nobody looks at until a client
renders it:

- **`<style>`, `<script>` and `<head>` contents were read as prose**, so the
  responsive rules appeared as text.
- **Conditional comments were not handled at all.** The two shapes need
  OPPOSITE treatment: a downlevel-*hidden* block (`<!--[if mso]> … <![endif]-->`)
  is the Outlook fallback and must go content and all; a downlevel-*revealed*
  one (`<!--[if !mso]><!--> … <!--<![endif]-->`) must lose only its markers.
  Getting this wrong in either direction is visible — treat them the same and
  either every CTA appears twice, or the text loses every link it had.
- **Entity decoding was a fixed list of six names**, so `&#847;` — the
  zero-width combining grapheme joiner every email preheader is padded with —
  printed as the literal string `&#847;`. Numeric and hex references are now
  decoded generally, with zero-width and formatting characters dropped rather
  than emitted.
- **The hidden preheader was included**, duplicating the opening line with a
  trail of padding after it. `display:none` elements are now dropped.

`email-kit.test.js` is **deleted** — 27 tests, all `describe.skip`, pointing at
an absolute `/tmp/mesa/email` path for a package that was not in the repo. The
kit is at `packages/email-kit` now with its own 34-test suite, and this package
went from 27 skipped tests to **zero**.

---

## 2026-08-03 — one click, two increments: nested delegation roots double-fired

`mount()` registers the anchor's parent element as a delegation root, and
`_makeDelegatedHandler(root)` walked `composedPath()` from the target up to
**its own** root, dispatching every `__click` it passed. Two roots where one
contains the other therefore both dispatched: the inner listener fired, the
event kept bubbling, and the outer listener walked the same path and called the
same handler again.

```
<main>                      ← delegation root A (an island mounted here)
  <div id="scroller">       ← delegation root B (another island mounted here)
    <button>                ← its onclick ran TWICE per click
```

Roots nest whenever two mounted trees sit at different depths, which is ordinary
— on a Sierra static page every island registers its own parent element, so one
island inside a wrapper `<div>` and another outside it is enough. Handlers in
the deeper tree ran once per ancestor root above them; the shallower tree was
unaffected, which is what makes it look like a component bug rather than a
delegation one.

Fixed by giving the event to the nearest registered root: the handler scans the
path first and returns if it meets another root before its own. Removing the
inner root hands the subtree back to the outer one.

Found by putting a Sierra island inside a scroll container in
`packages/sierra/tests/fixtures/island-site/`. Pinned in `runtime.test.js`
("a handler fires ONCE when delegation roots nest"). Full suite: 941 passing,
27 skipped.

## 2026-08-03 — a newline between two words was deleted, not collapsed

Found by reading a rendered page in the Sierra example, which is the only way
this was ever going to be found: nothing about the source looks wrong.

`compactDOM` replaced every newline-plus-indent run in a text node with the
empty string. So a paragraph wrapped across source lines — which is every
paragraph anyone writes — came out with the words welded together:

```html
<p>its 401s and its
  400s from it</p>          <!-- rendered: "its 401s and its400s from it" -->
<p>one <code>two</code>
  three</p>                 <!-- rendered: "one two three" with no space -->
```

HTML says a run of whitespace is one space. A text node **with content** now
collapses to that. A **whitespace-only** node keeps the old rule exactly — a
newline run goes (that is the indentation between block elements), a bare space
between two inline elements stays — because the DOM traversal counts those nodes
and changing which survive desyncs `refer()`.

`whitespace-collapse.test.js`, 7 tests, including the two cases above and the
inter-element indentation that must still disappear. Full suite: 940 passing.

### Still open — `{expr}{#block}` renders in the wrong order in the browser

Found in the same pass, **not fixed**. A bare interpolation immediately followed
by a block comes out after it on the client:

```html
<label>{name}{#if required}<span> *</span>{/if}</label>
<!-- browser: <!----><span> *</span>name    →  " * name" -->
<!-- server:  name<span> *</span>           →  "name *"  -->
```

The static renderer is correct, so this is the DOM path only — the block anchor
is inserted before the preceding text node instead of after it. Workaround:
wrap the interpolation in an element (`<span>{name}</span>{#if …}`), which pins
its position. The Sierra example carries that workaround with a comment.

---

## 2026-08-03 — three emitter bugs that produced invalid JS with no compile error

Found by restyling `@frontierjs/ui`. All three passed `analysis.errors` clean.

### `const fn = () => { reactiveLet = … }` emitted an invalid assignment target

The derived-const emitter called `rewriteExpr` on the initializer without first
calling `rewriteAssignments`, so the *reads* inside the function were rewritten
through the accessors and the *write* was not:

```js
const bump = $runtime.trackDerived(() => (() => { $runtime.get($$sig_n) = $runtime.get($$sig_n) + 1 }))
```

`$runtime.get(…) = …` is not valid JavaScript. The module threw on load.
`function bump() { n = n + 1 }` was always fine, which is why the bug survived —
it only bites the arrow-function form, which is the more common one.

Same fault in the `$context` provide emitter, which is how every compound
component shares a mutator (`$context.toggle = (id) => { open = … }`). That one
killed `Accordion` and `Tabs` outright.

The `$:` effect emitter already had the fix and a comment explaining it; the
other two call sites never got it.

### `{class}` replaced an element's own classes instead of merging them

`<button class="btn primary" {class}>` has to end up carrying all three
classes. The passthrough went through the general attribute path, which
*replaces*:

```js
$runtime.set_attribute(el0, 'class', $runtime.get($$sig_$class))
```

So with no class prop the element lost `btn primary` entirely, and with one it
kept only the consumer's. New `bindClassPassthrough()` in `runtime.js` adds and
removes only the tokens it applied, leaving the element's own alone; the
compiler routes the `$classAuto` attribute to it and keeps it out of the
bindAttribute grouping pass (which would rewrite it back into a replacing
`set_attribute`).

This one is worth remembering for its failure mode rather than its cause: the
component still rendered, it just had no classes. Nothing threw, nothing
warned, and it silently unstyled every component in `@frontierjs/ui` that
combined a base class with the passthrough — which is nearly all of them.

### Documented, not fixed

Pinned in `emission.test.js` as current behaviour:

- **A destructuring assignment to reactive lets is not rewritten.**
  `[a, b] = [b, a]` emits `[$runtime.get(…), $runtime.get(…)] = …`, which does
  not parse. `rewriteAssignments` only recognises a bare `Identifier` on the
  left.
- **`{@const}` inside `{#each}` calls the loop index as a getter**, so
  `{@const isLast = i === list.length - 1}` compiles to `i()` and throws.
- **`<mesa:element this={…}>` is not a feature** and compiles without an error.

---

## 2026-08-03 — CSS scope ids are content-addressed; compiler output is reproducible

`genId()` was `'m' + (Date.now().toString(36) + (++counter).toString(36)).slice(-8)`,
so two compilations of the same source produced different scope classes — in one
process, seconds apart. Its one caller was the CSS scope id.

Three things depended on that not being true:

1. **Reproducible builds.** Output could not be diffed or content-hashed.
   Checking that a compiler change was byte-identical reported **13 false
   differences** before anyone noticed they were all scope ids.
2. **One component, two compilers, one id.** A prerendered island is compiled by
   Mesa's renderer AND by Vite for its client chunk. Under two ids the page
   carried the same rules twice under two hashes, and the markup swapped class
   on mount.
3. **Debuggability.** A scope class that changes every build is not something
   you can search for.

`cssHash(styleContent)` replaces it — FNV-1a in two lanes, base36, no dependency
and no `node:crypto` (the compiler runs in the browser too, for the REPL). All
**66 REPL examples now compile byte-identically twice over, with no
normalization at all**; previously every example carrying a `<style>` block
differed.

Hashing the **style content and nothing else** is deliberate. Adding the
filename would break (2) the moment the two compilers disagree about a path — an
absolute path, a Vite id with a query string, a symlinked workspace — and that
failure would be silent. The cost is that two components with byte-identical CSS
share an id, which is harmless: their rules are the same rules, so applying
either to both changes nothing.

`genId()` is still exported and still non-deterministic; nothing in the compiler
calls it.

### `renderComponent` now reports styles per component

`result.styles` is `[{ id, css }]` in tree order — the same content as
`result.css`, split so a caller can emit `<style id="mHASH">` per component
instead of one anonymous blob. The id is the scope hash, so the runtime's
`addStyles` finds the block already in the document and injects nothing.

`options.styleTag: false` (html target) suppresses the `<style>` block Mesa
otherwise prepends to `result.html`, for a caller assembling the document from
`.styles` itself. Without it the caller has no way to opt out and the page
carries the rules twice.

Sierra's prerenderer uses both. An island's CSS on a static page went from
**three copies** — Mesa's blob, Sierra's blob, and the runtime's injection under
a second hash — to **one**, verified in Chrome.


## 2026-08-03 — **BREAKING**: scoped CSS actually scopes now

Two bugs that cancelled each other out, found while checking whether an island's
styles survive prerendering.

**A component could not style its own root element.** Scoping emitted
`.hash <selector>` — an ANCESTOR selector — while putting the hash class ON the
element:

```
addStyles('mHASH', `.mHASH button { color: red }`)
template(`<button class="b mHASH">x</button>`)
```

`.mHASH button` matches a `button` **inside** a `.mHASH` element, and never the
`<button class="mHASH">` carrying it. Confirmed in Chrome before touching
anything: the element carrying the class computes as unstyled, a descendant
computes as styled. So any rule whose subject was the component's own root
silently did nothing — in the browser, not just in SSR. Compounding it, the hash
was only added to elements that already had a `class` attribute, so a bare
`<button>` never got one at all.

`addStyles` had 19 assertions — insertion, dedupe, SSR no-op. None of them asked
whether the selector matches the markup. That is the gap.

**Prerendered pages leaked every component's CSS globally.** `compileTree`
de-scoped unconditionally, which is right for email/fragment (the inliner
consumes the selectors) and wrong for the html target, where the CSS ships in a
`<style>` block and the hash is the only thing keeping one component's rules off
another's markup. Measured on a real prerendered page: one island's
`button { background }` restyled every other button on it.

The two hid each other. De-scoping was the ONLY reason component styles applied
at all in prerendered output — the scoped form could not match — so the visible
symptom was "styles work, but globally".

### What changed

The hash is now appended to the **rightmost compound selector** — the subject —
and every element in a styled component carries it (VISION **RULE 55**):

```
button { color: red }        →  button.mHASH { color: red }
div span { color: red }      →  div span.mHASH { color: red }
a::before { content: "x" }   →  a.mHASH::before { content: "x" }   (never ::before.mHASH)
p { & + p { … } }            →  p.mHASH + p.mHASH { … }
:global(.x), :root, body     →  unchanged, unscoped
```

A component with no `<style>` block emits no hash at all.

### The breaking part

**Styles no longer leak into child components.** The ancestor form put every
descendant of the component root in range, including markup belonging to child
components; the subject form cannot, because a child's elements carry the
child's hash. If a component was styling a child's internals, use
`:global(...)` — which is what it is for.

Also fixed in passing: `& + p` left its subject unscoped (`p.mHASH + p`), so it
matched any adjacent `p` on the page, including outside the component.

### Verification

10 new cases in `render-ssr.test.js` assert the emitted selector against the
emitted markup, which is what nothing did before. 30 `scopeCSS` assertions were
updated from the ancestor form to the subject form. The computed-style proof is
in a real browser — happy-dom does not implement the cascade — in
`packages/sierra/tests/fixtures/island-site/verify.mjs`: the styled component
gets its own background, and the two other buttons on the page keep the UA
default. Mesa 911 → 921 pass; Sierra 699 pass; jetty green.


## 2026-08-03 — `tmpDir` on the renderer (SSR_SPEC W1), and island specifiers

**`renderComponent` / `renderFile` take `options.tmpDir`.** The renderer compiles
each module in a tree to a temp `.mjs` and imports it, and Node resolves a bare
specifier relative to the *importing* file — so the directory those temp modules
live in decides which `node_modules` a rendered tree can reach. It was a
module-level `const` resolved at import time to Mesa's own package root, which
made it a property of the package rather than of the call. Correct for rendering
Mesa's own trees; wrong for rendering an app's, where a layout containing
`import { page } from '@frontierjs/sierra/router'` died with "Cannot find
package". The directory is created if missing, threaded through the recursive
path so an import graph cannot be split across two directories, and defaults
exactly as before when omitted.

Pinned by four cases in `render-component.test.js`, including the negative one:
the same import that resolves under a caller-supplied `tmpDir` must still fail
under the default, or the test proves nothing. (Those fixtures live inside the
package, not `/tmp` — vitest resolves the renderer's dynamic `import()` through
Vite, which refuses to serve a file outside the project root.)

**`ctx.islands` entries now carry `specifier`** — the module the component was
imported from, verbatim. The marker in SSR output can only carry a component
*name*; the compiler is the only place that knows what module that name refers
to, and without this every meta-framework has to re-parse the source with its
own regex and get `import Counter as Tally from …` wrong. Sierra uses it to map
a marker onto a module to bundle.


## 2026-08-02 — island markers in SSR output (SSR_SPEC W3)

`ctx.islands` had been populated by the compiler since it was written and read
by nobody: Sierra collected it into `islandMap` and consumed it nowhere, and SSR
emitted an island's markup inline with nothing to identify it. A client loader
had no way to tell `<button>0</button>` from the static text beside it, and
nothing outside Mesa could add a marker, because the markup is produced inside
Mesa's own renderer.

Opt in with `{ islands: true }` — on `compile`/`compileSource`, or as
`renderComponent(src, { islands: true })`, which threads it to every module in
the tree.

```
<!--mesa-island {"component":"Counter","directive":"load","props":{"start":3}}-->
<button>3</button>
<!--/mesa-island-->
```

**Comments, not a `<mesa-island>` element.** The element form is what the spec
sketched and it fails two ways that produce no error. The HTML parser
foster-parents a non-table element out of `<tbody>`, so an island rendering rows
loses the association before any loader runs — checked in headless Chrome, where
the comment marker stays put in `TBODY`. And a wrapper element joins `>`
selectors and flex/grid layout, so a page would style differently prerendered
than client-rendered; `display: contents` fixes the layout half and nothing
fixes the selector half.

**Two guards.** The flag switches emission — omitting it is byte-identical to
before, so RULE 26 holds by default. The environment then decides whether a
marker is written: `island()` calls the component directly on a real client, so
client DOM is unchanged even with the flag on.

**The marker carries props as rendered.** `ctx.islands` is a compile-time view
and sees only literal attributes — `start={2 + 3}` contributes nothing to it,
while the marker says `{"start":5}`. Both ship: `renderComponent` now returns
`.islands`, the flattened build-time list with each entry tagged by the file it
was written in, which is what maps a component *name* onto a module to import.
Props that cannot survive JSON are dropped with a named warning; a props object
that cannot be serialized at all degrades to identity-only rather than losing
the marker.

**Mounting needs no new protocol**: clear the range, then
`mount(openComment, Comp, { props })`. It must be `mount` — a bare
`Comp(anchor, props, null)` renders the right markup and registers no delegation
root, so the island comes back **inert**, the same trap that made all 59 REPL
examples render and respond to nothing. A click in `render-ssr.test.js` pins it.

**Two things found by probing, both worth keeping.** happy-dom 14.12.3 filters
`createTreeWalker(root, NodeFilter.SHOW_COMMENT)` to nothing — the obvious
loader implementation, correct in Chrome, silently finds zero islands under this
repo's SSR harness. And happy-dom ends a comment at the **first `>`**, not at
`-->`, which split a marker in two and made `JSON.parse` throw on the fragment;
the payload now escapes every `-` and `>`, so `a --> b <!-- c > d` round-trips
exactly through both parsers.

Still Sierra's, and untouched: the loader itself, per-island bundling, and
name→module resolution.

11 new cases in `render-ssr.test.js`; 891 → 902 pass, 0 fail.

## 2026-08-02 — two emissions that compiled clean and did not parse

Found by a new `repl.test.js` check that the compiled output of every example is
valid JavaScript. Compiling without errors and emitting valid code are different
claims; nothing had been checking the second. Each bug had silently broken a
shipped REPL example.

### `bind:` on a component prop

`<Input bind:value={name} />` put the raw attribute name in the props object:

```js
Input(el, {bind:value: $runtime.get($$sig_name)}, null)   // not parseable
```

VISION §3.4 documents the form as supported and nothing in the repo used it, so
it appears never to have been implemented. Plain `value={name}` is one-way — the
child's writes never reach the parent — so there was no working two-way binding
across a component boundary at all.

Now implemented rather than rejected. The parent→child half already existed
(`pushProps` over the child's `_propRegistry`); the missing half is
`bindProp(anchor, name, setParent)`, which subscribes to the child's own prop
signal and writes changes back out. No feedback loop: the write lands on the
parent's signal, whose equality check stops it. Binding to anything that is not
a writable top-level `let` is now a compile error naming the variable.

Broke the `uiComponents` example.

### Multi-line interpolated attributes

```html
<div style="background:{done ? '#a' : '#b'};
            width:{pct}%">
```

emitted a template literal that was truncated at the newline and never closed.

`_renderGroup` — the pass that folds consecutive `bindText`/`bindAttribute` calls
into one `render()` block — is regex surgery over generated source, and its line
pattern ended at the first `;` before a newline. A CSS semicolon at end-of-line
looks exactly like a statement terminator. The attribute's first line was pulled
into a grouping run, the run was rewritten, and the continuation was orphaned.

The scanner now walks lines and requires a complete statement — balanced
backticks — before grouping anything. A binding it cannot parse is passed
through untouched: grouping is an optimisation, and leaving a binding alone is
always correct where truncating one never is.

Worth knowing for anyone reproducing it: a preceding text binding is required.
It is what pulls the attribute into the same run, so a single-element fixture
compiles fine even on the broken compiler.

Broke the `guiTimer` example.

**New:** `emission.test.js` — 7 tests. Both fixtures were checked against the
pre-fix compiler to confirm they actually reproduce.

## 2026-08-02 — `$: { }` assignments no longer emit invalid code

`$: { count = count + 1 }` compiled to `$runtime.get($$sig_count) = …`, an
invalid assignment target. The compiler reported nothing; it threw
"Invalid left-hand side in assignment" the first time the effect ran.

Cause: the `$:` effect emitter called `rewriteExpr` but not
`rewriteAssignments` — the only user-code emitter that skipped it. Script
statements and watch handlers had always called both. Member writes
(`obj.n = …`) went through the proxy and were never affected, which is why it
survived: the shapes people reach for first still worked.

Fixed by carrying the body's AST node on the effect record and running
`rewriteAssignments` before `rewriteExpr`, as every other site does. 691
compiler + runtime tests unchanged.

This is why no REPL example used the `$: { }` block form — it could not be made
to work. There is one now.

Applied during the 2026-07-25 performance/correctness pass. Baseline was the
`_built: 2026-05-05` snapshot.

## compiler.js — async function declarations no longer wrapped in an IIFE

`emitScript` decided whether to wrap a top-level statement in an async IIFE with
a regex:

```js
const containsAwait = /\bawait\b/.test(rewritten)
```

A regex cannot distinguish a top-level await from one nested inside a function
body, so

```js
async function handleLogin() { await save() }
```

compiled to `(async () => { async function handleLogin() {…} })()`. The
declaration ended up scoped inside the IIFE, so a template binding
`onclick={handleLogin}` resolved to nothing and threw
`ReferenceError: handleLogin is not defined` at click time — no compile warning,
no build failure.

Replaced with `_hasTopLevelAwait(node)`, an AST walk that stops at function and
class boundaries and refuses to wrap declarations outright (a declaration is a
binding; hiding it is never correct).

Scope of the bug: `async function` **declarations** containing `await`. Arrow
consts (`const go = async () => { await … }`) took a different code path and were
unaffected, which is why most code worked.

Genuine top-level await — `data = await fetch(...)`, a bare
`await new Promise(...)` — is still wrapped, verified by test.

**New:** `async-decl-scope.test.js` — 7 tests covering both directions.

## VISION.md §4 rewritten — v1.9

The `$:` section is now the authoritative reference for reactivity, and every claim in it
is checked by `spec-check.mjs` against the compiler rather than asserted.

Rewritten because §4 had drifted from the implementation in ways that mattered: it
documented `$: { (a, b) }` as a block effect (it compiled to a throwing `orderedGroup`),
said nothing about effect phase, and predated defer, previous values, and the inert-block
error.

New structure — §4.0 what `$:` is for, §4.1 watches, §4.2 explicit-dep effects, §4.3
auto-tracked effects, §4.4 ordered groups, §4.5 writable derived, §4.6 debug labels,
§4.7 timing and phase, §4.8 compile errors, §4.9 reference table.

Eight new rules, no existing rule dropped (verified by diffing the rule sets):

| | |
|---|---|
| **43** | Replacement is reactive; mutation is not — identical for local and imported objects |
| **44** | The compiler tracks what it compiled; imports are inert until `$:` says otherwise |
| **45** | A watch only fires for writes that go *through* the proxy |
| **46** | `prev` holds a reference — replacement gives a real previous value, mutation does not |
| **47** | Auto-tracked effects cannot be deferred; they discover deps by running |
| **48** | DOM-building work runs before user effects within a flush |
| **49** | The initial run of an auto-tracked effect precedes the template |
| **50** | A `$: { }` block whose body only reads is a compile error |

RULES 43 and 44 are the two that explain the rest — they were true all along and stated
nowhere.

§5 gained the **writer** side of shared state, which was the missing half: it documented
how components read a plain-object store but not how the store notifies. Plus RULE 51 —
reactive logic doesn't belong in `.js` modules, stated as discipline rather than
enforcement, with the reasoning for why no `createRoot` exists. *(Superseded
2026-08-02 for lifetime boundaries — VISION RULE 54.)*

## `$: deps, handler` is deferred and receives the previous value

Two changes to the same form, decided together because they reinforce each
other.

**Deferred.** The handler no longer runs on mount, only on change. "When X
changes, do Y" reads as change-triggered, and firing on mount is usually wrong —
`$: userId, () => { count = 0 }` resetting on first render is a no-op at best.
The eager case is already owned by `$onMount`, and the "initialise, then keep in
sync" shape is almost always a `const` memo wearing an effect's clothes.

This is only possible because the deps are explicit: the effect still reads them
on the first run to subscribe, and withholds only the handler. An auto-tracked
`$: { }` block **cannot** be deferred — it discovers its dependencies by
running, so skipping the body would subscribe to nothing and never fire again.
That constraint is why Solid's `defer` hangs off `on()` rather than bare
`createEffect`, and it is why the two forms differ here by mechanics rather than
by convention.

**Previous value.** The handler receives `(value, prev)`; multiple deps give
`([a, b], [prevA, prevB])`, as Solid's `on()` does. Deferring is what makes
`prev` well defined — the first invocation is the first change, so there is
always a real previous value instead of `undefined` needing a guard.

Reference semantics: a *replaced* object gives a genuine previous value; an
object *mutated in place* gives the same reference for both, since producing a
distinct previous would mean deep-cloning every read. Documented, not solved.

**New:** `watch-handler-defer.test.js` — 13 tests.

### Bug found on the way: handler deps never registered a path watch

`$: cart.total, () => sync()` — a form §4.3 documents — compiled to a plain read
of an inert object:

```js
createEffect(() => { cart.total; return untrack(() => sync()) })
```

No `watchProxy`, no `watchPath`. It subscribed to nothing and never fired. Only
the bare `$: cart.total` form registered the path; the handler form was omitted
from the collection that drives proxy setup. Adding a redundant bare watch
alongside it happened to make it work, which is presumably how it went unnoticed.

Fixed by collecting dotted deps from `watchHandlers` as well. Deliberately only
*dotted* deps — adding bare identifiers too registered proxies for local `let`
variables, which switched their accessor from `$runtime.get($$sig_a)` to
`$$proxy_a` and broke three compiler tests. That deep-watch opt-in belongs to the
bare `$: a` form alone.

## runtime.js — onCleanup warns when it has no owner

`onCleanup` — and `$onDestroy`, which forwards to it — silently discarded the
callback when called with no owning scope: at module scope, after an `await`, or
inside a later callback. That is how subscriptions and timers leak for the
lifetime of a page. It now warns.

Reactive code outside a component stays supported but deliberately unadvertised:
`createEffect` works there, returns a disposer, and owns nested effects. No
`createRoot` was added — naming the pattern is what blesses it, and Sierra
demonstrates it isn't needed.

*(2026-08-02: reversed for lifetime boundaries only. `createRoot` now exists and
is exported — see VISION RULE 54. The argument above holds for reactive logic in
a `.js` store, which RULE 51 still forbids; it does not hold for code that owns a
span of work and must end it. `createEffect` cannot substitute there: it
subscribes to what its body reads, so a component that reads then writes a store
during setup ran **1001 times for one page render** under an effect and once
under a root.)* An entire routing framework uses zero reactive
primitives in its `.js` files; every state change is an imperative `.set()` from
an event handler, socket callback or promise resolution.

## runtime.js — user effects now run after the DOM updates

`render()` is `createEffect()`. Control flow — `ifBlock`, `keyBlock`,
`awaitBlock` — is also `createEffect()`. So renders, control flow and user `$:`
effects were all the same kind of node in one queue, and their relative order
fell out of creation order. Since the compiler emits the `<script>` before the
template, a `$:` effect ran *before* the DOM it was reacting to had updated:

```js
$: items, () => { count = el.childNodes.length }
```

measured one update stale, every time. Demonstrated: with 3 items rendered, the
effect reported 1.

This is inverted from both frameworks people arrive from. Solid's `createEffect`
runs after the render phase completes — `createRenderEffect` is the during-render
tier. Svelte's `$effect` runs after the DOM updates, with `$effect.pre` as the
opt-out. In both, the effect you reach for by default is the post-DOM one.

`_flush` now drains in two passes per iteration: everything that builds the DOM,
then user effects. Effects that queue further work are picked up by the next
iteration under the same ordering, so a render triggered by an effect still
lands before any effect it in turn triggers.

**The split is by *user effect*, not by *render*.** The first attempt tagged
render blocks and deferred everything else — which inverted parent/child order
and made inner renders fire against an `{#if}` branch that was about to be
disposed. `compiler.test.js` caught it: *"render() effects inside disposed
ifBlock branch do not run after branch switches"*. Control flow builds DOM and
belongs in the first pass; only the bodies of `$:` forms are deferred, tagged
`{ user: true }` at three emission sites in the compiler.

**New:** `effect-phase.test.js` — 5 tests, including a guard for the
control-flow ordering that the first attempt broke.

### Still pre-DOM: the initial run

`createEffect` runs its body immediately at creation, so on mount a `$:` effect
still runs before the template's render blocks exist. Only updates are
reordered. This mostly resolves itself if explicit-dep effects become lazy — the
decision already taken — since they then have no initial run at all. Auto-tracked
`$: { }` blocks must still run once to discover their dependencies.

## compiler.js — `$: { }` blocks that do nothing are now reported

A `$: { }` block runs code. If its body provably does nothing — every top-level
statement is a bare read — the author reached for braces to express a watch and
got silence. Effects don't drive renders in Mesa: a template's `{a}` compiles to
its own `$runtime.render()` block tracking its own reads, so an effect
subscribing to the same signal has no consumer. Measured: an effect reading a
signal a template also reads produces zero extra renders.

Reported forms:

```js
$: { }              // empty
$: { count }        // bare read
$: { a, b }         // see the note below
$: { (a, b) }       // sequence of bare reads
$: { cart.total }   // bare member read — and no path watch registered either
```

`$: { (a, b) }` is the one that mattered. It previously compiled to
`orderedGroup([{ deps: [a], handler: <the VALUE of b> }])` and threw
`fn is not a function` the first time `a` changed — so this replaces a runtime
crash with a build-time message that names the form the author wanted.

The parenthesised sequence and the handler shorthand have **identical ASTs** —
`{ (a, b) }` and `{ a, syncFn }` are both `SequenceExpression` with an
`Identifier` tail. The parens are the only distinguishing feature, so the check
reads them from source position. That is what RULE 14b is really about.

**New:** `inert-block.test.js` — 18 tests.

### Handlers inside a block must be inline functions — RULE 52

`{ a, syncFn }` and `{ a, b }` have identical ASTs, so the reference shorthand
could not coexist with detecting a bare multi-value read. Blocks now require
`() => …`; the unbraced form keeps the shorthand.

```js
$: { userId, () => load() }     // ✅
$: { userId, load }             // ❌ — write `() => load()`
$: userId, load                 // ✅ unbraced
```

That closes the last ambiguity in the block form: every `$: { … }` whose body
only reads values is now caught, where previously `{ a, b }` slipped through and
threw `fn is not a function` at runtime. The message covers both readings, since
they genuinely cannot be told apart:

> `'$: { a, b }' does nothing. A handler inside a '$: { }' block must be an inline
> function… If 'b' is a handler, write 'a, () => b()'. If you meant to watch both
> values, drop the braces: '$: (a, b)'.`

### Severity: diagnostics stay warnings — RULE 53

`analysis.errors` are emitted through `ctx.warning()`, so a build with an inert
block still produces output. Kept deliberately, and now documented: "error"
describes the intent — the code is wrong and will not do what it says — not the
exit code. A build tool that wants hard failures can escalate warnings.

## compiler.js — external reactivity diagnostic

A template read of an imported signal is only reactive if the name appears in the
`externalSignals` map the consuming build passes — a hand-maintained list living
in a different package from the signals it describes. A miss doesn't error: the
expression reads nothing reactive, so it's hoisted out of the render block and
the signal object, always truthy, renders once and never updates. Three real
bugs came from this, most recently a connection badge that read "ws connected"
with the server stopped and survived a reload.

`emitScript` now runs `_checkExternalReactivity`, which walks the template AST,
collects value reads, and warns when an identifier imported from a **described**
module isn't covered by that module's entry. It also catches namespace access
(`import * as j` → `{j.connected}`), which is never rewritten even when the
member is declared.

Deliberately quiet where it can't know: modules the map doesn't describe at all,
callee position (`{fn(x)}`), event handlers (`on:click={h}`) and directives.
Measured at 0 false positives across 36 real components; the event-handler
exclusion was necessary — without it the diagnostic fired on
`on:click={toggleTheme}`.

**New:** `external-reactivity.test.js` — 26 tests.
**Doc:** `docs/EXTERNAL_REACTIVITY.md` — failure matrix and the remaining options.

### Path-watch tier

The same pass also reports §4.1 path watches that are missing. An imported plain
object is inert; `$: page.path` is what makes a path reactive. A member read with
no covering watch compiles to a static value.

Default level only fires when the file already watches *something* on that
import — intent is clear, so an uncovered path is an oversight. A `strict` level
(`externalReactivityHints: 'strict'`) reports any uncovered member read; opt-in,
because a plain config object and a mutable store look identical. Both defer to
`externalSignals`, so declared signals are never reported.

0 false positives across 36 real components in either mode.

## runtime.js — child watch proxies went stale on reassignment

`_getNestedProxy` cached child proxies by path alone, so replacing an
object-valued property left the previous child proxy in place permanently:

```js
cart.items = ['c']
cart.items      // → ['c']       raw object, correct
proxy.items     // → ['a','b']   stale child proxy
```

A template reading `{cart.items}` therefore rendered the *previous* value after
any reassignment. Primitives were unaffected and mutation in place
(`items.push(...)`) worked, so it looked intermittent — only reassignment of an
object-valued property, and only through the proxy.

Found while working out how to give `$:` handlers a previous value: a watcher on
`cart.items` reported `prev === current` after a replacement, both holding the
old array.

The cache now keys on path AND the object that path currently holds, so it
self-heals however the value changed — including writes that bypass the proxy
entirely, and descendants of a replaced parent.

**New:** `watch-proxy-staleness.test.js` — 8 tests. 5 fail against the previous
implementation.

This matters more than it looks: `docs/PLAIN_OBJECT_STATE.md` proposes making path
watching the primary way components consume framework state. Every `page.data =
result` in that design is an object reassignment.

## runtime.js — watchProxy is idempotent

`watchProxy(alreadyProxy)` built a second proxy layer. `watchPath` then keyed its
signal by the outer proxy while the inner set trap fired signals keyed by the raw
object — they never met, so writes reached no watcher and nothing re-rendered,
silently. That happens whenever a module exports `watchProxy(state)` instead of
the plain object, which is a natural thing to write.

`watchProxy` now returns a proxy input unchanged, and `watchPath` normalizes a
proxy argument to its root object. Both export shapes work.

**Doc:** `docs/PLAIN_OBJECT_STATE.md` — assessment of replacing Sierra's signal
architecture with watched plain objects, which is what motivated both changes.

## Test status

710 passing. The 27 failures in `email-kit.test.js` are pre-existing and
environmental: they need `/tmp/mesa/email/*.mesa` fixtures from the sibling
`@frontierjs/email-kit` package, which is not part of this archive. Unchanged
from baseline.

## Not changed, but worth knowing

Findings from the audit that were **not** acted on:

- **`exports` map root points at the compiler.** `"." → "./compiler.js"` means a
  bare `import … from '@frontierjs/mesa'` pulls a 234 KB build-time module and
  its 11 dependencies (acorn, astring, css-tree, unified, remark-*…). The root
  export should probably be the runtime.
- **No `"sideEffects": false`.** Measured impact is small — the 119 KB runtime
  lands at ~10 KB raw / 4 KB gzip in a real app build — so this is a tidy, not a
  win.
- **SSR is process-global.** `render.js` installs happy-dom globals on
  `globalThis` and keeps a module-level `_win`; the reactive core
  (`_listener`, `_owner`, `_contextStack`) is singleton. Concurrent
  `renderToHTML()` calls will interleave. Latent today, but Sierra's
  `render: 'static'` / `getStaticPaths` path will want concurrency.
  *(2026-08-01: still process-global, but no longer able to interleave —
  `renderToHTML` is synchronous end to end by contract, with a test asserting
  it, so `renderAll` is serial rather than racy. Real parallelism still needs
  one window per worker. See `docs/STATIC_RENDERING.md` §Concurrency.)*
- **`render-component.js` litters the package directory.** `compileTree()` writes
  temp `__mesa_render_*.mjs` files into the mesa package dir; running the test
  suite leaves ~14 behind. They were removed before archiving.
