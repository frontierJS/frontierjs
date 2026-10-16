# Lane: Conduit connectors

**Claimed by:** _name_ · one branch and one PR per connector, `conduit/<vendor>`.
Read [`ALONGSIDE.md`](../ALONGSIDE.md) first. This lane follows its rules, and
§ 5 there is the routine before every push.

You build official connectors: each one is `@frontierjs/conduit-<vendor>` at
`packages/conduit-<vendor>/`. Three rulings in `DECISIONS.md` are the spec, so
read them before writing code:

- `FJS-D890`: what a connector package contains
- `FJS-D889`: when a connector is named for a protocol instead of a vendor
- `FJS-D891`: how a vendor's auth reaches conduit, through a `signed` target

## Where it stands

**Every connector below already exists as a prototype** in the sibling workspace
`../conduit-connectors/` (own repo; `IDEAS/conduit-connectors.md` § Prototyped
has the state table, verified by running every drive 2026-10-12). The lane's
job is now PROMOTION: move a prototype into `packages/conduit-<vendor>/` with its
sink and drive, swap the two relative imports for workspace dependencies, and
add the row. Start from the prototype, not from the references below.
`conduit-postmark` and `conduit-mailgun` in the sibling workspace are the first two
shaped for `packages/` (2026-10-16, held there until the owner commits them): copy their `package.json`, `tsconfig.json` and `test`
script (the drive IS the package's test), and import the drive's `results`,
`report`, `control` and `DRIVE_RESILIENCE` from `@frontierjs/conduit/testing`.

## Order

1. **google-maps**: runs on today's `api_key` auth. Four apps want it
   ([`IDEAS/conduit-connectors.md`](../IDEAS/conduit-connectors.md) § Tier B, row 8).
2. **turnstile**: the smallest connector. A `signed` target with the secret in the body.
3. **twilio**: a `signed` target using Basic auth. The first one with a webhook,
   so it is where the verifier shape gets tested.
4. **push** (APNs + FCM): a `signed` target. The resolver mints the JWT, and
   `withCache({ get: mint }, { ttl_ms })` controls when it expires.

The Tier A rows (stripe, resend, s3, telnyx, cloudflare, digitalocean, hetzner)
belong to the owner. Each one moves code out of a package somebody else is
working in.

## What each package holds (`FJS-D890`)

| Piece | Rule |
| --- | --- |
| target builder | returns a `TargetDescriptor` and installs nothing |
| payload types | the vendor's request and response shapes, for the calls this connector makes |
| error mapping | every vendor failure maps onto a `ConduitErrorKind`; adding a kind is conduit's call, never the connector's |
| sink | a `Bun.serve` that stands in for the vendor and owns chaos: a 429, a duplicate delivery, a lost response, a moved clock |
| drive | a test that runs the connector through a real `createConduit` against the sink, plus a negative control that must fail |
| webhook verifier | only where the vendor sends webhooks: a pure function from raw body, headers and secret to the event or a refusal |
| fixture | only where a conforming server exists to point at; a protocol connector always has one |

Write it in TypeScript, in the house style. Use the three markdown files at the
package root (Invariant 17), and declare `@frontierjs/conduit` as a peer
dependency. Add the package's row to the root `CLAUDE.md` Packages table in the
same PR, with `batteries` in the Ring column, because the rings test fails on a
package with no ring.

Two references to copy the shape from:

- `example/api/src/providers/stripe/` (`index.ts`, `sink.ts`): a whole
  connector, including its sink.
- `packages/conduit/signers.test.ts`: a `signed` target driven against a real
  `Bun.serve`.

## google-maps: probe these before building

- **Auth.** Places (New) and Routes take an `X-Goog-Api-Key` header, which fits
  an `api_key` target. Check whether Geocoding accepts that header too. If it
  only takes `?key=`, record it as a finding: a signer returns headers and a
  body but cannot change the URL, so the seam would need a change, and conduit
  core changes go through the owner.
- **Field mask.** Places and Routes require `X-Goog-FieldMask` on every call.
  It belongs on each request, not on the target.
- **Errors in a 200.** Geocoding returns HTTP 200 with a `status` field in the
  body (`OVER_QUERY_LIMIT`, `REQUEST_DENIED`, `ZERO_RESULTS`), so the mapping
  has to read the body. Decide whether `ZERO_RESULTS` counts as an answer or an
  error, and say which in the README.
- **Cost.** Every lookup costs money, and the same address looked up twice is
  paid for twice. Read `IDEAS/external-field-cache.md`. Whether the connector
  caches is undecided: propose an answer as a finding rather than building one.

## What this branch writes

`packages/conduit-<vendor>/`, this file, and the package's row in the root
`CLAUDE.md`. A new package changes `exports.snapshot.md`, so regenerate it with
`fli ws:exports`; the CI snapshots phase fails if it is stale.

`ISSUES.md`, `DECISIONS.md`, `IDEAS/` and conduit's own source are written only
by the owner. When the contract or the seam does not fit a vendor, write that
up under § Findings below, with a repro. The contract was derived from the
connectors that already exist, so where a new one does not fit is the most
useful thing this lane can report.

## Findings

One section per finding, in the shape `ALONGSIDE.md` § 4 gives.
