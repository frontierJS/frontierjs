# Handoff — 2026-08-10

> **Basecamp declares `@@gate` on all 37 models and `@@allow` on one** — `Server`,
> as of 2026-08-10. The gate ladder is per WORKSPACE, not per user, which is why
> `example/api/gate.ts` could not be copied; the policy is graded off the same
> principal. Every screen whose blocker was an API is built —
> `packages/basecamp/docs/SCREENS.md` is the map, 41 mock screens, **31 built**.

Session state for picking up cold. Read `CLAUDE.md` first (the map), then this.

Everything below was verified by running it, not by reading. Where I could not
verify something, it says so.

**Sessions are recorded here, newest first.**

---

## Next — the other 36 models (2026-08-10)

`Server` declares `@@allow('all', workspaceId == auth().workspaceId)` and holds.
The rest is repetition with an audit in front of each one, and the audit is the
part that matters: **a gate refuses, a policy filters**, so a read that
legitimately crosses a workspace and is not `asSystem()` returns nothing with a
200. For `Server` that audit came out clean — the three engines, the hub and the
agent's heartbeat were already system paths. The next model may not be.

Do them one at a time with `bun run verify` between. Two shapes to look at
before each: **who reads this model without a workspace** (grep the service for
`asSystem`), and **which parent includes it**, now that an include really does
apply the child's rules.

`Volume` and `ServerEvent` are the interesting pair, because neither carries a
`workspaceId` — their tenancy is the join to `Server`, and `check(server)` is
the policy expression for exactly that. Worth doing early: it is the shape most
of the remaining models are not, and it will say whether `check()` through a
belongsTo is enough.

**Still unruled**: `/metrics` is unauthenticated (`healthPlugin` got no token),
so the service registry and every action name is world-readable. Untouched
again this session because the drives and any external probe read it — it wants
a decision, not a quiet edit.

**Not run this session: `example`'s browser drives.** A `bun run api` from
another session has held :3600 since 03:50 (11h54m at the time of writing) and
serves pre-change code; killing it is not mine to do, and probing it would have
proved the old build. If you can clear that port, `example`: `verify` +
`verify:public` are the two the litestone read-path change most deserves.

---

## Session — Mesa support was one commented-out line and three landmines (2026-08-10)

```
frontierjs-vscode    npm test 34 + 36 + 6 · typecheck clean · verify:package all green
```

`FJS-008b` closed. `startMesaClient` is called from `extension.ts` and `.mesa`
files get hover, completions, the outline and compiler diagnostics — plain
vscode providers, no second server. **Uncommenting the line was never the fix**:
each of the three blockers ships an extension that fails where nothing watches.

- **The providers are plain JS and tsc emitted none of them** — no `allowJs`, so
  `require('./hover')` threw at activation. They are `import`ed now as well:
  esbuild leaves a computed require alone, so the bundled `.vsix` would have
  shipped without them and thrown on the first hover, in the marketplace.
- **The compiler resolver hunted `@mesa/compiler/compiler.js`**, a name from
  before the rename. It probes `@frontierjs/mesa`'s `src/compiler.js` in
  node_modules, a `packages/mesa` above the edited file, `mesa.compilerPath`
  (file or package directory), and a sibling of `context.extensionPath` —
  which had to replace `__dirname`, since that is `out/` in the bundle and
  `out/mesa/` in the tsc output.
- **`await import(p)` cannot load it.** tsc under `module: commonjs` rewrites it
  into a `require()`, and `require()` of mesa's ESM throws in the extension host.
  It is loaded through `new Function('specifier', 'return import(specifier)')`
  so neither compiler can see the specifier. This one is the dangerous shape: it
  fails as *no diagnostics*, which looks like a clean file.

The compiler is the workspace's own and is never shipped — without one, the other
four features still work and the extension says so once.

