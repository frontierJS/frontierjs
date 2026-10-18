---
id: ui-kit-gaps
status: proposed
dated: 2026-10-04
---

# Idea — the components `@frontierjs/ui` lacks against a current kit

**Status: PROPOSED. Nothing here is built.** Do not cite this file as describing
behavior — see `VERIFYING.md`.

Measured against Sivir (`https://www.sivir.dev/docs/components`, ~60 components),
read from its one-line descriptions only, not its APIs. Each gap was checked against
`packages/ui/components/`, `packages/css/src/` and `IDEAS/`. Most of the list maps
onto something that ships; what follows is the remainder.

## Worth building

| Gap | What it is | Why here |
| --- | --- | --- |
| **Tag Input** | free entry of a list of strings — Enter, comma and paste each add, Backspace removes | `controlFor()` answers a `String[]` with no value set as `control: 'json'` (`sierra/src/resource/field-rules.js`, `case 'array'`), so a person editing tags types JSON. `MultiSelect` covers the array only when the values are KNOWN. This is the control that branch should name for an array of strings. Each entry renders as the existing `Tag`, whose header already names tag inputs as a caller |
| **Toggle / Toggle Group** | a button that stays pressed (`aria-pressed`); a row of them with single or multiple selection | list/grid switches and filter chips; `FilterBar` is the first caller. Small |
| **Context Menu** | the actions for what was right-clicked | a trigger, not a menu: it reuses `DropdownItem`/`DropdownGroup`/`DropdownSeparator` and positions at the pointer instead of the trigger's rect. Table rows in Basecamp and Studio |
| **Gauge** | a radial meter for usage against a limit | `Progress`, `Bar` and `Sparkline` ship, nothing radial. Basecamp's fleet readings (disk, CPU, memory) are the caller. The platform's word is `<meter>` (`low`/`high`/`optimum`), which is the semantics and the a11y for free; the radial drawing is the only new part, so the name is open |

## Maybe

- **File Diff** — a unified diff with gutters and change counts. Callers: Studio's
  migration diff, a Basecamp deploy. Niche.
- **Shortcut** — `Kbd` displays a chord; the missing half binds it to a keypress.
  Pairs with `CommandPalette`, and `command-surface.md` should own where bindings live.
