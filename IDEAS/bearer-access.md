---
id: bearer-access
status: proposed
dated: 2026-09-14
---

# Idea — Access without an account: the bearer claim as a paved road

**Status: IDEA. Nothing new here is built.** Dated 2026-09-14. What *ships* is
cited to the file that ships it; every number was read off a database or a probe
named beside it. Do not cite this file as behavior — see `VERIFYING.md`.

---

## Trigger

`conversion-maid-tech.md`'s application is building a **client portal**: a lead
or client with no account follows a link and fills in forms, reads where their
project stands, and holds a conversation with the business. The question asked
was whether FJS has a canonical shape for *somebody who is not a user and still
has access to some rows*, and the honest answer is **half**.

The mechanism is settled and proven by a drive. The shape an app reaches for
second — a link that expires, is revoked, has more than one strength and is
recorded in the audit trail as someone — is written nowhere, and the two apps
that need it wrote it twice, differently.

---

## What already ships

| Piece | Where | What it settles |
| --- | --- | --- |
| A claim resolved per request, for a caller with no session | `createApp({ principal })`; `example/api/src/domain/shop/cart-claim.ts` | a stranger stays STRANGER(0); the claim decides *which rows*, never *what kind of caller* |
| The claim is declared | `FJS-D181` — `claims: [...]` at `createClient` | a policy naming `auth().cartTokn` is refused rather than matching nothing |
| The policy is in the schema | `example/db/schema.lite` § `Cart`, `CartLine` | `@@allow('read', token == auth().cartToken)` — Invariant 6, no hook |
| The secret never comes back | `Cart.token @guarded` | the only way to hold one is to have been handed it |
| It is visible to review | `cartClaim.describe()` → `kind: 'bearer'`; `principal.snapshot.md` § Claims | *bearer* against *membership* is stated where access is reviewed |
| A capability crossing an origin | `carts.handoff` / `carts.redeem` | a one-time code in the fragment, not the token in a URL |
| A secret stored as an HMAC | `packages/auth/crypto.ts`, `auth.ts` (API keys, recovery codes) | the precedent for a link token at rest |
| A ticket exchanged for a session, once | `client.auth.completeSignIn(code)` → `/auth/login/challenge`; `LoginChallenge` (`value @unique @guarded`, `expiresAt`, `attempts`) | the second factor's flow IS redeem-a-code-for-a-session, single-use and server-side |
| Who mints a token | `@frontierjs/toolbelt/ids` — `generateCuid()`, `mintId(kind)` behind `@default(cuid())` | the shape check below can be DERIVED from the minter rather than spelled as a regex |
| Proof it works | `bun run verify:cart`, 32 assertions | |

`membershipClaim` is the framework-owned resolver for the OTHER kind. There is
no framework-owned resolver for a bearer, so `cartClaim` is app code — including
the token-shape regex whose comment records that it read `uuid` while the schema
said `cuid()`, and every basket answered 404.

---

## The two consumers, side by side

| | `example` — `Cart` | maid.tech — the client portal |
| --- | --- | --- |
| Subject | the row the token sits on | a `Client`, and every row carrying its `clientId` |
| Rows reached | `Cart`, `CartLine` (token copied onto the child) | form responses, messages, the intake record, progress |
| Proof | **by construction** — the token IS the column compared | **by lookup** — the link resolves to an id, which is compared |
| Lifetime | the basket's | a link that expires, and a legacy one that never does |
| Strengths | one | two: a bare `Client.uuid` reaches forms and progress; a minted `Client.token` also reaches messages and the intake (`allowUuid` in `api/src/services/portal/portal.class.js`) |
| Where access lives | the schema | a hooks table (`portalPolicy`) plus `params._publicApi` switching off the account scope |
| Revocation | the sweep abandons the basket | overwrite the one token column |
| At rest | `@guarded`, plaintext | plaintext |
| Crosses an origin | yes — the buy button | no, but the credential is in every path |
| Adoption | `verify:cart` | pre-launch: 5 of 108,954 live clients hold a `uuid`, 3 a token (`db/development.db`, 2026-09-14) |

**The split that matters is proof by construction against proof by lookup.**
`cartClaim` reads no row, because a token compared against the column it lives
in scopes a caller to exactly the rows carrying the string they already hold.
That stops working the moment the subject owns rows of more than one model:
`CartLine` already carries a *copy* of the basket's token because a policy
cannot traverse a relation, and a portal would copy the link onto form
responses, messages and intake records — then fail to revoke it, since the copy
outlives the link.

The portal's rows already carry `clientId`. So the claim it wants is **an id,
resolved by reading a row** — `auth().portalClientId` — which is
`membershipClaim`'s shape with a token where the session was.

---

## Prior art outside