**`test/mesa.test.js` — 36 assertions over the built output.** There is no
protocol to drive these providers over, so `test/vscode-stub.js` stands in for
the editor; the compiler is the real one, because a fake compiler resolves
happily and resolution was the defect. It covers all five resolution routes and
the none-found prompt, an analysis error and a `compile()` that throws, the
debounce, and each provider. Mutation-checked: dropping `allowJs` reproduces
`Cannot find module './hover'`, and restoring the plain `await import(p)` turns
every resolution case red. `verify:package` runs it against the unpacked `.vsix`
and asserts the providers and the opaque import survived bundling.

Writing it found one more: a diagnostic's range came from matching a declared
variable on a word boundary anywhere in the message, so
`bind:group={missing} — 'missing' must be a top-level let variable` underlined
`let a = 1` — "must be a top-level" contains a standalone `a`. Only a quoted
name names a variable now.

**Running it in a dev host found `FJS-156`, which no suite could have.** Two
Mesa snippets wrote `$onCleanup` and `$class` unescaped in their BODY, where
`$name` is a VS Code snippet *variable* — an unknown one expands to nothing, so
the snippets inserted `(() => { })` and `export let  = ''`. The editor says so
once, in the extension host log, naming neither snippet nor file:
*"very likely confuse snippet-variables and snippet-placeholders"*.
`test/snippets.test.js` now walks every body of both languages; a `$` must be
escaped, a tabstop or one of the 33 real variables, and a `prefix` is exempt
because it is typed rather than expanded.

**The third blocker was outside the repo** and is gone: two copies of an older
`mesa-language-support` extension (publishers `frontierjs` and
`your-publisher-name`) sat in `~/.vscode/extensions` contributing the same
`mesa` language id, along with a stale `undefined_publisher` build of this
extension. Removed by hand. A dev host shows what is INSTALLED, so check that
directory before concluding anything about this tree.

---

## Session — eleven packages prepped to publish, and two were broken (2026-08-10)

```
prepped   mesa utils sierra auth caravan conduit notifications ui email-kit jetty cli
verified  every declared export imported from an INSTALLED copy, each package ALONE
suites    mesa 1052 · sierra 833 · email-kit 34 · utils 15 · ui 64/64 — unchanged
```

