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
| **Tag Input** | free entry of a list of strings — Enter, comma and paste each add, Backspace removes | `controlFor()` answers a `String[]` with no value set as `control: 'json'` (`sierra/src/junction/field-rules.js`, `case 'array'`), so a person editing tags types JSON. `MultiSelect` covers the array only when the values are KNOWN. This is the control that branch should name for an array of strings. Each entry renders as the existing `Tag`, whose header already names tag inputs as a caller |
| **Toggle / Toggle Group** | a button that stays pressed (`aria-pressed`); a row of them with single or multiple selection | list/grid switches and filter chips; `FilterBar` is the first caller. Small |
| **Context Menu** | the actions for what was right-clicked | a trigger, not a menu: it reuses `DropdownItem`/`DropdownLabel`/`DropdownSeparator` and positions at the pointer instead of the trigger's rect. Table rows in Basecamp and Studio |
| **Gauge** | a radial meter for usage against a limit | `Progress`, `Bar` and `Sparkline` ship, nothing radial. Basecamp's fleet readings (disk, CPU, memory) are the caller. The platform's word is `<meter>` (`low`/`high`/`optimum`), which is the semantics and the a11y for free; the radial drawing is the only new part, so the name is open |

## Maybe

- **Hover Card** — a rich preview opened on hover or focus. `Popover` is
  click-triggered only; this is a second trigger on it, not a new component, if the
  popup code `mesa-kit-primitives.md` names is extracted first.
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

- Does Tag Input replace `json` for every `String[]`, or only one that declares it?
  The `case 'array'` comment's reason — the schema stops describing the value — does
  not hold for an array of strings.
- Is Toggle Group a `RadioGroup` treatment rather than a component? Single-select
  Toggle Group is radio semantics; multi-select is not.
- Gauge or Meter? Sivir's word is the ecosystem's; `<meter>` is the platform's and
  carries the thresholds. Choosing is a naming decision (*familiarity vs. precision*).
