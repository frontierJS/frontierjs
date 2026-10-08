---
id: app-manifest
status: proposed
dated: 2026-08-04
---

# Idea — the app manifest: declared intent, observed fact, and a filename that can be wrong

**Status: IDEA. Nothing here is built.** Dated 2026-08-04. There is no
`frontier.config.js`, no lock, and no filename-segment rule anywhere in the tree. Do
not cite this file as describing behavior — see `VERIFYING.md`.

Three proposals that only pay off together:

1. **Filename segments as falsifiable claims** — `users.service.ts` is not a label, it
   is an assertion the tooling can disprove.
2. **`frontier.config.js` + `frontier.lock`** — declared intent versus observed fact,
   at the app level.
3. **Reconcile between them** — the third leg is currently missing. It is written `fli doctor`
   throughout this file and that name is taken (`FJS-D133`): the reconcile belongs to `fli
   check`, or to a command of its own, and never to fli's own setup check:
   *boot the app and compare what it claims against what it mounted.*

---

## The observation

Three-quarters of this already exists by accident.

**Filename segments are already a vocabulary.** Measured across `packages/` and
`example/` on 2026-08-04:

```
115 .test.{js,ts}    18 .service.ts    15 .config.js
  8 .spec.js          5 .meta.js        3 .job.ts
  2 .engine.ts        1 .types.ts
```

Nobody designed that. It is small, it is consistent, and `.service.ts` already
carries real meaning — the stem is the registration name.

**A reconcile command already exists, for one realm.** `bun db/generate.js --check`
in `packages/basecamp` fails on migration drift. That is exactly the pattern, applied
to the Data realm only.

**An invariant is already waiting for a machine-readable home.** Invariant 14 —
*typecheck baselines ratchet down only* — lives in prose, with junction's `212`
written in a markdown table. Nothing enforces it.

What is missing is the thing that binds them: a place where an app says what it is
meant to be, a place where the tooling records what it actually is, and a command
that diffs the two.

---

## Part 1 — a filename segment is a claim, not a label

The obvious argument for `users.service.ts` is that a human knows what to expect
without opening it. That is the weaker half. The stronger half:

> **The segment is an assertion the tooling can falsify.**

`payments.service.ts` claims *this file registers a service named `payments`*. That
claim can be wrong, and when it is wrong nothing today says so. `packages/basecamp`
is the proof: `workspaces` looked exactly like a service with role enforcement and
enforced nothing, because its hook read a `workspaceId` that nothing set. Every
filename was correct. Every claim was false.

### The rule that stops segment sprawl

Feathers shipped four segments (`.service`, `.hooks`, `.class`, `.schema`). A
framework that grows to fifteen has made filenames harder to read than files. The cap
should not be a number, it should be a principle:

> **A filename segment exists if and only if the file contributes to a registration
> point** — something that lands in the route table, in `app.<thing>`, or in a
> plugin/job/channel registry.

That ties the vocabulary to **Invariant 5** (*one owner per `app.<thing>`*), which
means it cannot drift: the segment list *is* the registration-point list. If a file
registers nothing, it has no segment and is a plain module.

Applied to the API realm:

| Segment | Registers into | The claim doctor can check |
| --- | --- | --- |
| `users.service.ts` | `app.service('users')` + route table | mounts under the stem; stem passes `accessorCandidates()` against a model |
| `users.hooks.ts` | that service's pipeline | the named service exists |
| `mailer.plugin.ts` | `configure()` | default export has `name` + `register`; **`register` is sync** — `configure()` never awaits it |
| `nightly.job.ts` | `app.jobs` (caravan) | registered before `runStartPhases` |
| `welcome.notification.ts` | `app.notify` | — |
| `stripe.target.ts` | `app.conduit.send()` | declared target exists |
| `users.test.ts` | the suite | — |

And the ones that fail the rule and should therefore *lose* their segment or earn a
real one: `.types.ts`, `.core.ts`, `.utils.ts`, and today's `.engine.ts` (×2 in
basecamp) — either it registers into something and gets a proper segment, or it is a
plain module.

The payoff is that **audit becomes `readdir`-cheap**. Doctor does not need to parse an
AST to know what an app claims; it needs a directory listing. Parsing is then reserved
for checking whether the claim is true.

---

## Part 2 — the manifest is Terraform, not npm

The tempting analogy is `package.json` + lockfile. It is the wrong one, and the wrong
one in a way that will cause damage: `node_modules` is 100% derived and disposable, so
`rm -rf` + reinstall is always safe. An app is not. `api/src/users.hooks.ts` is
hand-written and no config will ever regenerate it.