- **Capability URLs** (W3C TAG, *Good Practices for Capability URLs*) — the
  link is the credential; the note's advice is short lifetimes, revocation, and
  keeping it out of `Referer` and logs.
- **Stripe's customer portal** — the server mints a short-lived session URL per
  visit, so nothing permanent is ever in a link.
- **Service-business client hubs** (Jobber, Housecall Pro, HoneyBook) — the
  same product as maid.tech's portal: a client with no account, a link in an
  email, and an emailed magic link before the conversation opens.
- **Fine-grained personal access tokens** (GitHub) — scope, expiry, last used,
  revoked individually, shown once and stored hashed. An API key with a subject
  that is not the person holding it.
- **Party / PartyRole** (Silverston, *The Data Model Resource Book*) — *user* is
  one role a party plays; a client is a party with no login role. The reason not
  to make a portal client a `User` at level 0.

---

## The proposal — cut one level simpler

**No shipped model and no new schema keyword.** The subject is the app's noun —
a `Client`, a `Lead`, a `Supplier` — so a framework model would need a
polymorphic foreign key Litestone does not have, and would name a thing the app
already names. The app declares its own link model; the framework owns the
resolver that reads it.

### 1. `bearerClaim`, beside `membershipClaim`

One resolver, both proofs, one owner — and `describe()` derived from its
options rather than written by hand.

```ts
// by construction — what cart-claim.ts is today, with the shape check derived
// from `Cart.token`'s own @default rather than a regex that can disagree with it
principal: bearerClaim({ from: header('x-cart-token'), claim: 'cartToken', model: 'Cart', column: 'token' })

// by lookup — the portal
principal: bearerClaim({
  from:    header('x-portal-link'),
  model:   'PortalLink',
  column:  'tokenHash',           // presented token is HMAC'd before the read
  claims:  { portalClientId: 'clientId', portalScope: 'scope' },
})
```

The lookup form refuses a row whose `expiresAt` has passed or whose `revokedAt`
is set **when the model declares those columns**, and touches `lastUsedAt` when
it declares that. Declared columns rather than options, so the answer is in the
seed where `fli check` can read it.

### 2. The link model is the app's

```lite
/// A way into the portal for somebody who has no account. The link in the
/// email carries the token; this row carries its HMAC and what it may reach.
model PortalLink {
  id          Int       @id
  clientId    Int       @label("Client")
  client      Client    @relation(fields: [clientId], references: [id], onDelete: Cascade)

  tokenHash   String    @unique @guarded
  scope       PortalScope @default(forms)

  purpose     String?
  expiresAt   DateTime?
  revokedAt   DateTime?
  lastUsedAt  DateTime? @system
  createdById Int?      @system

  createdAt   DateTime  @default(now())

  @@gate("5")
  @@index([clientId])
}

enum PortalScope { forms full }

model PortalMessage {
  // …
  @@gate("0.0.0.5")
  @@allow('read',   clientId == auth().portalClientId && auth().portalScope == 'full')
  @@allow('create', clientId == auth().portalClientId && auth().portalScope == 'full')
}
```

`portalPolicy`, `allowUuid`, `scopeQueryToClient` and `_publicApi` all become
policies. The two strengths are a claim value, which needs no mechanism. The
legacy bare uuid becomes one `PortalLink` row per client with `scope: forms` and
no expiry, retired by deleting rows rather than by editing code.

### 3. The audit trail names a bearer — ~~measured wrong today~~ **fixed**

