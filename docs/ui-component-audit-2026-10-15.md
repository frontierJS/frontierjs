# UI component audit — 28 apps against `@frontierjs/ui`, 2026-10-15

This is a read-only audit of every `.mesa` file that is neither a route nor a resource. It covers 24 apps in `fjs-prototypes/` plus `example/`, `packages/basecamp`, `packages/haven` and `packages/orion`, about 450 files. It answers three questions:
1. How do the components apps wrote line up with the kit?
2. Which sets belong together?
3. What could be one base with variants?

**Nothing here is filed.** No `FJS-###` rows were opened and nothing is built.

**How it was done:** four agents read the files, one per slice: ela; the business prototypes; example + basecamp + the editor apps; and the kit itself + haven + ksite. Some claims were then checked by running a probe:
- Modal vs Drawer was diffed.
- Tag's class was read.
- The `transitions()` count was taken with `rg`.
- RadioGroup's `segmented` layout was confirmed.

Everything else is an agent's reading, cited by path. Lines marked *(inf)* are the agent's inference, not something it read.

**Read with:** `docs/mesa-usage-audit-2026-10-12.md`, which covers the route layer and missing patterns. Four papers in `IDEAS/` already hold part of this ground: `ui-kit-gaps.md`, `mesa-kit-primitives.md`, `chat-surface.md` Part 5 and `app-shell.md`.

## Verdict

**Kit adoption is good for CRUD chrome.** Across ela, Button is imported 193 times, Alert 121, Pill 56, Form 50 and Cell 49. Apps hand-roll three kinds of thing:
- **Compound screens the kit has no noun for:** a board, a thread, a calendar, a wizard.
- **Kit parts missing one prop:** a status per step in Steps, a DatePicker trigger, a row snippet in Combobox.
- **What the scaffold teaches.**

The kit also carries internal duplicates, and those should be merged before it grows.

**Mesa has no inheritance.** It has slots, snippet props, `{...$attributes}` forwarding and context (`packages/mesa/AGENTS.md:166-216`). So "a general version that can be extended" always means one of two things:
- a base component taking a **variant prop and a snippet**, with thin wrappers that fix the variant;
- a **helper** in `utils.js` beside `drag.js`.

## 1. Merge inside the kit

| Merge | Evidence | Shape |
|---|---|---|
| Modal + Drawer → `Dialog side=` | **Probed:** `Modal.mesa:50-100` and `Drawer.mesa:36-78` differ only in comments | `side` absent means centered. `Shell.mesa:37` imports Drawer |
| Popover / DropdownMenu / ConfirmPanel → `AnchoredPanel` (or an `anchored()` attachment) | Three copies of placement, click-away, Escape and focus return, and they have drifted. Popover uses `document.addEventListener` (`Popover.mesa:68,80,93`) and an unguarded `getBoundingClientRect` (`:72-73`) | Portal to `overlayHost`, sync placement, `mesa:window` click-away. Touches `FJS-D904` |
| `fieldFrom(form, props)` + `optionsFrom(form, name, options)` | The same 9 field props in about 20 controls (`Input.mesa:107-144`, `NumberInput.mesa:70-78`). The option source is copied 4 times (`Select:73`, `Combobox:113`, `MultiSelect:161`, `RadioGroup:70`). There are 3 `normalize()` shapes. The names disagree: `search` vs `asyncOptions`, `items` vs `options` | `IDEAS/mesa-kit-primitives.md` names this; unbuilt. MultiSelect's single mode overlaps Combobox |
| Tag → Pill `onremove` | **Probed:** `Tag.mesa:26` is `.pill.removable` | Delete Tag |
| `AlertBody` under Alert / Callout / Toast / AlertProvider | Four inline icon maps (`Alert:34-39`, `Toast:24-29`, `AlertProvider:30-35`, `Callout:34-40`). Callout's success glyph has drifted to a lightbulb | `announce` picks `role=alert` or `<aside>`. The tone→glyph map moves to `utils.js` |
| Cut the legacy aliases | `color`→`tone` survives in 11 components. `type` survives in Alert and Callout, `variant` in ConfirmationPopover, `icon`→`square` in Button. Toast's `type` comes from `toastStore.js:79` | The evolution policy allows no alias. Cutting them frees the `color` name for data colors (`FJS-1981`) |
| One size scale | `xs` is 0.625rem in Badge, Pill and Kbd, 0.6875rem in Mono, and 0.75rem in Button | A css density/size class |
| Treatment as a word | Card has `raised`/`outlined` (`Card.mesa:27-28`); Callout has `filled` (`:27`), the inverse of the same treatment | `treatment=`, per Invariant 13 |
| DatePicker without a time | `showTimePicker` (`DatePicker.mesa:93-107,568`) is a second instant control with no zone. Its props use a ported dialect: `isRange`, `onDateChange` | Times go through DateTimeInput |
| Bar → `<meter>` | Already an open question in `IDEAS/ui-kit-gaps.md` (recommend C) | — |
| StatCard forwards instead of restating | `StatCard.mesa:18-23,43` re-declares every prop Stat takes | `{...$attributes}` |
| Tabs context | `$context.activeId` and `registerTab` are un-namespaced (`Tabs.mesa:87,95`) *(inf: nesting is fragile)* | `$context.tabs` |