The right analogy is **Terraform**: desired state (`.tf`) + observed state
(`.tfstate`) + `plan` (diff) + `apply` (reconcile). Same shape in Kubernetes (spec vs
status) and Nix (`flake.nix` + `flake.lock`). Terraform has also already absorbed the
hard lessons this will hit — drift, refresh, and importing a resource that already
exists.

| | `frontier.config.js` | `frontier.lock` |
| --- | --- | --- |
| Who writes it | human | `fli` only |
| What it is | **intent** — the choices a schema cannot derive | **fact** — what the app actually is |
| Hand-edited | yes | never |
| How produced | typed | **by booting the app**, not by parsing it |

### Config holds only what the schema cannot derive

`CLAUDE.md` opens with *everything derives from `db/schema.lite`*. A config that
restates fields creates a second source of truth and the drift is then between two of
the project's own files. Test for every key: **could this come from `.lite`?** If yes,
delete it.

```js
// frontier.config.js
export default {
  services:  { include: ['User', 'Project'], exclude: ['AuditEntry'],
               actions: { deployments: ['restart', 'rollback'] } },
  resources: { User: { plural: 'users' } },   // irregular plurals — schema-registry.js needs these
  plugins:   ['@frontierjs/auth', '@frontierjs/caravan'],
  targets:   { web: 'spa' },
}
```

Three buckets, and a key that fits none of them does not belong: derivable → `.lite`;
secret → env; a choice → config.

### The lock records a boot, not a parse

```jsonc
{
  "packages":  { "@frontierjs/junction": "…", "litestone": "1.1.0" },
  "schema":    { "hash": "…", "migrationHead": "0007_add_env" },
  "services":  { "users": { "methods": [...], "model": "User", "channel": "users" } },
  "routes":    ["GET /users", "POST /users/{id}"],
  "plugins":   ["auth", "caravan", "mailer"],   // configure ORDER — `requires` is checked against it
  "jobs":      ["nightly-prune"],
  "baselines": { "junction": 212 }
}
```

That last line is the sleeper. **Invariant 14 becomes mechanical**: `fli doctor
--check` fails when a baseline goes up. An invariant that currently depends on someone
remembering starts enforcing itself.

---

## Part 3 — the reconcile, which is doctor's missing third leg

The diagnostics record (since deleted, ruled as `FJS-D133`) proposed a rule registry over source text and schema. This adds
the leg that catches what text cannot:

| Leg | Source | Cost |
| --- | --- | --- |
| **Intent** | `frontier.config.js` — 8 services declared | read one file |
| **Claim** | filesystem — 8 files named `*.service.ts` | `readdir`, no parse |
| **Fact** | boot the app; `routePaths()` / `hasExactRoute()` | one boot |

Drift is then a set difference, and each direction has a distinct meaning:

- config declares `refunds`, no `refunds.service.ts` — **scaffold is behind**
- `refunds.service.ts` exists, never mounted — **the filename lies; dead code**
- `legacy.service.ts` on disk, absent from config — **config is stale**

`hasExactRoute()` and `routePaths()` already exist for precisely this and are already
documented in § Live hazards as the correct way to ask "is this mounted" (`hasRoute()`
is a matching question, not an existence one). The machinery is present; nothing
currently asks the question at app scope.

**Build the lock from a boot on day one.** A parse-derived lock is easy to ship and
never gets fixed afterwards, and a parse-derived lock is only the filename claims
again in a larger file — it would have recorded `workspaces` as enforcing roles.

---

## Scaffold: what you can actually hand someone

The shareable unit is **the pair**, not the config alone:

```
frontier.config.js   ← the choices
db/schema.lite       ← the data
```

Which splits on this framework's own realm boundary rather than an invented one. WASP
crams entities, routes and auth into `main.wasp`; here the data half already has a
better language than a config block would be.

Two modes, and the second is the honest one:

- **Empty directory + the pair → a genuinely runnable app.** Model services, gates,
  validation, migrations and CRUD UI are all derivable today. This is `create-frontier`
  (overview 1.2) with an input.
- **Existing app + config → report only.** Every hand-written hook is what Terraform
  would call unmanaged state.

The bridge between them is ownership marked in the filename — the same mechanism as
Part 1, one segment further:

```
users.service.gen.ts   ← fli owns it; overwrite freely
users.service.ts       ← you own it; doctor reports drift, never edits
```

Precedent for `.gen.` as *generated, never hand-edit*: Dart's `user.g.dart` and
`user.freezed.dart`, protobuf's `_pb2.py`. Precedent for the whole share-a-file move:
`rails new -m template.rb`.

## Shape

```
fli scaffold -c frontier.config.js   # empty dir → app
fli doctor                           # three-way report: config × disk × booted
fli doctor --check                   # CI; non-zero exit on drift
fli doctor --fix                     # rewrites .gen.* only, never yours
fli lock                             # boot, record observed state
```

