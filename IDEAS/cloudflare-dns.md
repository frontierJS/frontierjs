---
id: cloudflare-dns
status: proposed
dated: 2026-10-22
---

# Idea — Cloudflare DNS in the console: pick an account, pick a zone, edit its records

**Status: PROPOSED. Nothing below § The shape is built.** Dated 2026-10-22. Do
not cite this file as behavior — see `VERIFYING.md`. § What exists was read off
the tree and this machine on that date.

A person with several Cloudflare accounts — their own, each client's — opens
one terminal screen, sees every account their login reaches, walks into a zone
and adds, edits or removes records. Basecamp's `edge` service is a different
thing and stays one: a fleet writing its own marked records on a schedule
(`cloudflare-edge.md`). This is a person's hands on any zone they can reach,
with no app behind it.

---

## What exists

- **`packages/cli/commands/cloudflare/`** — `_module.md` holds `cfApi` (a
  `fetch` to `api.cloudflare.com/client/v4`) and `resolveZone`; `cf:dns` lists,
  adds, updates and deletes by flag; `cf:zones`, `cf:purge`, `cf:pages`,
  `cf:workers` beside it. The credential is ONE `CLOUDFLARE_TOKEN` — global env,
  a project `.env`, or `--token` — so an account is whichever token is loaded,
  and *which accounts can I reach* has no answer.
- **The console** (`fli gui`, `IDEAS/one-console.md`) — nine `.mesa` panes in
  `packages/cli/console/`, each reading `core/server.js` endpoints through an
  `api` prop, mounted in the terminal by `runTerminalConsole` and served to a
  browser from the same file. Keys are one `keys()` table per pane with a
  legend footer; `bun run test:browser:console` diffs the two frames row by row
  and puts a stand-in binary first on the PATH for `:ask`.
