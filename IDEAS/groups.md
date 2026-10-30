---
id: groups
status: proposed
dated: 2026-10-30
---

# Idea — Group: the Warden's sanctioned bundle of capabilities and people

**Status: PROPOSED. Q1–Q3 were asked through AskUserQuestion on 2026-10-30. The
pattern runs today with no new syntax, probed the same day.
Nothing below is in a doc yet.** Do not cite this file as behavior — see
`VERIFYING.md`.

## The claim

**A Group is a named set of capabilities AND the people who hold them, per tenant.**
A user's capabilities are the union of every group they belong to, resolved on each
request. There are two tiers, capability → Group → user, with no Role model between
them. Django's `auth.Group`, Discourse groups, Okta groups and GitHub Teams all have
this shape.

[`permission-sets.md`](shipped/permission-sets.md) designed Role → user and said a
capability *"tomorrow may arrive from a group"*. This paper is that tomorrow, and it
folds the two nouns into one: a Role row with members *is* a Group. Every rule that
paper ruled still holds, so a Group:

- unions, and nothing subtracts.
- carries no level: authority to modify authorization is not authority granted by
  authorization.
- marks a seeded row `builtIn @system`.
- reaches `auth().capabilities` per request, never in a token.

**For now it is sanctioned as example models, not syntax.** The models are the house
pattern, and an app copies them. A `@@group` marker was priced and deferred (Q2).

## The example models

```lite
model Group {
  id           String        @id @default(cuid())
  workspaceId  String
  name         String        @label("Group")
  builtIn      Boolean       @default(false) @system
  /// Writing it may not exceed the writer's own set. That guard comes with the column.
  capabilities Capability[]
  members      GroupMember[]

  @@gate(2.5.5.6)
  @@unique([workspaceId, name])
  @@deny(update, builtIn == true)
  @@deny(delete, builtIn == true)
}

model GroupMember {
  id      String @id @default(cuid())
  groupId String
  group   Group  @relation(fields: [groupId], references: [id])
  userId  String
  user    User   @relation(fields: [userId], references: [id])

  /// Only the service door below writes a member, so read 2 and every write SYSTEM.
  @@gate(2.8.8.8)
  @@unique([groupId, userId])
}
```

**The one door.** Joining a group never touches `Capability[]`, so the column's guard
cannot see it. A weak admin could add themselves to a group that already holds what
they lack (probed 2026-10-30). The gate refuses every direct write. A member then
arrives only through a service method, which checks `group.capabilities ⊆ caller's
set` and writes with `system: ['@@gate']`. That keeps the policies, redaction and the
audit actor (`FJS-D575`). Removal runs the same check, so you revoke only what you
hold.

```js
const holds = (principal, group) => group.capabilities.every(c => principal.capabilities.includes(c))

async function addMember(principal, groupId, userId) {
  const scoped = db.$setAuth(principal)
  const group = await scoped.group.findUnique({ where: { id: groupId } })
  if (!holds(principal, group)) throw new AccessDeniedError('You may only add someone to a group whose capabilities you hold')
  return scoped.groupMember.create({ data: { groupId, userId }, system: ['@@gate'] })
}
```

**This is an access check in app code**, which Invariant 6 places in the schema. It
passes because the gate closes every other path, so the door is the only writer, not
a second rule beside one. The cost is stated as it stands: an adopter who copies the
models and leaves out the door has no member writer at all. They get a refusal, not a
hole. The reopen condition is in Q2.

**The union.** It lives in the claim resolver, per request. Today that is three lines
beside `membershipClaim`. Phase 2 moves it into `membershipClaim` (Invariant 4):

```js
const caps = [...new Set((await sys.groupMember.findMany({ where: { userId }, include: { group: true } }))
  .flatMap(m => m.group.capabilities))]
```

### Executed

