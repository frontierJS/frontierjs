---
id: teams-rig
status: proposed
dated: 2026-11-14
---

# Idea — the teams rig, with the rig installer

**Status: plan only, Phase 0 next.** Joins overview 3.8 (teams) and 3.2 (the installer).
Probed against the tree 2026-11-14. Do not cite this file as behavior — see `VERIFYING.md`.

**The ask** (owner, 2026-11-14): teams, membership tenancy and the rig installer
together. Every stressor app rebuilt members and invitations by hand.

## What exists (probed 2026-11-14)

- **Membership tenancy (overview 4.18a) is built, not waiting.** `FJS-D113` ruled it and
  `FJS-374` (closed) built `createApp({ principal })` and `membershipClaim()` in junction.
  Four apps call it: basecamp, swatchbook, thod and music. Swatchbook's whole resolver is a
  ten-line `membershipClaim({ tenantFrom, model, subject, tenant, standing })`.
- **What apps still write by hand is everything around the claim:**
  - the models. `rig-catalog.md` counts 9 apps with an organization, a member and a role.
    `packages/litestone/references/Organization.lite` is the reference shape and leaves the
    role enum out, because every app names its roles differently.
  - the invitation flow. Basecamp's `invitations.service.ts` is 457 lines: create, resend,
    remove, preview, and an accept that creates the account through auth and signs it in.
    Sstime's `invites.service.ts` plus its screen and notification are 216.
  - the screens: members, invitations, the accept page.
  - role → gate level. Basecamp's `api/src/core/gate.ts` maps five roles onto the 0–7 scale.
- **Basecamp's `Invitation` has no status.** It has `expiresAt`, a `@secret @hashed` token
  unique across the installation, `@@unique([workspaceId, email])` and `@@gate(5)`.
  Accepted, revoked and expired are implied by the row being deleted or the date passing.
- **No installer exists.** There is no `fli add` and no `rig:list`. `fli auth:install`
  (`packages/cli/commands/auth/install.md`) is the nearest thing: it injects auth's schema
  fragments, generates keys and scaffolds `auth.ts`.
- **Packages ship their schema in `db/`.** That is true of `packages/auth/db/` and
  `packages/notifications/db/`. `rigs.md` § The folder is the manifest names the folder
  `model/` (see Q4).
- **An imported fragment resolves an enum the host declares.** Probed: a fragment whose
  `Member.role` is `MemberRole`, imported by a schema that declares `enum MemberRole`,
  parses and resolves the field to the host's enum. No test pins this yet (0.1).

## Rulings this plan builds on

- `FJS-D630` — *Rig* is the noun; a Rig's `service/` part is a Plugin.
- `FJS-D822` — no `upgrade/` codemods.
- `FJS-D824` — a rig declares an external service as an `attachments` entry.
- `FJS-D2163` — ejected files: the installer records version + hash, `rig:list` shows drift.
- `FJS-D2164` — a rig's suite is collected into the consumer's `bun run test`.
- `FJS-D2165` — no litestone peer range; the installer parses `model/*.lite` against the
  installed litestone and refuses by name.
- `FJS-D2166` — a rig feeds the gate through a function the app composes in its own
  `getLevel`.
- `FJS-D2167` — teams is the first rig.

## Open questions

- ~~**Q1 — Build the teams rig and the general installer together, or the rig first?**~~ **Answered 2026-11-14 (`FJS-D2168`): A — together: `@frontierjs/teams` in the rig layout and `fli add` / `rig:list`, proving the whole format on its first rig.**
  - **A** — together: `@frontierjs/teams` in the rig layout and `fli add` / `rig:list`,
    proving the whole format on its first rig.
  - **B** — the rig first, installed by its own `fli teams:install` shaped like
    `fli auth:install`; the general `fli add` waits for a second rig to argue with.
  - **C** — a scaffold, no package: `fli make:teams` copies models, service and screens into
    the app, as Laravel Jetstream's `--teams` does.
  - **Recommend B** — one rig is thin evidence for a general installer, the hard design
    questions sit in the teams half, and `FJS-D153` waited for a second connector the same
    way.

- ~~**Q2 — Where do the role names come from?**~~ **Answered 2026-11-14 (`FJS-D2169`): A — the host declares the enum: the rig's `Member.role` names `MemberRole`, which the app declares in `db/schema.lite`, and the app passes a role → level map to the rig's standing function.**
  - **A** — the host declares the enum: the rig's `Member.role` names `MemberRole`, which the
    app declares in `db/schema.lite`, and the app passes a role → level map to the rig's
    standing function.
  - **B** — the rig ships a fixed enum (`owner admin member guest`).
  - **C** — `role String`, with no enum.
  - **Recommend A** — the probe shows it parses, it keeps the role vocabulary the product's
    (as `Organization.lite` argues), and the boundary still validates the value. B is wrong
    for every app with a `manager` or a `developer`; C loses the check.

- ~~**Q3 — Is an Invitation its own model, or a Grant with an email and a role?**~~ **Answered 2026-11-14 (`FJS-D2170`): A — its own model with `pending → accepted | expired | revoked` declared as `@@transitions`, lifted from basecamp's `Invitation`.**
  - **A** — its own model with `pending → accepted | expired | revoked` declared as
    `@@transitions`, lifted from basecamp's `Invitation`.
  - **B** — a Grant (`references/Grant.lite`) with an `email` and a `role`, so invitations
    and the share-links rig share one shape.
  - **C** — read `Grant.lite` against basecamp's and sstime's invitations before choosing.

