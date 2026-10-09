---
id: membership-from-schema
status: proposed
dated: 2026-09-23
---

# Idea — `membershipClaim` read off the schema

**Status: proposed, and not to be built until a second app has the shape.**
`claim … from` ([`FJS-D359`](../DECISIONS.md#fjs-d359)) reads a claim off the
one row pointing at the caller. The membership shape — one row per person per
tenant, the standing and the grants on it — is refused there by name and stays
with `createApp({ principal: membershipClaim({ … }) })`. This paper asks whether
that resolver's configuration is already stated in the schema, so that it could
be derived rather than written.

## 1. The measurement — every option against the schema

Basecamp is the only caller of `membershipClaim` in the tree. One caller is
thin, so what follows is a design reading, not a measured one.

| Option | Basecamp passes | Already stated in the schema? |
| --- | --- | --- |
| `model` | `workspaceMember` | **Yes** — the one `@@relator([workspaceId, userId], once)` whose relata are the tenancy column and a key to `@@auth` |
| `subject` | `userId` | **Yes** — the relatum pointing at `User` |
| `tenant` | `workspaceId` | **Yes** — `tenancy { column }`, and the relator's other relatum |
| `as` | *(default)* | **Yes** — `tenancy { claim }` |
| `include` | `['workspace']` | **Yes** — the relator's relation to the tenant model |
| `standing` / `standingAs` | `role` → `memberRole` | **As a claim** — `claim memberRole from WorkspaceMember(userId).role`, keyed by the request's tenant. Refused today: `userId` is unique only per tenant |
| `capabilities` | `capabilities` | **Refused by `FJS-D359`** — a framework name, and a row may not decide one. See the open question |
| `namedBy` | a sentence | Only where `tenantFrom` is known |
| `tenantFrom` | header, then `?workspace_id=`, then the session's claim | **No — and ruled not to be** ([`FJS-D360`](../DECISIONS.md#fjs-d360)) |

## 2. What is settled

**Where a request names its tenant stays a function.** `FJS-D360` scoped
`tenancy { resolve }` to `strategy database`, where the registry reads it, and
refused it under row, where nothing did. So a derived resolver would still take
`tenantFrom` from the app — one option where there are nine today.

## 3. What a derivation would be

A `claim … from` whose subject is unique per TENANT rather than globally, legal
only when the model is a `@@relator([<tenant column>, <subject>], once)` under
`strategy row`, and read per request keyed by the request's tenant. The tenant
claim itself comes from the same row's existence — no row, no membership, which
is `membershipClaim`'s refusal today. `ctx.locals[MEMBERSHIP]` would still carry
the row, since basecamp's hooks read it.

**The proof** is to replace basecamp's `membershipClaim({ … })` with the
declarations and run `packages/basecamp`: `bun run test` and `bun run verify`.

## Open questions

- ~~**`FJS-D361` — May a membership row decide a framework claim?**~~ **Answered 2026-09-28 (`FJS-D361`): A — Yes, for one shape only: a `@@relator([<tenant column>, <subject>], once)` under `strategy row`. Everywhere else the refusal stands.** `FJS-D359`
  refuses `capabilities`, `role` and the rest of the framework's nine as the
  name of a claim read off a row, because a row may not decide who the caller is
  or how they are graded. A membership row does exactly that, per tenant — it is
  what the row exists for. Basecamp dodges `role` by renaming it `memberRole`;
  `capabilities` cannot be renamed, because the grid reads that name.
  - **A** — Yes, for one shape only: a `@@relator([<tenant column>, <subject>], once)`
    under `strategy row`. Everywhere else the refusal stands.
  - **B** — No. `capabilities` and a standing stay `membershipClaim` options, and a
    derivation stops at the model, subject and tenant.
  - **C** — Yes, generally: drop the refusal from `FJS-D359`.
  - **Recommend A** — the refusal guards against a row deciding standing by
    accident, and the membership relator is the one shape where the row IS the
    standing by construction. B leaves the derivation half done on exactly the
    fields basecamp most needs; C reopens the accident.

## See also

[`IDEAS/shipped/relators.md`](shipped/relators.md) · [`FJS-D113`](../DECISIONS.md#fjs-d113) ·
[`FJS-D359`](../DECISIONS.md#fjs-d359) · [`FJS-D360`](../DECISIONS.md#fjs-d360)
