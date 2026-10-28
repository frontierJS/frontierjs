---
id: package-host
status: proposed
dated: 2026-10-27
---

# Package host — every published tarball at a URL `bun install` can fetch

**Status: PROPOSED.** Dated 2026-10-27. Nothing here is built. Do not cite this
file as behavior — see `VERIFYING.md`. Ruled `FJS-D1568`.

A FrontierJS app depends on the framework one of two ways today: `link:` to a
workspace on the same machine, or a range resolved from npm. Neither serves a
build machine that has no workspace and no npm account to publish to: the
Basecamp Dockerfile template (`packages/basecamp/api/src/domain/release/dockerfile-template.ts`)
clones the whole monorepo at `dev`, installs the workspace and `bun link`s
every package to satisfy five dependencies, which is slow, needs git in the
image and names a moving branch. Bun installs a dependency from a tarball URL
(`"@frontierjs/litestone": "https://…/litestone/1.1.11.tgz"`), and the tarball
is the one `fli ws:publish` already hands npm — the same bytes `core/vendor.js`
packs into a build context. What is missing is a place those bytes can be
fetched from.

**The bytes live on the GitHub Release for the tag `ws:publish` already cuts.**
The URL is on the project's own domain and is derived from two facts a
developer already knows, the package name and its version:

```
https://packages.frontierjs.com/<stem>/<version>.tgz
  → 302 → https://github.com/frontierJS/frontierjs/releases/download/<tag>/<stem>-<version>.tgz
```

where `<stem>` is `@frontierjs/litestone` with `@` dropped and `/` turned to
`-` (`vendor.js` line 236 already computes it) and `<tag>` is the tag
`01-version-all` writes, `@frontierjs/litestone@1.1.11`. One Cloudflare redirect
rule, a pattern and not a per-package table, is the whole of the domain. If the
rule ever needs a list it has failed `decision-rules` Q5 and the design is
wrong.

**Reconciling `FJS-D988`.** That ruling says a tarball path is not what a client
upgrades from, and it is right: a URL carries no range and `bun update` has
nothing to resolve. This is a different question. The URL is the **install
path** for a machine with no registry — ring 0 of `deploy-plane.md` — and npm
remains the **upgrade path**. An app scaffolded `--source url` is one that will
later `--source npm`.

## Prior art