- **Q4 — Are a rig's folders `model/ service/ resource/ suite/` or the app's
  `db/ api/ web/ test/`?**
  - **A** — `model/ service/ resource/ suite/`, the realm nouns `rigs.md` chose; `auth` and
    `notifications` move to match when they become rigs.
  - **B** — the app's own layout (Invariant 3), which `auth/db/` and `notifications/db/`
    already use, so a rig reads like a small app.
  - **Recommend B** — a rig's parts land in exactly those app folders, the two packages
    nearest to being rigs already use it, and pre-alpha a rename costs the same either way;
    B makes the move from rig to app one-to-one with nothing to translate.

## Plan

### Phase 0 — Groundwork

Goal: the probe pinned, the hand-built instances read, the stale records fixed.
Done when: 0.1's test is green in `packages/litestone` (`bun run test`), the table in 0.2 is
written here, and Q4 is ruled.

- [ ] 0.1 Pin the host-enum probe as a litestone test: a fragment imported by a bare
  specifier resolves an enum the host declares, and a host that declares none is refused
  with the enum's name.
- [ ] 0.2 Read basecamp, sstime, saas-starter and swatchbook: which of create, resend,
  re-invite without duplicating, revoke, expiry, accept-creates-account and last-owner
  refusal each one has. The rig's scope is the union a second app wanted.
- [ ] 0.3 Fix the stale records: overview 4.18a reads built (`FJS-374`);
  `membership-from-schema.md` names four callers, not one; `Organization.lite`'s
  *No `Invitation`* paragraph says why the rig has one (Q3); `rigs.md` § The rig that should
  come first drops *blocked on the installer*.

### Phase 1 — The Data part

Goal: `@frontierjs/teams` ships a schema an app imports.
Done when: a scratch app imports the fragment, migrates, and litestone refuses an
Invitation transition that skips a state.

- [ ] 1.1 Scaffold `packages/teams` with its schema exported through `package.json`.
- [ ] 1.2 `Organization` and `Member` from `Organization.lite`: one level,
  `@@relator([orgId, userId], once)`, `role MemberRole` per Q2.
- [ ] 1.3 `Invitation` per Q3: token `@secret @hashed @unique(global)`, `@@expires`,
  one pending invitation per email per organization.
- [ ] 1.4 The standing function (`FJS-D2166`): role → level from the app's map, and a
  startup refusal naming any role the map leaves out.

### Phase 2 — The Service part

Goal: the invitation and membership flows as one Junction plugin.
Done when: the plugin's tests pass against a real Litestone client, including a caller
naming an organization they are not in getting a 403.

- [ ] 2.1 The invitations service lifted from basecamp's: create, resend, revoke, preview,
  accept. Accept creates the account through auth, so the rig runs after auth and mail.
- [ ] 2.2 A `membershipClaim` preset read off the rig's own models, so an app passes only
  `tenantFrom`.
- [ ] 2.3 The members service: change role, remove, leave, and refuse removing the last owner.

### Phase 3 — The Resource and Suite parts

Goal: screens to eject, and tests that run against the consuming app.
Done when: the suite passes against the scratch app with the screens ejected into it.

- [ ] 3.1 Screens: `Member.mesa`, `Invitation.mesa`, and the accept page (Invariants 18, 19).
- [ ] 3.2 The suite: invite → accept → member, a stranger refused, a skipped transition
  refused, the last owner kept.

### Phase 4 — The installer

Goal: `fli add` installs any rig, and teams is the first.
Done when: `fli add @frontierjs/teams` on a fresh `fli project:new` app passes the rig's
suite inside that app's `bun run test`.

- [ ] 4.1 Read the layout and resolve the parts; `--parts` picks a subset.
- [ ] 4.2 The consumer edits: the schema import, the plugin registration ordered by
  `after`, the `.env` lines.
- [ ] 4.3 Parse the rig's schema against the installed litestone and refuse by name
  (`FJS-D2165`).
- [ ] 4.4 Eject the screens, recording the version and a hash per file (`FJS-D2163`).
- [ ] 4.5 Collect the suite into the consumer's `bun run test` (`FJS-D2164`).
- [ ] 4.6 `fli rig:list`: installed rigs, their parts, and the drift 4.4 recorded.

### Phase 5 — Adoption

Goal: an app that hand-built teams drops its copy.
Done when: swatchbook's `bun run test` and basecamp's `bun run test` + `bun run verify` pass
on the rig.

- [ ] 5.1 Swatchbook adopts the rig through `fli add` (one level, the simplest).
- [ ] 5.2 Basecamp adopts it at the Workspace level, or this plan records what stops it
  (its Account over Workspace is two levels, which the rig does not ship).
- [ ] 5.3 Overview 3.2 and 3.8 read shipped.

## See also

- `rigs.md` — the rig format; `rig-catalog.md` — which rigs, counted from the apps
- `membership-from-schema.md` — deriving `membershipClaim`'s options, which 2.2 builds on
- `packages/litestone/references/Organization.lite`, `Grant.lite`
