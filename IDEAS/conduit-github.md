---
id: conduit-github
status: proposed
dated: 2026-11-25
---

# Idea — `conduit-github`: GitHub's REST dialect over conduit

**Status: PROPOSED.** Dated 2026-11-25. Nothing here is built. Do not cite this
file as behavior — see `VERIFYING.md`. The GitHub facts below were read from
GitHub's docs on that date, not measured; Phase 0 measures the ones the
connector branches on.

---

## Trigger

Basecamp already speaks GitHub through conduit, in one file that knows the
dialect (`packages/basecamp/api/src/providers/source/github.ts`), a stand-in
beside it (`github-sink.ts`), and a webhook verifier in `plugins/git-push.ts`.
That is a connector in everything but name, written for one app. The owner
asked for a GitHub connector on 2026-11-25. This plan builds the connector by
extracting the dialect Basecamp already proved, so the package starts with one
real caller instead of none (`conduit-airtable`'s parked phases are the cost of
building without one, `FJS-D2056`).

---

## What exists, and must not be restated here

| Piece | Where | What it settles |
| --- | --- | --- |
| Authentication | `FJS-D1571` | A fine-grained personal access token, stored as a `Secret` (`kind: providerKey`, `providerKind: github`). A GitHub App is the reopen path: when an organization refuses fine-grained tokens, or when a scheduled re-verify is needed. |
| The grants each call needs | `FJS-D1571`, `FJS-D2108` | Administration write (deploy keys), Webhooks write (hooks), Contents read (files), and Contents write for a draft push. |
| Reading a file | `FJS-D1573` | Ask for the repository first, so a missing FILE is never read as an unseen REPOSITORY. Both answer 404. |
| Connecting an App | `FJS-D2051` | `apps.connect` writes the deploy key and push hook through one helper. |
| A draft push | `FJS-D2108` | The token goes to git through `GIT_ASKPASS`, per call, only for github.com. This is git's credential path, not a REST call. |
| Advisories | `FJS-D1546`, `FJS-D1548` | `oven-sh/bun` and `moby/moby` advisories come from GitHub's repository advisories. |
| The contract | `packages/conduit/docs/CONTRACT.md` | C1–C13. This connector is graded against it. |
| Where connectors live | `FJS-D1559`, `FJS-D2365` | `packages/conduits/conduit-<x>/`, held out of releases unless named in `ADMITTED`. |

### Today's GitHub callers

| Caller | File | Calls |
| --- | --- | --- |
| Basecamp, account verify | `providers/source/github.ts` `verify` | `GET /user` |
| Basecamp, connect | `github.ts` `setDeployKey`, `setPushHook` | `GET`/`POST /repos/{o}/{r}/keys`, `GET`/`POST`/`PATCH /repos/{o}/{r}/hooks` |
| Basecamp, Dockerfile read | `github.ts` `readFile` | `GET /repos/{o}/{r}`, `GET /repos/{o}/{r}/contents/{path}` |
| Basecamp, draft push | `github.ts` `gitCredential` | `readFile` as a visibility probe, then the token goes to git |
| Basecamp, push webhook | `plugins/git-push.ts` `forgeDialect` | verifies `X-Hub-Signature-256`, which GitHub, Forgejo and Gitea all send |
| Advisory lookup | `domain/host/components.ts` `lookupFor` | `GET /repos/{o}/{r}/security-advisories`. Only `api/test/verify-advisories.mjs` calls it, unauthenticated, at 60 an hour. No runtime target was found on 2026-11-25. |
| fli `github:*` | `packages/cli/commands/github/_module.md` | Raw `fetch` with a classic token. fli does not use conduit. |
| Sign in with GitHub | `packages/auth/oauth.ts` preset | OAuth sign-in. That is auth's provider table (`FJS-D797`), not a connector. |

---

## What GitHub presses that the connector owns

Read from GitHub's REST docs on 2026-11-25:
[Rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api),
[Best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api).

