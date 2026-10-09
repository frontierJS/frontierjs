---
id: threat-model
status: shipped
dated: 2026-10-08
---

# Idea — the threat model: who attacks a FrontierJS app, and what each boundary promises

**Status: ruled as `FJS-D656` (A) and built: [`THREATS.md`](../THREATS.md), graded by `fli check`'s `threat-row`. Option C, one test identity per adversary, is still the later shape for B1–B5.** Corrections from the re-probe before ruling: B3 and B4 have no open hole (F1/F2 are FJS-634/638 and the Bearer finding is FJS-788, all closed), and § 4's Origin row missed the doctrine's sense, so Origin stays open. Dated 2026-10-08. Wave 5 of the vocabulary
atlas (*papers before nouns*): the nouns below come out of this paper, they
are not ruled. Do not cite this file as describing behavior — see
`VERIFYING.md`.

The tree has no threat model. `rg -i "threat model|trust boundar"` over
`packages/*/src`, `packages/*/docs`, `docs/`, `DECISIONS.md`, `IDEAS/` and
`VOCABULARY.md` returns nothing. What it has instead is about thirty rulings
and a few hundred register rows that each defend one boundary against one
adversary, with the adversary implied. Invariants 6, 7, 8 and 10 are the
nearest thing to a statement, and none of them names who they defend against.

---

## 1. What exists, per boundary (measured)

A **boundary** here is the line one adversary must cross. A boundary's
**promise** is what holds on the far side whatever the adversary sends.

| # | Adversary | Boundary | Promise today | Enforced at | Known open hole |
|---|---|---|---|---|---|
| B1 | anonymous caller | Data boundary | a gate reads level 0; access is in the schema, never a hook (Inv 6) | litestone `policy.js`, `field-policy.js`; junction `gateAuth()` | — |
| B1′ | anonymous caller | the bundle | the client ships defs, not prose | sierra `stripProse` (FJS-785, closed) | the defs (models, gate levels) still ship by design |
| B2 | signed-in user of another tenant | Tenant | `registry.tenantFor({host, headers, principal})` picks one db; a row never crosses | litestone tenants, `resolveTenancy` | — none open found |
| B3 | any caller, via names | SQL | a caller-supplied name never enters a pattern (Inv 8); a `$` key not in the table is refused (Inv 10, `FJS-D237`) | `@frontierjs/toolbelt/directives`, `$checkWhere`, `$checkOrderBy` | the 2026-09 litestone audit's F1 (injection) and F2 (tx-bypass) are the ones its memory says to check first |
| B4 | cross-site page holding the cookie | the app origin | csrf defaults to the app's own origin; `'*'` is refused by name | `packages/junction/src/core/app.ts:2245-2265` (`FJS-D610`) | Bearer off-origin (UI audit 2026-09) |
| B5 | agent via MCP | the agent surface | the gate IS the permission model; a tool is visible per standing; one execution path (`FJS-D258`) | `packages/mcp/src/plugin.ts` — `principalGateLevel`, `withholdProtected` | `narrow` grades plan/key, not level, and is skipped on the listing path (plugin.ts:247) |
| B6 | pasted `inline` app on outpost | 8181 static origin | "a port is an origin" — a stranger's script never shares the fleet command port (`FJS-D345`) | `packages/outpost/src/serve.js` | **FJS-1834**: `shop.fleet.test/admin/` runs admin's script as origin shop; ruling owed `FJS-D618` |
| B7 | extension page / other extension | the SW relay | only this extension's pages reach the relay | jetty `define/harbor.js:48` — `runtime.onConnect` (internal only, no `onConnectExternal`) | none stated; the promise is the browser's, not ours, and is written nowhere |
| B8 | compromised third party / forged webhook | inbound credential | a signed request becomes a principal through one list (`FJS-D475`, `createApp({ credentials })`) | `junction/src/auth/credentials.ts`, `toolbelt/signature` | FJS-1607 (WS upgrade skips the list), FJS-1804 (receiver record unmeasured), FJS-1858 (`x-service-method` outside the signed material) |
| B9 | outbound: we are the third party | our webhook | each delivery signed over the canonical string, path and query bound (`FJS-678`) | `junction/src/plugins/webhooks/index.ts:353-438` | — |
| B10 | Basecamp ↔ fleet machine | signed command port 8180 | a command is signed, fresh and once | outpost `server.js`, `toolbelt/signature` | FJS-1833 (nonce forgotten before timestamp expires), FJS-1763 (no clock sync), FJS-1857 (`timeout_s: 0` unbounded) |
| B11 | operator (holds the box, the keys, `asSystem()`) | the audit trail | protected fields log `[redacted]` (Inv 7); a write is announced once (Inv 4) | litestone `audit-log.js` | **no promise at all against the operator** beyond redaction — `asSystem()` is called 18× in junction core alone |

