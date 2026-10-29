---
id: workspace-onboarding
status: proposed
dated: 2026-10-28
---

# Plan — A workspace is ready when every connection it needs is proven

Basecamp's `/onboarding` asks six questions of the database and links each to
the screen where the work happens. *Done* there is *a row exists*: a revoked
Hetzner token, a bucket that refuses writes and a Slack webhook that 404s all
read as done. The probes that would say otherwise already exist and the screen
calls none of them. This plan makes the screen the place a workspace is wired
up, one step at a time, with a vendor link, the scopes to tick and a Verify
button on each step, and grades each step **missing → present → proven**. A
workspace whose required steps are all proven is *workspace ready* — always
the two words, since bare *ready* is `/health`'s (`FJS-D440`) and a site
preview's. It is where the first-app wizard (a later plan) starts, and it is
advisory: a banner and a starting point, never a refusal, so a vendor outage
cannot block a deploy.

Every connection stays workspace-owned (`FJS-D1491`). The hub tier gets no
credential of its own; mail is the install's, set by env, and the screen
shows it read-only with a link to the hub.

---

## What exists

- **`web/src/routes/onboarding/index.mesa`** over `infra.onboarding`
  (`api/src/services/infra/infra.service.ts`): steps `workspace`, `server`,
  `ssh-key`, `project`, `deploy`, `team`, each `done` by a count. No `done`
  column and no *mark complete* button. That ruling is SCREENS.md § Phase 11,
  and this plan keeps it: a step's grade is a question asked fresh.
- **`secrets.verify`** makes the vendor's cheapest authenticated read through
  `accountConnectorFor(providerKind)` (`providers/compute/accounts.ts`:
  Hetzner, DigitalOcean, Cloudflare, GitHub) and writes `Secret.isVerified`.
  It reports `tested: false` for a kind no connector can check. The flag has
  no timestamp, so a key verified once and revoked a month later still reads
  as proven.
- **`backup-destinations.test`** writes and deletes a probe key in the
  bucket. **`channels.test`** sends a real message. Both stamp `lastTestAt`.
- **A connector carries `kind`, `label`, `descriptor`, `verify`** and nothing
  about where a person gets a key or which scopes it needs. That fact lives in
  nobody's head but the person's.
- **`verify` proves a token is alive, not that it can do the job.** A
  Cloudflare token without `Zone.DNS:Edit` passes and fails at the first
  `edge.sync`.

## The steps

| Step | Required | Proven when |
| ---- | -------- | ----------- |
| Compute | yes | a verified Hetzner or DigitalOcean key with write scope, or an imported server online |
| SSH key | no | a `ssh_key` Secret exists (presence only: proving it means connecting to a machine) |
| DNS | yes | a verified Cloudflare key with DNS edit on at least one zone |
| Backups | yes | a `BackupDestination` whose last test passed |
| Alerts | yes | a `NotificationChannel` whose last test passed |
| Source | no | a verified GitHub key with the scopes `IDEAS/git-deploy.md` needs |
| Mail | n/a | read-only: configured at the install level (`MAIL_URL` / `RESEND_API_KEY`), links to the hub |
| Team | no | more than one member, or an invitation out |

`project` and `deploy` leave this screen; they are the first-app wizard's.

## Prior art

Read 2026-10-28 (0.1). Coolify and Dokploy were read from source; Stripe,
Vercel and Railway from their docs. Nobody grades a connection beyond one
boolean, and nobody checks a pasted token's scopes.

- **Coolify** (`coollabsio/coolify` @ `c2de0d8`).
  - **Shape.** A linear wizard covering server, SSH key and first project
    (`app/Livewire/Boarding/Index.php`). The step lives in the URL, and
    *Skip setup* is on every step.
  - **Completion.** Stored as `teams.show_boarding`. While it is set,
    middleware sends every other path to the wizard
    (`app/Http/Middleware/DecideWhatToDoWithUser.php`). It is never
    recomputed from state.
  - **Token checks.** `GET /v1/servers` for Hetzner and `GET /v2/account` for
    DigitalOcean, and any 2xx passes
    (`app/Livewire/Security/CloudProviderTokenForm.php`). A read-only Hetzner
    token is therefore accepted. No result is stored.
  - **S3 checks.** S3 is tested by listing only. The result is
    `is_usable`, a boolean with no timestamp. An hourly job re-tests only the
    storages that failed (`RevalidateUnusableS3StoragesJob`).
  - **Vendor guidance.** A console link per provider and no scope list
    (`resources/views/livewire/security/cloud-provider-token-form.blade.php`).
  - **GitHub.** Connected through an App created from a manifest, with
    `checkPermissions()` refreshing the stored permissions afterwards.
