---
id: fli-profiles
status: partial
dated: 2026-11-05
---

# fli profiles — one machine, several clients' credentials

**Status: PARTIAL.** Dated 2026-11-05. Phase 1 and step 2.1 are built
(2026-11-12): the layer, `eset --profile`, the `fli doctor` rows and the
profile as each outward command's first line; the behavior is described in
`packages/cli/docs/configuration.md` § Credentials, not here. 2.2 is the
owner's; Phases 3–4 are not built — see `VERIFYING.md`.

The want: one person runs `fli` for several clients from one machine, and each
client has its own GitHub org, DigitalOcean and Cloudflare accounts, Basecamp
and support endpoints. Today every one of those is a single line in
`~/.config/fli/.env`, so changing client means editing that file. The owner's
copy shows how that's done today: two commented-out `GITHUB_TOKEN` lines and
a commented-out `SUPPORT_ELA_URL` next to the live ones. The failure this
invites is a deploy, publish or `eset` that spends client A's token from
client B's repo.

Basecamp hit the same shape once and fixed it by key: `FJS-1020` found one
install could hold exactly one DigitalOcean token shared by every workspace,
and a vendor credential is now a `Secret` owned by its workspace
(`FJS-D1491`). This paper is the CLI's half.

---

## What exists

- **`loadFliEnv`** (`packages/cli/core/utils.js`) loads the project `.env`,
  then `~/.config/fli/.env`; `loadEnv` never overwrites a set key, so the
  order is shell → project → global. `test/load-env.test.js` pins it
  (`FJS-2631`).
- **`global-env.js`** owns the global path (`globalEnvPath`) and its writer
  (`storeGlobal`, behind `fli eset --global`). Its header separates it from
  `~/.fli/`, which holds machine state and never a secret.
- **The global file mixes two kinds of key** — checked 2026-11-12 by `rg`
  over this tree, `~/code` and `~/.claude/skills`:

  | Key | Kind | Read by |
  | --- | --- | --- |
  | `ME` | machine | `basecamp:install`/`reinstall`/`key` (first admin), `core/basecamp-backups.js` |
  | `KSITE_DIR` | machine | only the retired `FRONTIER/cli` (`site:update`) and ksite docs |
  | `SUPPORT_DRAFT_MODEL`/`_EFFORT`/`_BUDGET` | machine | ELA's `cli/src/routes/support/` (`support:draft`, `support:try`) |
  | `GITHUB_TOKEN`, `GITHUB_DEFAULT_ORG` | account | `core/services.js`, `github:*`, `ws:publish` preflight |
  | `DIGITALOCEAN_TOKEN` | account | `core/cloud.js`, `server:` `requires:` |
  | `CLOUDFLARE_TOKEN` | account | `core/cloud.js`, `basecamp:dns`, `core/services.js` |
  | `VW_URL`, `VW_EMAIL`, `VW_PASSWORD` | account | `core/vaultwarden.js` (`env:pull`/`env:send`) |
  | `B2_KEY_ID`, `B2_APPLICATION_KEY` | account | `core/b2.js`, `core/basecamp-backups.js`, and Workbench's `basecamps.ts` **straight off the global file** |
  | `BASECAMP_URL`, `BASECAMP_API_KEY` | account | tests only; `basecamps.json` replaced them (`workbench-basecamps.md`) |
  | `SUPPORT_ELA_URL`, `SUPPORT_ELA_KEY` | account | ELA's `support` module as `SUPPORT_${app}_*`, the `support` skill |
  | `REMOTE_MT_URL`, `REMOTE_MT_TOKEN` | — | **nothing**: no reader anywhere under `~/code` or the skills |

  Two readers take the global file by path rather than through the loader —
  Workbench's B2 lookup and `services.js`'s "held" set (`listGlobal`) — so
  neither sees a profile. Workbench is the laptop's app with no project, so
  that is Phase 4's question, not a Phase 1 bug.
- **`~/.config/fli/basecamps.json`** is already a named map of Basecamps
  (admin keys, mode-checked by `fli doctor`), and `resolveBasecamp` refuses an
  ambiguous name rather than remembering a choice. No `fli` state today is a
  sticky "current" selector.
