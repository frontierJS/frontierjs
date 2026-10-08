---
id: rigs
status: proposed
dated: 2026-08-02
---

# Idea — Rigs: installable full-stack modules

**Status: IDEA. Nothing here is built.** Dated 2026-08-02. No code in this repo
implements any of it. Do not cite this file as describing behavior — see
`VERIFYING.md`.

**Vocabulary:** *Rig* is ruled (`FJS-D630`) and blessed in `ARCHITECT.md` §2 — a
package assembled from realm parts, any subset of which an app installs; its
`service/` part is a Plugin. The rigs today are notifications, orion and auth;
notifications is the reference rig. The format below is still unbuilt.

---

## Trigger

Wasp's post, *"JavaScript still can't ship a full-stack module"*
(https://wasp.sh/blog/2026/06/22/javascript-still-cant-ship-a-full-stack-module).

Its argument: shipping a reusable vertical feature (payments, auth, uploads) needs
three things — (1) a way to distribute runtime code, (2) a way to distribute the
**glue** that wires frontend/backend/database together, (3) an installable unit
format. npm gives JS (1) and (3). Nothing gives it (2), so every full-stack
feature is hand-assembled per app. Wasp's answer is its spec file: a TS config
declaring routes, queries, actions, jobs, which a module can contribute to.

## Where FrontierJS actually stands against that

Ahead on the glue, behind on the packaging.

**Ahead — the glue is derived, not declared.** Wasp's spec file is still glue you
write. Ours is read out of `db/schema.lite`: `packages/junction/example/elegant.ts`
gets CRUD, 400s from `@length`/`@email`/`@gte`, 401s from `@@gate`, pagination,
the envelope, and WS broadcast from a six-line service. One seed, three realms.

**Ahead — gates travel with the model.** A rig shipping `@@gate` and `@@allow`
in its schema fragment carries its authorization into the consuming app, enforced
at the Data boundary. Wasp modules can't express that; their auth lives in
handlers. This also answers the article's "AI-generated integrations are a
security risk" point — a Gate on a Model is much harder for an agent to get wrong
than a check in a handler.

**Ahead — composition, not codegen.** The Plugin protocol
(`{ name, register, boot, ready, shutdown }`, `packages/junction/src/core/app.ts`)
is runtime composition; caravan, conduit, auth, and notifications already attach
through it. Wasp compiles. Escape hatches cost us nothing.

**Behind — schema fragments are pasted, not imported.** `fli auth:install` string-
appends models into `schema.lite`. This is exactly what the article criticizes
RedwoodJS for. The proof it's a gap is already in-tree: the same auth schema
exists twice, in `packages/auth/schema.ts` and `packages/cli/commands/auth/install.md`,
carrying a "KEEP IN SYNC" comment.

**Behind — no installable unit.** Nothing declares what a package contributes.
Installing notifications today is: paste a model, configure `mailerPlugin`, then
`notificationsPlugin`, in that order (`packages/notifications/examples/wiring.ts`).
Four steps and an undeclared ordering constraint, versus the article's bar of "2
env vars and 2–3 lines of config."

**Behind — no UI half.** The article's unit is a vertical slice including its
frontend. Ours are Data+API only. Sierra routes come from the consuming app's file
tree; a package cannot contribute a Resource. Notifications ships the record and
the WS event but no bell.

**The cautionary tale.** Notifications is our closest thing to a rig.
Its Model lives in a *comment block* inside `examples/wiring.ts`, its email bodies
are empty, and it has no test script. That is what "rig isn't a
first-class unit" looks like from the inside.

---

## The design

### Partition by realm

The realms are the partition, so "I want the API but not the frontend" is not a
special case — it's *take the Service part, skip the Resource part*. Each realm
already has its own install mechanism, so the parts are genuinely independent.

### The folder is the manifest

The lesson from Vite/Rollup: a plugin declares only the hooks it implements.
There is no `parts: []` enumerating what you have — presence *is* declaration.
Applied here, directory layout replaces the manifest. Folder names come from
`ARCHITECT.md` §2's nouns: Data → **Model**, API → **Service**, UI → **Resource**.

```
@frontierjs/notifications/
├── package.json
├── model/
│   └── schema.lite               → Data part.    imported, migrated
├── service/
│   ├── index.ts                  → API part.     default export = Plugin
│   ├── notify.ts
│   └── drivers/
├── resource/                     → UI part.      ejected into consumer tree
│   ├── routes/
│   │   └── notifications/
│   │       └── index.mesa                        → /notifications
│   └── components/
│       └── NotificationBell.mesa
├── suite/
│   └── notifications.test.ts     → Testing part. runs against the consumer app
└── .env.example                  → the env prompts
```

Everything a declarative manifest would have held is inferred:

| Would be declared            | Inferred from                                                        |
| ---------------------------- | -------------------------------------------------------------------- |
| which parts exist            | which directories exist                                              |
| schema path                  | `model/*.lite`                                                       |
| plugin entry                 | `service/index.ts` default export                                    |
| route table                  | `resource/routes/` file tree — the rule Sierra already uses          |
| exported components          | `resource/components/*.mesa`                                         |
| part interdependencies       | realm direction: Resource → Service → Model (the rule we enforce)    |
| env vars + prompts           | `.env.example`; the comment above each var is the prompt             |
| eject policy                 | default: `resource/` ejects, `model/` and `service/` link            |
| "run migrations"             | a `model/` exists                                                    |

`service/index.ts` needs no new format — `packages/conduit/src/plugin.ts` already
returns `{ name, register, boot }`. The API part of a rig *is* a Junction plugin.

### `rig.ts` — optional escape hatch

Only for what no directory can express. Two of the six candidate rigs in this
repo would have one:

```ts
export default {
  after: ['mailer'],            // real prerequisite ordering — not inferrable
  ui:    '@acme/billing-ui',    // UI half lives in a separate package
}
```

`after` is the honest survivor. Today that constraint exists only as a comment in
`packages/notifications/examples/wiring.ts`, where the installer can't act on it.

### Parts that don't live together

A part may ship as its own npm package, so backend-only consumers never pull Mesa
or the CSS package into their tree, and a community UI can sit on top of an
official API:

```
@acme/billing/               @acme/billing-ui/
├── model/schema.lite         └── resource/
├── service/index.ts              ├── routes/billing/index.mesa
└── suite/                        └── components/PlanPicker.mesa
```

Found by naming convention (`<name>-ui`) or by the `ui:` line in `rig.ts`.

### Link vs eject

Opinionated, per-part, and the thing Wasp cannot express because it compiles the
whole unit:

- `model/` and `service/` stay **linked** — schema imported from `node_modules`,
  plugin composed at runtime, upgrades flow through npm.
- `resource/` is **ejected** — copied into the consuming tree, theirs to restyle,
  never overwritten.

You will always want to restyle a bell. You never want to fork a migration.

### The Suite part

A rig shipping conformance tests that run against the *consuming* app is how
"I installed only the Service part" gets verified rather than assumed. Nobody in
the ecosystem does this and it is cheap for us — per-package test runners exist.

*Caveat added 2026-08-03:* cheap, but not free — there is no shared test environment
for a `suite/` part to run *in*. Four different runners, no way to stand up a seeded
app across realms, and no CI to run `rig:doctor` from. See
the testing-and-ci record (since deleted); this part and that idea unblock each other.

### CLI surface

```
fli add @frontierjs/notifications                     # interactive: which parts?
fli add @frontierjs/notifications --parts model,service   # scriptable / agent-friendly
fli rig:list                                        # installed rigs, parts, drift
fli rig:doctor                                      # run every installed rig's suite
```

The interactive walkthrough falls out of the layout: the CLI has the part list,
the realm-direction graph, and the `.env.example` prompts, so it asks exactly the
right questions. The scriptable form is the AI argument from the article — one
command an agent gets right, versus four ordered wiring steps it gets wrong.

Consumer tree after `--parts model,service`:

```
db/schema.lite      + import "@frontierjs/notifications/model/schema.lite"
api/server.ts       + app.configure(notifications())      ← placed after mailer
.env                + RESEND_API_KEY=
```

---

## What would have to be built

Ranked. Only the third is real work.

1. ~~**Bare-specifier `.lite` imports.**~~ — **built.** `import "@frontierjs/notifications/schema.lite"`
   (or `@frontierjs/auth/schema.lite`) resolves through the package's own
   `exports` map, the same door that killed the auth schema hand-copy.
2. **The installer.** Read the directory layout, resolve parts, apply the three
   consumer edits, order `configure()` calls by `after`. Mostly calling things
   that already exist.
3. **Sierra contributing Resources from a package.**
   `packages/sierra/src/build/scanner-plugin.js` is file-tree-only. Deferrable:
   with `eject: true` as the default, v1 copies routes into `src/routes/` and the
   scanner never changes. When `eject: false` is wanted later, merge rig routes
   into `virtual:sierra` the way `build/schema-plugin.js` already merges schemas,
   rather than walking `node_modules`.

Steps 1–2 ship Model+Service rigs — linked, partially installable,
conformance-tested — without touching Sierra.

---

## The rig that should come first — teams, memberships, invitations

Added 2026-08-15. `IDEAS/ecosystem-gaps.md` nominates **billing** as the canonical
first rig and the proof the format works. Billing is the right *commercial* first
rig and the wrong *structural* one, and there is a better candidate that nothing in
`IDEAS/` currently mentions at all: a grep across every record for `invite`,
`invitation`, `membership`, `organization` or `organization` returns nothing on point.

**It is the largest thing this repo has already built by hand.** Basecamp declares
`Workspace` and `WorkspaceMember`, a five-rung role ladder (viewer/billing → READER,
developer → USER, admin → ADMINISTRATOR, owner → OWNER), `applyStanding()` resolving
membership onto the principal once per request, a `/hub/` tier above every workspace,
and fifteen models carrying `@@allow('all', workspaceId == auth().workspaceId)`. That
is a rig with the packaging removed. Every B2B application built on FJS writes it
again, and writes it slightly differently.

**Why it is the better proof than billing.** Billing contributes models, a service and
a screen — three parts of a format that has four. Teams contributes all four *and* the
one thing no rig has had to carry: **an input to the gate**. Only one
`GatePlugin({ getLevel })` may be installed, so a rig that supplies standing either
owns the ladder outright — which forbids an app having any second source of standing —
or contributes a **fragment** the app composes into its own `getLevel`, the way
`authSchemaFragments(db)` already contributes into the seed rather than replacing it.
That question has no answer today, it is the sharpest unanswered thing about the rig
format, and billing would never have surfaced it.

**Invitations are the part everyone underestimates**, and they are the part that makes
this a rig worth shipping rather than a snippet worth copying: a token, an expiry, an
email, an accept that creates a membership at a stated role, a re-invite that does not
duplicate, and a revoke. That is `pending → accepted | expired | revoked` — a state
machine, which means the rig *demonstrates* `@@transitions` at the Data boundary
rather than merely using the framework. A rig whose value is visible in the schema
diff is the one to lead with.

**Design it with two neighbors, not after them.** `FJS-D05` (row tenancy, 4.18)
is the mechanism for *which rows*; `warden` (4.5) is the mechanism for *which
permissions*; this is the *noun* both of them are about. Settled apart, they produce
three vocabularies for one idea — the same failure `IDEAS/release-transitions.md`
records between an Audience and a tenant. Blocked on the same two items everything
here is blocked on: bare-specifier `.lite` imports and the installer.

---

## Open questions

- ~~**Does `Slice` get adopted in `ARCHITECT.md` §2, and what happens to `Plugin`?**~~ **Answered 2026-10-07 (`FJS-D630`): C — adopt *Rig*: a package assembled from realm parts, any subset of which an app installs; a Rig's `service/` part is a Plugin.**
  A Plugin adds behavior to a running app; a Slice is a distributable package that
  *contains* a Plugin. They are not competing for the same slot, but the boundary
  needs a ruling.
  - **A** — not yet: `FJS-D06` § 7 stands, and Plugin keeps its slot.
  - **B** — adopt *Slice*, the word this file already uses.
  - **C** — adopt *Rig*: a package assembled from realm parts, any subset of which an app installs; a Rig's `service/` part is a Plugin.
  - **Recommend A** — FJS-D06 already answers this: § 7 defers the word until
    `fli add <slice>` is on the table or a third party ships one, and Plugin keeps
    its slot as what attaches a capability to a running app.
- Upgrade path for ejected Resources — none, by design. Is that acceptable, or is
  there a middle state (ejected but diff-able against the package version)?
  - **A** — none: an ejected file is the consumer's, and the package never speaks
    about it again.
  - **B** — the installer records the package version and a content hash per
    ejected file; `fli rig:list` shows which files drifted from what was ejected
    and the upstream diff since, and never applies it.
  - **C** — no eject: link `resource/` and let the consumer override named slots.
  - **Recommend B** — the record is written once at eject time by an installer that
    has to exist anyway, and it turns *upstream fixed a bug in a file you own* from
    silent into a line in a listing. C gives up the restyle promise that is the
    reason to eject.
- Should `suite/` run against the consumer app in CI by default, or on demand?
  - **A** — by default: an installed rig's suite is collected into the consumer's
    own `bun run test`, so it runs wherever the app's tests run.
  - **B** — on demand, through `fli rig:doctor`.
  - **Recommend A** — the suite exists to catch the consumer breaking the rig (a
    hook that strips a field, a gate the app tightened), and an on-demand check is
    one nobody runs until the break has shipped. `@frontierjs/testing` now gives it
    an app to run in.
- Does a rig get an `upgrade/` part — codemods it ships to move a consumer across
  its own breaking changes? A rig that renames a model or changes a service key has
  the framework-upgrade problem in miniature, and the ejected `resource/` part makes
  it worse: linked parts upgrade through npm, but ejected files are the consumer's
  and will not. See `IDEAS/ecosystem-gaps.md` tier-2 item 10.
  - **A** — yes: `upgrade/<version>.ts` codemods, run by the installer on upgrade,
    over linked references and ejected files alike.
  - **B** — no codemods: linked parts move through npm and the rig's own
    migrations; ejected files get the drift report from the eject question above,
    and the rig's `CHANGES.md` says what broke.
  - **Recommend B** — a codemod over an ejected file edits a file the rig promised
    never to touch, and over a linked part it is redundant with npm plus a
    migration. B costs nothing beyond the eject record already recommended.
- Does a Rig declare a Litestone version range in its `package.json` peer-deps?
  Not a blocker — litestone 1.1.0 is published and npm `latest` points at it as of
  2026-08-02 (verified: `npm view` dist-tags, and the published tarball's `SCALARS`
  carries `Int/String/Float/Bytes`), so a rig shipping a `model/schema.lite` in
  the current dialect parses against registry litestone. Open only as a question of
  whether the peer range should be mandatory for a rig and who enforces it.
  - **A** — mandatory peer range on `@frontierjs/litestone`; the installer refuses a
    rig without one.
  - **B** — optional; npm's own peer warning is the only enforcement.
  - **C** — no range required: the installer parses the rig's `model/*.lite`
    against the consumer's installed litestone and refuses by name on failure.
  - **Recommend C** — the question a range answers is *does this schema parse here*,
    and parsing it answers that directly where a range only restates it and can be
    wrong without anything saying so. A range becomes worth requiring once a
    rig's `service/` part imports litestone API, which none does yet.
- Deployment (Release) is unrepresented above. Does a rig contribute ports,
  secrets, or migration ordering to `fli deploy`?
  - **A** — nothing beyond what already flows: the rig's schema joins the app's,
    so there is one migration stream, and its `.env.example` lines join the app's,
    which `envCheck` already grades.
  - **B** — A, plus an external service the rig needs is declared as an
    `attachments` entry (`FJS-D158`) the installer adds to `junction.config.js`.
  - **C** — a rig may contribute processes and ports to `fli deploy`.
  - **Recommend B** — a rig that needs a mail server has exactly the
    half-bound-at-3am problem `FJS-D158` solved, and the declaration already has an
    owner. Ports are moot: the API part is a plugin inside the running API and owns
    no process.
- **The fragment question has a second seam, and one ruling should cover both.**
  The `getLevel` problem above — only one `GatePlugin({ getLevel })` may be installed,
  so a rig supplying standing either owns the ladder or contributes a fragment — is
  the same shape conduit has for credentials: only one `CredentialResolver` may be
  installed on a conduit, so a rig supplying per-user third-party credentials either
  owns resolution outright or contributes a fragment an app composes. Noticed
  2026-08-24 while scoping `third-party-credentials.md`; `authSchemaFragments(db)` is
  the precedent for both, and settling them apart is how one idea grows two
  vocabularies.
  - **A** — the rig owns the seam outright: it installs the one `GatePlugin` or
    the one `CredentialResolver`, and an app with a second source must fork it.
  - **B** — the rig exports a fragment, a plain function the app composes in its
    own `getLevel` or resolver, the way an app's `getLevel` already wraps
    `sessionGateLevel` and `withCache(inner)` wraps a resolver.
  - **C** — a framework registry: rigs register fragments and the framework
    composes them in a declared order.
  - **Recommend B** — it is the shape both seams already compose by, so it adds no
    concept, and the composition order sits in the one file the app owns, where a
    reader can see it. C makes the framework a second owner of an order that only
    the app knows.

## See also

- `ARCHITECT.md` §2 — the realm nouns these folders take their names from
- `PHILOSOPHY.md` — the "growth happens outward and traces back" axiom this serves
- `DECISIONS.md` — where a ruling on `Rig` would land