All eleven got the four things junction needed — `publishConfig.access`
(a scoped package's first publish otherwise fails on *payment*), a `files` field
written from what each entry point actually reaches, a `LICENSE` for the MIT
every manifest already claimed, and `repository` + `directory`.

**Two of them would have shipped broken, and the same probe found both.**

- **mesa** had `happy-dom` in `devDependencies` while `src/render.js` and
  `src/css-inliner.js` import it at the top level. Six specifiers dead on
  arrival. Now a dependency.
- **sierra** had **no `peerDependencies` at all**, while five shipped files
  statically import `@frontierjs/mesa/runtime` and one imports
  `@frontierjs/junction/client`. `@frontierjs/sierra/router` — the main path —
  would throw. mesa is now a **required peer**, deliberately not a dependency:
  two copies of the reactive runtime are two signal graphs and nothing says so.
  junction, litestone and vite are optional peers, all three genuinely
  `await import`ed (litestone resolves from the APP on purpose).

**The method is the transferable part. A probe that installs the family together
cannot see either bug** — the missing package is present because a sibling
pulled it in. Both only appear when the package is installed ALONE. That is the
same failure as auth's `../junction` imports wearing a different hat: correct by
adjacency, broken on arrival. Install one package into an empty project and
import every subpath its own `exports` declares.

The static scan that found them has one trap worth knowing: `import('vite').Plugin`
in a JSDoc `@returns` and `import x from 'y'` inside a doc comment both look
exactly like real imports. Strip comments first or roughly half the hits are
phantom — of 16 candidates, 11 were prose.

**Publish order, because one package gates three.** mesa is a leaf and
`sierra`, `ui` and `email-kit` all peer on it — they now *refuse to install*
until it exists, which is the improvement. Wave 1: **mesa**, utils, auth,
caravan, conduit, notifications, jetty. Wave 2 (needs mesa): **sierra**, **ui**,
**email-kit**. `cli` is separate — it is already on npm at `0.0.0-beta.0` while
the tree says 0.1.0, so it is a re-release and the version bump is a human's
call. Never: basecamp and both `example`s are `private`, and
`frontierjs-vscode` goes to the VS Code marketplace.

## Session — junction is on npm, and it is Bun-only for good (2026-08-10)

```
packages/junction    919 tests unchanged · 29/29 subpath exports import from the
                     INSTALLED copy · @frontierjs/junction@0.1.0 live, tag latest
```

No code changed. Four manifest gaps, each failing at a different moment:

- **`publishConfig.access: "public"`.** A scoped package defaults to restricted,
  so the FIRST publish under `@frontierjs/*` fails on *payment* — an error that
  says nothing about the package. This is the one that would have wasted an hour.
- **`files`** — 131 files / 464 kB, carrying `tests/`, `example/`, `bun.lock`,
  `tsconfig.json` and all three state markdowns. Now 64 / 281 kB. `tools/` ships
  because the bin loads `init.ts`/`setup.ts`/`repl.ts`/`build-app.ts` beside it;
  the seven `check-*.mjs` repo audits are negated out.
- **`LICENSE`** — the manifest claimed MIT with no file.
- **`repository` + `directory`.**

**The decision underneath it: it ships raw TypeScript, and that is correct.**
Node refuses to strip types inside `node_modules` — a policy, not a version
gap — so `import '@frontierjs/junction'` fails there outright. Compiling would
not buy Node support, only move the failure later: the transport is `Bun.serve`,
logging and static files are `Bun.file`, cache and database import `bun:sqlite`.
So the honest move was to say so rather than build a dist. The README's Quick
start used to open `git clone <this repo>` — the wrong first sentence for
someone arriving from npm — and now opens with `bun add` and the Bun-only
paragraph.

**Verified against the artefact.** Every one of the 29 declared subpath exports
imports from an installed copy; `/auth` answers zero runtime exports, which is
correct because it is types-only. The `junction` bin runs from
`node_modules/.bin`. Then the thing this was for: `bun add` of the auth tarball
into an empty project resolves `@frontierjs/junction@^0.1.0` **from the
registry** and imports — the same command that 404'd before publish.

**`npm publish` needs a 2FA OTP**, which is on a human's authenticator. Prep,
dry-run and verification are all automatable; the publish itself is not.

**Publishing a package makes every loose peer range on it go quiet, and that is
the part to check after the next one too.** While `@frontierjs/junction` was a
404, a peer of `"*"` or `>=0.1.0` failed at install — loudly, with a name in the
error. The moment it existed, those same ranges resolved to 0.1.0 from the
registry without a word, and would keep resolving through a future 2.0. Five
were tightened to `^0.1.0` (caret pins the minor below 1.0, which is the
behaviour wanted here): notifications and jetty were bare `*`, caravan and
conduit were `>=0.1.0`. Nothing in the workspace had actually switched to the
published copy — every consumer pairs its peer with a `workspace:*` devDep, and
jetty's `file:` entry is a symlink — so this was about what an *outside* install
would resolve, which is exactly the surface publishing just created.

The audit found one unrelated live mismatch: **`@frontierjs/ui` declared
`@frontierjs/css: ^0.11.0` while css is 0.15.0** in the workspace and on npm.
Below 1.0 a caret pins the minor, so `^0.11.0` means `>=0.11.0 <0.12.0` — ui's
declared peer excluded both copies of the package it is built on. Nothing caught
it because ui resolves css by workspace and never by range. Now `^0.15.0`.
Verified by suite, not by reading: caravan 79, conduit 193, notifications 38,
auth 83, ui 64/64 + 26/26 + 60/60 + 7/7, jetty unchanged at its one known
`FJS-030` failure.

## Session — the extension packages, and the icon was the small half (2026-08-10)

```
frontierjs-vscode    npm test 34/34 · typecheck clean · npm run verify:package all green
```

`FJS-008c`, closed. The row said `icons/` does not exist and that it blocks
packaging only. Both true, and the icon was the cheaper half: `icons/` now holds
`frontierjs.svg` → `frontierjs.png` (128×128) plus `litestone-{light,dark}.svg`,
one family with `example/`'s favicon — three bars, middle one `#0d83dd`, which is
`--color-primary` from `@frontierjs/css`.

**With the icons in place `vsce package` still died** —
`invalid relative path: extension/../../.claude/settings.local.json`. bun installs
`vscode-languageclient` and the two server packages as **symlinks into the
workspace root's `.bun` store**, and vsce's dependency walk follows them above the
extension root. `--no-dependencies` packs in one second and ships an extension
whose first `require('vscode-languageclient/node')` throws — in the marketplace,
where nothing tests it. That is the failure the icon was hiding.

So `vscode:prepublish` bundles: `scripts/bundle.js` (esbuild, already a dep and
already bundling the parser) rewrites `out/extension.js` and
`out/litestone/server.js` as self-contained CJS. Two things stay out — `vscode`,
which the host provides, and `out/litestone/parser-bundle.js`, which `server.js`
require()s by a computed path and which must sit beside it.

**Proven against the artefact, not the tree.** `npm run verify:package` packs,
unpacks the `.vsix` into a temp dir with no `node_modules` above it, asserts every
icon `package.json` names is inside, asserts neither bundle bare-requires anything
unshipped, and then runs **all 34 LSP assertions against the unpacked server** —
`test/lsp.test.js` takes `FJS_LSP_SERVER` now, so one suite covers both copies.
The `.vsix` is 20 files, 292 KB. A `LICENSE`, a `.vscodeignore` and a README with
its stale *"npm run build fails"* banner removed came with it — that banner is the
marketplace page.

**Left open:** `vsce publish` needs a marketplace publisher account, and nothing
here can create one. `FJS-008b` (Mesa client switched off) is untouched — the
bundle does not reach it, since `startMesaClient` is still commented out.

---

## Session — auth was written as a folder, not as a package (2026-08-10)

```
packages/auth        83 tests unchanged · typecheck 4, unchanged (its baseline)
example              verify 37/37 · basecamp verify 270/270 (--reset)
```

`FJS-003`, closed. The row named three things and all three were the same
mistake: the package was written as a directory that happens to sit next to
junction, rather than as something that leaves the workspace.

**Eight imports of `../junction/index.ts`** across `auth.ts`, `plugin.ts`,
`types.ts`, `crypto.ts` and `cleanup.ts` — a path *out of the package root*.
Three of the eight are runtime values (`parseTtl`, `createScheduler`, the three
error classes), so an installed copy did not typecheck wrong, it threw on
import. They are now `@frontierjs/junction`. Worth knowing why this was only
ever auth's bug: conduit, caravan, notifications, basecamp and `sierra/example`
were all already writing the specifier, so **auth was the one package resolving
by adjacency**, and nothing in the repo could see it because adjacency held.

The peer range was `"*"` (now `^0.1.0`) and there was no `files` field (now
`["*.ts", "README.md"]`, a 10-file tarball rather than one carrying `tests/`
and the state docs).

**Proven the way the row asked**: `npm pack`, install the tarball into an empty
project, import it, build a plugin. Two things that probe teaches, neither
obvious from the diff:

- **`bun install` cannot satisfy a semver peer from a `file:` dep.** The probe
  404s on `@frontierjs/junction` even with junction's own tarball installed
  beside it — and it does that with `"*"` as the range too, so it is not the
  range. `npm install` resolves it from the tree and the import passes. Do not
  read that 404 as a regression.
- **auth's own side is done; the peer was junction's turn** — and junction was
  published the same day, so this is closed end to end. See the session below.

## Session — an include enforced nothing, and one model got a policy (2026-08-10)

```
packages/litestone   1480 tests (was 1462) · junction 919 · sierra 833 + 5 safety
packages/basecamp    verify 270/270 · 61 data tests (was 56) · typecheck 63, unchanged
```

The ask was `@@allow` on `Server`, one model, as the start of moving row-level
tenancy out of service where-clauses. The declaration is one line and it works.
Everything else here is what was found underneath it.

**The audit named in the last handoff was the `include:` graph, and the answer
was worse than the question.** The question was *does a policy on a child model
apply to a parent's include* — asked by probing rather than reading, and the
answer is that **nothing** did. Not the policy, not `@@gate`, not `@guarded`,
not a field `@allow`. A caller refused `Vault.findMany` by a level got the whole
table back as `team.secrets`, with the `@guarded(all)` column in plaintext and
the `@encrypted` one as raw ciphertext. `resolveIncludes()` builds its own SQL
below the query pipeline — which is why the soft-delete and `@@hasTemplates`
filters in it are hand-appended, and why the access rules, which nobody
hand-appended, were absent. 1462 tests and not one asked a policy question
through an include (`FJS-150`).

That is also the sentence that matters for the previous session's work: **the
gate the last handoff called landed was one join away from not being enforced
at all**, for a day, in an app whose whole tenancy model is nested.

Three fixes, because the three rules answer at different times. The gate is a
**preflight** in `GatePlugin.onBeforeRead`, walking `include:`, `select:` and
`_count`: `getLevel` is async and the include resolver is not, and a gate is per
model, so refusing by name beats returning an empty list that reads as *no rows*.
The row policy is compiled into all three relation SQL shapes and both `_count`
shapes — subqueried in the m2m branch, where the target is aliased beside the
join table and the policy compiler emits unqualified column names. The field
rules moved out of `makeTable`'s closure into `applyFieldPolicyTo(row,
modelName, …)`, because an include holds rows of a model that is not its own.

**The second defect only appears when a policied model has a Json column, and
`Server` has four.** `@@allow('post-update', …)` reverts a write that became
illegal once it landed, and it reverted from the `read()`-shaped snapshot —
where a Json column is an object, and a SQLite parameter cannot be one. So the
revert threw `Binding expected string, TypedArray, boolean, number, bigint or
null`, the `AccessDeniedError` never reached the caller, and **the write the
policy had just refused stayed in the database** (`FJS-151`). It reverts from
the raw row now; `beforeRow` stays read-shaped for the audit snapshot, which is
what wanted it that way.

**What the declaration itself needed was an audit, not a line.** Every read that
crosses a workspace has to be `asSystem()` before the policy exists, or it
silently filters to nothing — and here all of them already were, each with a
comment saying why. That is the only reason this was a one-liner, and it will
not be true of every model.

Five tests run the policy with **no service and no hook in the picture**
(`db/test/schema.test.ts`), which is the only arrangement that can tell a policy
from the where-clause the service was already writing: a caller reads one
workspace's servers with no `where` at all, naming another workspace's server by
id answers null, creating or moving one into another workspace is refused, and a
`Workspace` carries only its own servers through an `include`.

**A third defect came out of the probe schema rather than the app** (`FJS-152`,
also fixed). Implicit many-to-many only ever worked on models keyed `Int @id`
named `id`: the join table hardcoded `INTEGER … REFERENCES "<table>"("id")` and
six runtime sites read the target's key as the literal `.id`. A uuid key dies
loudly on the first connect; **a key named anything else fails silently**,
because join rows are written `INSERT OR IGNORE` and OR IGNORE swallows a NOT
NULL as happily as a duplicate — connect returns the row, writes nothing, and
the relation reads back empty. Nothing in the repo noticed because nothing here
uses the feature: `basecamp` writes an explicit join model all three times, and
`sierra/example`'s ids are `Int`.

---

## Session — the gate that was deferred ten phases (2026-08-10)

```
packages/basecamp   verify 270/270 (was 262) · 56 data tests (was 49)
                    typecheck 63, baseline lowered from 76
