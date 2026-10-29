---
id: kamal-parity
status: assessment
dated: 2026-10-28
---

# Idea — Kamal parity: what `fli deploy` shares with Kamal 2, and where FJS leaves it

**Status: ASSESSMENT.** Read 2026-10-28 against Kamal's command list
([view-all-commands](https://kamal-deploy.org/docs/commands/view-all-commands/),
fetched) and this tree's `fli ? deploy`, `fli ? basecamp` output. Nothing was run on a
box. Every Kamal claim past the command list comes from `paas-parity.md` § Deploying an
FJS app through the fleet and `release-transitions.md`, which fetched the pages in
October; a claim marked *(unfetched)* comes from neither.

**The question** (owner, 2026-10-28): is FJS's deploy setup different from Kamal's, and
should it just match Kamal's structure?

**The answer: Kamal is already ring 0's model, by three rulings, and the structure stays.**
`website/projects.json` (Rails, rank 21) says *Kamal 2 is already the FJS deploy model*;
[`FJS-D942`](../DECISIONS.md#fjs-d942) chose *build where `fli` runs, ship the image*,
Kamal's shape; `paas-parity.md` rows 3 and 6 took Kamal's path routes and health window.
What FJS adds sits outside the ring Kamal occupies, and is the reason Basecamp exists.
Four small things are worth taking from Kamal; § Phase 1 lists them.

---

## The command map

Ring 0 is `fli deploy` (`deploy-plane.md` § The bootstrap ring). Laid beside Kamal:

| Kamal | fli | Note |
| --- | --- | --- |
| `init` | `new`, `make:deploy` | the deploy block in `frontier.config.js` |
| `server` | `deploy:setup` | docker, bun, caddy, routes; `--auto-install` asks nothing |
| `setup` | `deploy --auto-install` | setup and deploy in one run |
| `build` | `deploy:vendor`, `deploy:local` | vendor the workspace, build and run the image here |
| `deploy` | `deploy` | journal-backed |
| `redeploy` | `deploy` | no second verb: preflight is idempotent and cheap |
| `rollback VERSION` | `deploy:revert --to`, `deploy:rollback` | revert restores the pair (Release, Generation) |
| `lock` | `deploy:unlock`; `deploy:status` prints it | `.deploy.lock` on the target: the run, who, when, which step; no expiry by design ([`FJS-D156`](../DECISIONS.md#fjs-d156)) |
| `audit` | `deploy:journal` | a litestone db on the target, not a log file |
| `app logs / exec / boot` | `deploy:logs`, `deploy:run`, `deploy:repl`, `deploy:status` | |
| `remove` | `deploy:retire` | also removes the deploy root and its database |
| `prune` | inside `09-cleanup` | `docker image prune --filter label=app=` after every swap |
| `proxy` | none exposed | Caddy routes written by `deploy:setup`; Outpost `ingress.js` |
| `accessory` | **none** | SQLite in a volume; no db or redis sidecar (§ Not taken) |
| `registry` | **none** | `docker save \| ssh docker load` ([FJS-2645](../ISSUES_ARCHIVE.md#fjs-2645)) |
| `secrets`, `config` | `deploy:doctor` | diffs the env file against `.env.example`; no dump of the effective block |
| `details`, `version`, `docs`, `help`, `upgrade` | `deploy:status`, `--version`, `?` | |
| — | `deploy:plan`, `deploy:pause`, `deploy:unpause`, `deploy:outpost` | no Kamal counterpart |
| — | `basecamp:create`, `install`, `dns`, `app`, `deploy`, `stop`, `destroy` | rings 1 and 2 |

Ring 0's surface is Kamal's minus accessory, registry and proxy, plus plan, pause,
journal and revert. The verbs that differ differ for a reason each, which is
`PHILOSOPHY.md` § IV's *familiarity vs. precision* decided verb by verb:

- `journal`, not `audit`: *audit* is the audit trail (Invariant 7), a different record.
- `retire`, not `remove`: the deploy root and its database go too, and the verb says so.
- `revert`, not `rollback`: `revert` restores the pair (Release, Generation);
  `rollback` is kept for the narrower thing Kamal's word means, an older image started.
- `setup`, `deploy`, `logs`, `run`, `status` already agree.
- `init` → `make:deploy`, `server` → `deploy:setup`: the FJS spellings follow the `fli`
  namespace rule (`make:*` writes files, `deploy:*` acts on a target), which Kamal has
  no counterpart to. No reason past that, so these are the two a rename could take.

## What FJS does that Kamal does not

1. **Three rings where Kamal has one.** Kamal is laptop → servers, and that is all of it.
   FJS: `fli deploy` installs Basecamp (ring 0), Basecamp makes boxes and installs
   Outpost by cloud-init (ring 1), Outpost pulls a digest and runs the swap while
   Basecamp records the `Deployment` (ring 2). `basecamp:create` makes the box through
   the DigitalOcean API, which is Forge's front door; Kamal's `setup` assumes the box.
   Matching Kamal's structure would mean deleting Basecamp.
2. **A journal and a Release, not a log file.** Kamal writes `.kamal/app-audit.log`,
   takes its lock as a directory, and prunes images after three days so a rollback target
   expires (`release-transitions.md` § The finding). FJS keeps a litestone db at
   `.fli/deploy.db` on the target ([`FJS-D746`](../DECISIONS.md#fjs-d746)), a
   content-addressed Release of digest ⨯ configuration ⨯ pinned secrets, `deploy:plan`
   printing the rows before anything runs, and `deploy:revert` restoring the pair and
   refusing by name (`--past-pivot`, `--past-retention`). Kamal's rollback starts an
   older image; FJS's revert knows the configuration and schema went with it.
3. **A deploy classified before it runs.** Basecamp holds the `.lite` of every app it
   deploys, so a deploy answers expand / contract / unknown before the swap
   (`deploy-plane.md` § What FJS has here that Coolify and Forge structurally cannot).
   Kamal sees an opaque image. The pivot classifier is why `--past-pivot` exists at all.
4. **The SQLite ceiling, chosen.** No accessories, no zero-downtime, the old container
   stopped before the new one starts (`setAside` in Outpost). Kamal's proxy and
   blue-green story exists for a stateless process over an external database. FJS copies
   the database before the swap (`05-backup`, litestream) and accepts the 3–10 s gap.
5. **Pause and unpause.** The edge refuses, the app keeps running, the journal records
   who and when. Kamal has no maintenance verb.
6. **The App is the environment.** With `BASECAMP_APP_ID` set, `fli deploy` becomes
   `basecamp:deploy` and the target flags are refused: a second environment is a second
   App. Kamal's `--destination` picks a config file. FJS's nouns (`App`, `Environment`,
   `Release`) come from a schema.

## Where Kamal is ahead

Each of these is small, and each is a row in Phase 1 or § Not taken.

- **A registry on 127.0.0.1, forwarded over SSH** (Kamal 2.8+, per `paas-parity.md`
  row 1). `docker save | ssh docker load` ships the whole tarball on every release and
  dedupes no layer. A local registry gets layer caching from Docker itself. The load route
  was chosen for having no moving part; the registry becomes worth it when a release of
  an unchanged base layer is measured slow.
- **`kamal config`** prints the merged configuration, secrets included. `deploy:doctor`
  grades the block and never shows it, so *what will this run deploy, where, as whom* is
  answered by reading `frontier.config.js` and the env resolution rules in one's head.
- **Kamal works end to end today.** FJS's chain has not run on a real droplet
  (`zero-to-live.md` 0.3, 0.4 open). That is the whole of Kamal's practical lead, and
  no rename closes it.

---

## Plan

### Phase 0 — Settle what this is held against

Goal: this file cites the ring it grades and nothing it grades is a Basecamp-only feature.
Done when: every row in Phase 1 names the `fli` verb it changes.

- [x] 0.1 Read Kamal's command list against `fli ? deploy` and `fli ? basecamp`; the
      table above is the result
- [x] 0.2 Check the prune and lock rows against the step files: prune is `09-cleanup`,
      and `deploy:status` already prints the lock's run, owner, time and step from
      `core/lock.js`, so neither is a gap

**Done 2026-10-28.** Two of the four candidate gaps closed by reading the code.
`decision-rules` caught the first draft describing the lock as a litestone `$locks`
row with a TTL; it is a file with no expiry, and `$locks` is reached by nothing but a
test.

### Phase 1 — Take what is worth taking

Goal: the one verb Kamal has that `fli deploy` answers only by reading source, and one
measurement.
Done when: 1.1's test passes and 1.2's number is written into its box.

- [ ] 1.1 `fli deploy:config`: print the deploy block this run would use, after the
      environment, `--server` and `--domain` are resolved, with the env file's keys named
      and values masked; `--values` shows them at a terminal, the spelling `env:list`
      uses. Kamal's `config`. A verb rather than a flag on `deploy:plan`, because the
      siblings are one verb per question (`status`, `plan`, `doctor`, `journal`) and the
      block is already derived: `deployConfFor` and `deployTargetFor` in
      `deploy/_module.md` resolve it, so the command prints what they return and computes
      nothing. What must stay true: the printed block is the block `deploy` runs. The
      test is a case in `test/deploy-helpers.test.js` taking both through the same
      resolver and comparing
- [ ] 1.2 Measure a release of an app whose base layer did not change through
      `basecamp:deploy`, tarball bytes and seconds, on the real droplet `zero-to-live.md`
      0.4 produces. Below a minute, the registry row stays in § Not taken; above it, open
      a step here for a loopback registry in `02-ship` and the Outpost load route

## Not taken

- **`accessory`.** A sidecar database or cache is the thing the SQLite ruling refuses
  (`deploy-plane.md` § The grading). `attachments` in `junction.config.js` is the FJS
  shape for a third-party service ([`FJS-D158`](../DECISIONS.md#fjs-d158)): declared,
  bound per Environment, never run by the deploy.
- **`proxy` as a user-facing namespace.** Routes come from the Domain and its path routes
  ([`FJS-D1040`](../DECISIONS.md#fjs-d1040)); a hand-edited proxy is the workaround the
  paved road replaces.
- **`registry`** until 1.2 says otherwise.
- **`lock` as a verb.** `deploy:status` prints the held lock and `deploy:unlock` drops
  it; `core/lock.js` names three readers and refuses a fourth.
- **Renaming to Kamal's verbs.** See § The command map.
- **`redeploy`.** One verb with an idempotent preflight is simpler than two verbs whose
  difference is which steps are skipped.

## See also

- `deploy-plane.md` — the three rings, and ring 0 as Basecamp's installer
- `paas-parity.md` — the six rows graded against Kamal, Dokku, Coolify and Dokploy
- `release-transitions.md` — what a Release records, and why Kamal's rollback target expires
- `zero-to-live.md` — the chain's first real run, which this file waits on
