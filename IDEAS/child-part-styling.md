---
id: child-part-styling
status: proposed
dated: 2026-08-24
---

# Idea — Styling a child's parts from the parent

**Status: IDEA. Nothing here is built.** Dated 2026-08-24. The *What exists today*
section was measured by compiling against `packages/mesa/src/compiler.js` on that
date; everything under *Proposed* is a suggestion and the names are placeholders.
Do not cite the proposed sections as behavior — see `VERIFYING.md`.

A parent occasionally needs to reach a specific element **inside** a child — the
header of a `<Card>`, the body of a `<Dialog>` — and Mesa has four adjacent
mechanisms, none of which is that. Two of them work and are about something else,
one is an escape hatch with a real defect, and one compiles to nothing at all.

---

## What exists today

**`{class}` passthrough works and is not this.** The child marks ONE element with
`{class}` or `bind:class` and the parent's `class=` lands on it, merged rather than
replaced (`bindClassPassthrough` removes only the tokens it previously added, so the
element's own classes and the scope hash survive). The author selects the element by
*pointing at it* — there is no name involved, and it is not the root unless the
author put the marker there:

```mesa
<section><header>h</header><div class="body" {class}>b</div></section>
```
```js
var el0 = $$runtime.sibling($$_skip0);          // the div, not the section
$$runtime.bindClassPassthrough(el0, () => ($$runtime.get($$sig_$class)));
```

One element per component, by construction. That is the whole of what a parent can
reach today.

**`class:name={expr}` is a conditional toggle on an element**, not a part override
crossing into a child — `class:active={isActive}`, twenty-odd uses in
`packages/ui/components/forms/DatePicker.mesa` alone. It shares a colon with the
proposal below and nothing else.

**`:global()` is the escape hatch, and its defect is the reason for this file.** It
works, and it binds the parent to the child's *internal class name*:

```mesa
<style>
  .wrapper :global(.card-header) { padding: 0 }
</style>
```

Every child's internals become public API by accident, and nothing at either build
says when one moves. **Demand is real but small**: one use in the whole repo
(`example/site/src/islands/LivePrices.mesa:111`), zero in `packages/ui`.

**`class:header="tight"` on a COMPONENT compiles today and does nothing.** It is
passed as a prop keyed with the literal string and no reader exists:

```js
Card(el0, {$class: `raised`, "class:header": `tight`}, null);
```

That is the state to leave whichever way this goes: a spelling that looks like the
feature, type-checks nowhere, and silently drops.

**A fifth mechanism was parked and removed.** `makeClassResolver` in `runtime.js`
resolved named part overrides out of a `$option.$class` map with `'$$main'` reserved
for the unnamed root, and it never ran: the compiler's only `getClassMap()` returned
`{ classMap: {}, metaClass: {}, main: null }` and had no caller, so the `$$main`
branch was unreachable twice over. Deleted 2026-08-24 rather than left as a marker,
because a ruling (`FJS-D134`) cited it as live protocol. It is recoverable at
`c75183f` and **it is the wrong shape for what follows**, which is the more useful
half of the finding — see *What this does not need*.

---

## Proposed

### The child declares which parts are addressable

`part=`, which is the platform's own spelling and costs no new sigil:

```mesa
<article class="card" {class} {...$.attributes}>
  <div class="surface-header" part="header">…</div>
  <div class="surface-body"   part="body">…</div>
</article>
```

The alternative — every authored class is addressable — is `:global()` restated with
better ergonomics and the same defect. A part is a **declaration**, and declaring it
is what makes it survive an internal rename.

### The parent addresses only those

`part:name=`, not `class:name=` — that spelling means *toggle* on an element, and one
spelling with two meanings depending on node kind is the thing this file exists to
stop:

```mesa
<Card class="raised" part:header="dense" part:body="tight" />
```

**Merge, never replace**, matching `bindClassPassthrough`. The parked resolver
replaced — `if (override) result[override] = 1` and the part's own class is gone —
which was already inconsistent with the passthrough sitting beside it.

### The half that is not just passing a string

Two kinds of class can be handed over, and only one is free.

**A design-system class** (`dense`, `outlined`) is global and lands as-is. Invariant
13 says this is how you style anyway — a tone and a treatment, never a color — so
this case covers most of the demand and could ship alone.

**The parent's own scoped class** is the hard one. The parent's `<style>` compiles
`.tight` to `.tight.mHASHp`, and the child's element carries no `mHASHp`. So
`part:header="tight"` must be resolved **at the parent, at compile time**, into
`tight mHASHp` — only the parent knows its own hash. It is the same `resolveAsNode`
machinery that already writes `authored + ' ' + id` for the parent's own elements,
at a new call site.

Without this second case the feature does not replace `:global()`; it only replaces
the subset of it that was passing a utility class. **Whether it is in v1 is the
first real decision.**

### The part registry already exists

`@frontierjs/css`'s `ANATOMY` is the answer to *which parts does this term own* —
25 terms, 42 named parts, `parts` (owned) against `uses` (borrowed), one canonical
markup block each, checked against the real CSSOM in both directions by
`anatomy.spec.js`:

```js
Card: { markup: `…`, parts: [], uses: ['surface-header', …] }
```

So `<Card part:header>` is not a free-form string — it resolves against what Card
declares, and Card declares that it *borrows* the Surface sub-regions rather than
owning five headers. **A part name the component does not declare should be an
error**, and that is gradeable against a register that already ships rather than one
this feature would have to invent.

---

## What it costs

**A new protocol key** in the sense `FJS-D134` rules — `$part` beside `$class`, or
`$class` becoming a map. A protocol key is what two COMPILED components pass each
other, so moving or adding one breaks a published `@frontierjs/ui` built by one mesa
meeting an app built by another, with nothing at either build saying so. Measured
while attempting `FJS-470`: renaming `$class` to `$$class` compiled cleanly, parsed
cleanly, and silently broke class passthrough everywhere. So this ships with a
version bump attached, deliberately.

**A shadow-root caveat.** Sierra's `widget` target mounts in a shadow root, where a
class handed in from a host page matches no rule the host owns. A part passthrough is
still correct there — the child's own stylesheet is inside the shadow root with it —
but the *parent-scoped* case above crosses a boundary that CSS will not, and the
honest answer for a widget is the platform's `::part()` rather than a class. Worth
saying rather than discovering.

---

## What this does not need

**`$$main`.** The parked resolver ran the root and the named parts through one map,
so the root needed a reserved key that no real part name could collide with. In a
`part:`-keyed design the root is addressed by plain `class=` — which already works,
merges correctly, and is what every component in `packages/ui` uses — and named parts
by `part:*`. Two channels, no reserved key.

That is why the machinery was deleted rather than kept as a marker: it was parked for
this feature and it is not the shape this feature takes.

---

## Open questions

1. **Is `part:` the spelling?** `class:` is taken; `::part()` is the platform's and
   argues for `part`. A third option is `--`-style custom properties, which is what
   `@frontierjs/ui`'s DatePicker went **107 declared properties → 6** to get away
   from (`FJS-128`) — per-property, does not compose, enumerate-everything.
2. **Is the parent-scoped-class resolution in v1**, or does `:global()` stay for the
   bespoke-rule case and this ship as design-system-classes-only?
3. **Does `class:x` on a component start refusing now**, independently of the rest?
   That one is cheap, stands alone, and closes a silent drop today.
4. **Who grades a part name** — the compiler against a `part=` scan of the child
   (needs cross-module knowledge Mesa does not have), or `fli check` against
   `ANATOMY` (has the register, only sees text), or neither in v1.

---

## Prior art

| | Answer | Shape |
| --- | --- | --- |
| Shadow DOM | `part=` + `exportparts` + `::part()` | declared parts, CSS selector, crosses the boundary by design |
| Svelte | `:global()`, and `class:` on components was removed | escape hatch; the removal is the relevant data point |
| Vue | `:deep()` | escape hatch, same defect as `:global()` |
| Tailwind-ish kits | pass a class string per slot (`classNames={{header}}`) | prop-shaped, no registry, no scoping answer |

The shadow-DOM row is the one to copy: **the child declares, the parent addresses,
and an undeclared name is not reachable.** It is also the row FrontierJS is closest
to already having, because `ANATOMY` is that declaration written down for 25 terms
and checked.

---

## See also

- `IDEAS/page-composition.md` — the other open `@frontierjs/css` structure question
- `DECISIONS.md` `FJS-D134` — what a protocol key is and what moving one breaks
- `DECISIONS.md` `FJS-D132` · `ISSUES.md` `FJS-470` — the `$` tiers this sits beside
- `packages/css/vocabulary.js` — `ANATOMY`, the register a part name would grade against
