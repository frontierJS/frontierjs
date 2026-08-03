# Decisions

Dated rulings by the project owner. These are settled unless explicitly reopened —
do not "fix" behavior back toward what a decision replaced. When a decision is
reversed, amend it here (strike and date it), don't delete it.

Format: **decision — why — where it lives.**

---

## Naming & vocabulary

**2026-08-01 · Model names are PascalCase and singular, always.**
`model Lead` → accessor `db.lead`; `model PageView` → `db.pageView`. The accessor
rule derives the API from the model name, so mixed conventions produced three
spellings of one model across packages. Exception: `@@external` models mirror a
foreign physical table and keep its name verbatim.
*Lives in:* all examples/docs in `packages/litestone`; enforce in scaffolds and reviews.

**2026-08-01 · Named gate syntax is canonical; digits are the compact form.**
`@@gate(read: READER, write: USER, delete: OWNER)` in all docs and new schemas;
`@@gate("2.4.4.6")` remains valid shorthand. `write:` expands to
create+update+delete unless one is given explicitly; missing keys cascade
read→create→update→delete, read defaults to STRANGER.
*Lives in:* `packages/litestone/docs/access-control.md`, parser `parseGateArg()`.

## Access control

**2026-08-01 · Gates enforce by default when declared; undeclared imposes nothing.**
Any model with `@@gate` is enforced from the first request via the shipped
`FrontierGateGetLevel` resolver (null user → STRANGER) even with no GatePlugin
installed. A user-supplied `GatePlugin({ getLevel })` replaces the resolver
entirely. Models without `@@gate` are completely open. `asSystem()` bypasses
(except LOCKED). Rationale: a declared gate that silently does nothing is a
fail-open security default — verified live before the fix.
*Lives in:* `packages/litestone/src/core/client.js` (default plugin injection);
tests in `test/elegance-fixes.test.ts`.

## Query & write semantics (Litestone)

**2026-08-01 · Unknown `where` fields: WARN on reads, ERROR on writes.**
Reads log once per model+field (did-you-mean hint) and still execute; writes
(update/delete/restore/upsert families) reject — a typo'd filter on a write is a
mis-scoped destructive operation. `AND/OR/NOT` are descended into; relation
sub-filters are not (their keys belong to the related model).

**2026-08-01 · Unknown `data` keys are silently stripped.**
Mass-assignment protection: pass a request body straight in without
whitelisting. This deliberately REPLACED an earlier reject-with-did-you-mean
behavior — do not restore the rejection. Safety net: a typo on a *required*
field still fails loudly via the required-field pre-flight.

**2026-08-01 · `take`/`skip` are rejected with a pointer to `limit`/`offset`.**
Prisma muscle-memory must fail loudly and helpfully, never be silently ignored.

**2026-08-01 · Missing required fields on create are a ValidationError.**
`name is required`, same shape as every other field rule — never a raw SQLite
`NOT NULL constraint failed`. Exempt: optional fields, arrays (implicit `[]`
DDL default), `@default`/`@updatedAt`/`@sequence`/generated/computed/`@from`,
`Int @id` (autoincrement). Applies to create/createMany/upsert-insert only —
updates stay partial.

**2026-08-01 · `@@strict` model flag: PARKED.**
(Would escalate read-warnings to errors per-model.) Revisit after the warnings
have been observed in practice; the warn infrastructure makes it nearly free.
*All four above live in:* `packages/litestone/src/core/client.js`
(`withArgValidation`, `checkWhereKeys`, `writeData`); tests in
`test/elegance-fixes.test.ts` and the rewritten block in `test/litestone.test.ts`
("write payload — unknown fields are silently stripped").

## Migrations (Litestone)

**2026-08-01 · The executor owns the transaction.**
`apply()`/`autoMigrate()` strip in-file `BEGIN/COMMIT` + FK pragmas and provide
the real thing: one transaction per migration, ROLLBACK on failure,
`recordMigration` committed atomically inside it, FK pragma restored in a
finally. Generated files keep the in-file pair for hand-running in a sqlite
shell only.

