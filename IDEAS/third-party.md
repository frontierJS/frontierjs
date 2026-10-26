---
id: third-party
status: partial
dated: 2026-10-24
---

# Idea — one register of the third parties we recommend

**Status: PROPOSED.** Nothing here is ruled unless a row cites a ruling. Probed
against the tree 2026-10-24. Do not cite this file as behavior — see `VERIFYING.md`.

**The ask** (owner, 2026-10-24): a document of our top recommended third-party
services and tools, mostly Docker installs, and research into which bucket vendor
and which local S3 server to recommend.

## What exists (probed 2026-10-24)

- **No register.** Picks are scattered across package docs, `IDEAS/` and fixtures.
  Each was made where it was first needed, and most were never researched.
- **Provider** is the ruled noun for a third party the app speaks to and holds
  credentials for (`FJS-D06`, `FJS-D681`). It covers a vendor we pay, not software
  we run.
- **Blueprint** is Basecamp's catalog of Docker software that a workspace deploys:
  8 rows in `packages/basecamp/db/blueprints.js`, `@@tenant(none)`
  (`packages/basecamp/docs/SCREENS.md` § The five arguments). Its storage row
  is SeaweedFS 4.48 (`FJS-D1511`), which replaced an archived `minio:latest`.
  Its `n8n` and `umami` rows still pin `latest`.
- **Stand-in** is blessed and **Sidecar** refused (`FJS-D1509`). The middle kind
  is *self-hosted* until Basecamp's `VISION.md` rules its open noun.

## The three kinds

| Kind | What it is | Who runs it | Proved by |
| --- | --- | --- | --- |
| **Provider** (ruled) | a hosted vendor the app sends to or is called by | the vendor; we hold a key | one manual pass against the real account |
| **Self-hosted** (no noun yet) | software we run beside the app, usually in Docker or as a pinned binary | Outpost or `fli deploy` | the drive that starts it |
| **Stand-in** (`FJS-D1509`) | a local fake of a Provider that a drive can reset, stop or break on purpose | the drive | every run |

A Provider usually has a stand-in, and the pair is recorded together: the
stand-in runs the automated drive, and the Provider gets one manual pass after it.
Self-hosted software a workspace deploys for itself is a Blueprint row as well.

## The register

**Pick** is what we recommend, and *unruled* means it is a default somebody chose
without a ruling. **Runner-up** is what we would switch to.

### Providers

| Need | Pick | Runner-up | Where it is used | Ruling |
| --- | --- | --- | --- | --- |
| Backup bucket | Backblaze B2 | Cloudflare R2 | `BackupDestination`, `BACKUPS.md` | `FJS-D1506`; any S3-compatible bucket still works (`FJS-D1488`, `FJS-D1491`) |
| Cloud host | DigitalOcean, Hetzner | | `fli deploy --cloud`, `conduit-digitalocean`/`conduit-hetzner` | `FJS-D1478`–`D1480`, `FJS-D1185` |
| DNS | Cloudflare | | `fli cloudflare dns` (`cloudflare-dns.md`) | unruled |
| Transactional + inbound mail | Postmark, Mailgun | | `inbound-email.md`, sibling-repo connectors | unruled |
| Payments | Stripe | | basecamp billing, `example` | unruled |
| Voice + SMS | Telnyx, Quo | | `conduit-quo` stressor | unruled |

### Self-hosted

| Need | Pick | Pin | Where it is used | Ruling |
| --- | --- | --- | --- | --- |
| Front door, TLS | Caddy | 2.8.x (posture fixtures) | Outpost `src/ingress.js` | `FJS-D1459` |
| SQLite replication | Litestream | 0.5.17 | `litestone replicate`, Outpost unit | `FJS-D1486` |
| Speech to text | Parakeet TDT 0.6B via sherpa-onnx; whisper.cpp fallback | | `transcription.md` | `FJS-D1492` |
| Container runtime | Docker | 27.x | every fleet machine | unruled |

### Stand-ins

| Stands in for | Pick | Pin | Where it is used | Ruling |
| --- | --- | --- | --- | --- |
| S3 bucket | SeaweedFS; runner-up Versity S3 Gateway | `S3_IMAGE` in `example/web/test/verify-replicate.mjs` | `example` `verify:replicate` | `FJS-D1507` |
| Mail Provider | in-process mail sink | | `example/api/src/providers/mail/sink.ts` | `FJS-D460` |
| Payment Provider | in-process PSP sink | | `example/api/src/providers/psp/sink.ts` | `FJS-D460` |

