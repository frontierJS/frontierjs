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
| Data | open |  |  |
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
| Studio | open |  |  |
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