**2026-08-01 · Rebuilds copy only the old∩new column intersection.**
Added columns are never named in the copy-SELECT (SQLite's double-quoted-string
fallback turns unknown identifiers into literals — this silently corrupted or
destroyed data). A rebuild that adds a NOT NULL column with no default is
generated BLOCKED (commented out, with fix options); `autoMigrate` reports
`state: 'blocked'` and does not write its hash, so it resurfaces every startup.
*Both live in:* `packages/litestone/src/core/migrate.js` + `migrations.js`;
tests in `test/migrations-fixes.test.ts`.

## API design (Junction)

**2026-08-01 · Custom service actions stay on `X-Service-Method` header dispatch.**
Proposal to move to sub-path dispatch (`POST /api/notes/:id/summary`) was
considered and declined. Case is preserved for action names (`getStats` works);
CRUD names remain blocked from header override; `restore`/`upsert` match
case-insensitively.
*Lives in:* `packages/junction/src/transport/bridge.ts`.

**2026-08-01 · `createService({ model })` carries the derived hook layer.**
The model path must always include schema-derived gates/validation
(`base.hooks` = user hooks + derived); hook-less custom actions run the `'*'`
(all-hooks) pipeline, never an empty one. Litestone error names map across the
package boundary: `AccessDeniedError` → 403, `ValidationError` → 400.
*Lives in:* `packages/junction/src/core/service.ts`, `core/hooks.ts`,
`core/errors.ts`.

