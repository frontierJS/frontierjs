---
id: keys
status: proposed
dated: 2026-10-21
---

# Idea — Keys: one keymap engine under the terminal, the browser and the desktop

**Status: PROPOSED.** Dated 2026-10-21. Nothing here is built. Do not cite this
file as describing behavior — see `VERIFYING.md`. Every noun below is
provisional until `decision-rules` has run on it; the open questions are at the
end and a ruling cites one by its `Q` number.

**Trigger.** Haven asked what level of vim to support, and whether a vim layer
can be a self-contained component of any app rather than a thing each TUI
rebuilds. A read of khat (`~/code/tmp/khat`, a Rust Mattermost client with full
vim keys) answered the second question: its key engine is a pure reducer with
no terminal in it, and the same tree already holds three hand copies of that
reducer plus a plan for a fourth.

## What exists

| Site | What it hand-rolls | Shape |
| --- | --- | --- |
| `packages/sierra/src/terminal/shell.js` | `h j k l` renamed to the arrows before a keydown is made; `j`/`k` the page leaves alone move focus; NORMAL/INSERT per `FJS-D987` | a key table and a mode |
| `packages/haven/web/src/lib/hash/commands.js` + `lib/home/home-row.js` | verbs keyed by letter delivered nearest first; a waiting operator (`d`, `f`, `s`, `a`) with a 400ms timeout; a mode with `take` handed every key | a prefix trie, await-char and a layer stack, each by hand |
| `packages/ui/rowlist.js` | `↑/↓` or `k/j`, Home/End, Enter, Space or `x`; modified keys never taken; keys inside a field stay the field's | one keymap plus the text rule |
| `IDEAS/browser-kit.md` 2.2 | `hotkey('mod+k' \| 'g then d', fn, { scope, when })` over 15 kit and 9 app keydown bindings; a chord parser as a toolbelt kit | a chord parser and a sequence, browser only |

`FJS-3279` is what the copies cost: sierra's shell read `a` as vim's append
before Haven's scene saw it as a verb, and the fix was Haven refocusing a line.
With one engine that is an ordering of active keymaps, not a bug.

### Every key site, counted (0.1)

Read 2026-10-21 over `packages/` (mockups, vendored code and editor
completions left out): **95 sites**. 37 listen on `document` or `window`,
5 on the terminal runtime's `keyInput`, 53 on an element, 10 of those a
delegation root. No `keyup` is bound anywhere.

