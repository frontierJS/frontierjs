---
id: stored-templates
status: proposed
dated: 2026-09-14
---

# Idea — A template somebody authors at runtime and the app saves in a row

**Status: IDEA. Nothing here is built.** Dated 2026-09-14. Every result below
came from running the probe beside it against this tree on Bun 1.3.11; nothing
is quoted from a document. Do not cite this file as behavior — see
`VERIFYING.md`.

---

## Trigger

`tenant-authored-queries.md` found that a stored report is four pieces of
executable material, and put the fourth one, the `view`, aside in one sentence:
*a compiled component is JavaScript that runs, so it is the same decision as the
transformer.* That sentence is right and it is not the whole question, because a
template is wanted far more often than a report is. An order confirmation a shop
owner rewords, an invoice layout, a notification body, a landing block: every
app with customers eventually has somebody who is not a developer asking to
change the words without a deploy. `conversion-maid-tech.md` item 6 asks it
directly (the application keeps components in a tenant-scoped table and assumes
staff write them), and `machinery-models.md` lists `Template` as a model that is
a row in every app that has one.

The renderer already exists: `renderComponent(source, { target })` takes a
string, and `target: 'email' | 'fragment' | 'html'` covers every surface named
above. **What is missing is not a way to compile a row. It is a reason to trust
one.**

---

## The measurement that removes the easy answer

The easy answer is *strip the `<script>` and let them write markup*. Probed
with `renderComponent` from `packages/mesa/src/render-component.js`, each
source a template with no script block unless stated:

| Source | Result |
| --- | --- |
| `<p>Hello {$props.name}</p>` with `name: '<b>x</b>'` | `<p>Hello &lt;b&gt;x&lt;/b&gt;</p>`, escaped |
| `<p>{Object.keys(process.env).length}</p>` | `<p>90</p>` |
| `<p>{typeof Bun}</p>` | `<p>object</p>` |
| `<p>{"".constructor.constructor("return typeof process")()}</p>` | `<p>object</p>` |
| `<p>{globalThis.__pwned = 1}</p>` | renders `1`, and **`globalThis.__pwned` is `1` in the rendering process afterwards** |
| `<script>import fs from 'node:fs'</script><p>{typeof fs.readFileSync}</p>` | `<p>function</p>` |
| `<div>{@html $props.bio}</div>` with an `onerror` payload | the payload, verbatim |
| `<p>{await import('node:fs')…}</p>` | a build error, which is an accident of this spelling and not a boundary |

**A Mesa expression is JavaScript, evaluated in the API process, with that
process's globals.** Removing `<script>` removes nothing: `process.env` is one
brace away, the `Bun` global is `Bun.file` and `Bun.spawn`, and a render can
write into the host's global scope, which persists into every later request.
The text escaping is real and holds (row one), so the problem is not XSS in the
ordinary `{value}` position. It is that the braces execute. `{@html}` is the
separate XSS hole and needs its own refusal.

`tenant-authored-queries.md` already established the rest: `node:vm` is not a
sandbox on Bun, `Worker` has no permission model, and there is no isolate API.
Nothing in-process bounds a compiled component.

---

## Three designs

**A. Full Mesa, in-process, gated to staff.** Whoever holds the gate on the
`Template` row can execute code with the API's credentials. That makes the row's
write gate a deploy gate that is not reviewed, diffed or released. **Refused as a
stored shape.** The legitimate case, where a developer writes a template that
runs code, already has its paved road: a `.mesa` file in the tree, rendered with
`renderFile`, reviewed like everything else. A row adds nothing to that case
except skipping review.

**B. Full Mesa, in a separate process under OS limits.** This bounds the damage,
but it's a battery with tendrils: a process pool, a wire protocol for props and
results, resource limits per platform, and a second runtime to keep alive in
every deploy shape. It also leaves the template able to do anything inside its
box, which for an email body is still far more than asked. **Refused under
*batteries vs. smallness*.** It is not severable.

**C. Mesa markup, with expressions that are evaluated and never executed.**
The template keeps Mesa's parser, its blocks (`{#if}`, `{#each}`), its scoped
CSS and its `email`/`fragment` targets. What changes is what a `{…}` is: it is
parsed by the `.lite` expression grammar, not handed to JavaScript, and the
emitted render calls an evaluator over a frozen data object. No `<script>`, no
`{@html}`, no `import`, no component tag the app has not registered by name.
**This is the proposal.** It is the same answer the transform axis reached, for
the same reason: an operator's real needs here are expressions, not programs.

---

## What already exists for C, and what does not

**The evaluator exists and is already below the dependency graph.**
`@frontierjs/toolbelt/predicate` is the `.lite` expression language evaluated
against one record, moved out of litestone so a browser could run it
(`FJS-D259`). Mesa may import toolbelt. Its own header states the rule that
matters here: a second CALLER of one evaluator is safe, and a third COMPILATION
is how `@@allow`'s halves drifted (`FJS-195`). A template renderer would be a
caller.

**The parser does not exist outside litestone.** `parsePolicyExpr` is a method
on litestone's `Parser` class (`packages/litestone/src/core/parser.js`), and
Mesa cannot import litestone. The evaluator moved and the parser did not, so C
needs the parser to follow it into toolbelt, with litestone reading it from
there.