Filed as [FJS-1195](../ISSUES.md#fjs-1195). Probed against
`packages/litestone/src/core/client.js` on Bun 1.3.11, twice (2026-09-14 and
2026-09-20): a `@@log`
model written under `$setAuth({ cartToken: 'abc' })` records
**`actorType: 'user'`, `actorId: null`**; the same write through `asSystem()`
records `actorType: null`. The line is
`actorType: ctx.auth?.type ?? (ctx.auth ? 'user' : null)` — any principal object
is a user. So every stranger's basket edit in `example` is filed as *a user with
no id*, which is neither who did it nor what kind of caller they were.

maid.tech encodes the same fact by absence — a message with no `sentById` is from
the client. Closed by [FJS-1195](../ISSUES.md#fjs-1195): `actorTypeOf(ctx)` grades the
principal it was handed, and one carrying claims and no id is `bearer`.
**Half of §3 remains and it is the ACTOR** — a bearer still writes a null
`actorId`, because nothing hands the boundary a row id until `bearerClaim`
reads one; the by-construction form has no row to name at all. That is this
paper's § Open questions, unchanged.

### 4. Out of scope

A magic-link LOGIN in `@frontierjs/auth` (a client graduating to a `User`) is a
different act: it ESTABLISHES a session (`FJS-D20`), where everything above
grades a request. Named so it is not smuggled in; see § Open questions.

---

## Decision rules — answered before the draft

**Another origin of truth?** No, if the link model is the app's and the resolver
reads its declared columns. A shipped `PortalGrant` model would be a second
place the subject is named.

**Concept budget?** No new noun. *Bearer* is already `describe().kind`; the row
is named for the app's domain. **`grant` is deliberately NOT the word**: it
already means a capability grant column (`FJS-D147`) and a run's owner
(`FJS-D276`), and `Capability` is a synthesized enum.

**The problem's complexity, or ours?** The problem's. Expiry and two strengths
are in maid.tech's live code; the URL-leak concern is the one `example` already
paid for once with `carts.handoff`.

**Predictability?** Improves — today each app writes its own resolver, and the
one that exists drifted from the schema it guards.

**Derived instead of restated?** The token shape from `@default`, the refusal
columns from the model, `describe()` from the options. The claim names stay
declared, per `FJS-D181`.

**One owner?** Resolution: junction's `principal:` seam. HMAC: one of three
candidates (§ Open questions) — it must not be a copy of `auth/crypto.ts`.
Establishing a session stays auth's.

**Boundary explicit?** `kind: 'bearer'` in `principal.snapshot.md`; a policy's
claim checked by `FJS-D181`; `verifyRowPolicies` graded with a claims-only
principal.

**Failure proportional?** A wrong bearer policy is an empty screen with a 200
(`@@allow` filters) — cheap. A resolver that forgets expiry hands a stale link
every row it ever reached — expensive, which is why expiry is the resolver's and
not each app's.

**Wrong without anything saying so?** Three ways today: the token-shape regex
(documented, fixed by hand), the audit actor (§3, silent), and a hooks-table
portal that switches off account scoping (maid.tech). The artefacts that would
make each visible are the derived shape, `actorType: 'bearer'`, and policies in
the seed.

**Adjudications.** *Paved road vs. the workaround* — the same workaround in two
apps is a measurement of the road, so the road changes. *Batteries vs.
smallness* — `bearerClaim` is a sibling of a resolver junction already ships,
not a battery.

**Tier.** Assessment (`IDEAS/`, `proposed`). A ruling on §1's shape would go to
`DECISIONS.md`; §3 is a defect and belongs in `ISSUES.md`.

---

## Open questions

- **Where does the token HMAC live?** `bearerClaim` is in junction, and auth
  depends on junction, so it cannot import `auth/crypto.ts`.
  - **A** — a `@frontierjs/toolbelt` kit (WebCrypto only; `/signature` already has a private `hmacHex`)
  - **B** — `bearerClaim` lives in auth, beside the API keys it resembles
  - **C** — junction owns it and auth's API keys move onto it
  - **Recommend A** — both callers are below or beside it, the key is injected, and it is a pure function
- **Does the link travel as a header, a cookie, or the path?** maid.tech puts it in the path; `example` in a header.
  - **A** — header only; the page reads the link once from the URL fragment and holds it
  - **B** — redeem the link once for an httpOnly cookie scoped to the link row
  - **C** — any of the three, named by `from:`
  - **Recommend B** — the fragment is never sent to a server and the cookie keeps the secret out of history, `Referer` and logs; `from:` stays a single choice per app, and the CSRF concern `cart-claim.ts` raises is a `SameSite=Strict` cookie on a surface with no cross-site writes. **B has a precedent rather than needing a mechanism**: `LoginChallenge` is already a single-use, expiring ticket a POST trades for a session, and a portal link is the same act with a different question answered first
- **Does the more sensitive strength need proof of the inbox, or only a live link?**
  - **A** — a live link is enough
  - **B** — `full` scope is minted only by redeeming an emailed one-time code
  - **Recommend B** — a forwarded email otherwise hands over the whole conversation, and the client hubs converged on it
- **What does the audit trail record for a bearer?**
  - **A** — `actorType: 'bearer'`, `actorId` the link row's id, `subjectId` the subject's
  - **B** — `actorType: 'bearer'`, `actorId` the subject's id
  - **Recommend A** — revoking one link has to be answerable by *which link did this*, and `subjectId` already exists for support mode
- **Does a by-construction bearer (`Cart`) move to the lookup form?** Open — the basket has one subject and no strengths, so the lookup costs a read for nothing; keeping both forms is the price of not copying a token onto every child row.
- **A portal client who later signs up** — does the `PortalLink` attach to the new `User`, and is that auth's `oauthLink`-shaped `Verification` purpose or the app's? Open.

---

## See also

- `conversion-maid-tech.md` — the application this was read from
- `permission-sets.md` — the grant column, and why `grant` is taken
- `support-mode.md` — `subjectId`, the audit trail's other inverted actor
- `agent-surface.md` — STRANGER(0) holding a `cartToken` is correct, by the same argument
- `example/README.md` — *A guest could not take a line out of their own basket*: a gate answers what kind of caller, a policy which rows
