---
id: untrusted-bytes
status: shipped
dated: 2026-09-19
---

# Idea — serving bytes a stranger uploaded

**Status: PROPOSED.** Dated 2026-09-19. Every fact below was probed against the
tree and against a running `example`; nothing is read off a comment. The
question this existed to settle was [`FJS-D313`](../ISSUES.md#fjs-d313) and it is
**ruled — [`FJS-D314`](../DECISIONS.md#fjs-d314), option A, built the same day**.
The defect it came out of is [`FJS-1187`](../ISSUES.md#fjs-1187), closed with it.

---

## The shape

A `File` column's bytes are written by whoever filled the form, and something
has to serve them back. In an app using a local provider that something is
junction's `static` transport — the same handler that serves the app's own
bundle — and **the handler cannot tell the two populations apart**.

`nosniff` landed with `FJS-1187` and binds the browser to the declared type,
which the shared type table (`FJS-1186`) now makes correct. That is half. The
other half is `Content-Disposition`, and it cannot simply be added: a static
root normally holds an app's own scripts, and `isInlineSafe('text/javascript')`
is false by design, so an `attachment` rule over a static root breaks every app
it is meant to protect.

**The type that matters is SVG.** It is a document that may carry script, it
runs in the origin that served it, and it is a legitimate thing to upload.
`isInlineSafe` in `@frontierjs/toolbelt/mime` is the allow-list that already
refuses it, written for this and currently with no caller.

## Four facts the options turn on

Each was probed on 2026-09-19 and each moves the answer.

**It is not dev-only.** The runtime default for an unconfigured provider is
dev/test-or-throw, which reads like a guarantee and is not one: `example`
hardcodes `provider: 'local'` in every environment, including the deploy the
`deploy` CI phase exercises — and `example` is what people copy.

**Where anyone has thought about it, the populations are already separated by
DIRECTORY.** `example`'s static root is `db/public/`, which holds `storage/` and
nothing else, so its mount is uploads-only and its SPA is served by sierra. This
is the fact that shrinks the fail-open objection below.

**An S3/R2 app is not in this path at all.** `put` sends `contentType` and the
bucket serves the bytes. Only the local provider reaches junction — and it
**discards `contentType`** and writes bytes only, so the stored key's extension
is the whole of what a browser is ever told. That is why `FJS-1184` made the key
follow the resolved type rather than the uploaded name.

**The allow-list exists.** Nothing here needs designing from scratch; what needs
deciding is who is allowed to know that a given root holds uploads.

## Open questions

- ~~**What stops an uploaded SVG running in the app's own origin, and who is allowed to know it is an upload?**~~ **Answered 2026-09-19 (`FJS-D314`): A — `untrusted: true` on the static mount. The app names which roots hold stranger bytes; those answer `attachment` for anything `isInlineSafe` refuses and every other root is unchanged. A flag somebody can forget — except that `fli check` closes it: *a local `FileStorage` whose `publicBase` points into a static root that is not marked* is decidable from config alone.**
  - **A** — `untrusted: true` on the static mount. The app names which roots hold stranger bytes; those answer `attachment` for anything `isInlineSafe` refuses and every other root is unchanged. A flag somebody can forget — except that `fli check` closes it: *a local `FileStorage` whose `publicBase` points into a static root that is not marked* is decidable from config alone.
  - **B** — the local provider owns its own mount, so the headers arrive by construction and there is no flag to forget. Litestone cannot serve HTTP (Invariant 1), so this is a bridge rather than a move: the provider supplies the policy and junction mounts it.
  - **C** — invert the default everywhere: `attachment` unless `isInlineSafe`, with an app naming its own exceptions. Fail-closed by construction, and blunt — it breaks the ordinary SPA that serves its own HTML and JS from a static root.
  - **D** — nothing at the transport; declare it at the Data boundary instead, by requiring `@accept` on a `File` column. Invariant 6's shape, and it settles nothing here: an app may legitimately declare `@accept("image/svg+xml")` for a logo uploader and the disposition question returns unchanged.
  - **Recommend A** — the fail-open objection is the whole argument for B, and the second fact above shrinks it (the flag lands on a mount that is entirely uploads) while `fli check` closes it properly, which is this framework's standing answer to a declaration somebody forgets: a declaration plus a rule that fires when it is absent. B puts a serving policy in a package that cannot serve, for one header. C is the right default in a world where a static root held one population, and it does not. **D is worth doing on its own terms and is not an alternative to any of these.**

## See also

- [`FJS-1187`](../ISSUES.md#fjs-1187) — the defect, and the `nosniff` half that landed
- [`FJS-1186`](../ISSUES.md#fjs-1186) — the shared type table, which is what makes a declared type trustworthy enough to bind
- [`FJS-1184`](../ISSUES.md#fjs-1184) — why the stored key's extension follows the bytes
- [`FJS-692`](../ISSUES.md#fjs-692) — the same hazard on junction's own file store, hardened and then deleted with the module ([`FJS-D260`](../DECISIONS.md#fjs-d260)), which is how the hardening was lost