`doctor` with no flags prints the plan. Terraform got that right and everything since
has copied it. `--check` matches the precedent already set by
`basecamp/db/generate.js --check`.

## Why this is worth more here than in another framework

- **The claims are checkable only because the derivation exists.** `users.service.ts`
  can be checked against `model User` ⇄ `db.user` because `accessorCandidates()` is
  already the shared resolver for query, gate and validation. A framework whose
  authorization lives in handlers has nothing to compare a filename to.
- **It closes a failure class that has already cost this project weeks.** Silent
  non-registration and silent non-enforcement are the two most expensive bugs in the
  ledger. Both are set differences once the three legs exist.
- **It gives agents a cheap, structural read of an app.** `readdir` plus a config is a
  complete picture of intent before a single file is opened — the same argument
  `IDEAS/agent-surface.md` makes one layer down.

## What would have to be built

1. **The segment vocabulary, as a rule** — seven segments, each tied to a registration
   point, each with one assertion. Additive; `.service.ts` already behaves this way.
2. **`frontier.config.js`** — a schema for it, and the three-bucket test enforced.
3. **`fli lock`** — boot in the existing test path (`runStartPhases`, `needsHost`
   phases skipped) and serialize the registry. This is the load-bearing piece.
4. **The diff** — three-way, one direction per message, as rules in the
   `fli check` registry (`FJS-D133`) rather than a separate command.
5. **`fli scaffold -c`** last. It is the demo, but it is worth nothing until the
   reconcile exists, because a scaffold you cannot re-run is `fli make:*` with extra
   steps.

## Open questions and known hazards

- **Executable config cannot be audited.** `vite.config.js` is why nothing can
  statically reason about a Vite app, and `package.json` is JSON deliberately. Options:
  require `frontier.config.js` to export a **plain object literal** — no imports, no
  computation, no env reads, enforced by doctor (precedent: the workflow `meta` rule) —
  or drop to `.json`/`.toml` and stop pretending. Unresolved, but the status quo of
  "arbitrary JS" should not win by default.
  - **A** — arbitrary JS, as built: `loadFrontierConfig` (`packages/cli/core/utils.js`)
    `import()`s `frontier.config.js` and `junction.config.js` is loaded the same way.
  - **B** — JS, but the default export must be a plain object literal — no imports,
    no computation, no `process.env` reads — enforced by a `fli check` rule.
  - **C** — `frontier.config.json` (or `.toml`), parsed rather than run.
  - **Recommend B** — it makes the file readable without running it and keeps the
    comments that carry basecamp's `frontier.config.js`, which JSON would strip. A
    value that needs computing is a secret (env) or derivable (`.lite`), which is the
    three-bucket test doing its job.
- **Config sprawl is the default outcome.** webpack and Vite both got here. The
  three-bucket test is the only defense proposed and it needs teeth.
  - **A** — the three-bucket test as prose, as today; nothing refuses an unknown key
    in `frontier.config.js` or `junction.config.js`.
  - **B** — each config file has a closed key table, and its loader refuses an
    unknown key by name, pointing at the bucket it belongs in (`.lite`, env, or the
    other config file).
  - **C** — B, plus a `fli check` rule that flags a config key whose value a schema
    read could produce (a model list, a plural).
  - **Recommend B** — the closed table is the teeth: a key nothing reads is a typo
    or a restated fact, and both are silent today. C is a heuristic over values and
    would grade on guesses, so it waits until a real restated key shows up.
