# Vocabulary

**The words this framework defines, and what each one is.** Authored — this is
the half no scan can produce. `fli ws:terms` reads it and joins each row to
what the tree actually does with the word, so a term is defined in exactly one
place and measured somewhere else.

**Only real vocabulary belongs here.** A word that is not a term of this
framework — a tool, a place, ordinary English — is not labelled here; it is
excluded in `packages/cli/core/terms.js`, where the classifier can act on it.
A row saying *this is not a term* would be a second way of saying what a list
over there already says, and nothing would read it.

## Status

| Status | Means |
| --- | --- |
| `blessed` | use this word. The definition column is the definition |
| `refused` | never use it — **Means** names the word to use instead |
| `alias` | the same thing as another term — **Means** names it |
| `open` | seen and not yet decided. The seeded default |

`ARCHITECT.md` § 2 is the doctrine and stays prose; a term ruled there carries
`blessed` here with the same meaning. Where the two disagree, § 2 is right and
this file is stale.

**This is the root register and not the only one.** A package that defines its
own terms well enough to CHECK them has named them, and `fli ws:terms` reads
those registers rather than asking anyone to copy them here —
`@frontierjs/css/vocabulary.json` is 56 terms and 8 axes, each graded against
the real CSSOM by that package's own spec. A row here outranks one there, with
one exception that is the point: **`open` is not an answer**, so a word this
file has merely seen does not shadow a package that defined it. Those land in
`ws:terms`'s audit instead of being decided by whichever register spoke last,
because most of them are one spelling over two realms — a Table is a `<table>`
in css and a database table in litestone — and what is owed is which sense this
file is naming, not a copy of the other one.

## Terms

Seeded from `fli ws:terms` at spread ≥ 4 — a term used in four or more
packages. Ordered by spread, which is how much of the tree you have to read
before you meet it.

| Term | Status | Means | Note |
| --- | --- | --- | --- |
| Resource | blessed |  |  |
| Observer | blessed |  |  |
| Release | blessed |  |  |
| Hook | blessed |  |  |
| Service | blessed |  |  |
| Plugin | blessed |  |  |
| Provider | blessed |  |  |
| Event | blessed |  |  |
| Channel | blessed |  |  |
| Job | blessed |  |  |
| Component | open |  |  |
| Data realm | open |  | the first of the three — where `data` alone is too generic to be a term |
| Writable derived | open |  | mesa `$: name = expr` — `Writable` alone means nothing |
| Empty state | open |  | the condition a screen is in with nothing to show; `EmptyState` is the component that renders it |
| Data boundary | open |  | where access is enforced; the widest phrase in the tree |
| Invariant | open |  |  |
| WebSocket | open |  |  |
| State | open |  |  |
| PascalCase | open |  |  |
| Phase | open |  |  |
| User | open |  |  |
| Table | open |  |  |
| File | open |  |  |
| Step | open |  |  |
| Card | open |  |  |
| Bearer | open |  |  |
| Web | open |  |  |
| Litestone Studio | blessed | The browser UI `litestone studio` serves — the Data realm read and edited by hand | |
| Studio | alias | `Litestone Studio`. The bare word is shorthand once a page has named it in full |  |
| Popover | open |  |  |
| Tab | open |  |  |
| Homestead | open |  |  |
| Field | open |  |  |
| Host | open |  |  |
| Pill | open |  |  |
| ServiceContext | open |  |  |
| Cancel | open |  |  |
| App | open |  |  |
| Deployment | open |  |  |
| Item | open |  |  |
| Group | open |  |  |
| Int | open |  |  |
| GatePlugin | open |  |  |
| DateTime | open |  |  |
| Pane | open |  |  |
| Badge | open |  |  |
| Drawer | open |  |  |
| Window | open |  |  |
| Alert | open |  |  |
| Structure | open |  |  |
| Switch | open |  |  |
| Combobox | open |  |  |
| Customer | open |  |  |
| Prose | open |  |  |
| DropdownMenu | open |  |  |
| Hub | open |  |  |
| Product | open |  |  |
| Tooltip | open |  |  |
| Order | open |  |  |
| Button | open |  |  |
| Code | open |  |  |
| Access | open |  |  |
| Page | open |  |  |
| Row | open |  |  |
| Block | open |  |  |
| Question | open |  |  |
| Domain | open |  |  |
| Home | open |  |  |
| Lead | open |  |  |
| Rule | open |  |  |
| Suite | open |  |  |
| Float | open |  |  |
| Modal | open |  |  |
| Sidebar | open |  |  |
| Text | open |  |  |
| Tier | open |  |  |
| Account | open |  |  |
| DatePicker | open |  |  |
| Input | open |  |  |
| Progress | open |  |  |
| Create | open |  |  |
| Layout | open |  |  |
| Select | open |  |  |
| Server | open |  |  |
| CommandPalette | open |  |  |
| Pagination | open |  |  |
| RadioGroup | open |  |  |
| Save | open |  |  |
| Cloud | open |  |  |
| Form | open |  |  |
| Search | open |  |  |