packages/litestone  1461 tests (was 1458) · junction 919 · sierra 810 + 5 safety
```

`FJS-007` closed. All 37 models declare `@@gate`; `FJS-149` was found on the
first request of the drive and fixed in litestone.

**What it was actually blocked on was never the resolver.** `sessionGateLevel()`
grades standing that travels with the user, and here the same person is `owner`
in one workspace and `viewer` in the next — so grading them from their user row
answers USER(4) everywhere, including workspaces they are not in. The level is
resolved per request from the `WorkspaceMember` row for the workspace being
addressed: viewer/billing 2, developer 4, admin 5, owner 6, `isSystemAdmin` 7
above any membership, and an authenticated caller with no membership 1 — which
reads `Workspace` and nothing else, because that is the screen a fresh login
needs before it can name a workspace.

**Three things about `applyStanding()` are the work; the rest is arithmetic.**
It puts `memberRole` on the PRINCIPAL rather than on the client, because
junction's `getTable()` re-derives its own scoped copy from `ctx.auth.user` and
would drop it. It builds a fresh object rather than mutating, because the WS
session is resolved once at upgrade, shared by every frame on that socket, and
frozen. And it re-resolves when the workspace changes mid-request — the
workspaces service addresses `ctx.id`, not the header, and without it an admin
of the workspace on screen carried level 5 into a patch of any other workspace
they could name.

**The levels were not designed, they were moved.** Each one is the
`requireWorkspaceRole` call the service was already making — into the one place
that also covers an engine calling a service in-process, a custom action nobody
wired a hook onto, and a where-clause built by hand. The hooks stay: a gate
refuses with a level, a person needs the sentence.

**262 green checks proved nothing about the gates and that is the trap.** The
drive signs in as the setup user, who is `isSystemAdmin` — SYSADMIN(7) clears
every gate in the schema. Eight checks now ask the same API as a second human,
and the one that matters is *a developer is refused `GET /secrets`*, asserted on
the message naming the level: no hook refuses that read, so it fails if
`memberRole` never reaches the principal. That is the only check that can tell
a working gate from a wired-up-but-inert one.

**`FJS-149` — `$transaction` on a scoped client handed the callback the ROOT
client.** `POST /setup` writes four models in one transaction as system and
failed with *"Account.create" requires SYSTEM access (use asSystem())* about a
call that was using `asSystem()`. The mirror image is the quiet one:
`$setAuth(u).$transaction(…)` ran with `auth()` null, so `@@allow` matched
nothing and `@createdBy` stamped nobody. The `query()` batcher on those same
proxies already kept its scope and says so in a comment; `$transaction` was the
one that did not.

Two smaller things fell out: `runSeeder` ran on the root client (STRANGER(0)) in
a file whose own header says everything runs as system, and `AuditEvent` at
LOCKED(9) means `db:seed --force` cannot clear the table — it lets the workspace
FK cascade do it.

**Not run: `example`'s browser drive.** The rule table says a litestone client
change wants it. Port 3600 was held by an `example` API from another session
that has been up since 03:50, running pre-change code; killing it is not mine to
do, and probing it would have proved the old build. The change is covered by
litestone's own 1461 (3 written for this), basecamp's 270 in a browser, junction
919, sierra 810 + `test:safety`.

---

## Older sessions

`docs/handoff-archive/2026-08.md` — every session before the two above, newest
first, unedited.

**Rotate when a third session lands here.** This file is read cold at the start
of every session, so it stays at two; the archive is unbounded and read only
when something specific is being traced. Nothing is deleted — the move is a cut
and paste, and the archive keeps its own newest-first order.

What an archived session is NOT: a statement about the current tree. Live
behaviour is `CLAUDE.md`, open defects are `ISSUES.md`, settled questions are
`DECISIONS.md`. If a session note and one of those three disagree, the three win
and the session note is history.

