---
id: boards
status: proposed
dated: 2026-11-08
---

# Idea — Boards: a `<Board>` in the kit, a `resource.board()` beside `list()`, and a boards Rig last

**Status: PROPOSED.** Dated 2026-11-08. Nothing here is built. Raised by the board count in `docs/ui-component-audit-2026-10-15.md` § 5. The keyboard half is ruled already: `FJS-D1026` = A.

## The problem

Every app that shows a kanban has written its own, and none of them comes from the kit.

| App | Board | Lines | Lanes come from | A drop is |
| --- | ----- | ----- | --------------- | --------- |
| serpgrid | `components/Board.mesa` | 88 | the host's `columns` | `onmove({ stageId, order })` |
| ela | `work/StatusLanes.mesa` | 130 | `TaskStatus` rows | a patch of `statusId` |
| ela | `work/BoardLanes.mesa` | 328 | a `Board`'s `List` rows | a move of `Card.listId` + `position` |
| ela | `tasks/lanes/InboxLanes.mesa` | 924 | inbox groups | a patch, and a drop onto a card (`FJS-D1024`) |
| ela | `field/AssignmentBoard.mesa` | 242 | crews | an assignment |
| maidtech | `Kanban.mesa` + `KanbanColumns.mesa` | 239 | a `Board`'s `List` rows | a move of `Card.listId` + `@rank` |
| linear, eventmark | their board, `ChipZone` | — | — | — |

The parts that are already in the kit:

- **The Lane CSS ships**, in `packages/css/src/patterns/lanes.css` with a `--lane-size` token (`FJS-D524`, `FJS-1977`). ela's `work/kanban.css` predates it and still says the kit has no lane.
- **The drag ships** as `dndzone` in `packages/ui/dnd.js`. Three gaps remain: no drag between lanes from the keyboard (`FJS-2659`, now unblocked by `FJS-D1026`), no drop onto an item (`FJS-2004`, ruling `FJS-D1024` open), and no copy mode (`FJS-2818`, ruling `FJS-D1166` open).
- **The schema already says what a lane is** in most of the rows above. A lane is either one value of an enum (with `@@transitions`, a drop is a move, and `resource.transitions(row)` says which lanes take it) or one row of a related model (`TaskStatus`, `List`).
- **Reordering ships** as `resource.move(id, { after, before, into, field })` (`FJS-D366`), which mints the `@rank` key and refuses on a model that declares none.

Serpgrid's board is already generic, and `resource.list()` (`IDEAS/shipped/list-controller.md`) set the split this needs: the controller is Sierra's and the markup is the app's or the kit's.

## The shape

There are three layers. Each one is useful without the next.

- **`<Board>` in `@frontierjs/ui`**: a Kit component, built from serpgrid's `Board.mesa`. It takes `lanes: [{ id, name, tone, items }]`, a `card` snippet and `onmove({ laneId, order })`, and renders with `.lanes`/`.lane` and `dndzone`. Its data comes in props, so it has no idea where the data lives, and `@frontierjs/ui` still takes no dependency on Sierra.
- **`resource.board(field)` in Sierra**: the binding, beside `list()`. It reads the field's schema:
  - an enum gives one lane per value, and with `@@transitions` a drop calls the transition (a field with both a transition and a relation takes the transition);
  - a relation gives one lane per related row, and a drop patches the field;
  - a model with `@rank` reorders through `resource.move()`, which stays the one writer of a rank key.

  `resource.transitions(row)` only marks the lanes a card cannot reach. The server decides (Invariant 6), and its refusal is what puts the card back and shows the reason. The page passes what `board()` returns into `<Board>`.
- **A `boards` Rig**: `Board → Lane → Card` as a schema fragment, a service, and a resource that renders through `resource.board('laneId')`. It is for an app whose boards are data people create, the way ela's and maidtech's are. Both of those apps model `Board → List → Card` today, ela with `position Int` and maidtech with `@rank`. The Rig waits for the installer (`IDEAS/overview.md` 3.2).

## Open questions

- **Q1 — Where does the schema binding live: a Sierra controller, or a `<Board>` that takes a resource?**
  - **A** — `resource.board(field)` in Sierra, and `<Board>` takes plain lanes. A page that is not over one model (serpgrid's stages, eventmark's roster) uses `<Board>` alone.
  - **B** — `<Board resource={tasks} field="statusId">`: the component reads the schema itself, so `@frontierjs/ui` imports Sierra.
  - **Recommend A** — It is the split `resource.list()` shipped with, for the same reason: every app diverges in the markup and none in the binding. B makes the kit depend on Sierra for one component, and leaves serpgrid and eventmark with no board.