## Phase 0 — the register from the tree

Goal: every third party the tree already depends on, in one file.
Done when: each row names where it is used and a ruling or *unruled*.

- [x] 0.1 This file, built by probing the tree.

## Phase 1 — the bucket pair

Goal: a recommended default bucket vendor and a standard local stand-in.
Done when: Q1 and Q2 are ruled and their rows cite the rulings.

- [x] 1.1 Research the default bucket vendor (Q1). § Research.
- [x] 1.2 Research the local S3 stand-in (Q2). § Research.
- [x] 1.3 Owner rules Q1 and Q2: `FJS-D1506` B2, `FJS-D1507` SeaweedFS at 4.48.
  - `verify:replicate` on 4.48 with Litestream 0.5.17: 8 ok, 25 fail. That is
    `FJS-3485`'s split exactly. Every S3 check passes (`replicate.*`,
    `backup.succeeds`, `refuses.aReplicaWithNothingInIt`), and the failures are
    that issue's backup/restore half. The main tree needs
    `bunx litestone migrate apply` before the drive, because `db:seed` makes no
    `shop.db`.
- [x] 1.4 Probe what research left open: B2 `If-None-Match` (a `conduit-s3` row
      on the B2 fixture), and SeaweedFS 412/200 plus a prefix-scoped List/Read.
  - **B2 answers `if-none-match: *` on PUT with `501 NotImplemented`**, on the
    first write too. No caller in either tree sends it, so nothing breaks, but
    a create-only write cannot target B2. The `conduit-s3` row
    `createOnlyPutNeverOverwrites` asserts only that the second write never
    wins, and logs the answer.
  - **SeaweedFS 4.48 passes all 10 `conduit-s3` protocol rows**, including 200
    then `412 PreconditionFailed`. That makes it `FJS-D889`'s second real server.
  - **A SeaweedFS key with `Read:`/`Write:`/`List:drive/app1/*` holds.** In its
    prefix, put, get and list pass. A sibling prefix, the bucket root, a
    lookalike `app1x/`, a whole-bucket list and a sibling delete all answer 403.
  - Setting env keys closes anonymous access (an unsigned GET is 403). So a
    scoped-key row in `verify:replicate` would need its bucket create moved to
    `weed shell` (`s3.bucket.create`). That is not done, because nothing in the
    drive needs a second key yet.
  - Versioning combined with `If-None-Match` (#8073) was not probed. No drive
    turns versioning on.
- [x] 1.5 Replace or remove the Blueprint `minio:latest` row: SeaweedFS 4.48
      (`FJS-D1511`). The row's shape matches the other seven; not deployed.

## Phase 2 — the words

Goal: the register's kinds are defined once.
Done when: `VOCABULARY.md` has their rows, through `decision-rules`.

- [x] 2.1 Rule the nouns (Q3): Stand-in blessed, Sidecar refused (`FJS-D1509`).

## Phase 3 — the move

Goal: the register is a reference in `docs/`, not a proposal (`FJS-D1510`).
Done when: `docs/THIRD-PARTY.md` exists and this file is gone.

- [ ] 3.1 Rule the *unruled* rows, or mark each as a default nobody chose.
- [ ] 3.2 Move to `docs/THIRD-PARTY.md`, with each Pin cell replaced by the
      file that holds that pin.

## Research

### Q1 — the default bucket vendor (researched 2026-10-24)

Costs are for 50 GB stored, 10 GB egress and 500k Class A requests a month. Prices
come from each vendor's pricing page, fetched 2026-10-24; the AWS figures and B2's
region list were recalled, not fetched.

| Vendor | ~Monthly | What decides it |
| --- | --- | --- |
| **Backblaze B2** | $0.28 | Every S3 call is free. Free egress up to 3× what is stored. Keys scope to a prefix. **Keeps every version by default**, so retention needs a native rule (`daysFromHidingToDeleting`), and S3-API lifecycle is undocumented. **Refuses `If-None-Match` on PUT with 501** (probed 2026-10-24, 1.4), as a 2025 Proxmox patch reported. |
| **Cloudflare R2** | $0.60 | Egress is free. No versioning, so a DELETE deletes, and DELETE is free. Atomic `If-None-Match` is documented, and so is S3 lifecycle. Keys scope to a bucket only. Class A is metered, and Litestream #1171 measured about 480 PUTs/hour from an idle database. Outages: Feb 2025 (59 min), a credential rotation (1h07m), and AMS on 2026-10-01. |
| Scaleway | €0.80 | `If-None-Match` is documented. EU only. |
| Tigris | $3.40 | `If-None-Match` is documented. Requests are metered. |
| AWS S3 | $3.65 | The baseline. Egress costs $0.09/GB. |
| DigitalOcean Spaces | $5 flat | Egress is free only to Droplets in the same region. Conditional PUT is undocumented. |
| Hetzner Object Storage | €6.49 flat | EU only. A high-utilization notice has been open since 2026-01, plus outages in 2026-06 and 2026-07 (from aggregators, not Hetzner's status page). Open Litestream issue #1151. Objects are billed at a 64 KB minimum. |
| Wasabi | $7.99 floor | A 1 TB minimum and a 90-day minimum storage duration don't suit short-lived WAL segments. |

**Litestream must be ≥ 0.5.4 and configured with `url:`.** AWS SDK v2's trailing
checksums broke B2, R2, Hetzner and Spaces until 0.5.4 turned them off for custom
endpoints (#894, #912, #941, #943). Vendor detection runs only on the `url:` form
(#1096, #1351). We pin 0.5.17.

Still unproved:
- ~~B2 `If-None-Match` today.~~ Settled by 1.4: `501 NotImplemented`.
- B2 lifecycle over the S3 API.
- Conditional PUT on Spaces and Wasabi.
- Whether #1171's idle amplification also happens on B2.
- When B2's free-request pricing took effect, since its page carries no date.

Sources:
[B2 pricing](https://www.backblaze.com/cloud-storage/pricing) ·
[B2 transactions](https://www.backblaze.com/cloud-storage/transaction-pricing) ·
[B2 S3 API](https://www.backblaze.com/docs/cloud-storage-s3-compatible-api) ·
[B2 lifecycle](https://www.backblaze.com/docs/cloud-storage-lifecycle-rules) ·
[Proxmox B2 patch](https://lists.proxmox.com/pipermail/pbs-devel/2025-July/014234.html) ·
[R2 pricing](https://developers.cloudflare.com/r2/pricing/) ·
[R2 S3 API](https://developers.cloudflare.com/r2/api/s3/api/) ·
[R2 lifecycle](https://developers.cloudflare.com/r2/buckets/object-lifecycles/) ·
[R2 incident](https://www.cloudflarestatus.com/incidents/t5nrjmpxc1cj) ·
[R2 rotation outage](https://www.bleepingcomputer.com/news/security/cloudflare-r2-service-outage-caused-by-password-rotation-error/amp/) ·
[Hetzner](https://www.hetzner.com/storage/object-storage/) ·
[Hetzner actions](https://docs.hetzner.com/storage/object-storage/supported-actions/) ·
[Spaces pricing](https://docs.digitalocean.com/products/spaces/details/pricing/) ·
[Wasabi minimum](https://docs.wasabi.com/docs/how-does-wasabis-minimum-storage-duration-policy-work) ·
[Scaleway conditional writes](https://www.scaleway.com/en/docs/object-storage/api-cli/using-conditional-writes/) ·
[Tigris conditionals](https://www.tigrisdata.com/docs/objects/conditionals) ·
[AWS conditional writes](https://aws.amazon.com/about-aws/whats-new/2024/08/amazon-s3-conditional-writes) ·
[Litestream S3-compatible](https://litestream.io/guides/s3-compatible/) ·
Litestream issues [#1171](https://github.com/benbjohnson/litestream/issues/1171),
[#1151](https://github.com/benbjohnson/litestream/issues/1151),
[#1096](https://github.com/benbjohnson/litestream/issues/1096),
[#1351](https://github.com/benbjohnson/litestream/issues/1351)

### Q2 — the local S3 stand-in (researched 2026-10-24)

| Server | License | Latest | Image | Cond. PUT | Scoped key | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| **SeaweedFS** | Apache-2.0 | 4.49, 2026-10-23 | 92 MB | yes (412) | `Write:bucket/prefix/*` per identity | keep: already passes `verify:replicate` with Litestream 0.5.17 |
| **Versity S3 Gateway** | Apache-2.0 | v1.10.0, 2026-10-22 | 36 MB | in source | IAM accounts + bucket policies | runner-up: one Go binary, root key set by env, never tried here |
| RustFS | Apache-2.0 | 1.0.3, 2026-10-17 | 115 MB | in source | MinIO-style IAM | viable but young: 1.0 only since October |
| Garage | AGPL-3.0 | v2.5.0, 2026-10-23 | 27 MB | **ignored** by PUT (`put.rs`) | per bucket, no prefix | drop |
| MinIO fork (pgsty, "Silo") | AGPL-3.0 | 2026-10-18 | 55 MB | upstream's last free release refused it | full IAM | drop |
| moto · s3proxy · Zenko · LocalStack · OpenMaxIO | | | | | | drop: a mock, no second key, too heavy, archived and token-gated, a stale console fork |

**Plain Litestream replication needs no conditional writes.** In 0.5.17 only the
opt-in lease (`s3/leaser.go`) sends `If-None-Match`. That requirement is ours
(`conduit-s3`), not Litestream's.

What a scoped-key drive would hit on SeaweedFS:
- **The drive runs with no keys today.** It creates the bucket with an unsigned
  `fetch` PUT (`example/web/test/verify-replicate.mjs`). Once an identity exists,
  anonymous access likely closes, so those calls need SigV4.
- **Env keys are global admin.** A scoped key is added after start by piping
  commands into `weed shell` through `docker exec -i`. That needs no mount, so it
  works under snap Docker.
- **Prefix scoping is documented only for `Write`.** Whether `Read` and `List`
  honor a prefix needs a probe.
- **Versioning combined with `If-None-Match` has a reported bug** (#8073).

Still unproved: Versity's prefix policies, and the Garage finding,
which was read from source because its forge refused the fetch.

Sources:
[MinIO archived](https://pinggy.io/blog/minio_archived_self_hosted_s3_alternatives/) ·
[SeaweedFS conditional writes](https://seaweedfs.com/blog/conditional-writes/) ·
[SeaweedFS credentials](https://github.com/seaweedfs/seaweedfs/wiki/S3-Credentials) ·
[SeaweedFS #8073](https://github.com/seaweedfs/seaweedfs/issues/8073) ·
[Versity](https://github.com/versity/versitygw) ·
[RustFS](https://github.com/rustfs/rustfs) ·
[Garage S3 compatibility](https://garagehq.deuxfleurs.fr/documentation/reference-manual/s3-compatibility/) ·
[pgsty/minio](https://github.com/pgsty/minio) ·
[LocalStack 2026-03](https://blog.localstack.cloud/localstack-for-aws-release-2026-03-0/) ·
[Litestream leaser](https://github.com/benbjohnson/litestream/blob/main/s3/leaser.go)

## Open questions

- ~~**Q1 — Which vendor Basecamp recommends as its default backup destination.**~~
  **Answered 2026-10-24 (`FJS-D1506`): A — Backblaze B2.**
  - **A** — Backblaze B2. It's the cheapest, every call is free (so Litestream's
    request volume costs nothing), egress is free up to 3× what's stored, keys
    scope to a prefix, and it's already proved live. Retention needs B2's native
    lifecycle rule, and conditional PUT needs a probe first.
  - **B** — Cloudflare R2. Egress is free, DELETE really deletes, and
    `If-None-Match` is documented. But it needs one bucket per app, Class A is
    metered, and it has an outage record.
  - **C** — No default. The operator picks, and `BACKUPS.md` lists A and B.
  - **Recommend A** — it's the vendor already proved, and the two gaps are
    one probe and one rule rather than a design change.
- ~~**Q2 — Which local S3 server the drives standardize on.**~~
  **Answered 2026-10-24 (`FJS-D1507`): A — SeaweedFS at 4.48.**
  - **A** — SeaweedFS, with the pin moved to 4.48 (4.49's image was not on Hub
    yet). Scoped keys come in through `weed shell`.
  - **B** — Versity S3 Gateway. It's lighter, its root key is set by env, and it has
    IAM. The drive would have to be re-proved with Litestream.
  - **C** — RustFS. MinIO-style IAM, so it's closest to what the Blueprint row
    meant, but it reached 1.0 only this month.
  - **Recommend A** — it's the only one already green with Litestream 0.5.17, and
    every feature on the list exists in it. What's missing is two probes and a
    signed bucket create, not a switch.
- ~~**Q3 — The nouns.**~~ **Answered 2026-10-24 (`FJS-D1509`): Stand-in blessed,
  Sidecar refused; the middle table is *Self-hosted*.**
- ~~**Q4 — Where the register lives once ruled.**~~ **Answered 2026-10-24
  (`FJS-D1510`): `docs/THIRD-PARTY.md`, the Pin column replaced by pointers.**
