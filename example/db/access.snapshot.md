# Access snapshot

Generated from `schema.lite` by `fli test:access`. **Do not edit.**

Every line below is a rule the Data boundary enforces on every caller —
`@@gate` refuses, `@@allow`/`@@deny` filter. Regenerate after a schema change
and read the diff: it names exactly which access moved. A line that changed
without a schema change you meant to make is a shipped security bug.

```
4 models · 4 gated · 0 unrestricted
1 with row policies · 1 with protected fields · 4 gated transitions
```

## Gates

Minimum level per operation. `SYSTEM` is reachable only through `asSystem()`;
`LOCKED` is reachable by nothing, `asSystem()` included.

| Model | Read | Create | Update | Delete |
| --- | --- | --- | --- | --- |
| `Customer` | 0 STRANGER | 4 USER | 4 USER | 5 ADMINISTRATOR |
| `Notification` | 0 STRANGER | 8 SYSTEM | 4 USER | 8 SYSTEM |
| `Order` | 0 STRANGER | 4 USER | 4 USER | 5 ADMINISTRATOR |
| `Product` | 0 STRANGER | 4 USER | 4 USER | 5 ADMINISTRATOR |

## Row policies

A policy compiles into the WHERE clause. It never raises — a wrong one is an
empty result with a 200, so read these as "which rows", not "which callers".
An operation with no `@@allow` is unrestricted at this layer.

### `Notification`

- allow **read** — `userId == auth().id`
- allow **update** — `userId == auth().id`

## Protected fields

`@guarded` needs a system context. `@encrypted`/`@secret` are ciphertext at rest
and log as `[redacted]` in the audit trail. A field `@allow` strips the column
rather than refusing the row.

| Model | Field | Rule |
| --- | --- | --- |
| `Customer` | `notes` | `@allow('read', auth().role == 'admin')` |

## State transitions

A move a caller may not make is refused even where `@@gate` allows the update.
An ungated move needs only the model's update level.

| Model | Field | Move | From → To | Level |
| --- | --- | --- | --- | --- |
| `Order` | `status` | `pay` | pending → paid | — |
| `Order` | `status` | `ship` | paid → shipped | — |
| `Order` | `status` | `refund` | paid → refunded | 5 ADMINISTRATOR |
| `Order` | `status` | `cancel` | pending, paid → cancelled | — |

## Levels

| # | Name | Who |
| --- | --- | --- |
| 0 | STRANGER | unauthenticated |
| 1 | VISITOR | authenticated, unverified |
| 2 | READER | verified, read-only |
| 3 | CREATOR | can submit, cannot manage |
| 4 | USER | full member |
| 5 | ADMINISTRATOR | app admin |
| 6 | OWNER | account/tenant owner |
| 7 | SYSADMIN | global system admin — a real, revocable human |
| 8 | SYSTEM | `asSystem()` only — jobs, migrations. No identity, no audit trail |
| 9 | LOCKED | nothing passes |