- **Q2 — Is what a drop means read from the schema, or stated as an option?**
  - **A** — Read from the schema: a transition where the field has `@@transitions`, otherwise a patch, and reordering through `resource.move()` only where the model has `@rank`. There is no `drop:` option, and a host that wants something else calls `<Board>` with its own `onmove`.
  - **B** — A `drop: 'move' | 'patch' | 'upsert' | 'copy'` option on `resource.board()`, defaulted from the schema.
  - **Recommend A** — Every row in the table above that has a schema already says which one it is. An option would be a second answer that can disagree with the first. Copy and drop-onto-card wait on `FJS-D1166` and `FJS-D1024`, and they belong to `dndzone`, not to the binding.

- **Q3 — In the Rig, is a board's column model `Lane` or `List`?**
  - **A** — `Lane`, the word `FJS-D524` ruled for a board's column. ela and maidtech rename `List` when they adopt the Rig.
  - **B** — `List`, the word both apps and Trello use.
  - **Recommend A** — One word for one thing. *List* already means the list controller and a list view, so `db.list` next to `resource.list()` would be two senses on one screen. The rename is cheap because nothing has shipped.

- **Q4 — How does the Rig order cards?**
  - **A** — `rank String @rank(scope: laneId)`, which is what maidtech has. ela converts from `position Int`.
  - **B** — `position Int`, renumbered by the service on every move.
  - **Recommend A** — `@rank` is Litestone's declared answer and `resource.move()` (`FJS-D366`) already writes it, so a move writes one row instead of renumbering a lane. B would need a second rank writer in the Rig's service.

## Plan

### Phase 0 — Groundwork

Goal: the drag works from the keyboard, and the board census is measured rather than copied from the audit.
Done when: `packages/ui/test/browser/specs/dnd.spec.mjs` moves an item into another zone with the arrow keys and reads the announcement.

- [ ] 0.1 Keyboard drag between zones in `dndzone`, per `FJS-D1026` = A: the perpendicular arrow hops to the nearest zone of the same type, and an `announcements(event, info)` option. Closes `FJS-2659`.
- [ ] 0.2 Re-read the boards in the table above (linear's and eventmark's included) and fill in the missing cells, so that Q2 is answered against the tree.

### Phase 1 — `<Board>` in the kit

Goal: one board component, used by the app it came from.
Done when: a `board.spec.mjs` browser spec drags with the mouse and with the keyboard, and serpgrid's board pages work on the kit's `<Board>`.

- [ ] 1.1 Move serpgrid's `Board.mesa` into `packages/ui/components/display/Board.mesa` on `.lanes`/`.lane`, renaming `columns`/`stageId` to `lanes`/`laneId`.
- [ ] 1.2 A fixture and `board.spec.mjs` in `packages/ui/test/browser/`.
- [ ] 1.3 serpgrid adopts it and deletes its copy.

### Phase 2 — `resource.board()` in Sierra

Goal: a board over a model's field, with no hand-written lanes.
Done when: an `example/` route shows a board over a model with `@@transitions`, a drop the server refuses puts the card back, and the drive passes.

- [ ] 2.1 `resource.board(field)`: lanes from an enum or a relation, a drop as a transition or a patch, and reordering through `resource.move()` (Q1, Q2). A sierra test pins that `board()` writes no rank key of its own.
- [ ] 2.2 The `example/` route and its drive.
- [ ] 2.3 ela's `StatusLanes` moves onto it, and `work/kanban.css` is deleted for the kit's lanes.

### Phase 3 — The boards Rig

Goal: Board/Lane/Card installed by part, the way `notifications` is.
Done when: ela and maidtech both run their boards from the Rig, and their own `Board`/`List`/`Card` models are gone.

- [ ] 3.1 Diff ela's and maidtech's `Board`/`List`/`Card`. Their shared columns are the fragment; what only one app has (ela's `meta`/`onEntry` bags, maidtech's `isTemplate`) stays in that app.
- [ ] 3.2 `packages/boards`: the fragment, the service and the resource (Q3, Q4). This waits on the Rig installer, `IDEAS/overview.md` 3.2.
- [ ] 3.3 maidtech's `KanbanColumns` and ela's `BoardLanes` move onto it.

## See also

- `docs/ui-component-audit-2026-10-15.md` § 5, the Board family
- `IDEAS/shipped/list-controller.md`, the controller/markup split
- `IDEAS/rigs.md` and `FJS-D630`, the Rig format
- `IDEAS/owed-rulings.md`: `FJS-D1024` (drop onto an item), `FJS-D1166` (copy mode)
