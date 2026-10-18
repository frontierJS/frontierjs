---
id: lockdown
status: proposed
dated: 2026-10-15
---

# Lockdown — freezing the developer-facing surface

**Status: PROPOSED. Nothing here is built.** Do not cite this file as describing
behavior — see `VERIFYING.md`.

The pre-beta question was: what does a developer type against, and is it
settled? Five read-only passes answered it on 2026-10-15 — the `.lite` language,
the API realm as an app writes it, the UI realm as an app writes it, `fli` and
the scaffold (a real `fli new` into a scratchpad, then read), and the whole
`@frontierjs/*` export surface side by side. The rows are `FJS-2933`–`FJS-2990`
and the questions `FJS-D1077`–`FJS-D1086`; this paper is the order.

**One finding, many sites: two spellings for one thing, kept side by side.** The
nouns are right — Resource, Service, Model, Gate, Policy, tone — and refusal
messages name the right spelling. The verbs, the call shapes and the scaffold
accreted: three Plugin spellings, two service verbs, three event spellings, two
projection systems, a four-overload `createResource`, a quoted gate on a model
beside a bare one on a move, `dev:api` in the scaffold beside `api` in every app.
The evolution policy already forbids the alias; the work is a deletion pass, then
a few rulings, then the renames those rulings force, then a fresh scaffold read
as the interface it is.

**Done when** `fli new my-app` boots on `fli dev` first try, its `api/src/app.ts`
has at most five `app.configure` lines and no `!`, every spelling in it is the
one the docs teach, and this audit re-run finds no S2.

## What stays as it is

The call model — `ctx` fields, the five hook stages, `methods:` declarations,
the result envelope, the error class table. The `.lite` expression language
(`@@allow` / `@@deny` / `@@scope` / `@required(where:)` share one grammar) and
the protected-field ladder. The port formula, `fli check` as the arch test, one
`app-config.js` owner, `<surface>/config/*.config.js` placement. These were read
and found coherent; they lock as they are.

### Phase 0 — Groundwork

Goal: the surface measured and every finding on the register.
Done when: `fli register:check` is clean over the new rows and `fli decisions`
lists the ten questions with options.

- [x] 0.1 Five realm passes; claims spot-checked against source and `parse()` probes
- [x] 0.2 Scaffold a fresh app into the scratchpad and read its 32 files
- [x] 0.3 File the rows (`FJS-2933`–`FJS-2990`) and the questions (`FJS-D1077`–`FJS-D1086`)

**Done 2026-10-15.** Fifty-four defects, ten questions. Already-open rows the
passes re-found and did not duplicate: `FJS-1140` (kit alias props), `FJS-1130`
(`db:schema` Prisma relic), `FJS-2690` (`@required message:`), `FJS-2430`
(conduit snake_case), `FJS-1868` (README/scaffold service verb), `FJS-1230` and
`FJS-D668` (slot vs snippet), `FJS-1385` / `FJS-1379` (scaffold drift),
`FJS-1870` (three verbs for a schema change), `FJS-D866` (the `Store` word).

### Phase 1 — The deletion pass

