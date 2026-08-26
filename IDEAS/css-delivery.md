---
id: css-delivery
status: idea
dated: 2026-08-16
---

# Idea — how a component's CSS reaches the page

**Status: NOT STARTED. Dated 2026-08-16.** Written after `FJS-291`, which deleted
a half-built second answer to this question. It is filed as an idea and not as a
defect because nothing is broken: styles reach the page, and the case for
changing that is unmeasured.

---

## What ships

**One route: inlined into the module.** The compiler emits the scoped rules as a
call inside the component's own JavaScript —

```js
$$runtime.addStyles('m1dr2v21gtm', `p.m1dr2v21gtm { color: red }`)
```

— and the runtime appends a `<style>` the first time the component mounts. The id
is a **content hash of the style block**, so the same rules from any compiler in
any build carry the same id, and `addStyles` skips an id already on the page.
Both Vite plugins do this: `@frontierjs/mesa/vite` and Sierra's
`src/build/mesa-plugin.js`.

That content-addressing is load-bearing rather than incidental. Sierra's
prerenderer writes the ids into the HTML it emits, so a hydrating client knows
which styles are already there and does not paint them twice (Invariant 12). It
is what makes a static build able to dedupe across the *two different compilers*
it runs.

## What was deleted, and why it is worth remembering

Mesa's plugin also carried a **virtual CSS module**: keep the rules out of the
JS, hand them to Vite at `Component.mesa?mesa-css`, and let Vite treat them as
CSS like any other stylesheet. The condition guarding it could never be true —
the compiler's `css` option is a *destination*, not a switch, and the plugin read
it as a switch — so the path had never run in any build (`FJS-291`). It is gone.

The idea behind it is not wrong, and it is the reason for this file. Handing CSS
to Vite would buy four things the inline route cannot:

- **A real `.css` file in a production build**, rather than rules living in the
  JS bundle. Smaller JS, and a stylesheet the browser can cache and parse in
  parallel with the script.
- **Styles before the script runs.** Today a component's rules land when its
  module executes, which is a flash on a slow connection and a genuinely visible
  one for anything below the fold rendered late.
- **Style-only HMR.** Editing a `<style>` block today invalidates the module and
  remounts the component — the state inside it resets — where Vite would swap the
  stylesheet in place and touch nothing else. This is the one an app developer
  would feel every day.
- **Whatever Vite already does to CSS** — PostCSS, Lightning CSS, `url()`
  rewriting, asset hashing — arriving for free rather than being reimplemented.

## Why not now

**Because it is one file compiled two ways, and only one of the two plugins was
being changed.** A `.mesa` file goes through Sierra's plugin in every real app
and through Mesa's in a standalone build or `mesa-bench`. Wiring the virtual
module into Mesa's alone would mean one component's CSS arrives as a stylesheet
under one build and inside the module under the other, and the prerenderer's
dedupe — which reads `addStyles` ids out of the HTML — would see neither half of
a page it thought it knew about.

**And because nobody has measured the loss.** Every item on the list above is
plausible and none of them is a number. The flash has not been observed, the
bundle delta has not been weighed, and the remount-on-style-edit is annoying in a
way nobody has yet said out loud.

## What it would take

1. **A measurement first, on `example/` or `basecamp`** — JS bytes attributable
   to inlined CSS, first-paint with and without, and how often a style-only edit
   loses component state in a real session. If the answer is "small, none,
   rarely", this record closes and the deletion was simply correct.
2. **One decision for both plugins**, recorded in `DECISIONS.md`, because the
   thing being decided is what a `.mesa` file's CSS *is* — an asset or part of
   the module — and that cannot be true in one build and false in the other.
3. **The prerenderer's dedupe rewritten in the same change.** It knows about
   `addStyles` ids; if the rules become a stylesheet, it needs to know about the
   stylesheet instead, and a static page that double-paints or drops styles is
   the failure mode.
4. **Keep the content hash either way.** It is what makes any dedupe possible
   across the two compilers, and it costs nothing to preserve.

An intermediate exists and may be the better answer: **inline in dev, extract in
build**. It keeps the dev loop and the prerender contract exactly as they are and
takes only the bundle-size and caching wins, which are the two that a build —
where nothing is hot-reloading and the prerenderer runs once — can be measured
for cleanly.

## See also

- `FJS-291` in `ISSUES.md` § Closed — the deletion, and what the two readings of
  `css` were
- `packages/mesa/CLAUDE.md` § What bites here — the destination-not-a-switch trap
- Root `CLAUDE.md` Invariant 12 — reproducible output, and the dedupe it buys