- **A rate limit arrives as a 403 as often as a 429, and conduit reads every 403 as `auth_failed`.**
  - `transports/http.ts` turns 401 and 403 into `auth_failed`, with `retryable: false`.
  - Primary limit: a 403 or 429 with `x-ratelimit-remaining: 0`. Wait until `x-ratelimit-reset` (epoch seconds).
  - Secondary limit: a 403 or 429 with a message saying so. Wait for `retry-after` when present, otherwise until the reset, otherwise one minute.
  - `translate` (C3) is the one place a 403 is split into a grant refusal or a rate limit. Without it, a busy token reads to Basecamp as *give it Administration › Read and write*.
  - Octokit's `plugin-throttling` makes the same split, and is the prior art.
- **A 404 means two things.** The repository does not exist, or the token was not given it. The connector answers `unseen` and never claims which (`FJS-D1573`).
- **A 304 is free.** A conditional request that answers 304 does not count against the primary limit. Conduit already answers a 304 as `ok` with null data (`FJS-649`), so the connector sends `If-None-Match` on list reads and the caller keeps the copy.
- **Paging is the `Link` header**, at most `per_page=100`. Conduit already passes `Link` through.
- **Limits:** 5,000 an hour per token, 60 unauthenticated. Secondary limits: 100 concurrent requests, 900 points a minute, 80 content-creating requests a minute and 500 an hour. GitHub asks for serial requests and one second between writes. Pacing stays the app's, as in `conduit-dataforseo` (conduit has no outbound pace).
- **Pin the version and identify the caller.** `X-GitHub-Api-Version: 2022-11-28` is pinned, and a request with no `User-Agent` is refused. Both are target headers.
- **No write here takes an idempotency key (C5).** Deploy keys and hooks are created unkeyed and never replayed. Today's find-before-write is the C6 read that resolves a lost answer: list keys and match the key material, list hooks and match the URL.
- **A deploy key is unique across all of GitHub.** A second repository answers 422 *key is already in use*, and the connector names that refusal.

---

## Open questions

