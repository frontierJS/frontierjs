---
id: filter-controls
status: shipped
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
  an `@time` clock keeps its two time boxes. Presets are relative (2.4).
- [x] 2.3 A `number` or `scale` range is one `RangeInput` — a single bordered
  pill, `Label  [min] – [max]`, committing on `change`. Money reuses its shell
  with `readMoney`/`showMoney`.
- [x] 2.4 Ruling (Q2): a relative preset (*last 7 days*) is stored in the URL as
  `@today-6`..`@today` and resolved in the client before the request (`FJS-D1601`).
- [x] 2.5 `resolveDayTokens` in `toolbelt/query` is passed `today`, the zone
  and each column's kind, and rewrites only date and instant columns — an
  instant bound to the day's first or last moment, a bare day to its window.
  `tethered.js` calls it on the REQUEST, not in `currentQuery()`, so
  `list.query` keeps the token for 2.6 to read back; `resource.js` hands it the
  kinds. `FJS-1978` closed with it: `FilterBar` and `tethered()` both take
  `timeZone`. `readDayToken`/`dayToken` are the spelling's one owner.
- [x] 2.6 `DayRangeFilter` presets write the token and read it back as the
  preset's name, not *between X and Y*. The presets are operators in the same
  menu — *today*, *in the last 7 / 30 days*, *in the next 7 days* — each end
  counting today, so *the last 7 days* is `@today-6`..`@today`. A preset draws
  no picker; leaving one clears it. `FilterBar` passes a token across an
  instant column untouched, and a hand-typed token shows as *3 days ago*.
- [x] 2.7 `FJS-3583`: a non-date string compared against a `Date` or
  `DateTime` column is refused by name in litestone's `buildWhere`, so a
  leaked token fails loudly and every caller gets the 400, not only HTTP.

## Phase 3 — One click where it was two

- [x] 3.1 A boolean is a three-way segment, `Any | Yes | No`, drawn with
  `@frontierjs/css`'s existing `.field-row.segmented` — no new component:
  `RadioGroup layout="segmented"`, the column's name muted beside it.
- [x] 3.2 A declared enum of six members or fewer is a row of toggles, several
  on at once — `.btn` with `aria-pressed`, the column's name muted beside it;
  past the cutoff it stays a `MultiSelect`. The cutoff is `CHIP_LIMIT` in
  `FilterBar.mesa` (`FJS-D1583`); a `@values` binding never chips.

## Phase 4 — A relation is searched, not listed

- [x] 4.1 A fetched column — a relation, a `@values` binding, a to-many
  through its join — is a `MultiSelect` seeded with the first page and searched
  as typed, picks shown as chips. The kit never calls a service, so the ENTRY
  carries the asking: `resource.filters()` binds `optionsFor({ search, record })`
  to `resource.options(name)`, `Form.mesa`'s seam one surface along, and no
  caller changes. What a search matches is `options()`' choice, not the bar's;
  a held pick past the first page arrives labeled through `record`. A page's
  `options` prop still wins.

## Phase 5 — Asking for the empty

- [x] 5.1 Probe: does toolbelt's query parser take a null test off the URL.
  **Yes, end to end.** `?dueAt=null` parses to `{ dueAt: null }` and
  `?dueAt[not]=null` to `{ dueAt: { not: null } }`, both round-trip, and a
  literal `"null"` string is quoted; junction parses through the same
  function, and litestone answers `IS NULL` / `IS NOT NULL` on a `DateTime?`,
  `String?` and `Json?` column. Two things 5.2 must respect: `FilterBar`'s
  `write()` reads a bare `null` as *clear*, so *Empty* writes the object form
  `{ equals: null }` (`eq` is refused by name); and a `String?` holds `''` and
  `null` as two answers. A `null` inside `in`/`notIn` is answered wrong —
  `FJS-3580`.
- [x] 5.2 An optional column offers `Any / Has value / Empty`, placed by its
  control (`FJS-D1594`). An optional `json` or `file` column — offered nothing
  else — is `kind: 'empty'` in sierra's `filters()` and draws the segment; a
  nullable day range's operator menu gains *is empty* and *has value*. *Empty*
  writes `{ equals: null }`, *Has value* `{ not: null }`, and a hand-typed
  `?x=null` reads as *Empty*. Text, number and set columns get theirs from
  6.1's operator menu, where a `String?`'s *Empty* is `null` or `''`
  (`FJS-D1593`) and the empty-test pair moves to one owner before a third copy.

## Phase 6 — The bar holds a few, the rest are added

- [x] 6.1 The first 3 ranked filters draw inline; the others are behind
  `+ Filter` and draw as a removable chip once added, or once the query holds
  them (`FJS-D1596`). Every nullable text, number and set control, inline or
  a chip, carries an operator menu with *is empty* and *has value*
  (`FJS-D1595`). On a `String?` those are `{ in: [null, ''] }` and
  `{ notIn: [null, ''] }`, one key per column, which needed `FJS-3580` closed;
  the pair's one owner is `@frontierjs/toolbelt/query`'s `emptyTest` /
  `emptyTestOf` (`FJS-D1597`).

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

- ~~**Q2 — Does a relative preset (*last 7 days*) travel in the URL as itself?**~~ **Answered 2026-10-28 (`FJS-D1601`): B — the token is stored in the URL and resolved in the client.** (2.4)
  The page URL is `page.query`, which `tethered()` sends to the server as it
  is. A preset written as absolute days goes stale in a bookmark. A relative
  one is a value that something with a clock has to resolve, and toolbelt has
  no clock. Every product checked works the range out inside its query engine:
  Grafana `from=now-6h&to=now`, Kibana `_g=(time:(from:now-3h,to:now))`,
  GitHub Projects `updated:>@today-1w` and `@today..@today+7`, Jira `-7d`
  (rolling) beside `startOfDay(-7)` (calendar, zone-aware), PostHog
  `date_from` taking `-7d` or an ISO date in the same field.
  - **A** — absolute only. A preset writes today's days and the bookmark keeps
    them. Nothing new, and the bar reads a preset back as *between X and Y*.
  - **B** — the token is stored in the URL and resolved in the client. The URL
    holds `@today-7`. The request `tethered.js` builds resolves it
    to days or instants (the viewer's zone, or the `timeZone` prop of
    `FJS-1978`) through a pure `toolbelt/query` resolver that is passed
    `today`. The server never sees a token. The resolver rewrites only date
    and instant fields, so a text filter on the literal `@today` passes
    untouched. A token that leaks fails loudly (`FJS-3583`).
  - **C** — the token is part of the filter grammar from end to end. The
    server resolves it at the Data boundary in an app or account zone, so
    exports, API callers and cron digests get it too. It needs a server-side
    zone that does not exist yet, and a second converter beside the client's
    `dayToInstant`.
  - **Recommend B** — the bookmark stays fresh and the client already owns
    turning a day into an instant. `FJS-D71` already rules that a saved view
    is a URL, which removes C's main gain. Reopen for C when a second caller
    needs a relative range: an export (`FJS-2835`), an API client or a digest.
    Spelling: GitHub's `@today±N`, days only, because the presets are day
    ranges; `@` then needs a `VOCABULARY.md` line beside `$`.