## 2. App code duplicating the kit

| Where | Kit has | Note |
|---|---|---|
| Every app's `routes/_module.mesa` | `layout/Shell` + `ui/nav` | **No app imports Shell.** It shipped 2026-10-13, after the apps. sstime's and maidtech's `lib/shell/nav.js` already match the contract |
| ela `quote-page/SignaturePad.mesa`, `SignatureView.mesa` | the same names in the kit | The kit lifted them from ela. ela still imports its own copies (`routes/quote/index.mesa:41-42`) |
| basecamp `web/src/RelationCell.mesa` | Cell's relation branch (`Cell.mesa:78-81,234-238`) | Its premise at `:4-6` is stale: sierra's `relationLabel()` (`resource.js:1968-1975`) supplies `labelField` |
| darkroom `lib/stage/drag.js` (8 importers) | `@frontierjs/ui/drag` | A copy plus `pointIn(el, e, w, h)`. Move `pointIn` into the kit |
| sstime `clock/RangePicker.mesa`; ela `numbers/RangePicker`, `field/DayPicker`, `SurveyFilters` | the DatePicker range | ela's three wrappers add a default trigger and `YYYY-MM-DD` in and out, which is the missing prop pair |
| notion and linear `lib/rank.js` | `@frontierjs/toolbelt/rank` (`FJS-D366`) | Same exports |
| Segmented toggles in basecamp `WidgetCard:45-48`, charter `Chat.mesa:397` and portal `BookmarkStage:458-460` | `RadioGroup layout="segmented"` (`FJS-D805`, **probed** at `RadioGroup.mesa:16,45`) | — |
| ela `tasks/lanes/InboxLanes.mesa:474` | `createSelection` + `BulkBar` | Its comment cites `FJS-2003`, which is closed. Its siblings already use the kit |
| serpgrid dialogs (`WorkDialog:99-135`, `GroupDialog:61-77`, `StatusDialog:147-215`) | Input, Select, Textarea | Raw `.field` controls inside a Modal with no resource behind them |
| Hand-written `alert danger` in basecamp `LaunchSteps:34` and `VariablesEditor:97`, darkroom ×4, connectteam `Overview:86` | Alert | — |
| example (0 of 13 components import the kit) | Button, NumberInput, EmptyState, Alert | `site/config/vite.config.js:32-41` already aliases the kit |
| ela: `title=` used 25 times in `LaneCard`, 15 in `ColumnRow` | Tooltip | Tooltip is never imported anywhere audited |

## 3. Candidates for the kit, ranked by copies

1. **`<Moves resource row variant="buttons|menu">`**. **Probed: 67 files** hand-filter `transitions(row, level).filter(t => !t.system)`. The scaffold emits it (`packages/cli/core/crud-templates.js:79`), and maidtech alone has 34. sstime's `manage/Moves.mesa` and `StatusMenu.mesa` are the two variants already written. A component plus a scaffold change replaces all 67.
2. **`<Facts resource record only>`**, the read-only twin of `<Form>`, each value drawn through Cell. There are 29 hand-written `<dl>` in basecamp and example routes, plus darkroom `ExportPanel:151`, charter `Map:151` and example `Basket:189`. The email-kit already has the noun as `KeyValue`.
3. **Steps with a status on each step**: complete, active, pending, failed or running, plus a trail snippet. Today Steps infers state from position (`Steps.mesa:48-54`), so basecamp `LaunchSteps:43-57` and charter `Chat:318-329` write `.steps` by hand. Variants of the same base:
   - a **Checklist**: done/total header, `onadd` with multi-line paste. Callers are ela `Subtasks` and `todos/Checklist`, maidtech `TaskSteps`, serpgrid `SystemSetup`;
   - a **Wizard**: Steps + panel + Back/Next + `?step=`. The caller is charter `new/index.mesa:613-628`.