- **Go modules** — a vanity import path (`go get frontierjs.com/x`) redirects
  to the forge that holds the bytes; the path is the identity, the host is not
  ([go.dev/ref/mod](https://go.dev/ref/mod#vcs-find)).
- **Deno** — resolve by URL, pin by hash in the lockfile; the URL is the
  spec and integrity is the lock's job
  ([docs.deno.com](https://docs.deno.com/runtime/fundamentals/modules/)).
- **Bun** — `bun add https://example.com/pkg.tgz` is supported as a dependency
  spec ([bun.sh/docs](https://bun.sh/docs/cli/add)); whether `bun.lock` records
  an integrity hash for it is Phase 0's first probe, read from a run and not
  from the docs.
- **GitHub Releases as a package host** — Homebrew bottles and many Go and
  Rust binaries ship this way: one asset per tag, a stable download URL,
  nothing to run.

## What must stay true

Every published version has an asset at the derived URL, byte-equal to the npm
tarball. **What fails when it stops: none today.** Phase 1.3 builds the check,
and CI's `deploy` phase gains the third source run in 3.3; until then this is
recorded `none`, not assumed.

## Phases

### Phase 0 — Probes

Goal: three facts read from a run, not from a doc.
Done when: each probe's answer is written under its step.

- [x] 0.1 `bun install` from an `https://…tgz` spec: does `bun.lock` carry an
  integrity hash, and does a swapped tarball at the same URL fail the install.
  Pack litestone with `bun pm pack`, serve it from a local static server, install
  it into a scratch app, alter the file, reinstall.
  **Answer (Bun 1.4.4):** yes on both. The lock entry is
  `["@frontierjs/litestone@http://…/1.1.11.tgz", {…}, "sha512-…"]`, and the
  tarball's own dependencies (`@frontierjs/toolbelt`) resolve from npm by
  range as usual. With the bytes at the URL swapped and the lock kept, both
  `bun install` and `--frozen-lockfile` stop at `Integrity check failed for
  tarball: @frontierjs/litestone` once the cache is cleared; with the cache
  warm the swap is not even fetched. A URL spec is pinned by hash, not by URL.
  A pack of the working tree is NOT the npm tarball — the local pack of 1.1.11
  hashed `rG+T…` where npm holds `ld+C…`, because the tree moved after
  publish; 1.3 says what that means for the postflight.
- [x] 0.2 Bun follows a 302 from the spec URL to another host. A redirect rule
  on `awe.dev` (the hand-run zone) pointing at a GitHub asset, installed from.
  **Answer:** yes. A local `http://` server answering 302 to
  `registry.npmjs.org/…/litestone-1.1.11.tgz` installs clean; the lock keeps the
  SPEC URL, not the one it landed on, with npm's `ld+C…` hash. Cross-host and
  `http`→`https` both followed. The Cloudflare half was not run — the DNS write
  on `awe.dev` is refused to this session — and is not needed for the question;
  2.1 is where the rule gets written and 1.3 is where it is proved.
- [ ] 0.3 `gh release create '@frontierjs/litestone@1.1.11' <tgz> --latest=false`
  against the existing tag: the asset URL GitHub answers with, whether a `/` in
  the tag survives the `releases/download/<tag>/<file>` path, and whether an
  asset can be re-uploaded over itself (if it can, write-once lives in the
  command, as it does for npm).
  **Owner-run.** Two facts found on the way: the tag `@frontierjs/litestone@1.1.11`
  was local only — `ws:publish`'s `push HEAD --tags` after-step had not run, and
  pushing it now is blocked by pre-push `ci --fast` on an unrelated dirty tree;
  and `gh release create --target <sha>` writes the tag on GitHub without a
  push, so 1.2 can make the tag and the release one call. The command to run,
  with npm's own tarball as the asset so the release is byte-equal by
  construction (`sha512-ld+C…`, fetched to the session scratchpad):
  `gh release create '@frontierjs/litestone@1.1.11' frontierjs-litestone-1.1.11.tgz --target 9a353511 --latest=false --title '@frontierjs/litestone@1.1.11' --notes '…'`.
  Then `curl -sIL` the asset URL for the `/`-in-tag answer and `gh release
  upload <tag> <tgz>` without `--clobber` for the re-upload answer.
- [x] 0.4 Measure what this deletes: the clone-and-link Dockerfile's build time
  against a plain `bun install` of five URL specs, on the same machine.
  **Answer:** same scaffold (`fli new --auth`, ten `@frontierjs/*` deps),
  `docker build --no-cache`, one run each, npm tarball URLs standing in for the
  hosted ones:

  | Dockerfile | build | image | the install line |
  | ---------- | ----- | ----- | ---------------- |
  | clone-and-link (`fjsDockerfileTemplate`) | 100s | 1.53GB | 723 packages, 37s, after 24s of apt and a 46s clone+link |
  | `COPY . . && bun install`, URL specs + `overrides` | 13s | 410MB | 33 packages, 10s |

  Checked beside it: sierra's `^mesa` is a PEER range, and a URL-spec'd mesa
  satisfies it with one copy and no `overrides`. Where `overrides` matters is
  a hard range between packages (sierra → toolbelt `0.1.6`), which this run
  did not isolate; 3.1 keeps writing the block `vendor.js` already writes.

### Phase 1 — `ws:publish` ships to both

Goal: one pack, two destinations, from the pipeline that already owns a release.
Done when: `fli ws:pub patch --filter litestone --dry` prints the asset it would
upload beside the npm line, and a real run leaves an asset the postflight verifies.

- [ ] 1.1 `02-publish-all` packs once with `core/vendor.js`'s pack and publishes
  THAT file to npm (`npm publish <tgz>`), so the asset and the registry copy are
  the same bytes by construction rather than by two packs agreeing.
- [ ] 1.2 `--to <npm|tarballs>`, multiple, default both. `--to npm` or `--to
  tarballs` narrows. The tarball destination runs `gh release create <tag>
  <tgz> --latest=false --notes <subject>`; a release that already exists for
  the tag is refused the way a spent npm version is, unless 0.3 shows GitHub
  refuses it first. `00-preflight` gains the `gh auth status` check beside
  `npm whoami`.
- [ ] 1.3 `04-verify-assets` — the postflight: GET the derived
  `packages.frontierjs.com` URL for every released package, follow the redirect,
  sha256 the body against the tarball 1.1 uploaded — never against a fresh
  pack, which 0.1 showed differs once the tree moves. This is the only artefact
  for § What must stay true, so it fails loudly and names the package.

### Phase 2 — The domain

Goal: `packages.frontierjs.com/<stem>/<version>.tgz` answers for every asset.
Done when: 1.3 passes against the live domain.

- [ ] 2.1 One Cloudflare redirect rule on the `frontierjs.com` zone, written with
  the `cf` CLI: `packages.frontierjs.com/<stem>/<version>.tgz` →
  `github.com/frontierJS/frontierjs/releases/download/@frontierjs/<stem-without-prefix>@<version>/<stem>-<version>.tgz`.
  The stem's `frontierjs-` prefix and the tag's `@frontierjs/` are the same
  fact spelled twice; 0.3 says whether the tag's `/` needs encoding. A
  proxied DNS record for the host exists only so the rule has something to fire
  on. The zone has no entry-point ruleset in `http_request_dynamic_redirect`
  yet, so the first write is `cf rulesets account-rulesets phases update
  http_request_dynamic_redirect -z <zone> --rules @rule.json`, which creates
  it. **Hazard:** `frontierjs.com` is not among the zones the `cf` profile on
  this machine lists (`awe.dev` and the client zones are, under account
  `0a207b…`); find which account or profile holds it before 2.1, or the step
  is a dashboard click and 2.2 has nothing to copy.
- [ ] 2.2 The rule's text lives in the tree beside `core/tell-worker.js`'s
  wrangler config, so a second zone (`FLI_FRONTIER_POST`'s drive against
  `wrangler dev`) can carry the same rule. No command: a redirect rule is set
  once and the postflight proves it on every publish.

### Phase 3 — Consumers

Goal: the three places that choose a source know the third one, and the
Dockerfile that existed only because of `link:` is gone.
Done when: CI's `deploy` phase is green for `--source url`, and
`dockerfile-template.ts` holds no `git clone`.

- [ ] 3.1 `fli new --source url` — `scaffold/app.js` `specFor` writes the
  derived URL at the package's current version, and the `overrides` block
  `vendor.js` already writes, so sierra's own `^mesa` range resolves to the
  mesa tarball and not to npm's. The `--source` description says which path
  each is for: `url` installs, `npm` upgrades (`FJS-D988`).
- [ ] 3.2 The Outpost's `chooseDockerfile` (`FJS-D1560`) learns that URL specs
  need neither `deploy/generated/` nor a clone, and Basecamp's
  `fjsDockerfileTemplate` becomes `COPY . . && bun install`. The clone branch is
  deleted, not kept behind a flag — it exists only because `link:` cannot
  resolve in an image.
- [ ] 3.3 CI's `deploy` phase (`scripts/ci.mjs`) runs a third source,
  `--source url`, against the LIVE domain — the one place the published
  framework is tested (`FJS-252`), now testing the hosted one too. Skipped with
  a name when there is no network, the way the Docker run is skipped.
- [ ] 3.4 `docs/` and the root `README.md` § Project Structure say the three
  sources in one table: `local` develops, `url` installs, `npm` upgrades.

### Phase 4 — A dev channel (deferred)

Goal: a build machine pins the working tree at a commit without spending a
version.
Done when: Basecamp deploys an app against `litestone/1.1.12-dev.<sha>.tgz`.

- [ ] 4.1 Decide Q2 first. Until then the dev channel is `--source local` plus
  `deploy:vendor`, which already ships the working tree into a build context.

## Open questions

- **Q1 — Default destinations.**
  - **A** — `--to` defaults to both npm and tarballs, so § What must stay true
    holds by default and a flag only narrows.
  - **B** — defaults to npm; tarballs are opt-in.
  - **Recommend A** — B makes the asset's absence the common case and the
    postflight a check that usually has nothing to check.
- **Q2 — The dev channel.**
  - **A** — `ws:publish --channel dev` writes `x.y.z-dev.<sha>` assets to one
    rolling GitHub Release (`dev`), no git tag, no npm; the URL is derived from
    the sha.
  - **B** — no dev channel; a build machine that wants the tree uses
    `deploy:vendor`, which already ships the working tree into a build context.
  - **Recommend B until Phase 3 is green** — A is a second version list, which
    `decision-rules` Q1 refused, and the need it serves is already met.

## See also

- `deploy-plane.md` § Ring 0 — the distribution problem this is the answer to.
- `git-deploy.md` 1.6 / `FJS-D1560` — who chooses a Dockerfile.
- `FJS-D988` — tarballs are not an upgrade path; this file says what they are.
- `packages/cli/core/vendor.js` — the pack, the stem and the `overrides` hazard.