- ~~**Q1 — Who is the first caller, and does Basecamp move onto the package in the same change?**~~ **Answered 2026-11-25 (`FJS-D2367`): A — Basecamp moves. `providers/source/github.ts` becomes an adapter over the connector (Basecamp's `AccountSend`, `RepoUnseen` and its UI sentences), the sink moves into the package, and Basecamp's copy is deleted.**
  - **A** — Basecamp moves. `providers/source/github.ts` becomes an adapter over the connector (Basecamp's `AccountSend`, `RepoUnseen` and its UI sentences), the sink moves into the package, and Basecamp's copy is deleted.
  - **B** — Build the connector alone and leave Basecamp's copy in place. This is what Basecamp does today: `providers/edge/cloudflare.ts` sits beside `conduit-cloudflare`, the compute connectors beside `conduit-digitalocean` and `conduit-hetzner`, and Basecamp depends on no `@frontierjs/conduit-*` package. `FJS-D1185` chose B over a recommended A.
  - **Recommend A** — two copies of one dialect drift with nothing failing. The reason `FJS-D1185` gave (connector packages were not yet committed in this tree) is gone since `FJS-D1559` and `FJS-D2365`. One condition is unproven until 4.1: that `vendor.js` packs a held-out connector Basecamp depends on into the image (`FJS-D1559` condition a). If 4.1 fails, the plan falls back to B, and Phase 4 may become its own session as `FJS-D1559` allowed.
- ~~**Q2 — Authentication in v1.**~~ **Settled by `FJS-D1571`: a fine-grained personal access token, a `bearer` target.** Nothing to rule. A GitHub App arrives when D1571 reopens. It would be a JWT signed with RS256 from the App's private key, exchanged for an installation token that expires in an hour, minted by the resolver (`withCache({ get: mint })`, `FJS-D1075`). It would be a second `auth` shape on the builder, with no rename.
- ~~**Q3 — Where the `X-Hub-Signature-256` check lives.**~~ **Answered 2026-11-25 (`FJS-D2368`): A — `conduit-github` exports a pure verifier (C8) and the push parse. Basecamp's `forgeDialect` calls it, and Basecamp keeps its receiver, `tokenDialect` and `apply`.**
  - **A** — `conduit-github` exports a pure verifier (C8) and the push parse. Basecamp's `forgeDialect` calls it, and Basecamp keeps its receiver, `tokenDialect` and `apply`.
  - **B** — It stays in `plugins/git-push.ts`, because the same header serves Forgejo and Gitea.
  - **Recommend A** — the scheme is GitHub's and the other two copy it byte for byte. Every connector that receives already exports its pure verifier (`conduit-stripe`, `conduit-slack`, `conduit-resend`, `conduit-quo`, `src/verify.ts`), and conduit's core has no HMAC helper to put it in instead.
- ~~**Q4 — How much of the API v1 covers.**~~ **Answered 2026-11-25 (`FJS-D2369`): A — Basecamp's runtime calls only: user, repository, deploy keys, hooks, contents, and `translate`. Advisories and multi-page lists wait for a runtime caller.**
  - **A** — Basecamp's runtime calls only: user, repository, deploy keys, hooks, contents, and `translate`. Advisories and multi-page lists wait for a runtime caller.
  - **B** — A plus `advisories()` and a paged `listAll` with ETags, with `verify-advisories.mjs` as their caller. It is a test drive, and `lookupFor` has no runtime target.
  - **C** — B plus PRs, issues, releases and checks, the surface fli's `github:*` commands and a CI view would want.
  - **Recommend A** — a method with no caller is untested surface (`cut-one-level-simpler`), and a test drive is not a caller. Today's lists read one page of 100.
- ~~**Q5 — Whether fli's `github:*` commands move onto the connector.**~~ **Answered 2026-11-25 (`FJS-D2370`): A — Not in this plan. fli's raw `fetch` with a classic token stays a second GitHub REST path. It reopens when fli sends through conduit at all, which it does nowhere today.**
  - **A** — Not in this plan. fli's raw `fetch` with a classic token stays a second GitHub REST path. It reopens when fli sends through conduit at all, which it does nowhere today.
  - **B** — Yes, as the second caller.
  - **Recommend A** — putting conduit under fli is its own decision, bigger than this connector.
- ~~**Q6 — Whether `bindSend`, `translate` and `verify` keep their names in `@frontierjs/conduit-github`.**~~ **Answered 2026-11-25 (`FJS-D2371`): A — Three shared export names are one job each, kept: `bindSend`, `translate` and `verify` in `@frontierjs/conduit-github` beside `@frontierjs/conduit-airtable`, `@frontierjs/conduit-37signals` and `@frontierjs/litestone`.** The `FJS-D2278` ratchet refuses a name two packages export until a ruling names it.
  - **A** — Three shared export names are one job each, kept: `bindSend`, `translate` and `verify` in `@frontierjs/conduit-github` beside `@frontierjs/conduit-airtable`, `@frontierjs/conduit-37signals` and `@frontierjs/litestone`.
  - **B** — Rename them in this package: `bindGithubSend`, `translateGithub` and `verifyGithub`.
  - **Recommend A** — `bindSend` and `translate` are the connector contract's names (C2, C3), kept for `conduit-esri` by `FJS-D2366`, and `verify(send)` is the account check `conduit-cloudflare`, `conduit-digitalocean` and `conduit-hetzner` already export beside litestone's migration `verify`.

---

## Phases

### Phase 0 — Groundwork

Goal: the facts the connector branches on are measured, and Q1, Q3, Q4 and Q5 are ruled.
Done when: each question carries its ruling, and 0.2–0.3 have recorded what they measured, here under their steps.

- [x] 0.1 Rule Q1, Q3, Q4 and Q5 through the question tool. `decision-rules` graded the recommendations on 2026-11-25. All four went as recommended (`FJS-D2367`–`FJS-D2370`).
- [x] 0.2 Probe api.github.com without a token: 61 reads of one public repository (not `/rate_limit`, which costs nothing), to capture a real primary-limit refusal. Record its status (403 or 429), its headers and its body.
  - Measured 2026-11-25 on `GET /repos/octocat/Hello-World`: the primary limit answers **403**, not 429.
  - Headers: `x-ratelimit-limit: 60`, `x-ratelimit-remaining: 0`, `x-ratelimit-used: 60`, `x-ratelimit-resource: core`, `x-ratelimit-reset: <epoch seconds>`. There is **no `retry-after`**, so the wait is read from the reset.
  - Body: `{"message":"API rate limit exceeded for <ip>. (…)","documentation_url":"https://docs.github.com/rest/overview/resources-in-the-rest-api#rate-limiting"}`.
  - Every 200 before it carried the same `x-ratelimit-*` headers, counting down.
- [ ] 0.3 Probe with a fine-grained token given no grant on a repository: record the 403 for a missing grant (`x-ratelimit-remaining` above 0) to compare with 0.2. This pair is what `translate` tells apart.
- [x] 0.4 Read conduit's breaker rules for `auth_failed`, to confirm a 403 rate limit, re-kinded by `translate`, never counts as a breaker fault, and that the transport never remints on a 403 (`http.ts` `refusedCredential`).
  - Read 2026-11-25. `resilience.ts` `TARGET_FAULTS` is `connection_failed`, `timeout` and `server_error`: neither `auth_failed` nor `rate_limited` counts toward the breaker, before or after `translate`.
  - `http.ts` `refusedCredential` excludes a 403 for a `bearer` target, so a 403 never remints.
  - The transport answers a 403 with `retryable: false` and the body in `error.raw`, and the headers in `meta.headers`. That is everything `translate` needs.

### Phase 1 — The package and its errors

Goal: `packages/conduits/conduit-github/` exists, with a target builder and the one reader of `error.raw`.
Done when: `bun run drive` passes the error rows against the sink, including the negative control, and `fli ws:atlas` draws the package in its ring.

- [x] 1.1 Scaffold from `conduit-cloudflare`'s layout: `src/index.ts`, `src/errors.ts`, `src/types.ts`, `sink.ts`, `test/github.drive.ts`, scripts `test`/`drive`/`typecheck`. Add a row to the Packages table in the root `CLAUDE.md`, then `fli ws:atlas`, `ws:exports`, `ws:deps` and `ws:surface`.
- [x] 1.2 `githubTarget({ ref, accountId?, address?, perCaller?, userAgent })`. It is a `bearer` target with the Accept, version and User-Agent headers. `accountId` gives the id `provider:github:<id>`, Basecamp's `targetFor` spelling.
- [x] 1.3 `translate(error, meta)` (C3) answers one of these kinds:
  - `refused_grant`, naming the grant the call needs
  - `unseen` (404)
  - `key_in_use` (422)
  - `rate_limited`: a 403 or 429 with `x-ratelimit-remaining: 0` or `retry-after`, its `retryAfterMs` read from `retry-after`, else the reset, else 60 s
  - `auth_failed` (401)
  - conduit's own kinds otherwise
- [x] 1.4 The sink, lifted from Basecamp's `github-sink.ts` onto C10: a listener on `port: 0`, its state per instance, and fault arms for a primary 403 and a secondary 429 with `retry-after`.

### Phase 2 — The calls

Goal: every REST call today's callers make, through `send`, never an app (C2).
Done when: the drive's table covers each call, and a lost write is resolved by its C6 read.

- [x] 2.1 `verify(send)` (`GET /user`) and `repository(send, repo)`.
- [x] 2.2 `setDeployKey(send, repo, { title, key })`. Find by key material, then create unkeyed. The drive proves a write whose answer was lost resolves through the list.
- [x] 2.3 `setPushHook(send, repo, { url, secret })`. Find by URL, then `PATCH` or `POST`. The secret is never read back.
- [x] 2.4 `readFile(send, repo, { paths, ref })`. Ask for the repository first. Skip directories and files over 1 MB, which arrive with no content.
- [~] 2.5 `listAll` with `Link` paging and ETags, and `advisories()` on it — dropped: `FJS-D2369` waits for a runtime caller.

### Phase 3 — Receiving

Goal: the push webhook's signature is checked by the connector's pure verifier (`FJS-D2368`).
Done when: drive rows for a good signature, a wrong one, a missing header, and one byte changed in the body.

- [x] 3.1 `verifyGithubSignature({ rawBody, header, secret })` (C8, constant time) and `parsePush(body)`, lifted from `git-push.ts`.

### Phase 4 — Basecamp onto the connector

Goal: Basecamp holds no GitHub dialect, only its adapter (`FJS-D2367`).
Done when: Basecamp's `source.test.ts`, `from-repo.test.ts` and the push-hook tests pass, `verify-screens.mjs`' connect and Import from repository pass against the package's sink, and `fli done` is clear.

- [x] 4.1 Add `@frontierjs/conduit-github` to Basecamp's api dependencies. Prove `vendor.js` packs it into the image (`FJS-D1559` condition a).
  - Proved 2026-11-25 without an image build: `vendorWorkspacePackages` run over a scratch copy of Basecamp's `package.json` (`WORKSPACE_DIR` at the repo root, so sources resolve through `sourceOfRoot` as in-tree) packed `frontierjs-conduit-github-0.0.1.tgz` (`src/`, `sink.ts`) and rewrote the dependency and its override to `file:./deploy/generated/vendor/…`. A held-out member the app names directly is found by `memberByName`; `packages/cli/test/vendor.test.js` has no held-out row.
- [x] 4.2 Turn `providers/source/github.ts` into the adapter. It keeps `SourceConnector`, `RepoUnseen`, the grant sentences on screen, `githubHttps` and `gitCredential`, which is git's path (`FJS-D2108`). It sends through the connector, still behind `sendVia`'s spend guard.
  - `github.ts` maps `GithubError.failure` onto Basecamp's sentences; `rate_limited` reads *wait N minutes*. `sendVia` now carries the answer's headers (`AccountSend.headers`): without them a primary-limit 403 read as a grant refusal (`source.test.ts` row, checked by removing the headers).
- [x] 4.3 Point `forgeDialect.verify` at `verifyGithubSignature`. Comment there that Forgejo and Gitea deliveries go through the GitHub connector on purpose, because they send GitHub's header. `tokenDialect`, the receiver and `apply` stay Basecamp's.
- [x] 4.4 Retire `github-sink.ts`. Port 8126 and `GH_SINK_TOKEN`/`NO_HOOKS_TOKEN` move onto the package's sink, or `verify-screens.mjs` starts the package's sink. Record which, here.
  - Went the second way: `verify-screens.mjs` spawns the package's sink, resolved as `@frontierjs/conduit-github/sink`, on `GH_SINK_PORT` (API_PORT + 3). The dev stand-in on 8126 is the same file, `GH_SINK_PORT=8126 bun packages/conduits/conduit-github/sink.ts` (`docs/PORTS.md`). The tests import `startGhSink` and `NO_HOOKS_TOKEN` from the package. `verify-screens.mjs` against it is not yet run.
- [ ] 4.6 Run `API_PORT=7120 UI_PORT=7020 bun run verify:screens` in `packages/basecamp` on a disk with 10% free. On 2026-11-25 it stopped 40/41 at the hub backup (`FJS-4467`, disk 96% full), so its connect and Import from repository checks never ran against the package's sink. `verify:provision` passed 110/110 and `bun run test` 1446/0.
- [~] 4.5 Point `verify-advisories.mjs`' GitHub leg at `advisories()` — dropped with 2.5 (`FJS-D2369`).

### Phase 5 — Admission

Goal: the connector ships, or is ruled held out.
Done when: a ruling names it in `ADMITTED` or says why not.

- [ ] 5.1 Ask whether `conduit-github` joins `ADMITTED` (`FJS-D2365`'s path), and release it at 0.1.0 if it does.

---

## Not planned

- **GraphQL.** No caller asks a question REST cannot answer.
- **GitHub Apps and OAuth Apps**, until `FJS-D1571` reopens.
- **fli's `github:*` commands** (Q5), and **sign in with GitHub**, which is auth's.
- **Outbound pacing.** Serial requests and one second between writes stay the caller's, as in `conduit-dataforseo`.

## See also

- `IDEAS/conduit-connectors.md` — the test a connector must meet, and the Basecamp-onto-connectors history (`FJS-D1185`, `FJS-D1559`).
- `IDEAS/git-deploy.md` — where Basecamp's GitHub dialect was built.
- `packages/conduit/docs/CONTRACT.md` — C1–C13.
