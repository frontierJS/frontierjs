---
id: filter-controls
status: proposed
dated: 2026-10-28
---

# Plan — FilterBar draws each filter with the control its kind deserves

`<FilterBar>` already knows what every filter ASKS — `filterOpFor(display)`
answers `range`, `set`, `exact` or `text` (`FJS-D246`: a filter is a second
binding on `displayFor`'s names). What it draws for each is the plainest box
that works: two native date inputs for a day range, a Yes/No dropdown for a
boolean, a `MultiSelect` over every row of a related table. Nothing new is
declared in the schema; each step changes only what an existing kind renders.

## Phase 1 — Typing does not push a history entry per key

- [x] 1.1 `tethered().apply` debounces a change confined to `contains` filters
  the way it debounces `$search`, replacing the history entry. A Name box typed
  into was a navigation and a fetch per keystroke.

## Phase 2 — Ranges are one control

- [x] 2.1 A day range over a `Date` or instant column is an operator — *after*,
  *before*, *between* — beside one `DatePicker`: a single picker writing `gte`
  or `lte`, or `isRange` writing both. The operator is read back off which
  bounds the query holds, so nothing else is stored, and `DatePicker` does not
  change. Converted at the edges by the existing `dayToInstant`/`instantToDay`;
  an `@time` clock keeps its two time boxes. Presets write absolute days (2.4).
- [x] 2.3 A `number` or `scale` range is one `RangeInput` — a single bordered
  pill, `Label  [min] – [max]`, committing on `change`. Money reuses its shell
  with `readMoney`/`showMoney`.
- [ ] 2.4 Ruling: does a relative preset (*last 7 days*) travel in the URL as
  itself? An absolute day goes stale in a bookmark; a relative one is a value
  `@frontierjs/toolbelt/query` would have to learn. Owed before it is built.

## Phase 3 — One click where it was two

- [ ] 3.1 A boolean is a three-way segment, `Any | Yes | No`, drawn with
  `@frontierjs/css`'s existing `.field-row.segmented` — no new component.
- [ ] 3.2 An enum with few members is a row of chip toggles built from the
  kit's `Tag`/`Pill`, several on at once; past the cutoff it stays a
  `MultiSelect`. The cutoff is one named constant beside `filterOpFor`, and a
  ruling.

## Phase 4 — A relation is searched, not listed

- [ ] 4.1 A `relation` filter is an async combobox, picks shown as chips. The
  kit peers only on mesa and css, so it never calls a service: the page or the
  tether hands it a `search(term)` per relation (`$search` under `@@fts`, a
  `contains` on the field `labelFieldFor` names otherwise, with a `$limit`).
  The `options` prop becomes a seed rather than the whole list.

## Phase 5 — Asking for the empty

- [ ] 5.1 Probe: does toolbelt's query parser take a null test off the URL.
- [ ] 5.2 An optional column offers `Any / Has value / Empty` — which also
  gives a `file` or `json` column the one filter that means something on it.

## Phase 6 — The bar holds a few, the rest are added

- [ ] 6.1 The first ranked filters draw inline; the others are behind
  `+ Filter`, and each active one is a removable chip.

## Open questions

- ~~**Q1 — How a day range asks for an open end.**~~ **Answered 2026-10-28 (`FJS-D1576`): A — an operator beside the picker: *after* and *before* draw a single picker, *between* an `isRange` one. Notion, Airtable and Linear filter dates this way, and `DatePicker` does not change.** A filter asks *since the 1st*
  and *until the 7th* as often as *between*; a click-start, click-end picker
  has no spelling for an end alone.
  - **A** — an operator beside the picker: *after* and *before* draw a single
    picker, *between* an `isRange` one. Notion, Airtable and Linear filter
    dates this way, and `DatePicker` does not change.
  - **B** — an `openEnded` prop on `DatePicker`: the first click is applied as
    *from*, a second closes the range. *Until* is reachable only by a preset.
  - **C** — two single pickers, from and to: today's layout with the kit's
    picker. No span is highlighted and it is still two controls.
  - **Recommend A** — the open end is a QUESTION the filter asks, so it is the
    bar's to draw, and a picker prop for one caller is a mode on a 1,448-line
    component.