**Probed by running, 2026-10-08:** `cd packages/outpost && bun test
test/audit-static.test.js test/audit-signature.test.js` — 20 pass, and the
passes included `test.failing` rows for FJS-1834, FJS-1856, FJS-1857 and
FJS-1858; all four closed 2026-10-08, so none is open on this tree. The rest of the
table is read from source and the register, not run.

## 2. The gap, as a failure a real app hits

A Kobami client app on the fleet adds an MCP endpoint and a webhook receiver
in the same week. Nobody can answer *does the agent see what a level-2 user
sees, or what the operator sees?* without reading `plugin.ts`; nobody can
answer *does a webhook-made principal reach a WS channel?* without finding
FJS-1607. Every boundary's promise lives in the ruling that built it, so the
question *what may this adversary do* has no one place — and an audit grades
the boundaries it thinks of. The Fable audit found B6 and B10's holes because
run 1.3 happened to aim at outpost; the operator row (B11) has never been
graded because no document says it is a boundary.

The second failure is vocabulary: `Origin` is `open` in `VOCABULARY.md:219`
while three senses are live — the browser origin (B4, csrf), "a port is an
origin" (B6, `FJS-D345`), and SQLite's index `origin` (`introspect.js:339`,
`migrate.js:163`) plus `cross-process.js:162`'s writer origin.

## 3. Options

**A — one root `THREATS.md` table, graded by `fli check`.** One row per
(adversary × boundary): promise, enforcing file, the proving test. A `fli
check` rule `threat-row` fails when a row names no test, or names a test that
does not exist. Spelling:

```md
| Adversary | Boundary | Promise | Enforced at | Proved by |
| tenant-other | Tenant | no row crosses | litestone/src/tenants | litestone/test/tenancy.test.ts |
```

Cost: one file, one rule (~60 lines in `packages/cli`), the table above as
its seed. Refuses: a promise with no test; an adversary named in prose and
not in the table. Risk: it is a sixth thing a change must remember to touch.

**B — a `## Threats` section in each package's `CLAUDE.md`.** The package
that enforces a boundary states it. Cost: zero tooling. Refuses nothing — a
boundary that spans packages (B8 is junction + toolbelt + conduit; B10 is
outpost + basecamp + toolbelt) has no owner, which is exactly where FJS-1858
and FJS-1833 sit. Breaks Invariant 4's spirit: one promise, several homes.

**C — adversary as a fixture, not a document.** `@frontierjs/testing` ships
one principal per adversary (`anonymous`, `otherTenant`, `agent`, `bearer`,
`signedThirdParty`) and `createTestEnv` grades every model against each, the
way `verifyGateLadder` grades levels today. Cost: large — five fixtures, and
the inline-app and extension rows (B6, B7) are not Data-realm and cannot be
fixtures. Refuses: a model that leaks to an adversary, by construction.

**Recommend A, seeded from §1, with C as the later shape for B1–B5.** A is
the cheapest thing that makes the operator row (B11) exist at all and gives
every cross-package boundary one owner; its `Proved by` column is the seam C
fills when fixtures arrive. B is refused because the holes found so far are
all at seams between packages.

