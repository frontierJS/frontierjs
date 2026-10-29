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

Every version `ws:publish` ships has an asset at the derived URL, and where it
also went to npm the two are byte-equal. **What fails when it stops: none
today.** Phase 1.3 builds the check, and CI's `deploy` phase gains the third
source run in 3.3; until then this is recorded `none`, not assumed.

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
- [x] 0.3 `gh release create '@frontierjs/litestone@1.1.11' <tgz> --latest=false`
  against the existing tag: the asset URL GitHub answers with, whether a `/` in
  the tag survives the `releases/download/<tag>/<file>` path, and whether an
  asset can be re-uploaded over itself (if it can, write-once lives in the
  command, as it does for npm).
  **Answer (owner-run; `gh release create` is a public-surface write a session
  is refused):** the release exists, its asset is npm's own tarball, and
  `https://github.com/frontierJS/frontierjs/releases/download/@frontierjs/litestone@1.1.11/frontierjs-litestone-1.1.11.tgz`
  with the `/` and `@` LITERAL answers 302 to a signed
  `release-assets.githubusercontent.com` URL that expires in an hour, then
  200; `bun install` from the literal URL lands with npm's `ld+C…` hash. A
  second `gh release upload` without `--clobber` is refused: `asset under the
  same name already exists` — write-once is GitHub's, not the command's, and
  1.2 need only not pass `--clobber`. `--target` takes a FULL sha; a short one
  is `Release.target_commitish is invalid`. The tag `@frontierjs/litestone@1.1.11`
  was local only (`ws:publish`'s `push HEAD --tags` after-step had not run) and
  `--target` wrote it on GitHub without a push, so 1.2 makes tag and release in
  one call. The release page URL encodes both characters
  (`/releases/tag/%40frontierjs/litestone%401.1.11`); the download URL does not
  need to.
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

- [x] 1.1 `02-publish-all` packs once with `core/vendor.js`'s pack and publishes
  THAT file to npm (`npm publish <tgz>`), so the asset and the registry copy are
  the same bytes by construction rather than by two packs agreeing.
  **Built:** `packPackage({ name, dir, destination })` and `tarballStem` are
  `core/vendor.js` exports, and `vendorWorkspacePackages` runs the same
  function. Step 02 packs every released package into
  `<fliTmpRoot>/publish/<startTime>/` before its first prompt, keeps the path
  as `released[i].tarball` for 1.2 and 1.3, and runs `bun publish "<tgz>"`
  (`bun publish [dist]` takes a tarball; proved with `--dry-run` on toolbelt).
  Not the workspace's `.cache/`: the *spends nothing* test in
  `publish-view.test.js` asserts a dry run leaves a fixture repo clean. On
  `--dry` the bump is not written, so the pack carries the tree's version and
  the line says so. `fli ws:pub patch --filter toolbelt --dry --allow-dirty`
  prints the pack beside the publish line; `vendor.test.js` gains two tests
  (`packPackage` returns its own file beside a prefix sibling; a failed pack
  is named).
- [x] 1.2 `--to <npm|tarballs>`, multiple, default both. `--to npm` or `--to
  tarballs` narrows. The tarball destination runs `gh release create <tag>
  <tgz> --latest=false --notes <subject>`; a release that already exists for
  the tag is refused the way a spent npm version is, unless 0.3 shows GitHub
  refuses it first. `00-preflight` gains the `gh auth status` check beside
  `npm whoami`.
  **Built:** `--to` is a repeatable `choices: [npm, tarballs]` flag on
  `ws:publish`; **unset is `tarballs` alone** (Q1 ruled C, `FJS-D1613`). Step
  02 runs, per package and after any npm publish, `gh release create <tag>
  <tgz> --latest=false --target <full sha> --title <tag> --notes <subject>` in
  the repo — `--target` because 0.3 showed gh writes the tag on GitHub and
  step 03 has not pushed yet; without it the tag lands on the default branch's
  head. No `--clobber`, so GitHub's own refusal is the write-once. The resume
  rule asks EVERY destination in the run (`npm view`; `gh release view <tag>
  --json assets`, the asset by its packed name) and a half-shipped version is
  shipped only where it is missing, so a failed release after a good npm
  publish is finished by the next run rather than by hand. `00-preflight`
  asks `gh auth status --active` only when `tarballs` is in the run, and `npm
  login`/`whoami` only when `npm` is. **Hazard found:** gh takes
  `GH_TOKEN`/`GITHUB_TOKEN` from the environment over its keyring login, and
  fli loads `~/.config/fli/env` into that environment — the token there was
  stale and every gh call under fli answered 401 while a bare shell was green;
  both refusals now name the variable. Proof: dry runs print one line per
  destination for each `--to` shape and `--to bogus` is refused by name; with
  the variable blanked, litestone 1.1.11 (released in 0.3) reads as shipped
  and toolbelt 0.1.6 (npm only) as `in-flight-moved`, which is 1.5's point;
  cli suite 4025 pass.
- [x] 1.4 The GUI's publish walk (`core/publish-view.js`, `PUBLISH_STEPS`)
  still gates on `npm whoami` and reads `ws:npm` for *what is out*: it learns
  the default destination — `gh auth status` as the ready gate, the release
  list beside the registry — and a *to* option that passes the same
  `choices` gate as `--tag`. Built: `core/publish-hosts.js` is the one reader
  per destination, asked by `ws:pub` before a bump and by the page beside the
  registry column; a destination's login gate is drawn only while it is in
  the run; the default is left unsaid in argv, like `latest`.
- [ ] 1.5 Backfill: every version already on npm has no release, and under the
  new default the next `ws:pub` reads each as in flight — `in-flight-moved`
  where the tree has moved since its tag, which is all of them. One owner-run
  pass, 0.3's procedure per package: fetch npm's own tarball (`npm pack
  <name>@<version>` — the registry's bytes, never a fresh pack), `gh release
  create <tag> <tgz> --latest=false --target <tag's sha>`. Owner-run because
  `gh release create` is refused to a session. Until it runs, `--to npm` is
  the only clean default run. The pass is `scripts/backfill-releases.mjs`:
  dry by default, `--run` does it; dry run 2026-10-28 names 20 to release and
  skips litestone, which 0.3 already shipped.
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

### Phase 4 — A dev channel

Goal: a build machine pins the working tree at a commit without spending a
version and without touching npm (`FJS-D1602`).
Done when: Basecamp deploys an app against
`packages.frontierjs.com/frontierjs-litestone/1.1.11-dev.<sha>.tgz`.
Needs 1.2's upload step and 2.1's rule; runs before Phase 3 if the owner wants
the dev road first.

- [ ] 4.1 `fli ws:publish --channel dev`: a closed set (`dev` only), refused
  with `--to npm` by name. The dev version string is
  `<manifest version>-dev.<short sha>` of HEAD; no manifest is written, no
  commit, no git tag. `00-preflight` refuses a dirty tree on this channel
  regardless of `--allow-dirty` — the sha in the filename is the one origin
  and a dirty tree makes it a lie. The pack is 1.1's `packPackage` over a
  manifest copy with the dev version, so the tarball's own name carries it.
- [ ] 4.2 Upload to ONE rolling GitHub Release named `dev` (`gh release
  upload dev <tgz>`, created once with `--prerelease --latest=false`); the
  release's tag is never cited, the filename is. Same name twice is refused
  by GitHub (0.3), which is write-once per sha for free.
- [ ] 4.3 2.1's redirect rule gains its second branch: a version containing
  `-dev.` resolves to release `dev`. Two branches, never a list.
- [ ] 4.4 1.3's postflight runs over the `dev` release too, against the
  tarball 4.1 packed. This is the only artefact for the ruling's silence.
- [ ] 4.5 `fli new --source url` accepts a dev version string in place of the
  current one (`--source url@1.1.11-dev.ab12cd3` or an env the scaffold
  reads; decide in the step), writing the same `overrides` block as 3.1 so a
  dev litestone's `^toolbelt` does not resolve from npm.

## Open questions

- **Q1 — Default destinations.** Ruled `FJS-D1613`, 2026-10-28: **C**,
  tarballs alone; `--to npm` is said on purpose. A was recommended; the owner
  asked what npm is still for, and the honest answer was ranges for
  `bun update` and outsiders — neither in play pre-alpha — against a browser
  2FA round trip per package per release. The repo is public, so a release
  asset is as open as an npm tarball; nothing new leaks.
- **Q2 — The dev channel.** Ruled `FJS-D1602`, 2026-10-28: **A**, against
  the recommendation. `--channel dev`, `<current>-dev.<sha>`, dirty tree
  refused, `--to npm` refused, one rolling release `dev`. The paper's *B until
  Phase 3* served one laptop; the owner's need is a second machine testing
  the latest tree with no npm, and 3.2 deletes that machine's only other road.
  Phase 4 is the build.

## See also

- `deploy-plane.md` § Ring 0 — the distribution problem this is the answer to.
- `git-deploy.md` 1.6 / `FJS-D1560` — who chooses a Dockerfile.
- `FJS-D988` — tarballs are not an upgrade path; this file says what they are.
- `packages/cli/core/vendor.js` — the pack, the stem and the `overrides` hazard.
