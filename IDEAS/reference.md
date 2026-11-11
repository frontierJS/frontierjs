---
id: reference
status: proposed
dated: 2026-11-11
---

# Idea — Reference: one URI-shaped name for a thing, resolved by its scheme's owner

**Status: PROPOSED.** Dated 2026-11-11. Do not cite this file as behavior — see
`VERIFYING.md`. Nothing here is built. The `Reference` row in `VOCABULARY.md`
stays `open` until a ruling blesses it; this file is the argument for one.

---

## The definition

> **Reference** — a value that names one thing in URI syntax (an RFC 3986
> *URI-reference*: absolute, or relative to the context holding it), resolved
> by the one owner of its scheme.

- **Syntax is borrowed whole.** `URI-reference` is RFC 3986's own production —
  `URI / relative-ref` — so the short form (`Order/42`, inside the app) and the
  long form (`<scheme>://<identity>/Order/42`, across apps) are one grammar, and
  relative resolution is §5 of the RFC, not ours.
- **One resolver per scheme** is Invariant 4 applied to names. A scheme with no
  owner is refused by name.
- **The fragment keeps its RFC meaning** — a part of the thing, never sent to the
  resolver. `secret:<id>#field` uses it correctly. A version pin changes *which*
  thing, so it does not go after `#`.

---

## The case

**A Reference is what a holder keeps instead of a copy.** Axiom 8 says the
browser holds a reference to data, never a second copy; this generalizes the
holder to an email, a job, an agent, another app and another institution.
Dereferencing is a call to the owner, so the owner's gate grades it and the
owner's trail records it — the web's link only fetches.

**The strongest case is `one-origin-across-owners.md`.** That file argues a
county should ask the licensing board rather than keep a PDF of the license, and
never says what the county stores in the PDF's place. It needs two things:

| The county's need | What replaces the copy |
| --- | --- |
| Is the license valid **now**? | a live reference — ask the board each time |
| What did it say **when the permit was issued**? | a pinned reference — the name plus a digest of the version seen, which the board's trail corroborates |

The pinned half is why copies exist at all: they are evidence. A Reference
without a pin leaves people keeping PDFs.

---

## What the tree spells today

Read 2026-11-11 by an inventory sweep. Rows marked ✓ were opened and checked;
the rest are the sweep's reading, not re-run.

| Shape | Where | What is missing |
| --- | --- | --- |
| `subjectType` + `subjectId` | `packages/notifications/db/notification.lite:53` ✓, basecamp `AuditEvent`, `litestone/references/Tag.lite` | nothing constrains or resolves the pair; litestone's own trail uses `subjectId` for the *person* |
| hand-built route string | `packages/basecamp/api/src/notifications/DeployFailed.notification.ts:24-41` ✓ | `/deployments/${id}/` three times in one file; cannot be parsed back to a row |
| `secret:<id>#field`, `env:NAME` | `packages/basecamp/api/src/core/credentials.ts:39-40` ✓ | nothing — the precedent: scheme-prefixed, one minter, one parser |
| `ui://<server>/<Model>` | `packages/mcp/src/plugin.ts:474` ✓ | names a model's view, not a row; a row is "this tool with this id" |
| `Peer.call(path, method, body)` | `packages/conduit/src/peer.ts:40` ✓ | names the app, never a row in it |
| `{orderId}`, a bare id | `ctx.enqueue` payloads, WS remove events | each app picks the key |
| a relation | `packages/litestone/src/core/parser.js:7267` ✓ | cannot cross `@@db`, nor a tenant, nor an app |

`FileRef` and a release's four handles (uuid, tag, commit, digest) are names in
the same family. They are listed as evidence, not as migrations.

---

## Uses — spellings illustrative

- **Data** — a column that names any model: `subject Reference`,
  `on Reference<Order | Invoice>`. Litestone checks the model exists and
  `include` resolves it through that model's gate. This is the polymorphic
  relation `Tag.lite` says the framework lacks. An audit entry names its row
  pinned to the after-image.
- **API** — `ctx.enqueue('order.shipped', { order: 'Order/42' })`, then
  `ctx.resolve(job.order)` graded as the job's principal. Events and webhooks
  carry the same value.