**2026-08-02 · The result envelope has one owner, and `kind` is the discriminant.**
`{ kind, object, data, errors, total?, limit?, offset? }`. `kind` is `'single' |
'list'` and is THE field to branch on; `object` is the SERVICE name for both
kinds (`'posts'`, never `'list'` and never `'Post'`), so it is a stable identity
a client can key a cache or a type off. The shape was built in one place and
taken apart in twelve others, each with its own rules, and they had drifted:
the same `find()` returned a full envelope over HTTP, a bare array to internal
callers, and a bare array to the browser — `total` was reachable from curl and
nowhere else. Detection was `'object' in value`, which classifies any row with
a column named `object` as an envelope.
**The rule, everywhere: a list keeps its envelope, a single unwraps to the
record.** A list carries metadata that has nowhere else to live; a single does
not. `$wrap` is tri-state on the wire — absent = the rule, `true` = envelope the
single too, `false` = unwrap the list to a bare array (Feathers' `paginate:false`).
*Lives in:* `packages/junction/src/core/envelope.ts` — `wrapResult`,
`unwrapResult`, `resultData`, `isServiceResult`, `isListResult`, `single`, `list`.
Import them; do not reach into `.data`.

**2026-08-02 · `$` is transport syntax, not an internal data model.**
`ctx.query` is FILTERS ONLY (which records); `ctx.directives` is DIRECTIVES
(how to shape the result) — `limit`, `offset`, `orderBy`, `select`, `populate`,
`search`, `withDeleted`, `onlyDeleted`, structured and unprefixed. The bridge is
the only place that understands `$`. Conflating them is not theoretical: the
bridge stripped `$limit/$offset/$orderBy/$select` from `ctx.query` as "reserved"
while `parseQuery` looked for exactly those four keys there — the transport
deleted precisely what the query builder read, so pagination, ordering and field
selection were ALL inert over HTTP, and the unprefixed `?limit=1` became a WHERE
clause on a nonexistent column and returned zero rows. Internal callers pass
`{ directives: { limit: 10 } }` via `CallOptions`.
*Lives in:* `packages/junction/src/transport/bridge.ts` (`parseDirectives`),
`src/core/context.ts` (`QueryDirectives`, `RESERVED_PARAMS`),
`src/core/litestone.ts` (`parseQuery`).

**2026-08-02 · `errors[]` is load-bearing: bulk writes return partial success.**
Kept, not dropped — and now written to. A bulk create saves what it can and
returns the failures as `{ data, error }` pairs: the input that failed, paired
with why, so a caller can tell WHICH of fifty rows was rejected rather than
"some subset broke". This is Feathers issue #562's 2017 envelope proposal,
which never shipped there because the migration cost across its ecosystem
killed it; Junction had carried the field with nothing writing to it. Bulk stays
opt-in (`allowBulk: true`). Deliberate trade-off: rows are created individually,
so there is no all-or-nothing rollback — atomicity and partial success are
mutually exclusive; wrap the call in a transaction if you want the former.
*Lives in:* `packages/junction/src/core/envelope.ts` (`BulkFailure`,
`toBulkFailure`, `partitionBulk`, `BULK_FAILURES`), `src/core/litestone.ts`.

**2026-08-02 · One event origin, and broadcasting is declared on the service.**
A mutation is announced ONCE, in `callService`, and fans out to two consumers:
the in-process bus (`posts:created`) and the channel manager (`posts created`).
They were independent origins, which cost three separate things: two places
derived the event name and disagreed; `ctx.dispatch = false` suppressed the
socket but not the bus, so a hook that deliberately withheld a broadcast still
handed the record to every server-side subscriber including webhook fan-out;
and an app that forgot to wire the publish hook had half a real-time layer with
no signal. `ctx.dispatch` is now the single switch for both — `false` announces
nothing, any other value replaces the payload.
A service declares its target with **`channel:`** — `'posts'`, a
`(rows, ctx) => Channel` function, or `false` for a declared opt-out. Named
`channel` and NOT `publish` because "publish" is an ordinary action name
(publishing a draft — the openapi suite has exactly that service) and reserving
it as an option key would stop a service from having one. A noun cannot collide
with a verb-shaped action.
**Bulk writes announce once per record**, as Feathers does: the browser's
created/patched/removed handlers each take one record, so a single event
carrying an array lands as one malformed upsert.
*Lives in:* `packages/junction/src/core/service.ts` — `callService`,
`publishToChannels`, `PublishDeclaration`.

**2026-08-02 · Broadcasting is opt-in in the framework, opt-out in the scaffold.**
`createService({ name, model })` broadcasts nothing. `@@allow` row policies are
enforced when a row is READ, and a broadcast does not re-evaluate them per
subscriber — so a default of "announce everything" hands every connection in a
channel rows it could never have fetched. This is exactly Feathers' split: its
core publishes nothing without a publisher, and its *generator* scaffolds
`app.publish(() => app.channel('authenticated'))` — the line its own docs then
tell you to replace. `fli make:model` / `make:scaffold` emit `channel: '<name>'`
with the scoping warning attached, so a generated app is live out of the box and
the line is in front of the developer who has to narrow it.
*Lives in:* `packages/cli/commands/make/model.md`, `make/scaffold.md`;
rationale in `publishToChannels()`.

## Design system (`@frontierjs/css`)

**2026-08-02 · An alias token declared in `:root` is always wrong.**
If token A should follow token B, write the fallback at the *use site* —
`var(--ring, var(--color-primary))` — and do not declare A at all. The
`:root` form (`--ring: var(--color-primary)`) looks equivalent and silently
is not: the `var()` resolves once against `:root`'s own value and the result
inherits straight past every `.theme-*` override. This has now bitten twice:
`--badge-radius` (Elite's square buttons kept round badges) and `--ring`
(**every** focus ring in **every** theme was the default blue). There is no
case where the `:root` form does what it looks like it does.
*Lives in:* `packages/css/tokens.css`; tested in `test/specs/focus.spec.js`.

**2026-08-02 · One focus ring, in the last cascade layer.**
`focus.css` writes the whole recipe once, at `:where()` specificity, in the
`a11y` layer. Variation goes through `--ring-color` / `--ring-width` /
`--ring-offset`, never a second recipe. It is in the last layer so a component
cannot switch the ring off by accident — which is exactly what had happened:
`.btn.outlined { box-shadow: none }` and the ring's `box-shadow` were the same
specificity in the same layer, so outlined and link buttons had **no focus
indicator at all**. A consumer's unlayered CSS still overrides deliberately.
*Lives in:* `packages/css/focus.css`; `test/specs/focus.spec.js`.

**2026-08-02 · A Treatment class works on every element that reads it, or it is a bug.**
This was already the rule for the seven tones; it applies equally to
`.raised` / `.outlined` / `.ghost`. Only `.outlined` was implemented on `.btn`,
so a toolbar of `.btn.ghost` rendered as solid primary blue. The test for a new
Treatment consumer is not "does it look right" but "does every value of that
Treatment do something".
*Lives in:* `packages/css/buttons.css`; `test/specs/components.spec.js`.

**2026-08-02 · Competing background inputs compose through a variable, not specificity.**
Stripe, hover and tone all want a say in a table row and only one can own
`background`. They set `--row-base` and the tone mixes into it, so a tone
survives a stripe instead of being out-specified by it. Any future "several
things tint the same surface" follows the same shape.
*Lives in:* `packages/css/tables.css`; `test/specs/tables.spec.js`.

**2026-08-02 · `.icon` means "this element IS an icon". The icon-only button is `.btn.square`.**
**Breaking rename**, v0.10. One class cannot mean both, or `<button class="btn
icon">` sizes the button itself to 1.15em. Icon sizing is one rule in
`icon.css` — it was previously hand-copied into three files with three
different sizes and a missing selector branch — covering the components the
package owns, plus `.icon` for anywhere else, varied by `--icon-size`.
Note the old markup fails *quietly*: with `border-box` a width under
padding+border clamps, so a stale `.btn.icon` floors at 30x30 and looks
roughly right while having lost its `aspect-ratio` and padding.
*Lives in:* `packages/css/icon.css`, `buttons.css`; `test/specs/core-gaps.spec.js`.

**2026-08-02 · Interactive state is styled from ARIA, never from a class.**
`[aria-selected]`, `[aria-current]`, `:user-invalid`, `[hidden]`, `[open]`.
A class lets the visual state and the announced state drift the moment someone
updates one and forgets the other; keying off the attribute makes that
divergence unrepresentable. Every affected component has a test asserting that
adding `.active` / `.current` / `.selected` fails to fake it. The one documented
exception is a completed Step — there is no ARIA token for "done", so the markup
owes assistive tech a `.visually-hidden` word.
*Lives in:* `tabs.css`, `nav.css`, `steps.css`, `form-core.css`.

## Open (discussed, not yet ruled)

- Junction structural refactor priorities (definition/compiled Service split →
  ~~single event origin~~ *(ruled 2026-08-02)* → ~~Envelope module~~
  *(ruled 2026-08-02)* → export tiering → middleware/hook naming) — proposed and
  sequenced in `drift-report.md`, awaiting go.
- Partial success for bulk PATCH and REMOVE — creates only, so far.
- Litestone `onEvent` still has zero Junction subscribers, so a write that
  bypasses the service layer (`asSystem()` in a job) announces nothing. Fixing
  it needs a litestone API addition — `onEvent` is fixed at `createClient` and
  there is no post-construction subscribe, unlike `$tapQuery(fn)`. Mirroring
  `$tapQuery`'s shape is the obvious move.
- Coherence-review vocabulary proposals (Hook/Guard/Observer/Delegate split,
  Provider, Job, Target, Component/Binding, Slice axis, Manifest→Release) —
  argued in `drift-report.md` §synthesis, not yet adopted into `ARCHITECT.md`.
- Migrations second tier: rollback stance documentation (`--backup`?),
  row-count assertion after rebuilds, second-granular timestamp collisions.
- IAuth partial acceptance (`auth: { verifySession }` sufficing), `publish()`
  string shorthand / `write` phase alias, typed `createSchema` inference,
  `createClient` options grouping + `setters/getters` hook naming (deferred
  2026-08-01 pending monorepo-wide Hook vocabulary decision).