- **`~/.config/fli/env`** (no dot) is gone (2026-11-12, 0.2): only the
  retired oclif `FRONTIER/cli` read it, and its keys were folded into `.env`.

## Prior art

- **Per-command name, no switch — AWS CLI.** `[profile acme]` in
  `~/.aws/config`, picked by `--profile` or `AWS_PROFILE`
  ([docs](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-files.html)).
  The shape this paper copies, and the name.
- **Picked by place — git and direnv.** `includeIf "gitdir:~/work/"` loads a
  config for every repo under a path
  ([docs](https://git-scm.com/docs/git-config#_conditional_includes)); direnv
  loads a directory's `.envrc` on `cd` ([direnv.net](https://direnv.net/)).
- **A sticky switch — gcloud, kubectl, doctl, gh.**
  `gcloud config configurations activate`
  ([docs](https://cloud.google.com/sdk/docs/configurations)),
  `kubectl config use-context`
  ([docs](https://kubernetes.io/docs/concepts/configuration/organize-cluster-access-kubeconfig/)),
  `doctl auth switch`
  ([docs](https://docs.digitalocean.com/reference/doctl/reference/auth/switch/)),
  `gh auth switch` ([docs](https://cli.github.com/manual/gh_auth_switch)).
  The active one is state held outside the command, so the same directory
  answers with different credentials depending on what was run last; acting
  on the wrong cluster after a forgotten `use-context` is the well-known
  failure.

## Recommended setup

A **profile** is a named env file, `~/.config/fli/profiles/<name>.env`,
holding one client's account keys. A project names its profile with
`FLI_PROFILE=<name>` in its own `.env`; the shell can set the same key, which
is the per-command override, free. `loadFliEnv` loads the profile between the
project and the global file, so the order is shell → project → profile →
global. A command run outside any project uses the shell's `FLI_PROFILE` or
none.

- **The selector is derived, never remembered.** A wrong-client deploy
  destroys real work, so the same directory must always give the same
  credentials; there is no `fli profile use`, and typing it fails naming
  `FLI_PROFILE`.
- **The name is a path segment, so it is checked** — `[a-z0-9-]+` — and a name
  with no file is refused by name, the way `resolveBasecamp` refuses an
  unknown Basecamp, never loaded as empty.
- **A profile is seen before it is spent.** Each outward command prints the
  profile in its first line, and `fli doctor` names it and where it came from.
- **Profile files are the bridge.** The end state is the one
  `workspace-onboarding.md` 4.3 describes for the global file: lines that are
  references (`basecamp://<workspace>/secret/<name>`) resolved at step start,
  so a profile holds no values. That is Phase 3.

## Direction — managed from Workbench

The owner's direction, 2026-11-05, not yet a ruling: profiles are managed in
**Workbench** (`packages/workbench`): listing them, seeing which projects
name each one, setting and checking a key. Workbench is the laptop's own app
(`LOCAL_MACHINE=1`), and profiles are laptop files, so they belong there
rather than in Basecamp. Workbench already reads the laptop's Basecamp list,
`basecamps.json` (`workbench-basecamps.md`).

The owner has further secrets-management ideas, not yet written down, that may
share the same Workbench screen. The secrets work already in the tree that a
screen like this would gather:

- **`workspace-onboarding.md`** — the token checks graded *missing → present →
  proven*. Phase 4's Cloudflare `mint` issues short-lived child tokens, and 4.3
  turns global env lines into `basecamp://` references; Phase 3 here follows
  4.3. The paper also covers fnox and 1Password `op run` as prior art.
- **`workbench-basecamps.md`** — `BASECAMP_URL`/`BASECAMP_API_KEY` leave the
  global env for `basecamps.json` entries: a key moving out of the global file
  for a reason other than profiles.
- **`expected-variables.md`** — an App's env key names reach Basecamp and the
  pane lists the unset ones; `FJS-D1940` decides which default to secret.
- **`fli env:pull` / `env:send`** — a project's env read out of Vaultwarden
  (`packages/cli/core/vaultwarden.js`); the global file's `VW_*` keys are its
  login. That makes it a source a profile could pull from.

## Phases

### Phase 0 — Read the keys

Goal: each global key is known to be a machine fact or an account credential.
Done when: § What exists carries the checked split, each key with its readers.

- [x] 0.1 For every key in `~/.config/fli/.env`, name what reads it (`rg` in
  this tree, the Kobami skills, the sibling repos) and mark it machine or
  account.
- [x] 0.2 Find whether anything outside this tree reads `~/.config/fli/env`
  (no dot); fold its live keys into `.env` or retire it — the owner's file,
  so the owner's call.

### Phase 1 — The layer

Goal: a project's `FLI_PROFILE` loads its profile in order.
Done when: `test/load-env.test.js` pins shell → project → profile → global,
the unknown-name refusal and the bad-name refusal.

- [x] 1.1 `profilePath(name, home)` beside `globalEnvPath` in
  `global-env.js`, with the name check; one line in `loadFliEnv`.
- [x] 1.2 `fli eset <KEY> <value> --profile <name>` through the same writer as
  `--global`; a missing-key hint names `--profile` when a profile is in use.
- [x] 1.3 `fli doctor` rows: the profile in use and its source (shell or
  project `.env`), mode 600 on each profile file as on `basecamps.json`, and a
  warning for a key set both in a profile and in the global file.

### Phase 2 — Seen before spent

Goal: no outward command spends a credential without naming its profile.
Done when: a deploy from a client repo and one from this tree each print their
own profile and spend their own token.

- [x] 2.1 The first line of `deploy`, `basecamp:deploy`, `ws:publish`,
  `ws:post` and `eset` names the profile, or says none.
- [x] 2.1a The `profile:` namespace (owner's ask, 2026-11-12): `create`
  makes the file at 600, `list` (`fli profiles`) shows key names, mode and the
  projects under `~/code` naming each, `open` edits one in `$EDITOR`, and
  `use` refuses by naming `FLI_PROFILE`. Phase 4's Workbench screen is the
  managed half; this is the read a terminal needs before then.
- [ ] 2.2 Move the owner's account keys into profiles and add `FLI_PROFILE`
  to each project `.env` — the owner's machine, so the owner runs it.

### Phase 3 — References, not values

Goal: a profile holds references to workspace `Secret`s, not tokens.
Done when: `workspace-onboarding.md` 4.3 is built and a profile line resolves
through it.

- [ ] 3.1 Profile lines take the 4.3 reference form; a profile whose every
  line is a reference is, in effect, *this Basecamp + this workspace*.

### Phase 4 — Workbench

Goal: Workbench lists and edits profiles, and every Workbench verb that
spends an account key spends the profile its Basecamp was bought under.
Done when: a dry `basecamp:create` from the New Basecamp page under a profile
prints that profile on its first line, and a reinstall of the Basecamp it
filed runs under the same profile without being asked.

Workbench's spenders today: create, resume-install, reinstall and the restore
drill spawn fli (`spawnFli`, `basecamps-create.ts`), so `FLI_PROFILE` in the
child's env picks the profile; the backup B2 lookup (`basecamps.ts`) and the
services "held" probe (`laptop/services.ts`) read the global file by path.

- [ ] 4.1 `basecamp:create` writes `profile` into the `basecamps.json` entry
  it files when a profile is in use (Q5), and `fli doctor` refuses an entry
  naming a profile with no file.
- [ ] 4.2 `spawnFli` takes a profile and sets `FLI_PROFILE` in the child's
  env; reinstall, resume-install and the restore drill pass the entry's.
- [ ] 4.3 The backup B2 lookup reads the entry's profile before the global
  file, through the cli's own loader rather than a second path read.
- [ ] 4.4 The New Basecamp page's Profile select, starting on nothing chosen
  (Q6): each profile, and *None — global file*; the run refuses until one is
  picked, and the shown command line carries `FLI_PROFILE=<name>`.
- [ ] 4.5 A Profiles section on the Laptop screen beside the global env pane
  (Q7): each profile's key names masked, its mode and the projects naming it,
  create, set and unset a key — the `profile:` commands' helpers in
  `global-env.js`, never a second writer.
- [ ] 4.6 Drive it: a dry create under a scratch profile, then the reinstall
  refusal path, in Chrome.

## Open questions

- ~~**Q1 — The noun.**~~ **Answered 2026-11-05 (`FJS-D1942`): A — *profile*: AWS's word for this exact shape, so nobody has to learn it. It's spelled like `FJS-D1152`'s `Profile`, the claim key for a Provider's person in a conduit, but that is a model name in another realm and this is a CLI word.**
  - **A** — *profile*: AWS's word for this exact shape, so nobody has to learn it.
    It's spelled like `FJS-D1152`'s `Profile`, the claim key for a
    Provider's person in a conduit, but that is a model name in another realm
    and this is a CLI word.
  - **B** — *account*: what gh and doctl call one login. But a profile holds
    one account at each of several vendors, so the word names the wrong level.
  - **C** — *context*: kubectl's word; collides with `ctx`.
  - **Recommend A** — discovered rather than invented, and the collision is
    across realms and cases.
- ~~**Q2 — How a project names its profile.**~~ **Answered 2026-11-05 (`FJS-D1943`): A — `FLI_PROFILE` in the project `.env`, shell overrides.**
  - **A** — `FLI_PROFILE` in the project `.env`, shell overrides.
  - **B** — a directory map in global config, git `includeIf` style: one
    line covers `~/code/<client>/*`, including repos with no `.env`.
  - **C** — a sticky `fli profile use <name>`.
  - **Recommend A** — derived from the project root `fli` already finds, one
    road, and the override is the shell's. B is a second place saying which
    credentials apply, and moving a repo changes them silently. C is the
    gcloud/kubectl failure. B is the reopen path if a line per repo proves
    heavy.
- ~~**Q3 — Whether the global file keeps account keys once profiles exist.**~~ **Answered 2026-11-05 (`FJS-D1944`): A — Yes, as the fallback: a project with no profile works as today.**
  - **A** — Yes, as the fallback: a project with no profile works as today.
  - **B** — No: the global file holds machine facts only, and a command needing
    an account key with no profile set fails on the missing key, naming
    `FLI_PROFILE`.
  - **Recommend B** — under A a forgotten `FLI_PROFILE` falls through to
    whichever account the global file holds, which is the wrong-client
    deploy again, silent. B costs a refusal the first time.

- ~~**Q5 — Whether a Basecamp remembers the profile it was bought under.**~~ **Answered 2026-11-12 (`FJS-D2087`): A — Record it on the entry: `basecamp:create` writes `profile` into the `basecamps.json` entry, and every later verb reads it there.**
  - **A** — Record it on the entry: `basecamp:create` writes `profile` into
    the `basecamps.json` entry, and every later verb reads it there.
  - **B** — Pick it every run: reinstall, backup and the restore drill each
    show the select.
  - **Recommend A** — the entry names its profile the way a project's `.env`
    does, so the selector stays derived; under B a wrong pick on a reinstall
    spends another client's account with nothing to catch it.
- ~~**Q6 — What the New Basecamp page's Profile select starts on.**~~ **Answered 2026-11-12 (`FJS-D2088`): A — Nothing chosen: the run refuses until a profile or *None — global file* is picked.**
  - **A** — Nothing chosen: the run refuses until a profile or *None — global
    file* is picked.
  - **B** — *None — global file*: today's behavior, a profile optional.
  - **Recommend A** — the command buys a box, so the account it charges is
    chosen on purpose; under B a forgotten pick charges the global account.
- ~~**Q7 — Where Workbench lists and edits profiles.**~~ **Answered 2026-11-12 (`FJS-D2089`): A — The Laptop screen, beside the global env pane, with its masked list and set/unset; it moves to a Secrets screen once the owner's secrets ideas are written.**
  - **A** — The Laptop screen, beside the global env pane, with its masked
    list and set/unset; it moves to a Secrets screen once the owner's secrets
    ideas are written.
  - **B** — A Secrets screen now, profiles its first section.
  - **Recommend A** — the pane it sits beside already does the same job for
    the global file; B shapes a screen ahead of the ideas that would fill it.

## Out of scope

- **`~/.fli/config.json`'s `frontier.*`** (nick, box, post key) — the
  person's Frontier network identity, which this paper treats as one per
  machine.
- **A default Basecamp per profile.** `basecamps.json` stays the named map; a
  profile sets whichever key picks a default if one is ever added.
- **App tenants' third-party accounts** — `third-party-credentials.md`.