- **Notifications** — `.action('View deployment', 'Deployment/d81f')`; the
  Resource knows its route, so the link is derived.
- **UI** — `<RefLink to={note.subject} />`, and a binding to one row by its name.
- **Agents** — MCP resources are already named by URI, so `resources/read` on a
  Reference returns the row graded as the agent's principal.
- **Peering** — `license Reference<peer:License>` on a county's `Permit`; reading
  it is a signed Peer call graded by the board's gate.
- **CLI and messages** — `fli open Order/42`; a Reference in `fli tell` renders as
  a link.

---

## Prior art

From memory on 2026-11-11 except where a link was read; re-read before a ruling.

| System | What it does | What it teaches |
| --- | --- | --- |
| [RFC 3986](https://www.rfc-editor.org/rfc/rfc3986) | the generic syntax, `URI-reference`, §5 relative resolution | the grammar exists; borrow it rather than coin one |
| [AT Protocol](https://atproto.com/specs/at-uri-scheme) | `at://<did>/<collection>/<rkey>`; a DID resolves to the current host; `strongRef` is `{uri, cid}` | identity apart from location survives a host move; live and pinned are two strengths of one name |
| Kubernetes `ObjectReference` | `{kind, namespace, name, uid}` across every API object | one shape for "that object" lets every tool point at anything |
| URNs | location-free names that never resolved | an identifier nobody can dereference is not adopted |
| git, IPFS | the name is a digest of the bytes | content addressing suits immutable things, not a row that changes |
| MCP resources | resources are identified by URI and read with `resources/read` | agents already speak this shape |

---

## The nine

Run 2026-11-11 through `decision-rules`. It passes as a proposal on the
conditions below; every one is something a build must say before it starts.

1. **Origin** — a Reference names and carries nothing, so it adds no origin, *as
   long as* it is derived from the typed columns, never a shadow of them.
2. **Concept budget** — spends the empty `Reference` row; adds no new one.
3. **Complexity** — the problem's, and the older name is RFC 3986's.
4. **Predictability** — improves: three regexes in `credentials.ts` already act as
   one shape.
5. **Derived** — each owner derives its references from what it holds; none is
   typed by hand.
6. **Owner** — one registry of schemes, one resolver each. Without the registry,
   every existing parser (`credentials.ts`, `FileRef`, MCP) becomes a second
   owner beside a new one.
7. **Boundary** — "relative to the context holding it" is RFC 3986 §5, and the
   build must say who supplies the base. Peering is where that bites.
8. **Failure** — an unresolvable Reference fails closed with a named refusal,
   never a silent empty.
9. **Silence** — *must stay true:* one resolver per scheme, and a caller-supplied
   Reference never reaches a SQL pattern or a path unparsed (Invariant 8). *Pinned
   by:* a test that no `scheme:` regex lives outside the registry, and a refusal
   test for an unknown scheme. Neither exists.

**Collisions to name in the ruling.** SQL's `REFERENCES` and `@relation`;
*resource*, which is the UI-realm noun here and the RFC's word for the target;
and `packages/litestone/references/`, the folder of reference models.

---

## Open questions

- **Q1 — What is the identity half of the absolute form?**
  - **A** — the Peer key id (`FJS-D1188`): built, but a key rotates.
  - **B** — the Frontier network chain (`frontier-network.md`): stable, not built.
  - **C** — a hostname resolved to a document, as `did:web` does: familiar, but a
    host is a location.
  - **Recommend B** — it is the one stable identity on the board; low confidence,
    since it is unbuilt.
- **Q2 — Is the relative form schemeless (`Order/42`), or does it carry one?**
- **Q3 — How is a pin spelled?** `?v=sha256:…` keeps the path the row's;
  a path segment makes the pinned thing its own resource. Not `#`, per the
  definition.
- **Q4 — Where does the scheme registry live?** `@frontierjs/toolbelt` sits below
  every realm, as the `$`-directives table does; litestone would own only the
  row scheme's resolver.
- **Q5 — Is the first build the polymorphic column?** It needs only the relative
  form, so Q1 and Q3 can wait, and it would replace the pairs above.

**What blesses the row:** answers to Q1–Q4, the registry with its two tests, and
one consumer replacing its own spelling.
