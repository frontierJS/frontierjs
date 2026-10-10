---
id: command-views
status: proposed
dated: 2026-10-10
---

# Idea — a command's output written as a Mesa view

**Status: PROPOSED. Spiked on `fli ps` and reverted; no code is in the tree.**

A command body prints with `echo` and the house `chalk` (`packages/cli/core/color.js`),
so layout lives inside string concatenation: a `padEnd` per column, a
`chalk.dim(...)` per span, and branches for each state interleaved with the
data code. `commands/ports/status.md` is the measured case — 80 lines of body,
most of it layout.

The proposal: a ```` ```mesa <name> ```` fence in a command `.md` declares
`async function <name>(data)`, which renders the template once and returns
terminal text. The js fence gathers the data; the view is the page.

```mesa
{#if busy.length}
  <p><b>{plural(busy.length, 'port')} in use</b></p>
  <table>
    {#each busy as b}
      <tr>
        <td class="success">●</td>
        <td><b class="info">{b.port}</b></td>
        <td><b>{b.project}</b> <span class="muted">·</span> <span class={envTone[b.env]}>{b.env}</span></td>
      </tr>
      <tr><td></td><td colspan="2"><span class="muted">pid {b.pids.join(', ')}</span> {b.command}</td></tr>
    {/each}
  </table>
{:else}
  <p class="muted">No port this workspace can name is in use.</p>
{/if}
```

`echo(await view({ busy, plural, envTone }))` from the js fence prints it.

## What the spike built

- **The fence.** `transformMarkdown` in `core/compiler.js` emitted the function on
  the fence's closing line, the template as one JSON string, so every line kept
  its place for the frame map. A function DECLARATION, so the fence may sit below
  its caller. The name is required: a bare ```` ```mesa ```` fence is an example in
  prose, and `tutor/_steps-app/09-mesa.md` has two.
- **Props from data.** Every key of `data` became an `export let`, written into
  the template's script, so a view declares nothing.
- **The render.** Mesa's `renderComponent` (happy-dom), then the HTML lowered to
  lines:
  - `p`, `div` and `li` are lines; `ul`, `ol`, `dd` and `blockquote` indent 2;
    `section`/`h1–h3` add a blank line after; `br` breaks; `pre` keeps whitespace.
  - `table` sizes each column to its widest cell, and a `colspan` cell sizes
    nothing. This is the largest win, since every `padEnd` goes away.
  - A css TONE class (`success`, `danger`, `muted` …, plus `text-*`) becomes an
    escape code; `b`, `i`, `u`, `s`, `small` become cell attributes.
  - Each text run states its whole style after a reset. That fixes nesting:
    with wrappers, an inner `dim`/`bold` ends the outer one, because both close
    with SGR 22.
- `bun test`: fence hoisting, a bare fence staying prose, table widths, a tone
  inside `muted` staying dim, one real render through mesa.

## What it measured

- **About 210ms** to load the compiler and happy-dom and render, on top of the
  1–1.6s `fli ps` already takes. That doesn't matter for `ps` and does matter
  for a fast command.
- **HTML whitespace rules apply.** Two spaces collapse to one, so alignment
  comes from a table, never from spacing.
- **A view cannot hold a `<script>`.** The command's own script block runs from
  the first open tag to the LAST close tag (`matchScriptBlock`, which has to
  stay greedy because scaffolds emit script tags), so a script tag inside a
  fence takes over the command. Helpers come in through `data`, and
  `{@const}` covers a local. That kept the template pure layout, but it also
  makes a view the one Mesa file with no script (§ V *predictability*, below).
- **A global `fli` has no mesa beside it.** The spike reached mesa by relative
  path and threw by name without it.

## The nine (answered late, after the spike)

1. **Origin**: none added. The template is the output and nothing restates it.
2. **Concept**: adds a fence kind, and removes a styling vocabulary. A command
   author writes the same tones and tags as a `.mesa` page (`FJS-D38`).
3. **Complexity**: the HTML→lines lowering is new code. Aligned, styled text is
   a problem that already has a name (layout), and a table is the existing
   answer to it.
4. **Predictability**: two ways to print (echo, view), and a view is a Mesa file
   with no script. Both are costs.
5. **Derived**: the tone→escape table restated css's seven tones. It should
   read `vocabulary.js`'s `tone` list, or a test should compare the two.
6. **Owner**: mesa already owns HTML→text for email (`htmlToText`) and a terminal
   tag table (`terminal/tags.js`). A lowering inside `cli` would be a second
   owner beside both.
7. **Boundary**: `view(data)`, every key a prop. Untyped.
8. **Failure**: the spike printed an unknown tag as inline text. The terminal
   target REFUSES a tag missing from `tags.js`, and a print lowering should too.
9. **Silence**: must stay true: every css tone renders as a distinct style.
   Fails as: a tone missing from the table prints plain and nothing says so.
   Artefact owed: a test over `vocabulary.js`'s tone list. Today: none.

**Adjudications in tension:** *batteries vs. smallness*. Mesa in `fli`'s
dependency graph has to stay severable, and `fli list`/`--help` import no
runtime (`packages/cli/CLAUDE.md` § What bites here). Also *paved road vs.
the workaround*, if echo stays a second road.

## Open questions

- Where the HTML→terminal-text lowering lives.
  - **A** — `packages/cli/core/view.js`, as spiked, with mesa reached by path.
  - **B** — a mesa render target beside `email`, `renderComponent(src, { target:
    'text' })`, reading `terminal/tags.js` for what it may print.
  - **Recommend B**: mesa owns the server render, the HTML→text precedent and
    the terminal tag table. B keeps one owner (§ V *owner*), the refusal comes
    free from the existing table, and `cli` calls a published entry rather than
    reaching into source.
- How a global `fli` gets mesa.
  - **A** — a real dependency, imported lazily at the first view.
  - **B** — an optional peer: a command with a view throws by name until it is
    installed.
  - **Recommend A**: a shipped command that breaks on a missing peer is a broken
    command. Lazy import keeps the read-only path at its current cost.
- Whether echo stays.
  - **A** — both, with a view for layout-heavy commands.
  - **B** — views only, migrated command by command.
  - No recommendation until a second command is ported. `ps` alone does not
    say whether the 210ms and the no-script rule are worth it everywhere.