```
clerk caps (per request)                 : [Invoice.create, Invoice.update]
clerk deletes invoice                    : REFUSED  You do not hold the "Invoice.delete" capability
weak admin raw self-join Admins          : REFUSED  "GroupMember.create" requires SYSTEM access
weak admin addMember self→Admins         : REFUSED  You may only add someone to a group whose capabilities you hold
clerk addMember weak→Billing             : OK       holds both
clerk widens Billing with delete         : REFUSED  cannot grant "Invoice.delete"
owner widens Billing with delete         : OK       clerk's next request holds it, no rewrite
owner creates group with builtIn:true    : REFUSED  "builtIn" is @system
owner renames builtIn Admins             : null     the @@deny filters an update, it does not throw
```

The last row is the row-policy rule (filter where the row was read). A group editor
has to treat `null` as "not editable".

## What it replaces

- **Basecamp's `ROLE_GRANTS`** is a table in code, copied onto `WorkspaceMember` at
  write time, so a later change to a role misses existing members until
  `setMemberRole` runs again. Under this pattern those become `builtIn` Group rows
  seeded per workspace, and the staleness goes with the copy.
- **`membershipClaim({ capabilities })`**, the grant column on the member row, is a
  second origin once groups exist. Q1 ruled it out of the pattern: a one-off grant is
  a group of one.

## Open questions

- ~~**Q1 — How many tiers between a capability and a user?**~~ **Answered 2026-10-30 (`FJS-D1671`): A — Two: Group holds `Capability[]` and its member list. No Role model, and no grant column on the member row.**
  - **A** — Two: Group holds `Capability[]` and its member list. No Role model, and
    no grant column on the member row.
  - **B** — Two, plus a per-member `Capability[]` unioned in, for one-off grants.
  - **C** — Three, Role → Group → user, as in Keycloak and AD. A Role is reusable
    across groups, at the cost of two editors and two escalation checks.
  - **Recommend A** — one noun, one origin for a capability, and one level simpler
    than C. A one-off grant is a group of one.
- ~~**Q2 — How does the framework sanction the Group shape?**~~ **Answered 2026-10-30 (`FJS-D1673`): D — Example models only: the documented house pattern, with no syntax.**
  - **A** — A `@@group` marker. Litestone recognizes the shape: it computes the
    union, guards a member write, and refuses a level column or nesting.
  - **B** — Litestone synthesizes fixed `Group`/`GroupMember` models, the way it
    synthesizes `Capability`.
  - **C** — `@frontierjs/auth` ships the models and the resolver.
  - **D** — Example models only: the documented house pattern, with no syntax.
  - **Recommend A** — the guard and the union move to the Data boundary, where
    Invariant 6 puts them, instead of a door every app copies.
- ~~**Q3 — When are a user's group capabilities computed?**~~ **Answered 2026-10-30 (`FJS-D1672`): A — Per request, one join in the claim resolver.**
  - **A** — Per request, one join in the claim resolver.
  - **B** — Copied onto the member row on write, as Basecamp does today.
  - **Recommend A** — a group edit reaches every member on their next request. This
    is already `permission-sets.md`'s rule, and B keeps the staleness defect class.

## Phase 0 — Prove the pattern

Goal: the example models run and close the escalation hole with today's syntax.
Done when: a probe of the models prints the § Executed table.

- [x] 0.1 Two-tier models, per-request union, gate-8 member and one door, probed

## Phase 1 — Document the house pattern

Goal: the example is a fence a runner executes, not a sketch (Invariant 16).
Done when: the fence runner (`FJS-D860`) runs the Group example in
`packages/litestone/docs/access-control.md` green.

- [ ] 1.1 Replace `access-control.md`'s `model Role` example with Group, GroupMember and the door
- [ ] 1.2 `VOCABULARY.md`'s `Group` row: blessed, "example convention, no syntax"
- [ ] 1.3 `warden.md` § layer 3 names Group as where a capability comes from

## Phase 2 — The union has one owner

Goal: no app writes the union by hand.
Done when: a junction test resolves `auth().capabilities` from two groups through `membershipClaim`.

- [ ] 2.1 A `membershipClaim` option for the group union, beside `capabilities`
- [ ] 2.2 Basecamp moves `ROLE_GRANTS` to `builtIn` Group rows

## See also

- [`shipped/permission-sets.md`](shipped/permission-sets.md) — the capability grid, and the Role design this folds in
- [`packages/litestone/docs/warden.md`](../packages/litestone/docs/warden.md) — the layers