- **Color Picker** — `<input type="color">` plus presets. Only for a color that is
  DATA (a label's color), never for styling — Invariant 13.
- **Show More** — clamps long content until expanded. `@frontierjs/css` has no
  line-clamp today, so the class is the larger half.
- **Sidebar** — the CSS ships (`components/frame.css`); there is no Mesa component
  and no collapsed state.

## Owned elsewhere

- **Reorder List** — `ui/dnd.js` (`dndzone`) ships; the missing parts are keyboard
  and screen-reader dragging (named as not built in its header), the moved-row
  animation (`list-motion.md`) and the persisted position (`manual-order.md`).
- **The AI family** — Conversation, Message, Composer, Reasoning, Tool, Response
  Stream, Attachment. `chat-surface.md` Part 5 already lists the chat components;
  this survey adds Reasoning and Tool (collapsible traces) and the paced reveal of a
  streamed response to that list rather than starting a second one.
- **Markdown** — `markdown-kit.md`.

## Not gaps

Alert Dialog is `ConfirmPanel`/`ConfirmProvider`, Sheet is `Drawer`, Command is
`CommandPalette`, Task Steps is `Steps`, Code Block is `Code`, Collapsible is the
`disclosure` pattern over native `<details>`, Typography is `@frontierjs/css`.
Scroll Area is refused: a themed scrollbar is CSS, and a JS scroll container gives
up native momentum and find-in-page. Navigation Menu and Fullscreen Nav are a
site's, so `site-kit`'s rather than the kit's.

## Open questions

- ~~**Does Tag Input replace `json` for every `String[]`, or only one that declares it?**~~ **Answered 2026-10-09 (`FJS-D804`): A — every scalar list, with no new component: `case 'array'` answers a list with `items` as `MultiSelect` with `allowNew` and no options, and the Tag Input behaviors (comma, paste) are added to MultiSelect.**
  The `case 'array'` comment's reason — the schema stops describing the value — does
  not hold for an array of strings.
  - **A** — every scalar list, with no new component: `case 'array'` answers a
    list with `items` as `MultiSelect` with `allowNew` and no options, and the
    Tag Input behaviors (comma, paste) are added to MultiSelect.
  - **B** — every `String[]` gets a new `TagInput` component.
  - **C** — only a column that declares it gets one; the rest stay `json`.
  - **Recommend A** — A is what ships in `sierra/src/resource/field-rules.js`
    `case 'array'`, which already stopped answering `json` for a scalar list.
    What remains is MultiSelect learning comma and paste, not a second control
    for the same value.
- ~~**Is Toggle Group a `RadioGroup` treatment rather than a component?**~~ **Answered 2026-10-09 (`FJS-D805`): A — no component: a lone toggle is `Button` with `pressed` (`aria-pressed`), single-select is a segmented treatment of `RadioGroup`, and multi-select is the same treatment over a row of checkboxes.** Single-select
  Toggle Group is radio semantics; multi-select is not.
  - **A** — no component: a lone toggle is `Button` with `pressed`
    (`aria-pressed`), single-select is a segmented treatment of `RadioGroup`, and
    multi-select is the same treatment over a row of checkboxes.
  - **B** — a `ToggleGroup` component of `aria-pressed` buttons with a
    `multiple` prop.
  - **Recommend A** — native inputs bring the keyboard, the form value and the
    a11y with them, and the look is a treatment, which is how Invariant 13 says
    a variant is spelled. B rebuilds radio and checkbox semantics on buttons and
    adds a noun the kit does not need.
- Gauge or Meter? Sivir's word is the ecosystem's; `<meter>` is the platform's and
  carries the thresholds. Choosing is a naming decision (*familiarity vs. precision*).
  - **A** — `Gauge`, a new radial component.
  - **B** — `Meter`, a new radial component over `<meter>`.
  - **C** — `Meter` over `<meter>`, replacing `Bar`, with radial as a shape of it.
  - **Recommend C** — `Bar` is already this component (*how full is this*, CPU
    and memory and disk) built on `<progress>`, the element for task completion,
    so a screen reader announces a disk as a task. One component on the
    platform's element with the platform's word, and the drawing is a treatment.
- ~~**Does the kit ship an `Icon`?**~~ **Answered 2026-10-13 (`FJS-D951`): A — no `Icon`. The set is each app's own.** Raised by `docs/mesa-usage-audit-2026-10-12.md`
  § 3.12: five local `Icon.mesa`, in two lineages. One is a three-line `<svg>`
  over an app's own Heroicons path table (ela, then copied into maidtech and
  sstime); the other is a path table inline (serpgrid, quo). The parts that
  fail silently are the size (an unsized `<svg>` draws at 300×150) and
  `aria-hidden`, and `@frontierjs/css`'s `.icon` already handles the size. Its
  README § Icons says the package ships no icons.
  - **A** — no `Icon`. The set is each app's own.
  - **B** — a wrapper only: `<Icon paths>` carrying `.icon` and `aria-hidden`,
    with the set still the app's.
  - **C** — a wrapper plus a shipped outline set (Heroicons, MIT).
  - **Recommend A** — B saves three lines and adds a noun. C is *batteries vs.
    smallness*, already decided for smallness in css § Icons, and a set the
    kit picks is a set every app restyles around. The copies agree with each
    other, so nothing is drifting.
- ~~**What does an app shell own, and is it the kit's?**~~ **Answered 2026-10-13 (`FJS-D952`): A — a paper first (`IDEAS/app-shell.md`), then a kit `Shell` over `frame.css` reading a `nav.js` contract.** Raised by the same
  audit, § 3.11. Every app rewrites `_module.mesa`, and the nav table is
  spelled six ways: sstime `lib/shell/nav.js`, serpgrid `NAV`, portal `MORE`,
  ela and maidtech `nav.js` with `sectionFor`/`tabsFor`, and basecamp and
  example, where the nav list is also the ⌘K palette. `frame.css` ships the
  layout and has no Mesa component (§ Maybe, *Sidebar*).
  - **A** — a paper first (`IDEAS/app-shell.md`). It surveys the six nav
    shapes and proposes a `nav.js` contract (groups, section tabs, bare
    prefixes, drawer copy), then a kit `Shell` over `frame.css` that reads it.
  - **B** — the scaffold's `_module.mesa` and a `nav.js` become the contract,
    and the kit gets no component.
  - **C** — nothing. A shell is the app's.
  - **Recommend A** — two apps already feed one table to both the nav and ⌘K,
    so there is a real shared shape. It is too large to coin inside a kit
    step, and B can follow A as the generator's half of the same contract.
