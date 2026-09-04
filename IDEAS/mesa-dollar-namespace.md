---
id: mesa-dollar-namespace
status: shipped
dated: 2026-08-23
---

# Mesa's `$` namespace — the implementation plan

**Status: not started.** The ruling is `FJS-D132`; this is how it gets built.
Nothing here is behavior — do not cite it as such. The follow-up on compiler
internals is `FJS-470`, the defect this work retires is `FJS-471`.

---

## What changed while planning

Two probes moved this from a tidy-up to a fix, and both were measured rather
than reasoned.

**The scope-id hash does not see emitted JavaScript.** `cssHash(content)` is fed
`styleNodes.map(n => n.content).join('\n')` and nothing else, and the header
above it says excluding even the filename is deliberate, because a path the two
compilers spell differently would break the one-component-one-id property
silently. So renaming an emitted identifier cannot move a scope class, and
**Invariant 12 does not gate any part of this work** — which was the one unknown
that could have made `FJS-470` a repo-wide change. It is not one.

**The injected builtins are a live defect surface.** An author who writes
`const $option = 1` in a component script gets **invalid JavaScript** — a
duplicate `const` in the emitted init function — and the compiler reports
`errors: none`. Measured across four declaration forms and thirteen names: `let`
is safe on all of them, because a reactive `let` is renamed to `$$sig_<name>`
before emit; `const`, `var` and `function` each break on nine — `$option`,
`$slots`, `$onMount`, `$onDestroy`, `$onCleanup`, `$props`, `$attributes`,
`$context`, `$emit` — for 27 silently-invalid combinations. The compiler
internals (`$runtime`, `$dom`, `$class`, `$parentElement`) are clean in every
form, so the collision surface is exactly the names `FJS-D132` is removing.

That reframes the work. **`FJS-D132` is not cosmetic: it takes the injected-name
count from twelve to one, and the one is covered by the shadow refusal the
ruling already requires.** The failure mode goes from a browser SyntaxError
inside generated code, after a compile that said it was clean, to a compile error
naming the author's own line.

---

## What is settled, and what is not

Settled by `FJS-D132`: the twelve builtins move onto `$`; `$:` and `$_name:`
stay and cannot conflict; `$` may not be destructured, aliased or shadowed;
Sierra does not join; compiler internals are out of scope.

**Settled 2026-08-23.**

**The old spelling becomes a hard error, shipped as a 0.1.x patch.** Both
spellings never coexist and the compiler carries one injection path. The cost is
stated rather than hidden: mesa is published at 0.1.3, and below 1.0 a caret
pins the minor, so `^0.1.3` resolves a 0.1.4 and an installed app is carried
across without asking. Exposure was measured before choosing — 484 downloads in
the month to 2026-08-22, on a package first published a week earlier — so the
population that can be broken is small and mostly not yet real. The mitigation
that follows from the choice is the error message: it must name the replacement
spelling, so anyone pulled across gets a one-line fix rather than a mystery.

**`$` is a per-instance object inheriting a module-level one.** The five
animation helpers are pure and stay shared — `Object.create($shared)` per
instance, instance keys assigned on top. One door to the author, one allocation,
and the static half is not rebuilt on every mount. This also answered the
allocation question Phase 1 was going to measure: there was nothing to measure,
because nothing is copied. Built out further than planned — the four lifecycle
functions are instance-independent too, so they went on the shared half as well,
leaving nine genuinely per-instance keys.

**`$` outside a component is a compile error naming the cause.** A `<script
module>` block or a plain `.js` reaching for `$` fails at compile with a message
saying `$` is component-scoped and pointing at the named runtime exports, which
stay the supported way in. Same argument as Junction's ambient `$`: an ambient
dependency is only acceptable with a loud failure, and a generic
`ReferenceError` in a browser is not one.

---

## Phases

Each phase ends green on its own. Nothing here is a big-bang.