- **`cf` v0.15.0** (Cloudflare's own CLI, beta) is installed here and not
  logged in. `cf auth login` is an OAuth device flow; `cf auth create <name>` /
  `activate` / `list` are named profiles; `cf accounts list` is the accounts a
  login reaches; `cf dns records list|create|edit|delete -z <zone> --profile
  <name>`, `create --dry-run` validates without writing. It keeps its own
  credentials as JSON under `~/.config/cloudflare/` and does not share
  wrangler's. The global instruction already says *use the cf CLI unless the
  project has a wrangler config*.
- **Basecamp's connector** (`packages/basecamp/api/src/providers/edge/cloudflare.ts`)
  marks the records it writes in the record's `comment` and refuses to touch an
  unmarked one. The pane meets those records from the other side.

## Prior art

Three tools answer *edit Cloudflare DNS from a terminal*, and all three take
one API token, so none of them has an account screen:

- [cftui (Go, Bubble Tea)](https://pkg.go.dev/github.com/devnullvoid/cloudflare-tui)
  — zones → a records table; add/edit/delete A, CNAME, TXT, MX, SRV, CAA; a
  headless mode for scripts; the token needs DNS Edit and Zone Read.
- [cftui (Python)](https://pypi.org/project/cftui) — the same shape, adds AAAA
  and NS and a proxy toggle.
- [dnstui (Go)](https://pkg.go.dev/github.com/scheiblingco/dnstui) —
  multi-provider (Cloudflare, ClouDNS, Openprovider, Technitium); caches zones
  and records, validates input before the call.

What they settle: the screen order is zones → records, the record table is
name · type · content · TTL · proxied, and a type picks the form's fields (MX
and SRV carry a priority). What they lack is the first screen the ask names —
*accounts I have access to* — and the reason is the token: a token is minted
inside one account. A user login reaches every account the user is a member
of, which is what `cf auth login` is
([cf: get started](https://developers.cloudflare.com/cf/get-started/)), and
it already resolves an account per profile the way
[wrangler's profiles](https://developers.cloudflare.com/workers/wrangler/profiles/)
do. Owning an OAuth client here would mean registering an app with Cloudflare;
`cf` has done that
([changelog](https://developers.cloudflare.com/changelog/post/2026-07-02-wrangler-auth-profiles/)).

---

## The shape

**One pane, `:dns`, three screens walked with Enter and Esc.**

| Screen | Rows | Keys |
| --- | --- | --- |
| Accounts | each `cf` profile × the accounts it reaches; the row names the profile, the account and its id. Not logged in: one row, *sign in*, which runs `cf auth login` and shows the device code in the pane | Enter · `l` sign in / add a profile |
| Zones | the account's zones: name · status · plan; type to filter | Enter · `/` filter |
| Records | name · type · content · TTL · proxied · comment, sorted name then type; type to filter; a record Basecamp marked carries a `basecamp` badge | `a` add · `e` edit · `d` delete · `p` proxy on/off · `r` reread · `/` filter |

**A write is shown before it is sent.** Add and edit open a form whose fields
the type picks (name, content, TTL, proxied where the type allows it, priority
for MX and SRV, comment); Enter shows the resulting line beside the current one
and a second Enter sends it. Delete shows the record and asks once. A write to
a `basecamp`-marked record warns that `domain:dns` will put it back on the
next sync and goes ahead — the person outranks the sync, and the sync's own
refusal protects the other direction.

**The data path is the console's.** `Dns.mesa` → `server.js` `/api/dns/*` →
`core/cloudflare.js` → `cf <verb> --profile <p>` spawned per call, JSON on stdout.
`core/cloudflare.js` becomes fli's one owner of the Cloudflare dialect: the
flag commands in `commands/cloudflare/` move onto it and `cfApi` is deleted
(Q2). fli stores no credential of its own: a profile is `cf`'s, and a token
is the env's. **A token is an account row** (`FJS-D1468`): `CLOUDFLARE_TOKEN`
in the shell, a project `.env` or the global env shows as one more row on the
Accounts screen, named by the variable, reaching the one account the token was
minted in. Where `cf` honors an env token (Phase 0.2) the module passes it
through; where it does not, the module carries the token on the spawn the way
`cf` wants it, and the Accounts screen is the one place that knows there were
two kinds of row.

**`fli dns` is the door**, an alias that opens the console on `:dns` in the
terminal, `--open` for the browser — the same two targets every pane has.

Out of V1: DNSSEC, zone settings, import/export, Pages and Workers (their flag
commands stay, over the module), a record cache (dnstui's), any provider but Cloudflare.

---

## Plan

### Phase 0 — Measure `cf`'s contract

Goal: the facts the owner module is written against, each read from a run.
Done when: § Measured below holds the five answers with the `cf` version.

- [x] 0.1 Sign in once (`cf auth login`), then record: the exact output of `cf accounts list`, `cf zones list`, `cf dns records list -z <zone>`, `cf dns records create --dry-run` — JSON or text, exit code on refusal, how a 403 and an unknown zone read
- [x] 0.2 How `cf` takes a token with no profile — an env name, a flag, or neither — and what `--profile` does when the name is unknown; the answer decides how the token row (`FJS-D1468`) reaches `cf`
- [x] 0.3 Wall time per spawn (node startup is the floor) — if a list is over ~400 ms the Records screen reads once and edits locally, dnstui's shape
- [x] 0.4 Pagination: how `records list` answers a zone past 100 records, and whether `--per-page`/`--page` or a cursor exists
- [x] 0.5 How `fli gui` can open on a named pane, and what `fli doctor`'s binary row needs to name `cf` (an npm package: on a machine with no `cf` the row prints the install line, never `bunx`)

### Phase 1 — One owner: `core/cloudflare.js`

Goal: every Cloudflare call fli makes goes through one module over `cf`.
Done when: `fli cf:dns --zone <z>` prints the rows it printed before, through the new module; `cfApi` is gone; `bun run test` green with a stand-in `cf`.

- [x] 1.1 `core/cloudflare.js`: `profiles()` (each `cf` profile, plus one `token` entry when `CLOUDFLARE_API_TOKEN` is set (`FJS-D1473`)), `accounts(profile)`, `zones(profile, account)`, `records(profile, zone)`, `createRecord`, `updateRecord`, `deleteRecord` — each one spawn, JSON on stdout with no flag (0.1), lists walked by page (0.4), the error as `cf`'s own message with the verb named; `env: process.env` on the spawn (package CLAUDE.md § What bites)
- [x] 1.2 `test/cloudflare.test.js` over a stand-in `cf` script first on the PATH that answers the Phase 0 fixtures by verb; the fixture header carries the `cf` version it was read from
- [x] 1.3 Move `commands/cloudflare/{dns,zones,purge}.md` onto it; delete `cfApi` and `resolveZone`; `pages.md` and `workers.md` follow or are named as staying with a reason — all five moved; `--token` is `--profile` (`profileFor`: the name, else `CLOUDFLARE_API_TOKEN`, else `cf`'s active login); `findZone` replaces `resolveZone` and dns's owning-zone walk; `--update` sends only the fields given; `cf:workers --status` lost its cron triggers (§ Measured 1.3)
- [x] 1.4 `_module.md` § Setup rewritten: `cf auth login` first, the token path second for CI; `requires:` stays `CLOUDFLARE_TOKEN` only where a command still takes one — no `cf:` command does, so the namespace declares none; `basecamp:dns` declares it in its own frontmatter (`FJS-D1465`), and `cloudflareToken` reads the page off that file for install and create, for which no token is not a refusal

### Phase 2 — The pane, read-only

Goal: accounts → zones → records on both targets.
Done when: `bun run test:browser:console` has a `:dns` spec whose browser and terminal frames agree, over the stand-in `cf`.

- [x] 2.1 `server.js`: `GET /api/dns/accounts`, `/api/dns/zones?profile=&account=`, `/api/dns/records?profile=&zone=`; the shape is `core/cloudflare.js`'s and the handler adds nothing — `reachable()` is the Accounts screen (each profile with its accounts, or `cf`'s refusal in the row); `profileFor('CLOUDFLARE_API_TOKEN')` is the token row and refused while unset; a `CloudflareError` is 502
- [x] 2.2 `console/Dns.mesa` — the three screens, the breadcrumb, filter-as-you-type, the `basecamp` badge read off the comment; `Console.mesa` gets the pane and its number; keys through `keyed` so the legend draws them — the pane's own cursor (`j`/`k`, Enter in, Esc out) rather than focus, so one key walks both frames; the filter is the console's `/`; `:dns` is `0`, and a filter takes Esc before a pane does; the badge reads the connector's `read()` spelling; `test:browser:console` walks accounts → records → back in both frames
- [x] 2.3 The not-signed-in state: one row, and the pane streams `cf auth login`'s device code; `openUrl` for the link, as `followLinks` already does — the row shows whenever no `cf` profile is listed, token row or not, and sits first; `login()` spawns `--no-browser` and the SERVER opens the link (`POST /api/dns/login`, SSE), since a link in the pane would navigate the browser frame away and a terminal one needs focus the console keeps; a second stream joins the waiting one, so both frames show one code and the link opens once, and the last stream closing stops the wait; Esc stops it

### Phase 3 — Writes

Goal: add, edit, delete and the proxy toggle, each shown before it is sent.
Done when: the drive adds a TXT, edits it, flips a proxy and deletes it against the stand-in, and once by hand against a real zone the owner names.

- [x] 3.1 `POST /api/dns/records`, `PUT`, `DELETE`, each over the module; a `basecamp`-marked target answers a `warning` the pane must echo before sending again
- [x] 3.2 The form per type — A/AAAA/CNAME/TXT/NS plain, MX/SRV with priority, CAA with flags/tag; `proxied` offered only for the types Cloudflare proxies (the connector's list in `cloudflare.ts` is the precedent); the before/after line
- [x] 3.3 Delete confirm, the proxy toggle as a one-key edit, and `r` after every write so the table is Cloudflare's answer and never the pane's guess

### Phase 4 — The door

Goal: `fli dns` lands on the pane.
Done when: `fli dns` at a TTY shows Accounts; `fli dns --open` shows it in the browser; `fli doctor` names `cf`.

- [ ] 4.1 `fli gui` takes a pane (`fli gui :dns`), per 0.5; `commands/cloudflare/tui.md` with `alias: dns` and an `effects:` line naming the writes
- [ ] 4.2 `fli doctor` row for `cf`; `docs/` line in `commands/cloudflare/_module.md`; `DRIVES.md` row for the console spec

---

## Open questions

- ~~**Q1 — Where an account comes from.**~~ **Answered 2026-10-23 (`FJS-D1468`): C — both, a token shown as a row.**
  - **A** — `cf`'s profiles and login; fli stores no credential and adds no token store.
  - **B** — fli's own named tokens (`CLOUDFLARE_TOKEN_<NAME>`), one per account, no `cf`.
  - **C** — both, a token shown as a row.
  - **Recommend A** — the ask is *accounts I have access to*, which only a user login answers; B is three tools' shape and none of them has the screen. A token still works through `cf`'s own env reading if 0.2 finds it, which is C with no fli code.
- ~~**Q2 — One dialect owner.**~~ **Answered 2026-10-23 (`FJS-D1469`): A — the flag commands move onto `core/cloudflare.js` and `cfApi` is deleted.**
  - **A** — the flag commands move onto `core/cloudflare.js` and `cfApi` is deleted.
  - **B** — `cfApi` stays for the flag commands, `cf` for the pane.
  - **Recommend A** — two spellings of one call drift (`commands/cloudflare/dns.md` and basecamp's connector already disagree on which types take `proxied`); the evolution policy says move every caller in one change.
- ~~**Q3 — The pane's name.**~~ **Answered 2026-10-23 (`FJS-D1470`): A — `:dns`.**
  - **A** — `:dns`.
  - **B** — `:cloudflare`.
  - **C** — `:edge`, basecamp's word for the adapter kind.
  - **Recommend A** — the screens and keys are DNS's and the provider is the breadcrumb's first crumb; `:edge` is a fleet noun and this has no fleet.
- ~~**Q4 — A Basecamp-marked record.**~~ **Answered 2026-10-23 (`FJS-D1471`): A — warn and go ahead.**
  - **A** — warn and go ahead.
  - **B** — refuse, as the connector refuses unmarked ones.
  - **C** — hide them.
  - **Recommend A** — the connector's refusal protects a stranger's record from a sync; a person at the keyboard is not the sync, and the sync puts its record back, so the write is reversible by the thing that owns it.
- ~~**Q5 — Pane or standalone.**~~ **Answered 2026-10-23 (`FJS-D1472`): A — a console pane, `fli dns` an alias into `fli gui`.**
  - **A** — a console pane, `fli dns` an alias into `fli gui`.
  - **B** — a command that mounts `Dns.mesa` with no server, functions as props.
  - **Recommend A** — the mount, loader, legend, keys and the two-target drive exist once; B is a second mount path and loses the browser.

- ~~**Q6 — Which env name fli keeps for a token.**~~ **Answered 2026-10-23 (`FJS-D1473`): A — rename fli's to `CLOUDFLARE_API_TOKEN`: one name, `cf` reads it with no mapping, and the module only has to DELETE it for a profile row.** `cf` reads `CLOUDFLARE_API_TOKEN`; fli's commands and `_module.md` say `CLOUDFLARE_TOKEN`.
  - **A** — rename fli's to `CLOUDFLARE_API_TOKEN`: one name, `cf` reads it with no mapping, and the module only has to DELETE it for a profile row.
  - **B** — keep `CLOUDFLARE_TOKEN` and map it onto `CLOUDFLARE_API_TOKEN` on the spawn.
  - **Recommend A** — two spellings of one secret is the duplication the evolution policy forbids, and nothing has shipped; B keeps a mapping forever for a name only fli knows.

## Doctrine

Run against `PHILOSOPHY.md` § V before any edit; tier **Assessment** (this
file) until Phase 1 lands, then the module and the pane are the Map.

1. *Origin* — the Cloudflare dialect is written once in fli, over `cf`; the `fetch` copy goes (Q2).
2. *Concept* — no new noun: account, zone, record, profile are Cloudflare's and `cf`'s words; the pane joins nine.
3. *Complexity* — `cf` is a beta dependency on the PATH, priced against owning OAuth (impossible without an app registration) and against tokens (no account screen).
4. *Predictability* — a pane like the others: `api` prop, `keyed`, legend, Esc back; a write shown before it is sent as `:decide`'s pick is.
5. *Derived* — the account list derives from a login; nothing is typed into a list fli keeps.
6. *Owner* — fli's one Cloudflare owner is `core/cloudflare.js`; basecamp's connector is an app's and stays (an app speaks for a fleet, a tool for a person).
7. *Boundary* — the pane knows endpoints, the endpoints know the module, only the module knows `cf`'s argv and JSON.
8. *Failure* — delete asks once, edit shows the change, a marked record warns; `cf`'s refusal is printed in its words with the verb named.
9. *Silence* — the stand-in `cf` ages against the real one: the fixture names the `cf` version and `fli doctor` prints the installed one, and a shape change between them is caught by the next real run and nothing else. **`none`** past that; recorded here.

Adjudication (§ IV): *batteries vs. smallness* — a dependency on `cf` over an OAuth client of fli's own; *paved road vs. workaround* — the console's pane over a bespoke mount.

## Measured

Read from `cf` v0.15.0 (npm package `cf`, node 22) on 2026-10-22, signed in with `cf auth login`, one profile (`default`), two accounts, 21 zones.

**0.1 Output.** Every list verb prints JSON on stdout by default — there is no `--json` flag, and `--json` is `Unknown argument: json`, exit 1. The JSON is the Cloudflare API's own object, unwrapped: an account `{id, name, type, settings, legacy_flags, created_on}`, a zone `{id, name, status, paused, type, name_servers, account: {id, name}, plan: {name, …}, …}`, a record `{id, name, type, content, priority?, proxiable, proxied, ttl, settings, meta, comment, tags, created_on, modified_on}` (`ttl: 1` is Auto, `comment: null` when none). A refusal is a box on stderr, exit 1:
- unknown zone NAME — `Zone not found: <name>`
- unknown zone ID — `[10000] Authentication error · 403 Forbidden · HTTP /zones/<id>/dns_records` plus `→ Check your API token permissions`; a 403 and a wrong id read the same
- a zone by NAME with more than one account reachable — `More than one account available but unable to select one in non-interactive mode` and the account list; `CLOUDFLARE_ACCOUNT_ID` in the env or a zone ID clears it. **The module passes zone IDs**, which the Zones screen has.
`cf auth whoami` prints `{authenticated, authSource, tokenValid, email, accounts: […]}` — the Accounts screen's row in one call; `cf auth list` prints the profiles `[{name, boundDirectories}]`.

**0.2 Token.** The env name is `CLOUDFLARE_API_TOKEN`, not fli's `CLOUDFLARE_TOKEN`. When set it WINS over the login, `--profile default` included (a bogus value turns every verb into `[6003] Invalid request headers · 400`). An unknown `--profile` is `No authentication token found` naming the two ways in, exit 1. So the token row spawns with `CLOUDFLARE_API_TOKEN=<value>` and a profile row spawns with it DELETED from the env, or the login is silently shadowed. Which spelling fli's own `requires:` keeps is Q6.

**0.3 Wall time.** 1.3 s per spawn (`accounts list` 1.32 s, `records list` 1.35 s; 0.9 s user). Over the 400 ms line: **the Records screen reads once and edits locally**, `r` rereads.

**0.4 Pagination.** `--page`/`--per-page` on every list, no cursor, past the end an empty array. **Zones default to 20 per page** — the run returned 20 of 21 with no flag — so `zones` passes `--per-page 50` and walks pages until a short one; records returned 22 of 22 and `--per-page 1000` is accepted, so `records` passes a large page and walks the same way. `--order`/`--direction` exist on both.

**1.3 Pages, Workers, purge.** `zones list` with no `--account-id` spans every account the login reaches (21), so `findZone` resolves a name there. `cache purge -z <id> --body '{"purge_everything":true}'` or `'{"files":[…]}'` is POST `/zones/<id>/purge_cache`. `pages …` and `workers …` take no `--account-id` and refuse with two accounts reachable — the same *More than one account* box as a zone by name — and `CLOUDFLARE_ACCOUNT_ID` in the spawn's env clears it. **Pages lists cap at 10 a page**: 11 is `[8000024] Invalid list options provided`, 400, so the old `per_page=50` list never ran. `pages projects deployments create <name>` is the deploy, multipart with an empty body. `workers list`/`get` are the new Workers API (`/workers/workers`): rows carry `id` and `name`, `updated_on`/`deployed_on` and `references.domains`, no `modified_on`. `workers deployments list --worker <name>` answers an OBJECT, `{deployments: [{versions: [{version_id, percentage}]}]}`; the first version of the first deployment is the one serving traffic, and `workers versions get <id> --worker-id <name>` carries its `bindings`. The newest version is not that one — an upload not deployed is newer. **No verb reads cron triggers** (`workers triggers` only deploys), so `cf:workers --status` shows none.

**0.5 Door.** `Console.mesa` already has `export let pane = 'run'`; `runTerminalConsole` passes `{api, legendAt}` and the browser mount `{root}` (`core/console.js`), so `fli gui :dns` is a positional in `commands/fli/gui.md` handed through both as `pane` (the browser one off `location.hash`). `fli doctor` reads `BINARIES` in `core/doctor.js`, `{name, required, hint}`; the row is `{ name: 'cf', required: false, hint: 'npm i -g cf  (needed for :dns and cloudflare:)' }`.

**2.3 Sign in.** Signed out, `auth list` is `[]`, `auth whoami` is `{authenticated: false, error: "Not logged in"}`, and a list verb is the *No authentication token found* box. `cf auth login --no-browser` with stdin closed prints `ℹ Starting OAuth login flow...` on stdout and the device text on stderr — *To authorize cf, please visit:*, the link `https://dash.cloudflare.com/oauth2/device/verify` alone on its line, *and enter the code:*, an 8-letter code alone on its line, *You have 5 minutes to approve this request.* — then waits. **Not measured:** what it prints once approved, and how an expired code reads; the run was never approved, and the pane takes exit 0 as signed in and anything else as the box `cf` prints.

**3.1 Writes.** `POST /api/dns/records` and `PUT`/`DELETE /api/dns/records/<id>` carry `{profile, zone, record | changes, confirm}`. Without `confirm`, an edit or delete reads the target with `cf dns records get <id>` first — +1.3 s, because the table is one read old — and a marked target, or a comment that writes the mark, is a 409 `{warning}`; the pane sends again with `confirm: true`. **Not measured:** what the real `get` answers for an unknown record id; the stand-in answers the 403 an unknown zone id does.

**3.2 Form.** `console/DnsForm.mesa`, opened by `a` and `e`; each control carries the form's keymap (Enter, Tab, Shift+Tab, Esc), since a key typed into a field never reaches the console root and the two frames order Tab stops differently. A name with no zone on the end is put under it and `@` is the apex. SRV and CAA are sent as `data`; an edit sends only the keys that moved, and a cleared comment is sent as `null`. A write the server took rereads the records, so the reread half of 3.3 is done for the form. **Not measured:** whether the real `edit` clears a comment on `null` or wants `""`; whether a real SRV or CAA row carries `data` in `list` (the form reads `content` when it does not).

**3.3 Table writes.** `d` draws the record and Enter deletes it; `p` sends `{proxied}` flipped in one press, offered on a row whose `proxiable` is true — Cloudflare's answer, not the form's type list — since a second press puts it back. A marked target answers either with the 409, drawn in the same panel, and Enter sends again with `confirm`. Every write rereads; nothing is patched into the table. The stand-in keeps writes in the file `CF_STATE` names, so the drive sees the table change after each. **Not measured:** a warned flip (the fixture has no marked proxiable record — the path is the delete's).

**Writes.** `create`/`edit`/`update` take only `--body '<json>'` — no per-field flags — and `--dry-run` prints `{command, method, url, pathParams, query, bodyKind, body}` without sending, exit 0; `delete <id>` the same with `bodyKind: none`. The stand-in `cf` (1.2) answers these shapes.

---

*Related:* `cloudflare-edge.md` (the fleet's side of the same zone) ·
`one-console.md` (the pane model) · `command-views.md` (one-shot output as a
view, which the flag commands could take later) · `keys.md` (the keymap engine
the pane's table rides on)
