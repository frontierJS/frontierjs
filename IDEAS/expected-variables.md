---
id: expected-variables
status: proposed
dated: 2026-11-05
---

# Expected variables — an App lists the env keys it still needs

**Status: PROPOSED.** Dated 2026-11-05. Nothing here is built. Do not cite this
file as describing behavior — see `VERIFYING.md`.

The want: after a deploy, the App's page in Basecamp lists every env key the
app expects and does not have yet, each with a value box. Today the owner
deploys, the container fails at boot or a feature quietly fails, and they go
back to the project to find which keys the app reads before they can type them
into the Variables pane one by one.

Only key names leave the laptop. Values stay in `.env.production`.

---

## What exists

- **`fli basecamp:app` makes the App bare on purpose** (`FJS-D1599`): no port,
  no volume, no Variables. It stays that way.
- **`fli basecamp:deploy` completes the App on every run** from what the app
  declares: `gatherReleaseInputs` (`packages/cli/core/release-preflight.js`)
  reads the `defineEnv` spec through `readEnvSpec`, `releaseFindings` grades
  it, and `releasePlan` merges each finding's `fix.app` into one App patch
  written through `apps:write`.
- **The spec is read and thrown away.** `env-required` fires for a required
  key set nowhere, with a fix only for `ENCRYPTION_KEY`; a credential "is
  somebody's and cannot be invented", so its fix is prose. A key the app reads
  straight from `process.env` is never seen at all.
- **`fli env:push` writes values when asked.** With `BASECAMP_APP_ID` set it
  posts `.env.production`'s keys to the App's Variables, secret by
  `FJS-D1940`'s name rule, skipping every key `releasePlan` sets
  (`releaseOwnedKeys`) and any value under `./db`. It is the explicit value
  half; this plan stays names-only.
- **`Variable` holds values only.** A row is a key with a value (or an
  encrypted `secretValue`); `isSecret` is `@immutable`. The pane is
  `components/VariablesEditor.mesa`, mounted on `routes/apps/[id]/index.mesa`
  under *Variables*.

## Prior art

- **Heroku `app.json`** — an `env` block declares each key with `required` and
  a description; the deploy button asks for the values.
- **Render blueprints** — an `envVars` entry with `sync: false` declares the key
  and leaves the value to the dashboard, which asks for it on create.
- **Railway** — *suggested variables*, read from the repo's env files, offered
  in the dashboard for the owner to fill.

All three keep the declaration apart from the value store. So does this.

## Recommended setup

One advisory column on `App`, `expects Json @type(ExpectedVariable[])`, with
`type ExpectedVariable { key, required, secret, from }` — `from` is `spec`,
`env.production` or both. `basecamp:deploy` replaces it whole on every run,
riding `releasePlan`'s App patch beside the port and the health check, and
stamps `expectsAt`. Nothing reaches `docker run` from it, which is what keeps it
clear of `FJS-D227`: that ruling moved Variables out of `Json` because the
machine reads them; the machine never reads this.

What is *missing* is never stored. The pane and the preflight both derive it as
`expects` minus the keys the App or its environment holds.

Placeholder `Variable` rows were weighed and refused: an empty row reaches the
container as `KEY=` and overrides the app's own default, and `resolve()` already
treats `''` as unset.

## Phases

### Phase 1 — The list reaches Basecamp

The deploy sends key names, and Basecamp keeps the last list.

- [ ] 1.1 `expects` and `expectsAt` on `App`, and `type ExpectedVariable`, in
  `packages/basecamp/db/schema.lite`. The comment says advisory, UI-only, never
  read by a release — so nobody reads it as a `FJS-D227` reversal. Writable
  under `apps:write`; no `@system`.
- [ ] 1.2 A key-name reader for `.env.production` beside `readEnvSpec` in
  `release-preflight.js`, not a third env parser. It returns names and drops
  everything after `=`. A test feeds it a file of values and asserts no value
  appears in its answer or in the App patch.
- [ ] 1.3 `gatherReleaseInputs` returns both sources, and `releasePlan` merges
  them into `app.expects`, each key labeled with where it came from. `secret`
  follows Q3: a name matching `KEY|SECRET|TOKEN|PASSWORD` is secret, any other
  is plain.
- [ ] 1.4 `basecamp:deploy` prints the list in its plan as names only, e.g.
  `Expects: STRIPE_KEY (required, secret), SENTRY_DSN`. Under `--dry` too.

### Phase 2 — The pane shows what is missing

- [ ] 2.1 `VariablesEditor` lists each expected key the App and its
  environment do not hold as a row with a value box, the secret switch preset
  per Q3, and a *required* mark from the spec. Saving makes an ordinary
  `Variable`.
- [ ] 2.2 The rows are headed with the deploy they came from (`expectsAt`), so
  a stale list does not read as current.
- [ ] 2.3 `env-required`'s fix text points at the pane. It still fires on an
  App with no `expects`, such as an older App or a `--dry` run.

### Phase 3 — Proof

- [ ] 3.1 `fli done` clean, and a drive of the pane: deploy the example app with
  a key unset, open its App page, see the row, fill it, see it leave the list.

## Open questions

- ~~**Q1 — Where the key names come from.**~~ **Answered 2026-11-05 (`FJS-D1938`): A — Both the `defineEnv` spec and the key names in `.env.production`, each labeled with its source.**
  - **A** — Both the `defineEnv` spec and the key names in `.env.production`,
    each labeled with its source.
  - **B** — The spec only.
  - **C** — `.env.production` only.
  - **Recommend A** — the spec gives required and defaults, the file catches a
    key read straight from `process.env`, and the label says which is which.
- ~~**Q2 — When the list is written.**~~ **Answered 2026-11-05 (`FJS-D1939`): A — On every `basecamp:deploy`.**
  - **A** — On every `basecamp:deploy`.
  - **B** — Also when `basecamp:app` makes the App.
  - **Recommend A** — `FJS-D1599` completes the App on every run and keeps
    `basecamp:app` bare; a key added later shows up after the next deploy.
- ~~**Q3 — Which keys default to secret.**~~ **Answered 2026-11-05 (`FJS-D1940`): B — Secret when the name looks like a credential (`KEY|SECRET|TOKEN|PASSWORD`), plain otherwise.**
  - **A** — Secret unless the spec or the name marks it plain.
  - **B** — Secret when the name looks like a credential
    (`KEY|SECRET|TOKEN|PASSWORD`), plain otherwise.
  - **C** — No default; each row makes the owner pick.
  - **Recommend A** — `isSecret` is `@immutable`, so a credential saved plain
    has already been read.

## Out of scope

- **Pushing values.** Values never leave the laptop through this; a
  value-carrying import is its own question against `FJS-D1186`.
- **Environment-wide expectations.** The list is the App's; an environment
  Variable satisfies it but nothing is expected of an environment.