**The grammar is a predicate language, not a value language.** Measured off the
parser: `or`, `and`, `!`, comparisons, ternary, literals, fields, paths,
`auth()`, `now()`. No arithmetic, no string concatenation, no calls. That covers
`{order.number}`, `{#if order.status == 'shipped'}` and
`{customer.name ? customer.name : 'there'}`. It does not cover
`{order.total}` rendered as `$31.50`. **Formatting is the gap**, and it is a
closed catalog, not a language extension: `@frontierjs/toolbelt/units` already
owns money and byte formatting, so a template needs a way to name a formatter
from that catalog and nothing more.

**The compiler has a seam but a lint is not the design.** `compileSource` runs
plugins at `dom`, `js` and `build` (`compiler.js`), and a `dom` plugin sees the
parsed tree. A plugin that walks it refusing `<script>`, `{@html}` and
suspicious expressions would be a denylist over JavaScript, which is
`scoped-sql.md`'s false guarantee in another language: the constructor escape
above contains no forbidden word. **C needs its own emission for expressions**,
where the braces never reach JavaScript at all, so nothing needs to be caught.

**The compile is cheap enough to do per render, and should not be.** Measured in
the same probe: about 29ms first call, 1.7ms steady state on a one-line
template. Every call still writes a temp module and imports it (`FJS-664` is the
abandoned-render half of that path). A stored template changes only when its row
does, so a cache keyed on the source's content hash, which Invariant 12's
content-addressed scope ids already make stable, turns the render into a lookup.

---

## What a build would have to answer

1. **Is this Mesa or a sibling?** C keeps Mesa's markup and replaces its
   expression half, which could be a compiler mode or a separate small compiler
   sharing `parseHTML`. A mode keeps one owner of the markup. A sibling keeps the
   main compiler from growing a switch that changes what braces mean.
2. **Where does the parser move, and what holds the two readers together?** The
   evaluator's oracle today is SQL against JS. A template reader adds no third
   evaluator, but the parser moving is a real edit to litestone and wants the
   same `policy-interpreters` coverage after the move as before.
3. **How does a template name a formatter?** Whatever syntax is chosen is a
   coined word in the language, so it goes through `decision-rules` on its own.
   The catalog is `/units` and nothing else.
4. **What components may a template use?** A registered allowlist (email-kit's
   components, an app's own) keeps layout expressive without letting a row reach
   arbitrary code. A component the registry does not name should be refused by
   name, listing the ones that exist, the way an unknown `mesa:*` tag already is.
5. **What is the data a template sees?** A frozen object the caller builds. The
   evaluator's resolvers for `check()` and relation paths would default to their
   fail-closed answers, so a template cannot open a database through a path.
6. **Who may author, and is that still a question?** Under C a template can
   leak only what its data object holds, so the write gate stops being a code
   execution gate and becomes an ordinary content gate. That is the main thing C
   buys, and a tenant-authored template becomes a reasonable feature rather than
   a vulnerability.
7. **What does an author coming from Handlebars, Liquid or Svelte get?** Their
   habits will reach for `{{ }}`, filters, and inline JS. Each wants a loud
   refusal naming the equivalent, not silent acceptance.

---

## The nine questions

Answered before writing.

- **Another origin of truth?** No. The markup is Mesa's parser, the expressions
  are the `.lite` grammar, the formatting is `/units`. C adds a way to combine
  them, not a new source for any of them.
- **Concept budget?** It enlarges it by one: a template whose braces are not
  JavaScript. That is a real cost, since the same `{…}` means two things in two
  places. The file extension or target has to make which one unmistakable.
- **Complexity ours or the problem's?** The problem's. Non-developers editing
  what an app sends is an ordinary requirement. The complexity A and B add
  (review bypass, a process pool) would be ours.
- **Predictability?** Improves it. *A stored template can show what it was
  handed and nothing else* is a sentence a reader can hold.
- **Derived instead of restated?** Mostly. Evaluator, parser, markup, targets,
  formatters all exist. The expression emission is the one new piece.
- **One owner?** Mesa for markup and targets, toolbelt for the expression
  language and formatters. The parser moving makes toolbelt the single owner of
  the grammar rather than litestone keeping it and a template reader copying it.
- **Boundary explicit?** Today it is absent, and the probe is how that was
  established. Under C the boundary is the grammar itself.
- **Failure proportional?** A's failure is the process's credentials, which is
  what makes refusing it proportionate. C's failure is a template that renders
  wrong data it was already given.
- **Wrong without anything saying so?** Yes, and this is the sharpest one. A
  template that leaks renders correctly. Any build owes a test running the
  escape rows above and asserting each is refused at compile time, **paired with
  a legitimate expression one character away that still renders**, because a
  compiler refusing every brace would pass a test asking only about the refusals.

**Adjudication.** *Ergonomics vs. strictness*, by what a mistake destroys: full
Mesa in a row destroys the process's credentials, so strict wins on cost.
*Batteries vs. smallness* refuses B. *Familiarity vs. precision* governs
question 7: take the shape authors know (markup with holes), refuse the words
that half-fit, and name the equivalent.

**Tier.** Assessment. Nothing here may be cited as behavior.

---

## See also

- `tenant-authored-queries.md`: the report axes, the `node:vm` probe, and the
  expression-language convergence this record joins as a third reason.
- `machinery-models.md`: `Template` as a candidate machinery model.
- `conversion-maid-tech.md` item 6: the live application with the requirement.
- `html-over-the-wire.md`: the renderer's timings as a broadcast path.
- `scoped-sql.md`: why a denylist validator is a false guarantee.