| What the sites do | Count | What the engine owes them |
| --- | --- | --- |
| a global listener with a text-field guard | 10 of 37, 4 counting `contenteditable` | Q5 stated once (`FJS-D1386`) |
| a global listener with no guard at all | 22 of 37 | the same rule, by construction |
| a platform modifier, `metaKey \|\| ctrlKey` | 16, none branching on the OS | `<Mod-…>` (`FJS-D1383`) |
| a sequence or a waiting operator | 1 (Haven's Scene, through `home-row.js`) | pending and await-char |
| a mode (vim NORMAL/INSERT) | 2 (sierra's `Shell.mesa:119`, `shell.js:347`) | the caller's, per `FJS-D987` |
| `mod+k` for a palette | 6, one per app | one row in a table |

`k` is spelled three ways in a comparison: `'k'` exactly, which misses Shift and
Caps Lock, `'k' \|\| 'K'`, and `e.key.toLowerCase()`. Every browser site compares
`e.key`, except basecamp's workbench, which compares `e.code` (`'KeyJ'`). On the
terminal, `e.code` holds the engine's own name (`'j'`), so a handler that works
on one target fails on the other: `FJS-3407`. The engine matches on `e.key` alone.

Four conflicts were found and filed. In each, two listeners answer one press,
and an ordered list of active keymaps settles it by construction:
- `FJS-3405`: the window Escape stack in ui ignores `defaultPrevented`.
- `FJS-3406`: Json and Haven's Editor run undo before their field guard.
- `FJS-3408`: Alt+Z fires both mesa's inspector and basecamp's workbench zoom.
- `FJS-3409`: Studio's Escape closes three things at once.

**The engine's case list** is khat's `keymap.rs` tests that are not about
khat's own app, 19 of 27: `parse_basic`, `parse_dashed_forms` (here a refusal,
since one spelling), `parse_errors`, `display_roundtrip`,
`event_normalization`, `pending_sequences`, `esc_resets_pending`,
`digits_are_pane_jumps_not_counts`, `hint_keys_follow_bindings`,
`layer_precedence`, `insert_char_fallback`, `empty_keymap_is_unhandled_but_types`,
`timeout_ambiguity`, `overrides_rebind_and_unbind`, `nop_removes_prefix`,
`overrides_warnings`, `override_into_empty_keymap`, `bindings_for_help`,
`char_argument_pending_and_cancel`. `input.rs`'s 38 are Phase 4's list.

## What khat settled

khat's `src/app/keymap.rs` is the reference. The engine is
`(keymap, state, context, key, now) → Action | Pending | Unhandled` and knows
nothing of app state; `update.rs` applies the Action. The parts that carry over:

- **Active keymaps, not modes.** A context `(mode, focus, overlay)` maps to an
  ordered list of tables; the first table with an exact or a prefix match wins.
  Emacs has called this *active keymaps* since 1985
  ([manual](https://www.gnu.org/software/emacs/manual/html_node/elisp/Active-Keymaps.html)),
  which is why the word is taken as is.
- **A table is a trie**: exact bindings plus a prefix set. A pending sequence
  shows in the status line. An exact-and-prefix ambiguity fires the exact after
  vim's `timeoutlen`. `f`, `t`, `r` are *await-char*: the next printable is the
  argument.
- **Unbound printable in a text context types.** That one rule is what lets
  vim keys coexist with ordinary typing, and it is the rule `rowlist.js` and
  browser-kit each restate.
- **No operator+motion grammar.** `dw`, `ciw`, `ct` are flat rows in a table.
  The types exist (`Operator × Target`) but the parser is sequence lookup.
- **No counts**, by decision: digits are pane jumps, pinned by a test.
- **Help and the hint bar are derived from the table.** One source.
- **Config overrides per table**, `nop` unbinds, a bad key warns and never
  fails.

The text half (`src/app/input.rs`, 1780 lines: motions, text objects, visual,
one register, undo) is where khat's cost lives, and it is a second pure
reducer over a string and a cursor.

## The levels, priced

| Level | What | Cost | Consumer today |
| --- | --- | --- | --- |
| L0 | app keys: `h j k l`, `gg`/`G`, a `g`-prefix, `]u`, `:` | the engine alone | sierra's shell, Haven, `rowlist`, browser-kit's 24 sites |
| L1 | a modal box: `i`/Esc, `h l w b 0 $`, `x`, `dd`, `u`, `p` | a few hundred lines over a string | Haven's line |
| L2 | operators, text objects, visual, register | khat's 1780 lines | none |
| L3 | counts, `.`, marks, macros | khat skipped | none |

L0 is this paper's Phases 1–3 and L1 is Phase 4. L2 opens when a consumer
edits more than a line, and nothing in a chat app has asked.

## Why not a TUI thing

Nothing in the engine is terminal-shaped. Mesa's terminal runtime already
delivers `keydown` with DOM key names (`FJS-D809`, `FJS-D987`: *the runtime
delivers keys as a browser does*), so one chord vocabulary serves three
targets. What differs per host is three seams: the clock that flushes an
ambiguity, the chords the host already owns (`Ctrl+W`, `Cmd+Q`, a menu
accelerator), and the predicate for *a text control has focus*. Browser
precedent for L0 is wide — Gmail's `j`/`k` and `g i`
([help](https://support.google.com/mail/answer/6594)), GitHub's `g c` and `?`
([docs](https://docs.github.com/en/get-started/accessibility/keyboard-shortcuts)),
Vimium ([repo](https://github.com/philc/vimium)), and tinykeys' sequence
spelling ([repo](https://github.com/jamiebuilds/tinykeys)) — and for L2 it is
CodeMirror's vim mode ([repo](https://github.com/replit/codemirror-vim)).

## The simpler version, priced

Extend browser-kit's `hotkey()` with sequences and stop. It fails on the
terminal by its own ruling (`FJS-D1097` Q6: a throw at the first call), so
sierra's shell and Haven keep their copies, and the two-origins bug
`FJS-3279` showed stays possible. The engine beneath `hotkey()` has to be the
one the terminal shell runs, which is this paper.

## Architecture

```js
// @frontierjs/toolbelt/keys — pure, no clock, no DOM
parseChord('<Mod-k>')          // → { key: 'k', mod: true }   vim's spelling, FJS-D1383
parseKeys('gg')                // → [chord, chord]; 'g g' and 'mod+k' refuse by name
keymap({ gg: 'top', d: { await: 'bolt' } })   // a trie; a duplicate key refuses by name
step(state, chord, active, now)   // → { state, outcome }
//   outcome: { action, arg? } | { pending: 'g' } | { typed: 'x' } | null
flush(state, active, now)          // the ambiguity after 720ms, FJS-D1385
bindings(keymap)                   // [{ keys: 'gg', action: 'top' }] for help and hints

// mesa runtime — the one host binding, both targets (Q7)
keys(() => ({ active: [sceneMap, shellMap], on: (action, arg) => … }))   // an {@attach}
// browser-kit's hotkey(chord, fn, { scope, when }) is one binding in the scope's keymap
```

The mode stays the caller's, as `FJS-D987` ruled for the shell: the engine
takes the ordered tables and never asks why they are active. On the terminal
the shell contributes its table; in a browser an app or a kit component
contributes one on its delegation root; Haven's scene puts its verbs before
the shell's.

## The nine, answered before any edit

1. **Origin** — one chord parser and one trie replace three copies and a
   planned fourth; the help a `?` shows is read from the table, never written.
2. **Concept** — *keymap*, *chord*, *await-char* are Emacs's and vim's words;
   the one coined here is none. *Modal* is already the overlay tier
   (`VOCABULARY.md`), so the box is *modal* nowhere in a name.
3. **Complexity** — a trie with a pending state and a timeout is what every
   sequence-key system has (vim, Emacs, tinykeys, khat); the grammar khat left
   out stays out.
4. **Predictability** — one spelling of a chord across three targets; a key a
   consumer binds behaves the same in a terminal and a tab.
5. **Derived** — hints, help and the duplicate check are derived from the
   table; the browser allowlist is one list, refused at bind time.
6. **Owner** — the engine in toolbelt, the binding in mesa's runtime, the mode
   in sierra's shell (`FJS-D987`); `hotkey()` becomes a caller, not a peer.
7. **Boundary** — `step()` is typed and pure; a host passes `now`, and the
   text predicate is an argument.
8. **Failure** — a duplicate default or a chord the browser owns refuses by
   name at bind time; a bad override warns and never fails (khat).
9. **Silence** — a binding that never fires is the silent case. Artefact: the
   toolbelt suite pins the engine; one mesa browser spec and one terminal spec
   each drive a sequence, a timeout and typing in a field; `verify-tui`,
   `verify-explore` and `verify-home-row` stay green through Phase 3. `none`
   until each lands.

Adjudications: *paved road vs. the workaround* — three copies in three
packages is the measurement; *batteries vs. smallness* — a toolbelt kit with
one seam into the runtime, severable; *familiarity vs. precision* — vim's
spelling (`gg`, `<C-k>`) taken as is, with `<Mod-k>` borrowing mousetrap's
`mod` for the one key vim has no name for, and the web's `mod+k` named in the
refusal (`FJS-D1383`). Tier: Assessment here; Register for the rulings
`FJS-D1382`–`FJS-D1388`; Map lines in
`packages/toolbelt/CLAUDE.md` and `packages/mesa/CLAUDE.md` when built.

## Plan

### Phase 0 — Groundwork

Goal: the sites counted, the questions ruled, the kit's folder standing.
Done when: `fli decisions` lists Q1–Q7 ruled and `bun run test` in toolbelt is green with the empty kit.

- [x] 0.1 List every key site with its shape: the four above, browser-kit's 24, and khat's test names as the engine's case list — § Every key site, counted: 95 sites, `FJS-3405`–`FJS-3409` filed
- [x] 0.2 Rule Q1–Q7 — `FJS-D1382`–`FJS-D1388`
- [x] 0.3 Scaffold `toolbelt/src/keys/`, the `exports` line, `fli ws:exports` — `./keys` in `exports.snapshot.md`, 871 passing

### Phase 1 — The engine

Goal: the pure reducer, with khat's cases passing.
Done when: toolbelt's suite is green and `exports.snapshot.md` carries the kit.

- [x] 1.1 `parseChord` / `parseKeys` / `formatChord` in vim's spelling (`FJS-D1383`): vim's names to DOM key names and back, `<Mod-…>`, a literal space or a `mod+k` shape refused by name — `test/specs/keys.spec.js`, 11 rows; one spelling per chord, what `formatChord` writes (`<cr>`, `<Enter>`, `<C-K>` refused naming it); Shift lives in the printable character (`<S-g>`, `<S-1>` refused), beside a modifier a letter is lowercase with `S-` explicit
- [x] 1.2 `keymap(table)`: the trie, the prefix set, a duplicate refused by name — one trie per platform, `<Mod-k>` resolved at build as ProseMirror and CodeMirror do, both built because the kit may not probe; the duplicate one spelling leaves is `<Mod-k>` beside `<C-k>` or `<D-k>`, refused naming both, as are a binding under an await-char and `<Esc>` after the first key; 6 rows. khat's four override cases (`nop`, a bad key warns) wait for the first consumer with a keys config — the reopen path is 2.2, where `hotkey()` adds to a scope's table
- [ ] 1.3 `step()` and `flush()`: exact, pending, ambiguity after the one 720ms timeout, await-char, `typed` for an unbound printable in a text context, `null` otherwise
- [ ] 1.4 `bindings()` for help and hints
- [ ] 1.5 khat's cases ported: a digit is a key, `0` is a binding, Esc clears pending, the timeout fires the exact match

### Phase 2 — The host binding

Goal: one attachment in mesa's runtime that both targets run.
Done when: a browser spec in `test/browser/` and a terminal spec in `test/terminal/specs/` each drive `gg`, a pending timeout, and typing in a field.

- [ ] 2.1 `keys()` attachment, matching `e.key` only (`FJS-3407`): `preventDefault` on a taken key, `isComposing` bypassed, the text predicate per Q5, the timeout on the host's clock
- [ ] 2.2 `hotkey()` as one binding in the scope's keymap — browser-kit 2.2 lands here, its parser is 1.1
- [ ] 2.3 The browser allowlist: a chord the browser or the OS owns refuses at bind time by name

### Phase 3 — The consumers

Goal: the three copies gone, each drive green.
Done when: `verify-tui`, `verify-explore` and `verify-home-row` pass and `rg` finds one chord parser.

- [ ] 3.1 sierra's shell: `VIM` and `FOCUS` become the shell's keymap; the mode stays the shell's
- [ ] 3.2 Haven: `commands.press`, the waiting operator (400ms becomes 720ms) and the find-walk on await-char and pending; the scene's table ahead of the shell's, which is `FJS-3279`'s fix by construction
- [ ] 3.3 `rowlist.js` on the kit; browser-kit 2.3's fifteen sites run on it from there
- [ ] 3.4 `?` in the terminal shell listing the active bindings, read from 1.4

### Phase 4 — The modal text box (L1)

Goal: a vim box any app mounts, one `.mesa` for three targets.
Done when: a ui kit drive and a terminal spec each run `i`, Esc, `w`, `0`, `$`, `x`, `dd`, `u`, `p` over the component.

- [ ] 4.1 The reducer per Q6: `{ text, cursor, anchor, register, undo }`, khat's flat table with no grammar
- [ ] 4.2 The component over `<textarea>`: the doc mirrored to value and selection, a mode badge, the table a caller overrides with `nop`
- [ ] 4.3 Haven's line opts in

### Phase 5 — L2

Goal: operators, text objects, visual.
Done when: a consumer that edits more than a line asks, and names the rows it needs.

- [ ] 5.1 Opened by that consumer; priced then against khat's `input.rs`

## Open questions

- ~~**Q1**~~ **Answered 2026-10-21 (`FJS-D1382`): A — `@frontierjs/toolbelt/keys`, a pure reducer that takes `now`.** — Where the engine lives.
  - **A** — `@frontierjs/toolbelt/keys`, a pure reducer that takes `now`.
  - **B** — mesa `src/browser/`, beside `hotkey()`; fails the terminal by `FJS-D1097` Q6.
  - **C** — a `keys-kit` package; nothing in it needs a dependency.
  - **Recommend A** — browser-kit 2.2 already put the chord parser in toolbelt, and `/directives` is the precedent for a table that three realms read. Confidence 3.
- ~~**Q2**~~ **Answered 2026-10-21 (`FJS-D1383`): B — vim's: `gg`, `<C-k>`, `<S-CR>` (khat), and `<Mod-k>` for Cmd on a Mac and Ctrl elsewhere; a literal space or `mod+k` refuses by name.** — The chord spelling.
  - **A** — the web's: `g g`, `mod+k`, `Shift+Enter` (tinykeys, GitHub).
  - **B** — vim's: `gg`, `<C-k>`, `<S-CR>` (khat).
  - **C** — both parse.
  - **Recommend A** — browser-kit already wrote `mod+k`; one spelling, with vim's named in the refusal (*familiarity vs. precision*). Confidence 2.
- ~~**Q3**~~ **Answered 2026-10-21 (`FJS-D1384`): A — none; a digit is a key a table may bind (khat, pinned by a test).** — Counts.
  - **A** — none; a digit is a key a table may bind (khat, pinned by a test).
  - **B** — vim counts in any non-text context.
  - **Recommend A** — moves no caller and adds no convention; B is the reopen path when a consumer wants `5j`. Confidence 3.
- ~~**Q4**~~ **Answered 2026-10-21 (`FJS-D1385`): A, at 720ms — one constant; Haven's 400ms `d` moves to it.** — The ambiguity timeout.
  - **A** — one constant, vim's 1000ms; Haven's 400ms `d` moves to it.
  - **B** — a `timeout` per keymap, default 1000ms.
  - **Recommend A** — vim has one `timeoutlen` and khat one constant; B when Haven's feel proves it needs its own. Confidence 1.
- ~~**Q5**~~ **Answered 2026-10-21 (`FJS-D1386`): A — inside an editable only a chord with a modifier fires and a letter types, unless the editable's own keymap is active (the Phase 4 box).** — A letter while a text control has focus.
  - **A** — inside an editable only a chord with a modifier fires and a letter types, unless the editable's own keymap is active (the Phase 4 box).
  - **B** — every active table fires everywhere.
  - **Recommend A** — it is khat's `is_text_ctx`, `rowlist`'s rule and browser-kit's, stated once. Confidence 3.
- ~~**Q6**~~ **Answered 2026-10-21 (`FJS-D1387`): A — `/textbox` and `<Textbox>`, ARIA's role for the control.** — The text reducer's name and the component's.
  - **A** — `/textbox` and `<Textbox>`, ARIA's role for the control.
  - **B** — `/buffer`, vim's and Emacs's word, which also names Node's bytes.
  - **C** — `/editline`, which a multi-line box outgrows.
  - **Recommend A** — the precise word with no collision. Confidence 2.
- ~~**Q7**~~ **Answered 2026-10-21 (`FJS-D1388`): A — one `keys()` attachment in mesa's runtime, since both targets deliver DOM-shaped keydown; `hotkey()` is sugar over it.** — One host binding or two.
  - **A** — one `keys()` attachment in mesa's runtime, since both targets deliver DOM-shaped keydown; `hotkey()` is sugar over it.
  - **B** — a browser attachment and a terminal listener in sierra's shell.
  - **Recommend A** — `FJS-D809` made the terminal a target of `web/`, and one binding is what makes Phase 4's box one `.mesa`. Confidence 2.