- **Deploy config and shareability are enemies.** The moment `deploy: { host, domain,
  tenant }` lands inline, "pass this file around" becomes "leak your infrastructure."
  Reference it; do not inline it.
  - **A** — as built: `frontier.config.js` IS the deploy file (`deploy.server`,
    `deploy.web.domain` inline, basecamp's copy), the app's own config is
    `junction.config.js`, and the shareable unit is `db/schema.lite` plus
    `junction.config.js`, never `frontier.config.js`.
  - **B** — split `frontier.config.js` into an intent half (shareable) and a deploy
    file it references by path.
  - **C** — keep `frontier.config.js` but move `server` and `domain` out to env or
    the per-run `--server` alias, so the file holds no infrastructure.
  - **Recommend A** — the name already went to deploy, and most of the intent block
    this paper wanted is derivable or already lives in `junction.config.js`
    (`FJS-D158`'s split). Calling the deploy file unshareable costs nothing; B builds
    a third config file for keys that have no home yet.
- **Lock merge conflicts.** `package-lock.json` is the most-hated file in the JS
  ecosystem for this reason alone. Stable key order, sorted arrays, one fact per line,
  and regenerate-on-conflict must always be correct — nobody hand-merges a lock.
  - **A** — regenerate on conflict, as the committed `*.snapshot.md` registers work
    today: the header names the generator and its flags, and the `snapshots` CI phase
    fails a stale one.
  - **B** — A, plus a git merge driver (`.gitattributes` `merge=fli-snapshot`) that
    reruns the generator during the merge.
  - **Recommend A** — the lock this paper describes already exists as
    `surface`/`jobs`/`notifications`/`principal.snapshot.md`, sorted and regenerated,
    and CI already refuses a hand-merged one. A merge driver is per-clone setup that
    a fresh clone silently lacks.
- **Do not repurpose borrowed segments.** `.server`/`.client` mean bundle-side
  everywhere (Remix, Vite, SvelteKit); `.test`/`.spec` are owned by runner globs;
  `.d.ts` by TypeScript; `.config.js` is already used 15× here.
  - **A** — a closed segment list, derived from the loaders (`.service.ts`,
    `.job.ts`, `.notification.ts`, …); a segment not on it means nothing to `fli`.
  - **B** — a deny-list of borrowed segments that a `fli check` rule refuses.
  - **Recommend A** — the list of loaders is the allow-list, so a borrowed segment
    can only be repurposed by adding a loader for it, which is a reviewed change. A
    deny-list is a second list that goes stale the day the ecosystem coins a segment.
- **Lowercase always.** macOS and Windows filesystems are case-insensitive, so
  `Users.Service.ts` and `users.service.ts` are the same file.
  - **A** — lowercase stem and segment always; `PaymentReceived.notification.ts`
    becomes `payment-received.notification.ts`.
  - **B** — the segment is always lowercase and the stem takes the case of the name it
    registers: PascalCase for a type (`OrderPaid.notification.ts`, `Lead.mesa` per
    Invariant 19), kebab for a routed name (`user-profiles.service.ts`,
    `send-email.job.ts`); a `fli check` rule refuses two files that differ only in
    case.
  - **Recommend B** — the tree already does B and two rules depend on it
    (notifications stamp the type from the stem; Invariant 19 names a resource file
    for its model). The real hazard is the case collision, and the check names it
    directly.
- **Directory or segment, not both as truth.** `src/services/users.service.ts` is fine,
  but one of them has to be authoritative when they disagree. Segment is the better
  candidate; Invariant 18 currently locates `.mesa` resources by directory, so this
  needs settling rather than assuming.
  - **A** — segment authoritative: a `*.service.ts` anywhere under `src/` loads.
  - **B** — directory authoritative: every file in `services/` loads; the segment is
    decorative.
  - **C** — as built: both are required (the junction loader globs
    `services/**/*.service.ts`, caravan `jobs/*.job.ts`), and `fli check` refuses a
    loaded segment outside its kind's folder by name.
  - **Recommend C** — `FJS-D625` already put every file in its kind's folder and
    made an unsuffixed file in a loader's folder a private helper, so the two answer
    different questions: the folder says where, the suffix says it registers. What
    is missing is the refusal, because a stray `*.service.ts` today is never loaded
    and nothing says so.
- **Does the lock belong in version control?** Everything about the analogy says yes,
  and everything about "it is produced by booting" says it will be noisy. Possibly
  committed but coarse — registrations and baselines, not routes.
  - **A** — committed, routes included, as the four `*.snapshot.md` registers are.
  - **B** — committed but coarse: registrations and baselines only.
  - **C** — never committed; generated on demand by `fli app:atlas`.
  - **Recommend A** — that is what ships, and the noise is the point: a route that
    appears in a diff is a change a reviewer should see. Coarsening it would hide the
    routes, which are the claims most likely to be silently wrong.
- **Overlap with `atlas` and `project:map --json`.** Same substrate as
  the diagnostics record's open question (since deleted). The lock may simply *be* `project:map`'s
  output, committed.
  - **A** — the lock is the four committed `*.snapshot.md` registers; `fli app:atlas`
    and `fli project:map` render them from one boot and commit nothing.
  - **B** — a fifth file, `frontier.lock`, holding `project:map --json`, committed.
  - **Recommend A** — A is what ships (`commands/app/atlas.md`: a fifth file derived
    from four gated ones would be a second origin). `frontier.lock` as a name is
    retired with it.

## See also

- `IDEAS/ecosystem-gaps.md` — `create-frontier` (overview 1.2); `scaffold -c` is that
  command with an input
- `IDEAS/agent-surface.md` — the same "hard to get wrong" argument, one layer down
- `CLAUDE.md` § Invariants 5, 14, 17, 18 — what the vocabulary and the lock enforce
- `packages/basecamp/db/generate.js --check` — the existing reconcile, Data realm only