4. **Messaging family** (`FJS-2810`, `IDEAS/chat-surface.md` Part 5) has three parts:
   - **`Transcript`**: follows the newest message unless the reader scrolled up; day breaks; author runs; a `mine` predicate; a row snippet; layout `bubble|post`.
   - **`Composer`**: Enter sends, Shift+Enter breaks a line. Trigger pickers take `{'@': people, '/': commands}`.
   - **`ConversationList`**.

   Copies:
   - ela: `support/Transcript` and `TicketNotes`, which re-implements the follow logic;
   - quo: `Thread`;
   - maidtech: `Thread`;
   - serpgrid: `PostList`, `ThreadPane` and `Composer`, 336 lines;
   - chatwoot: `ChatWidget`.

   Enter-to-send is written 4 times in ela alone. Composers use a raw `<textarea>` because the kit Textarea does not expose the element or the caret.
5. **Board family**, about 9 boards in all:
   - ela: `BoardLanes`, `StatusLanes`, `InboxLanes` and `AssignmentBoard`;
   - serpgrid: `Board`;
   - maidtech: `Kanban`;
   - linear: its board;
   - eventmark: `ChipZone`.

   serpgrid's `Board.mesa:19-24` is already generic: `columns`, a `card` snippet and `onmove`. ela's `work/kanban.css` says ".lane is not a kit term". Variant axes:
   - what a drop means: move, patch, upsert or copy;
   - whether lanes reorder;
   - accent;
   - lane header snippet.

   Blocked in part by drop-onto-card (`FJS-2004`) and by the lack of a keyboard path (transit `LayoutEditor:16-17`).