Goal: every alias, shim, duplicate and relic that needs no ruling is gone.
Done when: `rg -n "legacy|deprecated|backwards compat|alias for" packages/*/src
packages/ui/components packages/cli/commands` returns only `aliasesOf` (held for
`FJS-2960`'s ruling) and `fli ws:exports` writes a snapshot with one spelling per
subpath.

- [ ] 1.1 Kit prop aliases out: `color`, `type`, `variant`, `icon` and the legacy map in `utils.js tone()` (`FJS-1140`); Button gets `treatment` and loses `variant` (`FJS-2943`)
- [x] 1.2 Duplicate generators out: `api:service`, `api:model`, `web:resource`, `web:route`, `web:component`, `make:schema`, `db:schema` (`FJS-2944`, `FJS-1130`)
- [x] 1.3 Junction back-compat residue out: `skip`, `PaginatedResult`, the compat re-exports, the `junction.call` alias, the `errors.ts` TODO (`FJS-2957`); the `channels:` shim in notifications (`FJS-2960`)
- [ ] 1.4 One spelling per subpath in mesa, ui, config, css; `fli ws:exports` fails a pair (`FJS-2964`); junction drops its 15 internal mirrors and the `/email` footer, orion gains `.` (`FJS-2958`)
- [ ] 1.5 Scaffold truth: `ENCRYPTION_KEY` always written (`FJS-2945`); `make:model` writes the reference's `updatedAt` (`FJS-2952`); `make:component` / `make:resource` lose the false `@/` line, raw hex and `on:click` (`FJS-2970`, `FJS-1379`); `@required`'s catalog entry matches its parser (`FJS-2690`)
- [ ] 1.6 Shipped set: `fli validate` folded into `fli check` (`FJS-2986`); CapRover, SSH and personal-browser commands to the user tier (`FJS-2985`); jetty's five bins (`FJS-2989`); `routes.js` under `.sierra/` and ignored (`FJS-2981`); package descriptions say the realm (`FJS-2988`)
- [ ] 1.7 `$search` / `$scope` into the toolbelt directives table or refused, and one VOCABULARY.md paragraph for `$`'s house senses (`FJS-2934`)
- [ ] 1.8 `fli file --dry` writes nothing and stamps the local day (`FJS-2976`)

### Phase 2 — The rulings

Goal: each two-spellings row has one spelling, chosen and recorded.
Done when: `FJS-D1077`–`FJS-D1086`, `FJS-D668` and `FJS-D866` are closed by
`fli decide` and the recommendation column below is empty.

- [x] 2.1 `FJS-D1077` factory grammar (holds `FJS-2938`, `FJS-2953`)
- [x] 2.2 `FJS-D1079` one service verb (holds `FJS-2937`, `FJS-1868`)
- [x] 2.3 `FJS-D1080` one root on `createApp` (holds `FJS-2939`, `FJS-2975`)
- [x] 2.4 `FJS-D1078` one event spelling (holds `FJS-2941`) — ruled C: `onclick={fn}` everywhere, the pipe modifiers kept on the DOM name
- [x] 2.5 `FJS-D668` slot vs snippet (holds `FJS-2942`, `FJS-1230`) — ruled D: `slot=` is compile-time sugar for a snippet with no arguments, snippets the one runtime system
- [ ] 2.6 `FJS-D1081` one gate literal (holds `FJS-2936`); `FJS-D1082` bare policy ops (holds `FJS-2947`)
- [ ] 2.7 `FJS-D1083` one script table and `FJS-D1084` one front door (hold `FJS-2946`, `FJS-2944`'s sibling `FJS-1870`)
- [ ] 2.8 `FJS-D1085` how an app mounts; `FJS-D1086` the implicit default form
- [ ] 2.9 `FJS-D866` the `Store` word (holds `FJS-2967`)

### Phase 3 — The renames the rulings force

Goal: every app in the tree — example, basecamp, haven, the scaffold — on the one
spelling, in the same change as the rename, nothing kept for the old one.
Done when: `bun run ci` green, `fli check` carries a rule for each row below, and
the three `verify:*` drives `fli proves --from main` names have run.

- [x] 3.1 Service verb across example (×36), basecamp (×42), haven, scaffold; loader drops the `create*Service` factory-name rule (`FJS-2937`) — definition only, a function default refused (`FJS-D1079` amended); `fli check` rule `service-definition`; left over: `FJS-2995`
- [ ] 3.2 Plugin names to the ruled grammar; `define*` to one spec-object shape, `defineJob` stops restating the filename (`FJS-2938`, `FJS-2953`); `auth({ auth })` schedules its own cleanup jobs, so no app writes the inline plugin (`FJS-1893`)
- [ ] 3.3 `createApp({ root })`; `autoload`, `jobsDir`, `notifications`, `configPath` gone; the port read once by junction from the broker var (`FJS-2939`, `FJS-2975`, `FJS-2974`); `createApp`'s bag reduced to `db|tenants, auth, principal, system, config, root` (`FJS-2954`)
- [x] 3.4 `app.<slot>` typed present, an unconfigured read throwing the plugin's name; the scaffold ships no `!` (`FJS-2940`) — built: `APP_SLOTS` + the slot guard in junction's `core/app.ts`, `'slot' in app` the presence test
- [x] 3.5 Event spelling: compiler refuses the other two by name; `make:component`, VISION rule 23, ui README agree (`FJS-2941`) — built: `eventAttribute` in `compiler.js` is every reader's answer; a guard or timer modifier on a component wraps the value, a listener option is refused there; 1,680 `on:` in `.mesa` rewritten (596 workspace, 1,084 prototypes) plus 477 in tests and docs
- [x] 3.6 One runtime system: the compiler lowers `slot=` / `<slot>` to snippets with no arguments; `attachNamedSlotLegacy`, `makeSlots` and Form's hand fallback deleted; `slot=` with arguments refused naming the snippet form (`FJS-2942`, `FJS-1230`, `FJS-D668`) — built: `lowerSlots` in `compiler.js`; a written prop beside same-name content is the override; residue (`__block`, sierra's own `<slot />` rewrite) is `FJS-3149`
- [ ] 3.7 `createResource('products', opts?)` and nothing else; `client.resource` internal (`FJS-2933`, `FJS-2967`); `resource.list()` the one URL-driven list, `store`/`load`/`stale`/`more` its internals (`FJS-2968`)
- [ ] 3.8 Gate literal (`FJS-2936`) — digits-only moves landed with `FJS-2935`; bare policy ops and the comma-combo's deletion landed with `FJS-2947`
- [ ] 3.9 Script table written by `app-config.js`, the three apps moved to it, `fli dev` the printed door, `utils/dev.md` → `dev/index.md` (`FJS-2946`, `FJS-2944`)
- [ ] 3.10 `mount` per `FJS-D1085` in every `main.js` and the scaffold; implicit default form per `FJS-D1086`, the 76 markup halves deleted
- [ ] 3.11 One principal: `ctx.principal` on both contexts, one id key, `app.runAs(null)` documented as the system path (`FJS-2955`); `ctx.raw`, internals behind a symbol, one of `$.db` / `locals.db` (`FJS-2956`)
- [ ] 3.12 Auth callbacks: one event object each, `on*` observer / `can*` guard, one of `onRegister` / `onRegistered` (`FJS-2961`); one verb set at both layers and one token option name (`FJS-2969`)
- [ ] 3.13 `init*` / `configure*` split by side effect, analytics picks one (`FJS-2962`); `register*` one shape beside `claim` (`FJS-2963`); litestone's `Plugin` class renamed for its host (`FJS-2965`); duplicate export names qualified and graded by `fli ws:exports` (`FJS-2966`)
- [ ] 3.14 `apiPrefix` read from `junction.config.js` by sierra and the proxy (`FJS-2971`); configs carry live keys only, `frontier.config.js` written only with `--server` / `--domain` (`FJS-2972`); deps pinned to the CLI's own version (`FJS-2973`)
- [ ] 3.15 Conduit's descriptor camelCase (`timeoutMs`, `registeredAt`), and the registry-stamped fields off a target declared as a literal (`FJS-2430`)

### Phase 4 — Schema seams

Goal: a structural rule of the language refuses at `parse()`, and a wrong
spelling is answered with the right one.
Done when: the reference's *shapes that parse and fail later* list is exact, and
the 22 bad-schema probes from Phase 0 each get the message the row asks for.

- [x] 4.1 Gate order and model case refuse in `parse()` (`FJS-2948`)
- [ ] 4.2 The schema-function branch only for a declared `function`; a typo'd attribute gets *did you mean* (`FJS-2949`, `FJS-2977`)
- [ ] 4.3 `scope` (exclusion key) renamed away from `@@scope` (`FJS-2950`); a move word of its own or the overload documented once (`FJS-2951`)
- [ ] 4.4 Named keys for every optional operand, positional only for the required one (`FJS-2978`); migration verbs off the main barrel (`FJS-2979`)
- [ ] 4.5 The eight open `@@transitions` and access gaps ruled additive-or-not before the word is called locked: `FJS-2801`, `FJS-1971`, `FJS-2435`, `FJS-2920`, `FJS-1815`, `FJS-2035`, `FJS-1745`, `FJS-2289`

### Phase 5 — Re-scaffold and re-read

Goal: the fresh scaffold is the interface, and it reads as designed.
Done when: the five Phase 0 passes re-run over the new scaffold and the three
apps find no S2, and the surface is declared frozen in `DECISIONS.md` with the
list of what a later change to it must do.

- [ ] 5.1 `fli new` into a scratchpad; count `configure` lines, `!`, `apiPrefix` literals, comment ratio; `fli dev` boots first try
- [ ] 5.2 Re-run the five passes; file what remains; close this paper
- [ ] 5.3 Command taxonomy, alias styles, flag syntax, env names (`FJS-2982`, `FJS-2983`, `FJS-2984`, `FJS-2974`) — after the surface above, since each is a rename across the command tree
- [x] 5.4 Docs regenerated from code where a table lagged it: sierra routing (`FJS-2980`), jetty's nouns into VOCABULARY.md or out (`FJS-2990`)

## Open questions

- ~~**FJS-D1077 — What is the one factory grammar?**~~ **Answered 2026-10-16 (`FJS-D1077`): A — `createX(opts)` builds a thing you hold; `defineX(spec)` states a declaration the framework reads, one object argument, the name from the file or `spec.name`; a Plugin is a bare noun `x(opts)` because `app.configure(…)` already says *plugin*; a dependency goes in opts (`auth({ auth })`, `mail({ mailer })`), never positional. Renames: `manifestPlugin→manifest`, `metricsPlugin→metrics`, `exportPlugin→exporter`, `healthPlugin→health`, `notificationsPlugin→notifications`, `mcpPlugin→mcp`, `printerPlugin→printer`, `createAuthPlugin→auth`, `mailerPlugin→mail`, `createCaravan→caravan`, `backfills→backfill`.** Today: ~30 `createX(opts)`, 12 `defineX` (two positional-name, four spec-object), 7 `xPlugin(opts)`, 9 bare-noun `x(opts)`, 2 `createXPlugin(dep, opts)`. No ruling names a convention.
  - **A** — `createX(opts)` builds a thing you hold; `defineX(spec)` states a declaration the framework reads, one object argument, the name from the file or `spec.name`; a Plugin is a bare noun `x(opts)` because `app.configure(…)` already says *plugin*; a dependency goes in opts (`auth({ auth })`, `mail({ mailer })`), never positional. Renames: `manifestPlugin→manifest`, `metricsPlugin→metrics`, `exportPlugin→exporter`, `healthPlugin→health`, `notificationsPlugin→notifications`, `mcpPlugin→mcp`, `printerPlugin→printer`, `createAuthPlugin→auth`, `mailerPlugin→mail`, `createCaravan→caravan`, `backfills→backfill`.
  - **B** — `xPlugin(opts)` for every Plugin, so the word is in the identifier wherever it is read; bare nouns renamed up.
  - **Recommend A** — bare noun is already the majority (9 vs 7 vs 2), the subpath already carries the noun (`import { metrics } from '@frontierjs/junction/metrics'`), and `conduit()` / `orion()` / `outbox()` read well in a `configure` list where `metricsPlugin()` reads twice. § V *predictability*: knowing one teaches the next.

- ~~**FJS-D1078 — Which one event spelling does `.mesa` keep on an element?**~~ **Answered 2026-10-16 (`FJS-D1078`): C — `onclick={fn}` everywhere, with `parseModifiers`' pipe grammar kept on the DOM name: `onsubmit|preventDefault={save}`, `oninput|debounce(300)={search}`. A guard modifier (`preventDefault`, `stopPropagation`, `self`, `trusted`, `debounce`, `throttle`) compiles into a wrapped handler VALUE, so it survives a spread and a kit component's forwarding — the reason Svelte 5 dropped modifier syntax. A listener option (`once`, `capture`, `passive`) cannot be a value, so it is honored on an element and refused on a component by name. `on:` and `@` refused with the new spelling.** `onclick`, `on:click` and `@click` all compile; VISION rule 23, the ui README and `make:component` each teach a different one.
  - **A** — `onclick={fn}` everywhere, elements and components alike; modifiers as an options object (`onclick={[fn, { once: true }]}` or a `use:` action); `on:` and `@` refused by name.
  - **B** — `on:click` on elements (Svelte 4 habit, modifiers as `|once`), `onclick` on components as rule 23 says.
  - **C** — `onclick={fn}` everywhere, with `parseModifiers`' pipe grammar kept on the DOM name: `onsubmit|preventDefault={save}`, `oninput|debounce(300)={search}`. A guard modifier (`preventDefault`, `stopPropagation`, `self`, `trusted`, `debounce`, `throttle`) compiles into a wrapped handler VALUE, so it survives a spread and a kit component's forwarding — the reason Svelte 5 dropped modifier syntax. A listener option (`once`, `capture`, `passive`) cannot be a value, so it is honored on an element and refused on a component by name. `on:` and `@` refused with the new spelling.
  - **Recommend A** — basecamp already writes `onclick` 68 files to 5, the kit forwards attributes so one spelling reaches both an element and a component, and Svelte 5 itself moved to it. § IV *familiarity vs. precision* is about ecosystem habits and the ecosystem moved.

- ~~**FJS-D1079 — Which one verb defines a service, and what does it return?**~~ **Answered 2026-10-16 (`FJS-D1079`): A — `createService(def)` returns a definition; the file `export default`s it; the registry builds. `createBaseService` and the factory-name rule go.** `createBaseService(opts)` returns a definition (example ×36); `createService(def)` a built Service (basecamp ×43); the loader wraps either and demands a factory named `create*Service`.
  - **A** — `createService(def)` returns a definition; the file `export default`s it; the registry builds. `createBaseService` and the factory-name rule go.
  - **B** — keep both as two layers, document which to export.
  - **Recommend A** — a service file states what the service is, and building it is the app's job (Invariant 4, one owner per translation). B is the status quo that produced `FJS-1868` and `FJS-2270`.

- ~~**FJS-D1080 — Does `createApp` take one root from which the folders derive?**~~ **Answered 2026-10-16 (`FJS-D1080`): A — `createApp({ root: import.meta.url })`; `services/`, `jobs/`, `notifications/`, `../config` derive from it; a battery reads `app.root`.** Four keys today (`autoload`, `caravan.jobsDir`, `notificationsPlugin({ notifications })`, `configPath`), every default wrong under a drive.
  - **A** — `createApp({ root: import.meta.url })`; `services/`, `jobs/`, `notifications/`, `../config` derive from it; a battery reads `app.root`.
  - **B** — keep per-battery keys, fix the defaults to probe from the caller's `import.meta.url`.
  - **Recommend A** — Invariant 3 already says the layout is fixed, so there is one fact to state; four keys restate it (§ V *derived*).

- ~~**FJS-D1081 — Which one literal form does the gate ladder take?**~~ **Answered 2026-10-16 (`FJS-D1081`): B — bare on both: `@@gate(3.8.3.8)` as a dotted literal the lexer learns, `@gate(5)`; moves digits-only.** Model `@@gate("3.8.3.8")` is quoted; a move's `@gate(5)` is bare and `@gate("5")` refused. Both forms are digits-only — a level name is refused on each (`FJS-D239`, `FJS-2935`).
  - **A** — quoted on both: `@@gate("3.8.3.8")`, `@gate("5")`; moves digits-only.
  - **B** — bare on both: `@@gate(3.8.3.8)` as a dotted literal the lexer learns, `@gate(5)`; moves digits-only.
  - **Recommend A** — the model form has 95 uses in the tree and `FJS-D239`'s error message teaches it; the lexer stays small. The move form has 30 uses and changes mechanically.

- ~~**FJS-D1082 — Are policy operations bare identifiers like every sibling keyword argument?**~~ **Answered 2026-10-16 (`FJS-D1082`): A — bare: `@@allow(read, …)`, `@allow(write, …)`; comma-combo deleted; one op list, with field `write` = create+update stated in the reference.** `@@allow('read', …)` is the only quoted keyword argument in the language; `'update,delete'` parses with zero uses; field `@allow` has a different op list from model `@@allow`.
  - **A** — bare: `@@allow(read, …)`, `@allow(write, …)`; comma-combo deleted; one op list, with field `write` = create+update stated in the reference.
  - **B** — keep quoted; delete the comma-combo only.
  - **Recommend A** — `@@sync(server)`, `@@tenant(none)`, `@values(X, open)` already set the rule; an op is a keyword, not data.

- ~~**FJS-D1083 — What is the one script table an app's `package.json` carries?**~~ **Answered 2026-10-16 (`FJS-D1083`): A — `dev`, `api`, `web`, `build`, `test`, `db:seed`, `db:reset`, `check`; written by `app-config.js`; graded by `fli check`; the three apps moved.** Scaffold: `dev:api`, `dev:web`, `build:web`, `db:migrate`, `db:types`. Apps: `api`, `web`, `build`, `db:seed`, `db:reset`, `test`. `fli dev:api` branches on both.
  - **A** — `dev`, `api`, `web`, `build`, `test`, `db:seed`, `db:reset`, `check`; written by `app-config.js`; graded by `fli check`; the three apps moved.
  - **B** — the scaffold's `dev:*` table, apps moved to it.
  - **Recommend A** — three real apps already converged on it, and `bun run api` is what every drive's *Start first* says.

- ~~**FJS-D1084 — Is `fli dev` the one front door?**~~ **Answered 2026-10-16 (`FJS-D1084`): A — `fli dev`; the scaffold prints it; `utils/dev.md` becomes `dev/index.md` aliased `dev`; the README drops `bun run dev`.** The scaffold tail prints `bun run dev`; the cli README says `fli dev`; only `fli dev` runs the four preflights.
  - **A** — `fli dev`; the scaffold prints it; `utils/dev.md` becomes `dev/index.md` aliased `dev`; the README drops `bun run dev`.
  - **B** — `bun run dev` with the preflights moved into a `predev` script.
  - **Recommend A** — the preflights need the port broker, which is fli's.

- **FJS-D1085 — How does an app mount?** Every `main.js` and the scaffold write `createTextNode('') → appendChild → mount(anchor, App, { root })`; the mesa README shows a different call with a different result.
  - **A** — `mount(App, { target: '#app' })` appends inside the target; the anchor is the runtime's business.
  - **B** — `virtual:sierra` mounts `App.mesa` itself; `main.js` is optional and holds only side-effect imports.
  - **Recommend B** — the module already boots the router and the client; mounting the root is the same kind of thing, and a `main.js` that is five side-effect imports is what most apps would be left with. A is the fallback for an app that mounts somewhere else.

- **FJS-D1086 — Does a resource file with only a `<script module>` half render the kit's default form implicitly?** 76 resource files repeat the same 15-line markup half; `mcp-build.js` already generates a form for a markup-less file.
  - **A** — yes: no markup half means the kit's `<Form resource>`; a markup half is an override. Invariant 18's second sentence becomes *the markup half, when present, overrides the model's default form*.
  - **B** — no: Invariant 18 stands, the scaffold keeps writing the half.
  - **Recommend A** — the half states nothing model-specific (§ V *derived*), and the one place that reads a resource file already knows what to draw without it.

- **FJS-D1109 — What is the one grammar for an attribute's optional operands?** `@values(Set, open, dependsOn: col on srcCol)` mixes a positional strength, a named key and the language's only bare infix `on` (`parser.js:922`); `@@relator([a, b], many: col)` spells `many` as a keyword and as a key (`parser.js:2165`); `@@extensible(fields, declaredBy: X, max: { text: 8 })` takes the only `{}` literal (`parser.js:2245`). `@@transitions(declaredBy:, scope:)` and `@@fts(…, tokenize:)` are already all-named.
  - **A** — every optional operand is a named key and only the required one is positional: `@values(Set, strength: open, dependsOn: col, matching: srcCol)`, `@@relator([a, b], once)` / `@@relator([a, b], many, by: col)`, `@@extensible(fields, declaredBy: X, max.text: 8, max.number: 4)`. The old spellings are refused by name with the new one; no alias.
  - **B** — A for `@values` and `@@extensible` only; `@@relator`'s `once|many` stays a bare word because it is required, with `by: col` replacing `many: col`; `max: { … }` stays as the one structured literal and is documented as the exception.
  - **C** — fix only the infix: `on <col>` becomes `matching: col`; leave `open|suggested` positional and the `{}` literal, and rule positional strength the language's one enumerated-word form.
  - **Recommend B** — the infix and the keyword-as-key are the two real mixes; `strength:` is cheap and uniform, but forcing `max.text: 8` into dotted keys invents a form for a single use where the literal is already how an enum-keyed pool reads.

- ~~**How is a configured plugin's `app.<slot>` typed, so no app writes `!`?**~~ **Answered 2026-10-16 (`FJS-D1138`): A — each slot is typed present; reading one whose plugin was never configured throws, naming the plugin to configure in `app.ts`. The augmenting package declares it non-optional.** `FJS-2940`: `auth?`, `mail?`, `conduit?`, `jobs?` and every augmented slot are optional on `App` (`packages/junction/src/core/app.ts`), so example, basecamp and the scaffold write `app.conduit!.receive()`, `ctx.app!.notify()`.
  - **A** — each slot is typed present; reading one whose plugin was never configured throws, naming the plugin to configure in `app.ts`. The augmenting package declares it non-optional.
  - **B** — `configure(plugin)` returns `App & { slot }`, so the type narrows in `app.ts`.
  - **Recommend A** — a service reads `ctx.app`, typed as the general `App`, so B's narrowing never reaches the files that write the `!`; A's throw says what is missing where B's `undefined` would say nothing (§ V *failure*).

- ~~**FJS-D1245 — Do jetty's entrypoints keep the coined nouns Harbor, Dock, Pier and Island and enter VOCABULARY.md, or take the platform's own words the way Options already does?**~~ **Answered 2026-10-18 (`FJS-D1245`): A — keep all four; each gets a VOCABULARY.md row scoped to jetty naming the platform part it is, and Island's row names the two senses. Nothing renames.** `FJS-2990`, step 5.4. The five entrypoints are `defineHarbor` / `defineDock` / `definePier` / `defineIsland` / `defineOptions` (`packages/jetty/src/index.js:2-6`), discovered from `src/harbor/`, `src/dock/`, `src/piers/<name>/`, `src/islands/*.js` (`packages/jetty/src/build/discover.js:4-8`); Dock is the action popup (`manifest.js:46`, `default_popup: 'dock.html'`). The mapping to the platform is written only in jetty's `CLAUDE.md:8-10`, which also warns that jetty's islands are not Sierra's (`FJS-2425` counts Island ×2). Outside jetty, only `example/extension/` and `fli make:extension` (`packages/cli/core/extension-surface.js`) spell them. Prior art names every one of these by the platform's word: Chrome's docs say *extension service worker*, *popup*, *content script*, *options page*, *side panel*; WXT's entrypoints are `background`, `popup`, `options`, `*.content.ts` with `defineContentScript`, and *unlisted pages* (wxt.dev/guide/essentials/entrypoints); Plasmo's are `background`, `popup`, `options`, `contents/`, `tabs/` (docs.plasmo.com/framework).
  - **A** — keep all four; each gets a VOCABULARY.md row scoped to jetty naming the platform part it is, and Island's row names the two senses. Nothing renames.
  - **B** — the platform's words: `src/background/`, `src/popup/`, `src/pages/<name>/`, `src/content/*.js`; `defineBackground`, `definePopup`, `definePage`, `defineContentScript`, `openPage` / `closePage`; `discover.js` refuses an old directory by name with the new one. Jetty keeps its own name; `example/extension/` and `extension-surface.js` move in the same change.
  - **C** — B for Dock, Pier and Island; Harbor stays and enters VOCABULARY.md, on the ground that it is more than the service worker: it holds the Junction connection and the token every page relays through (`packages/jetty/CLAUDE.md:77-86`).
  - **Recommend B** — `FJS-D258` already draws the line: a metaphor names an organ that owns a realm, and jetty is that organ; its entrypoints are the browser's own parts and own nothing, so a coined word costs a reader four nouns and buys nothing back. The platform's words fit exactly, which is the *familiarity vs. precision* half `FJS-D258` applied to `mcp`, and Options already takes it, so B makes the five siblings agree and removes the Island collision. C's distinction is real but MV3 already makes the background the one long-lived context; the relay is what jetty's background does, which its docs can say without a fifth noun.