- **Dokploy** (`Dokploy/dokploy`, `canary`).
  - **Shape.** A stepper wizard (welcome, project, deploy, complete) with
    *Skip all* (`components/dashboard/onboarding/onboarding-wizard.tsx`).
  - **Completion.** Stored as `user.onboardingCompletedAt`. There is no way
    back into the wizard in the product.
  - **Probes.** All one-shot and none stored: Cloudflare `GET /zones`, S3
    `rclone ls`, Slack sends a message. The schema has no `testedAt`.
  - **Scope guidance.** Its only scope guidance is a line of prose, "Zone →
    DNS → Edit" (`handle-dns-provider.tsx`).
  - **Compute.** It has no compute-provider key at all; you paste an IP.
- **Stripe.**
  - **Account checklist.** It keeps its ticks in browser storage and never
    re-grades them ([checklist](https://docs.stripe.com/get-started/account/checklist)).
  - **Connect requirements.** This is the strong model. Readiness is
    computed on the server, and an item can come back into `currently_due`
    with an `errors[].reason` after it passed
    ([handling-api-verification](https://docs.stripe.com/connect/handling-api-verification)).
  - **States.** `pending_verification` means submitted but not yet checked,
    which is our *present*.
  - **Restricted keys.** No probe when the key is added; a missing
    permission surfaces as a 403 on a later call
    ([restricted-api-keys](https://docs.stripe.com/keys/restricted-api-keys)).
- **Vercel.**
  - **Shape.** No checklist. Git connects through a GitHub App, with a line
    of "why" per permission
    ([vercel-for-github](https://vercel.com/docs/git/vercel-for-github)).
  - **Disabled integration.** It notifies the owners, names what will stop
    working, and removes it after 30 days
    ([manage-integrations-reference](https://vercel.com/docs/integrations/install-an-integration/manage-integrations-reference)).
- **Railway.**
  - **Shape.** No checklist. GitHub is linked when first needed
    ([quick-start](https://docs.railway.com/quick-start)).
  - **Webhooks.** *Test Webhook* reports the real HTTP status, and a failing
    webhook pauses for 24h
    ([webhooks](https://docs.railway.com/reference/webhooks)).
  - **Revoked GitHub access.** Recovery is by hand: reconnect, then re-link
    the repo on each service
    ([github-autodeploys](https://docs.railway.com/guides/github-autodeploys)).

- **Leases** (the throwaway tokens 0.2 needs, and the long-lived ones
  `/secrets` holds today). Read 2026-10-28 from docs; no vendor probed yet.
  One guarded parent credential mints short-lived children, so the pasted
  token is the exception and never the working one.
  - **Vault** attaches a lease (a TTL and an id) to each dynamic secret;
    the consumer renews or replaces it, and revoking the lease invalidates
    the secret at once
    ([lease, renew, revoke](https://developer.hashicorp.com/vault/docs/concepts/lease)).
  - **fnox** has a Cloudflare lease backend: a parent token holding
    *Account API Tokens: Edit* creates child tokens that expire on their
    own. A child inherits the parent's policies unless the config names
    narrower ones, and `duration` defaults to the backend maximum, 24 hours
    ([fnox cloudflare lease](https://fnox.jdx.dev/leases/cloudflare.html)).
    The parent is therefore the powerful secret and the children are cheap.
  - **Cloudflare** exposes the two calls underneath: `POST
    /accounts/{id}/tokens` and `DELETE /accounts/{id}/tokens/{token_id}`,
    both needing *Account API Tokens Write*
    ([delete](https://developers.cloudflare.com/api/operations/account-api-tokens-delete-token),
    [create via API](https://developers.cloudflare.com/fundamentals/api/how-to/create-via-api/)).
    Its own guidance is to limit the parent by client IP or TTL.
  - **GitHub** installation access tokens, minted by an App, expire after
    one hour and can be narrowed to named repositories
    ([docs](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation)).
    `FJS-D1571` ruled a fine-grained token over an App for git-deploy, so
    this is the road not taken there, not a contradiction. A fine-grained
    PAT lives up to a year or forever and is revoked by hand
    ([credential types](https://docs.github.com/en/organizations/managing-programmatic-access-to-your-organization/github-credential-types)),
    so the App is the only GitHub shape that leases.
  - **fnox `exec`** is the dev-CLI shape: `fnox exec -- cmd` mints the child
    and sets `CLOUDFLARE_API_TOKEN` in the child process only; the parent
    never enters the command's environment
    ([leases guide](https://fnox.jdx.dev/guide/leases.html)). Its docs say a
    lease does not remove the need to guard the identity that mints, which
    here is the parent Secret. A second read of the same page gave the
    default TTL as 15 minutes rather than the 24-hour maximum; 0.4 reads the
    default off the backend rather than trusting either.
  - **1Password `op run`** resolves `op://vault/item/field` references from
    an env file into the child process only, and warns that same-user
    processes can still read that environment
    ([secret references](https://developer.1password.com/docs/cli/secret-references)).
    This is the shape for `~/.config/fli/env` (4.3): references on disk,
    values only in the running step.
  - **Pulumi ESC and Tailscale** exchange a platform's OIDC identity for a
    short-lived vendor token with no stored secret at all
    ([ESC](https://pulumi.com/docs/esc/get-started/use-short-term-credentials),
    [Tailscale](https://tailscale.com/docs/features/workload-identity-federation)).
    Out of reach here: none of the five vendors accepts a Basecamp
    identity, and it is noted so nobody re-researches it.
  - **Hetzner, DigitalOcean, Backblaze B2** are unchecked (0.4). Assumed
    unable to mint until probed.
  - **Not read:** Doppler, Infisical, `aws-vault`.

**What the rulings make of it.**

- **Q1 (`FJS-D1578`).** The two open-source peers chose a wizard, but theirs
  covers server, project and first deploy. That is this plan's later
  first-app wizard. Neither covers revisiting a connection after it is
  revoked, which is the common case here. Coolify's lockout is what a
  stored flag plus a gate costs. Stripe Connect is the computed, re-graded
  shape that A takes. The ruling stands.
- **Q2 (`FJS-D1579`).** Nobody requires backups or alerts. That is neither
  for nor against.
- **Q3 (`FJS-D1580`).** Nobody checks scopes, and Coolify's acceptance of a
  read-only Hetzner token is the exact false green A was ruled to stop. The
  ruling stands, and it goes past every peer.

**What it adds to later steps.**

- **Prefilled key pages, for two vendors.** GitHub fine-grained tokens and
  Cloudflare tokens can both be opened with the permissions already ticked:
  - GitHub:
    `github.com/settings/personal-access-tokens/new?name=…&contents=write…`
    ([docs](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)).
  - Cloudflare: `permissionGroupKeys=[{"key":"dns","type":"edit"}]`
    ([docs](https://developers.cloudflare.com/fundamentals/api/how-to/account-owned-token-template/)).
    A user-owned Cloudflare template drops an unknown key without saying so,
    so the scope list is shown beside the link even where the link presets
    it (1.3).
  - DigitalOcean and Hetzner have no prefill URL.
- **The fine-grained token fits git-deploy.** `FJS-D1571` already ruled a
  fine-grained GitHub token kept as a Secret over an App, and the prefill
  URL suits that shape.
- **A lease would shrink what 0.2 and the screen ask of a person.** One
  parent per vendor, held as a Secret, with a lease minting the
  verify-and-work token. Whether that earns a noun is Q5; until then the
  screen asks for the token it asks for today.
- **fnox is three parts, and two already have a home.** Its vault is
  `Secret` (`@encrypted data`, `kind`, `verifiedAt`). Its `exec` is `fli`
  running a deploy step as a child process with `~/.config/fli/env` in its
  environment, which today holds long-lived values in plaintext, and a stale
  `GITHUB_TOKEN` there has already broken `gh` under `fli`. Its lease is the
  gap, and FJS can place it better than fnox does: fnox mints on the dev
  box, which has to hold the parent, where Basecamp can mint server-side and
  hand the child down, so the dev box never sees the parent. The binary is
  not adopted; `fli` is the exec wrapper already, and only two of five
  vendors overlap fnox's backends. The pattern lands as Phase 4 once Q5 is
  ruled.
- **A failed re-probe keeps its reason.** Stripe's re-due item carries a
  reason, and ours should too: a re-probe that fails clears `verifiedAt` and
  keeps the vendor's refusal as evidence (1.1, 2.1). There is no fourth
  grade, because *present with a reason* already says it.

---

## Phase 0 — Prior art and the vendors' own answers

Goal: each later step is argued from how others do it and what each vendor's
API admits about a token.
Done when: § Prior art holds a sourced paragraph per product, and § Scope
probes a row per vendor naming the call that reads a token's scope, or *none*.

- [x] 0.1 Prior art, sources required: Coolify's boarding flow, Dokploy's
  first run, Stripe's setup guide, Vercel and Railway's integration connect.
  Q1–Q3 were ruled in chat before this pass ran; a finding that contradicts
  one reopens it rather than being filed under it.
- [ ] 0.2 Per vendor, the read that answers *what may this token do*: GitHub
  (classic `X-OAuth-Scopes`; fine-grained has no header), Cloudflare
  (`/user/tokens/verify` and whether a token can read its own policies),
  Hetzner (read vs read-write tokens), DigitalOcean (custom-scoped tokens),
  Backblaze B2. Probed live against a throwaway token, not read off docs.
  - GitHub classic and OAuth tokens report scopes in `X-OAuth-Scopes`
    (probed 2026-10-28: the `gh` login returned `admin:public_key, gist,
    read:org, repo`). Cloudflare: the `cf` login is OAuth, so
    `/user/tokens/verify` answered 401, because that route takes API tokens
    only. Fine-grained GitHub, Cloudflare API tokens, Hetzner, DigitalOcean
    and B2 are not probed.
  - Needs throwaway tokens. 0.4 may mint the Cloudflare ones.
- [ ] 0.3 Per vendor, the URL of the key page and the exact boxes to tick,
  checked by opening each. For GitHub fine-grained and Cloudflare, the URL
  is a prefilled template (§ Prior art): open it and confirm every box
  arrives ticked.
- [ ] 0.4 Lease probe. Per vendor, can a parent credential mint and revoke
  a short-lived child token over the API: Cloudflare first (create, call
  `/user/tokens/verify` and the policy read with the child, delete, confirm
  the child is refused), then GitHub via an App, then Hetzner, DigitalOcean
  and B2 from their API references. Uses one parent Cloudflare API token
  carrying *Account API Tokens Write*, or `cf` OAuth minting two throwaway
  tokens, which writes to the real account and so is the owner's call. Fills
  Q5's evidence; nothing is built from it.

## Phase 1 — A proof that ages, and knows what it proved

Goal: *proven* means *a probe passed, at a known time, for the scopes this
app uses*.
Done when: `bun run test` covers a key that is alive but under-scoped
reporting `verified: false` with the missing scope named, against a stand-in.

- [ ] 1.1 `Secret.isVerified` becomes `verifiedAt DateTime? @system`: set
  when a probe passes, cleared when the value rotates or the vendor refuses.
  A refusal's reason goes in `verifyError String? @system`, which is cleared
  on a pass or a rotation. Its time is in the audit trail, so no second stamp.
  This is not `Dependency.checkError`, which means *could not answer*: an
  unreachable vendor still leaves both fields as they were. Every setter
  clears on a refusal, `backup-destinations.test` included. A test row
  passes a key, then refuses it, and asserts `verifiedAt` is null and
  `verifyError` is set — the shape
  `BackupDestination.lastTestAt` and `NotificationChannel.lastTestAt` already
  have. Every reader moves in the same change (secrets, edge, servers,
  channels, domains, backup-destinations), so the screen can say *verified 3
  days ago* and one fact is stored once.
- [ ] 1.2 `AccountConnector.verify` returns `{ ok, missing: string[] }`; each
  connector checks the scopes 0.2 found readable. A vendor with no readable
  scope says so on the answer (`scopesChecked: false`), as `tested` does
  today, and its grade is Q4's.
- [ ] 1.3 The vendor facts move onto the connector beside `label`: `keyUrl`,
  `scopes` (what to tick, in the vendor's words) and a one-line `why`. One
  owner per vendor fact; `/secrets` and the readiness screen both read it.

## Phase 2 — Readiness is graded on the server

Goal: one read answers every step's grade and the workspace's.
Done when: `infra.onboarding` returns `workspaceReady` and per-step `grade`, and a
drive seeding one of each grade reads them back.

- [ ] 2.1 `infra.onboarding` grades each step `missing | present | proven`
  per § The steps, with `required` and the evidence (`verifiedAt`,
  `lastTestAt`, missing scopes, `scopesChecked`). `workspaceReady` is every
  required step proven.
- [ ] 2.2 `infra.verifyAll` runs each step's existing probe in turn
  (`secrets.verify`, `backup-destinations.test`, `channels.test`) and returns
  the regraded list. A vendor that cannot be reached leaves its step's grade
  where it was, as `secrets.verify` does now.

## Phase 3 — The screen

Goal: a person wires a workspace up without leaving `/onboarding`.
Done when: a browser drive takes a fresh workspace to *workspace ready*
against stand-ins for each vendor.

- [ ] 3.1 Each step expands to a panel: why it matters, the key link and
  scopes from 1.3, the paste field (the existing create form for that model,
  not a copy), and Verify. The first unproven required step opens on load.
- [ ] 3.2 *Verify all* over 2.2, and the header reads *Workspace ready* or
  *N of M required steps proven*.
- [ ] 3.3 A workspace that is not ready shows a banner on the dashboard
  linking here; a ready one does not.

## Phase 4 — A short-lived child does the work

Goal: for a vendor that can mint, the pasted token is held once and never
used directly; every probe, drive and deploy step takes a child that expires.
Waits on Q5 and on 0.4's per-vendor answer; nothing here starts before both.
Done when: a Cloudflare deploy step runs with a child token that
`/user/tokens/verify` later refuses, and the parent appears in no process
environment and no log.

- [ ] 4.1 The Cloudflare account connector grows `mint` — the word Basecamp
  already uses for a short-lived child derived from a held parent
  (`mintDeployKey`, `mintUpload`, `mintDownload`): `({ ttl, scopes }) →
  child`,
  with `ttl` capped at the vendor maximum and defaulting to 15 minutes, and
  `scopes` defaulting to the connector's own list from 1.3 minus token
  management. The child is returned, never stored; the mint is one audit
  entry with the value `[redacted]` (Invariant 7). The parent Secret carries
  *Account API Tokens Write* and nothing a child needs, so a leaked child
  cannot mint. A connector that cannot mint has no verb, and a caller asks
  `connector.leases` before reaching for it, so a vendor that cannot is
  never silently handed the parent. `AccountConnector`'s pick grows to
  `'verify' | 'mint'`; no `/secrets/mint` route beside `verify`.
- [ ] 4.2 `secrets.verify` and 0.2's scope read take a child where the
  connector leases, and the parent is probed only for *can it mint*. The
  probe that 0.2 wanted throwaway tokens for becomes mint, read, expire.
- [ ] 4.3 `~/.config/fli/env` holds references, not values: a line such as
  `CLOUDFLARE_API_TOKEN=basecamp://<workspace>/secret/<name>` that `fli`
  resolves at step start by asking Basecamp for a child, which enters the
  step's environment only. A plain value still works and is reported by
  `fli doctor` as long-lived. One resolver, in `fli`, beside the env loader;
  the scheme name runs `decision-rules`. Fixes the stale-token class of
  failure as a side effect, since a reference cannot go stale. A reference
  that fails to resolve REFUSES the step with the vendor's or Basecamp's
  reason; it never falls through to an empty variable.
- [ ] 4.4 GitHub via an installation token is the second vendor only if
  `FJS-D1571` (fine-grained PAT over an App for git-deploy) is reopened; a
  PAT cannot lease. Filed as the question it is rather than built around.
- [ ] 4.5 Hetzner, DigitalOcean and B2 stay long-lived keys: encrypted,
  verified on 2.2's schedule, scope-checked per 1.2. The screen says
  *long-lived* beside them so the difference is visible, not hidden.

## Open questions

- ~~**Q1 — The shape of the experience.**~~ **Answered 2026-10-28 (`FJS-D1578`): A — one checklist page; each step expands in place to why, link, scopes, paste and Verify; the next open step opens itself. Evolves `/onboarding` and keeps its no-done-column ruling.**
  - **A** — one checklist page; each step expands in place to why, link,
    scopes, paste and Verify; the next open step opens itself. Evolves
    `/onboarding` and keeps its no-done-column ruling.
  - **B** — a modal step-by-step wizard, Next and Back. Skipping and coming
    back are awkward and its forms duplicate `/secrets`.
  - **C** — both: the wizard on first visit, the checklist after. Two
    surfaces kept in step.
  - **Recommend A** — one surface, and coming back later is the common case.
- ~~**Q2 — Which steps a ready workspace requires.**~~ **Answered 2026-10-28 (`FJS-D1579`): A — Compute, DNS, Backups and Alerts; Source, SSH key and Team are recommended, not required.**
  - **A** — Compute, DNS, Backups and Alerts; Source, SSH key and Team are
    recommended, not required.
  - **B** — those four and Source (GitHub).
  - **No recommendation** — asked as a pick of steps, not argued.
- ~~**Q3 — Whether Verify checks scopes.**~~ **Answered 2026-10-28 (`FJS-D1580`): A — per vendor: each account connector checks the scopes this app uses, where the vendor lets a token read them.**
  - **A** — per vendor: each account connector checks the scopes this app
    uses, where the vendor lets a token read them.
  - **B** — alive only, `secrets.verify` as it is; scopes later.
  - **Recommend A** — an alive, under-scoped token is the green tick that
    lies at first deploy.
- **Q4 — The grade of a live key whose scopes the vendor will not report**
  (a fine-grained GitHub token sends no scope header). Waits on 0.2, which
  says which vendors this is.
  - **A** — `present`, with *scopes not checked* as its evidence: proven
    stays a claim the probe made.
  - **B** — `proven`, with *scopes not checked* beside it: the key is alive
    and the person ticked the boxes the panel listed.
  - **C** — a write probe per vendor (create and delete a throwaway record)
    that proves the scope by using it.
  - **Recommend A** — it is the false green Q3 was ruled to stop, and C is a
    side effect on a person's account for a grade.
- **Q5 — Whether a lease earns a noun.** The prior art is a parent
  credential minting short-lived children (§ Prior art, Leases). Waits on
  0.4, which says which vendors can; run `decision-rules` before coining.
  - **A** — no noun: the pasted token stays the only credential, and this
    plan's verify, scopes and keyUrl work stands alone.
  - **B** — a *Lease* for the vendors that can mint: one parent Secret, and
    verify, drives and the dev workflow take a child that expires.
  - **C** — a lease for development and drives only (the throwaway tokens
    0.2 wants); production keeps the pasted token.
  - **D** — a verb, not a noun: the account connector of a vendor that can
    mint exposes it, the child is returned and never stored, and the audit
    trail is the only record. Phase 4 is written to D. A row would outlive
    its value by months and would be a lie for the three vendors that
    cannot mint; a verb on two connectors is honest about the minority and
    cheap to retract. A *Lease* row is coined later only if someone needs
    *which children are live now*, which the vendor can also answer.
  - **Recommend D, as `mint`** — agreed in chat 2026-10-28 as the
    direction; `decision-rules` the same day chose the word: Basecamp
    already mints three such children, `lease` half-fits (no renew or
    revoke on our side) and is a fourth house sense. The ruling itself
    waits on 0.4 saying Cloudflare can, so a verb is not named for a vendor
    that refuses; when it lands, `mint` enters `VOCABULARY.md` and the
    open `Secret` row closes in the same edit. The homonym paragraph below
    is then moot for D and stands only against B.
  - **Homonym to answer first.** *Lease* already means a job row's
    ownership (`packages/caravan/CLAUDE.md`), a hold inside `runInline`
    (`packages/orion/CLAUDE.md`) and the per-request tenant-pool hold, which
    `FJS-D172` calls "not a public verb". B has to say why a fourth sense
    does not collide, or pick another word, and register it in
    `VOCABULARY.md`. Any owner lives in `/secrets` beside 0.2 and 1.1,
    never a module beside them.