6. **Calendar month/week** (`FJS-2826`): eventmark `MonthGrid` (234 lines), calendly `Booking:58,128`, sstime `.week`. Display vs picker (`enabledDates`).
7. **`IssuedSecret` + write-only `SecretInput`**. Issued secrets, which are issued, shown once, copied, withdrawn and re-issued: serpgrid `SharePanel`, `ClientShare` and `PartnerSettings`; maidtech `PortalAccess`; sstime `ElaLinkSetup`; notion `ShareDialog`; ela's quote share. The write-only `@encrypted` input, which shows "set" and keeps the value when left blank: serpgrid `DataforseoSettings`, sstime `TextingSetup`.
8. **`Rating`**, read-only or input, with `iconSet` and `max`. Copies: ela `Stars`, `survey/Rating` and `ScaleIcon`; ksite `Stars`; email-kit.
9. **Props on parts that exist:**
   - Combobox: a row snippet (`FJS-2673`; quo `NewConversation:110-130`, ela `MergePicker`, `AddToTicket`, `ContactSearch`).
   - Drawer: non-modal (`FJS-2811`; ela `SupportWidget`, `TicketDrawer`) and a swipeable bottom sheet (remnant `Sheet`).
   - Form: a schema-only `Fields` with no resource (orion `NodeInspector:20-28`, transit `ParamFields:24-33`).
   - A row repeater for `[{…}]` (basecamp `VariantsEditor`).
   - ela `ScaledInput` registered as the kit's `@scale` control.
   - `HtmlFrame` (`FJS-2672`).
   - A data color on Pill, Dot and Tag (`FJS-1981`; 6 copies in ela, linear's board). This waits on the alias cut.
   - A segmented `Bar`, the 4-bar signal in ela `LaneCard:121-123`.
   - `Thresholds` with pre-binned counts, for darkroom `LevelsBars` *(inf)*.
10. **One app each, so hold until a second appears:**
    - an activity `Feed` (ela `Activity` + `ClientActivity`);
    - a `RecordPage` aside + ribbon (ela; `FJS-2686`, `FJS-2687`);
    - a `NoRecord` (basecamp);
    - a `BulkPanel` that edits N records (ela);
    - a dashboard tile/grid/body registry (basecamp `Widget`/`WidgetCard`, transit `Dashboard`/`LayoutEditor`).

## 4. Belongs outside the kit

- **Phone softphone:** quo and serpgrid are a near copy (`phone.js` differs only in storage keys). It belongs in a Telnyx connector or rig.
- **SupportBanner:** basecamp and ela, nearly identical. It belongs beside `client.auth.endSupport`, taking `session` and `onend`.
- **Bell:** ela. It belongs in `@frontierjs/notifications`.
- **Live reconcile:** example `LivePrices`, `LivePlans` and `LiveStock`, one machine. It belongs in sierra or site.
- **Viewport `zoomAt` + `pointIn`:** wheel-zoom-about-pointer is written four times (orion `FlowCanvas:132`; darkroom `Stage:153`, `CardStage:49`, `BeforeAfterStage:65`). It belongs in helpers beside `drag.js`. orion `FlowCanvas:90-130` also hand-writes the drag gesture.
- **Site blocks:** ksite's Features, Services, Process and Reviews differ only by glob, name and item class (`layouts/Services.mesa:20-28`). They are one `<Collection>` with an item snippet. Button, LeadButton, BookingButton and PhoneButton are one settings-backed link. `IDEAS/site-kit-structure.md:119-143` gates moving these on a second consumer, and that gate has not fired.
- **email-kit drift:**
  - It takes colors where the kit takes tones (`email-kit Button.mesa:6-7`, `Card.mesa:3-6`), against Invariant 13.
  - Its columns use `key` where the kit uses `name` (`DataTable.mesa:2` vs `Table.mesa:67`).

  Aligning both would let one report file switch kit by target (transit `RevenueReport.email.mesa:13-19`). print-kit ships no components: print is the screen template plus `@page`. The 13 maid report fixtures use Tailwind with hex colors and import nothing.
- **haven:**
  - It imports no kit component and needs none. `Scene.mesa` (`FJS-D997`) is the right base.
  - Its panes (Notices, History, Scores, WorldMap, Barkeep) could share a haven-local `Pane` *(inf)*.
  - `commands.js`'s mode rule is exactly the owner `FJS-D904` lacks: one overlay open, and Escape belongs to it.

## 5. Kit defects seen on the way (unfiled, unprobed)

- A `data-confirm` on a `DropdownItem` runs nothing: the confirming click counts as a click-away and unmounts the row before the provider re-fires it. Inside a `Drawer`, the confirm panel portals under the top layer and is inert. ela works around both with Modal (`routes/boards/[id].mesa:55-56`, `work/BoardLanes.mesa:147-152`).
- A Drawer mounted with `open` already true is noted at ela `TicketDrawer.mesa:12-14`. The same shape for Modal is in the 2026-10-10 kit audit. Re-probe before filing: `Drawer.mesa` now carries an `onMount` call for it.
- Popover is likely unsafe on the terminal target *(inf, § 1)*.

## 6. Settled — not reopened

- **Icon (`FJS-D951`, no kit Icon).** This audit counts 6 to 8 local icon components. Only ela, maidtech and sstime share one implementation; basecamp `NavIcon`, charter `StepIcon` and portal `SiteIcon` are different things. Two agents proposed `registerIcons(map)`, which is option B, already declined.
- **Map** is `FJS-D327`. **Tag Input** is `FJS-D804`. **ToggleGroup** is `FJS-D805`, now RadioGroup `segmented`.

## Next, if taken up

### Phase 0 — Merge the kit's own duplicates

Goal: one owner for each overlay and field behavior before new components land on them.
Done when: ui's `bun run test` and example `verify` are green with no alias left.

- [ ] 0.1 Modal + Drawer → `Dialog side=`
- [ ] 0.2 Tag → Pill `onremove`; cut the legacy aliases
- [ ] 0.3 `AnchoredPanel` under Popover, DropdownMenu and ConfirmPanel (needs `FJS-D904`)
- [ ] 0.4 `fieldFrom` + `optionsFrom`

### Phase 1 — Highest-copy new pieces

Goal: components that replace generated or copied code.
Done when: the scaffold emits them and one app per piece is moved over.

- [ ] 1.1 `<Moves>` + `crud-templates.js:79`
- [ ] 1.2 `<Facts>`
- [ ] 1.3 Steps status per step → Checklist and Wizard variants

### Phase 2 — Families

- [ ] 2.1 Messaging (`FJS-2810`)
- [ ] 2.2 Board (from serpgrid `Board.mesa`)
- [ ] 2.3 Calendar (`FJS-2826`)

Each new noun goes through `decision-rules` first.