**Phase 0 — the defect, alone (`FJS-471`). DONE 2026-08-23.** Make the nine colliding names a
compile error naming the author's line, and add a case to the compiler suite
that parses the output. This is worth doing first and separately because it is
the only part with a user-visible bug behind it, it is small, and it lands
whether or not the rest proceeds. It also builds the refusal machinery Phase 2
needs. Invariant 15 applies directly: the test must parse, not merely compile.

**Phase 1 — `$` becomes the door, old names still work. DONE 2026-08-23.** Emit `$` as a
per-instance object carrying all twelve, beside the existing injected names.
Nothing breaks, nothing is migrated, and both spellings compile. This is where
the animation-helper question gets answered and where the per-instance
allocation gets measured. The emit site is already localized — the builtins are
injected as a run of `const` declarations in the component init, visible in
compiled output as `const $option = { props: __props }` and its neighbors — so
this is an addition next to an existing block rather than a new mechanism.

**Phase 2 — the refusals. DONE 2026-08-23.** Destructure, alias and shadow of `$`, each a compile
error naming the line. Mesa already refuses in this class (an unknown `mesa:*`,
a bad instance-script export form), so this follows an existing shape. Must land
before Phase 3, because a codemod that introduces `const { props } = $` in one
file is a silent staleness bug the refusal is there to catch.

**Phase 3 — the codemod. DONE 2026-08-24.** 252 sites across 122 of the repo's 296 `.mesa` files:
`$onDestroy` 90, `$attributes` 82, `$context` 51, `$onMount` 19, `$slots` 10.
The other seven builtins have no in-tree uses and move as pure surface. It is a
mechanical rewrite, and the one thing that makes it worth scripting rather than
hand-editing is that `$context.theme = x` is a property assignment whose left
side must survive.

**Phase 4 — retire the old spelling, and the sniff. DONE 2026-08-24.** Old names become errors
(subject to the deprecation question), and the `rawScript.includes('$.transition')`
heuristic goes, because `$` is now always emitted and there is nothing left for
it to decide. Removing that sniff is the quiet win: today a mention inside a
comment injects the namespace and `$['transition']` does not.

**Phase 5 — the docs. DONE 2026-08-24.** `VISION.md` §14's builtins table, RULE 25, RULE 31a,
RULE 37, RULE 42, and the root `CLAUDE.md` Live-hazards entries that name a
builtin. The sentence that must **not** be written yet is *`$foo` is an ordinary
user variable name* — that only becomes true with `FJS-470`.

**Later, separately — `FJS-470`.** Internals to `$$`, `__` converging with them.
Unblocked on Invariant 12 by the hash finding above; still wants `__` in the same
pass or the four-line rule is fiction.

---

## What proves it

Mesa's own suite is the floor — `bun run test` in `packages/mesa`, vitest then
Chrome over CDP. Beyond that, the root map says a compiler or runtime change is
proven by `example`'s `verify` **and** `verify:site`, because SSR and hydration
fail apart, and that holds here: `$onMount` is inert on the server while
`$context` is not, so a change to how either is injected can pass one and fail
the other.

Two more are load-bearing for this particular change. `packages/ui` has 69
components that between them use `$attributes` 82 times and `$slots` 10 — the
largest single consumer of what Phase 3 rewrites — so `ui`'s own drive plus
`example`'s `verify:ui` is what says the codemod was faithful. And `jetty`
bundles mesa output into an MV3 content script, which is a classic script: any
change to what the compiler emits at module scope is exactly the class of thing
that broke there before (`FJS-030`), so `jetty`'s ten phase files should run
before Phase 4 rather than after.

---

## Sequencing against the other session

This plan touches `packages/mesa/src/compiler.js` heavily and 122 `.mesa` files
across `packages/ui`, `example` and `basecamp`. A concurrent session working in
this tree makes Phase 3 in particular a poor thing to run unattended — a codemod
and a hand edit landing in the same file disagree quietly. Phases 0 and 1 are
additive and narrow enough to start earlier; Phase 3 wants the tree to itself.