## 4. Nouns, and every collision

| Noun | Sense proposed | Collides with |
|---|---|---|
| **Adversary** | one named class of attacker; a row key in `THREATS.md` | none live (`IDEAS/proving-grounds.md:356` uses it for a test schema — a figure of speech) |
| **Boundary** (qualified) | keep `FJS-D06`'s rule: always qualified — *Tenant boundary*, *agent boundary*, *static-origin boundary* | `Data boundary` is `open` (`VOCABULARY.md:86`) and is the widest phrase in the tree; this paper makes it one row of eleven, not the whole |
| **Promise** | what holds past a boundary | `Commitment` (`buildCommitments()`) is a schema-level noun for a row's obligations — keep apart; a Promise is never in a schema |
| **Principal** | unchanged (`FJS-D633`) — the adversary *as graded*; a Bearer is one | `Actor` (who answers for a write). The operator is an Actor with no Principal when `asSystem()` runs — that asymmetry is B11 |
| **Origin** | **recommend: the browser's sense only** (scheme+host+port) | outpost's "a port is an origin" (`FJS-D345`) is the same sense and survives; SQLite index `origin` is SQLite's own word, stays in litestone internals unrenamed; `cross-process.js` writer origin should be renamed (*writer*) because it is ours |
| **Operator** | whoever holds the machine and the keys | Basecamp's fleet operator role — same person, keep |

## 5. Open questions for the owner

- ~~**Is the operator an adversary at all?**~~ **Answered 2026-10-09 (`FJS-D656`): B11 is Trusted: the operator is promised Invariant 7 redaction and nothing more, and anything more is a new ruling.** If yes, B11 needs a promise beyond
  redaction (e.g. `asSystem()` writes are announced with a reason). If no, the
  table says so in one row, so no audit spends a run on it.
- ~~**`FJS-D618` decides B6's promise**~~ Ruled A 2026-10-08: a host that names an app is that app's origin.
- ~~**Does the agent (B5) ever see more than the human at the same level?**~~ No: `FJS-D656`, `narrow` only removes.
- **Origin's `cross-process.js` sense** — rename to *writer* in the same
  change that blesses Origin, or leave it? The field is not internal:
  `decode()` (`packages/litestone/src/core/cross-process.js:231`) hands it to
  every `onEvent` observer, and the value is `${pid}:${random}`
  (`client.js:9313`), a process, never a place.
  - **A** — rename to `writer` throughout `cross-process.js`: the column, the
    recorder's parameter, the decoded field. The events table is litestone's
    own file, so an existing one is deleted, not migrated.
  - **B** — keep `origin`; the `VOCABULARY.md` row notes the litestone-internal
    sense beside the two live ones.
  - **C** — rename to `process`, naming what the value is rather than its role.
  - **Recommend A** — §4's table already makes the case: it is ours and leaves
    the module, so it is a third sense of a word kept for the browser's. *Writer*
    names its one use, skipping your own writes, where *process* would collide
    with the Node global. Out of scope here: `RequestMeta.origin` (`'internal'`
    in `packages/junction/src/testing/index.ts:430`) and the audit trail's
    `origin` column (`audit-log.js:201`) are a fourth sense the §4 sweep did not
    list. They want their own row before Origin is blessed.
- ~~**Where do the F1/F2 litestone audit findings stand?**~~ **Answered
  2026-10-08 by re-probe:** both closed — F1 as `FJS-634` (a crafted `where`
  key refused; `quoteIdent` the one owner, `FJS-D169`) and F2 as `FJS-638`
  (every write verb through the FIFO lock, `FJS-D170`/`FJS-D171`), both in
  `ISSUES_ARCHIVE.md`. Their suites — `identifier-refusals`, `unknown-args`,
  `write-autocommit`, `transition-race` — pass 88/0 on 2026-10-08. `THREATS.md`
  B3 is seeded and cites `FJS-634` and those tests.
