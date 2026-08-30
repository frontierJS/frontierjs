---
title: release:mint
description: Compute the Release this tree would deploy — content-addressed, and writes nothing
alias: mint
examples:
  - fli release:mint
  - fli release:mint --production
  - fli release:mint --json
  - fli release:mint --digest sha256:abc123
flags:
  production:
    type: boolean
    description: Mint for production (overrides branch detection)
    defaultValue: false
  stage:
    type: boolean
    description: Mint for stage
    defaultValue: false
  digest:
    char: d
    type: string
    description: The image digest, where one has been built
    defaultValue: ''
  json:
    char: j
    type: boolean
    description: Emit the Release as JSON
    defaultValue: false
---

```js
// Reached through `global.fliRoot`, not by relative path: a command is compiled
// into a shim somewhere else, so `../../core` resolves against the shim and not
// against this file. Same idiom as deploy/_module.md.
const core = (name) => import(new URL('file://' + global.fliRoot + '/core/' + name))

const { loadFrontierConfig } = await core('utils.js')
const { bindingSet, schemaSurfaceHash, mintRelease, formatRelease, BindingError } =
  await core('release.js')

// ─── target ──────────────────────────────────────────────────────────────────
// The same resolution `fli deploy` uses, so a Release is minted for the
// environment it would be deployed to and not for a different one.
const branch = context.git.branch?.() ?? ''
const target = flag.production ? 'production'
             : flag.stage      ? 'stage'
             : /^(stage|staging)$/.test(branch) ? 'stage'
             : 'dev'

const frontierConfig = await loadFrontierConfig(context.paths.root)
const deployConf     = frontierConfig?.deploy

if (!deployConf) {
  log.error('No deploy block in frontier.config.js — there is no Environment to bind against')
  log.info('Run `fli make:deploy` to write one')
  return
}

// ─── the four terms ──────────────────────────────────────────────────────────
let bindings
try {
  bindings = bindingSet(deployConf, target)
} catch (e) {
  if (!(e instanceof BindingError)) throw e
  log.error(e.message)
  return
}

const schema = schemaSurfaceHash(context.paths.db)
if (schema.missing) {
  // Not fatal: an app may legitimately have no schema. It is stated because a
  // Release with no data boundary in its id is a weaker claim than one with,
  // and silence would make the two look alike.
  log.warn(`No release surface at ${schema.missing} — minting without a schema term`)
  log.info('`fli release:check` writes it')
}

// The pivot is litestone's answer, asked rather than re-derived — the same
// walk `fli release:check` prints. A tree with no baseline to compare against
// answers unknown, which is the fail-closed direction.
let pivot = 'unknown', findings = []
if (!schema.missing) {
  // `stdio: 'pipe'` and not `capture: true` — exec spreads its options into
  // execSync, whose default is `stdio: 'inherit'`, so an unknown key leaves the
  // output on the terminal and returns null.
  //
  // `--json` alone: it emits the VERDICT and writes nothing. Adding `--stdout`
  // prints the surface instead, which parses as JSON and is the wrong document.
  const out = context.exec({
    command: `cd ${context.paths.root} && bunx litestone release --schema ${context.paths.db}/schema.lite --json`,
    stdio:   'pipe',
  })
  try {
    const verdict = JSON.parse(String(out ?? '').trim())
    pivot    = verdict.verdict   ?? 'unknown'
    findings = verdict.findings  ?? []
  } catch {
    log.warn('Could not read a pivot verdict — minting as unknown, which counts as a contract')
  }
}

// ─── the Release ─────────────────────────────────────────────────────────────
const release = mintRelease({
  app:           deployConf.app_id ?? deployConf.appId,
  environment:   target,
  digest:        flag.digest || null,
  bindingsHash:  bindings.hash,
  schemaHash:    schema.hash,
  pivot,
  pivotFindings: findings,
  createdBy:     context.git.user?.() ?? null,
})

if (flag.json) {
  console.log(JSON.stringify({ ...release, bindings: { values: bindings.values, secretRefs: bindings.secretRefs } }, null, 2))
  return
}

console.log()
console.log(formatRelease(release, { bindings }))
console.log()
```

## What this does, and what it deliberately does not

It **computes** a Release and prints it. It writes no journal, starts nothing
and deploys nothing.

That is not a stub. A Release id is the hash of its own terms, so minting is a
pure function of the tree and the bindings — the same tree mints the same id on
a laptop, in CI and on the target. *Build once, promote a digest* is only a
sentence you can say if the thing being promoted has a name that does not depend
on who computed it, and this is that name.

The journal is a different question. It lives on the target
(`packages/cli/db/deploy.lite`) and a Release is **recorded** there when a
transition begins. Minting from a machine that cannot reach the target is the
normal case, not an edge one.

## The four terms

| Term | What it is | Where it comes from |
| --- | --- | --- |
| `digest` | the bytes | `--digest`, or absent |
| `bindingsHash` | the configuration **as declared** | `deploy.bindings` + `deploy.secrets` |
| `schemaHash` | the data boundary | `db/release.snapshot.md`, hashed |
| `pivot` | can N-1 still serve | `litestone release --json` |

**The environment is not in the id.** One artefact promotes from staging to
production unchanged and only its bindings differ, so the environment is on the
row and the bindings are in the hash.

**`bindingsHash` covers a DECLARATION and not the running configuration.** `fli`
writes no `.env` on a target — the operator owns that file, and the container is
started with `--env-file` against it — so nothing under `deploy.bindings` is
applied by a deploy. What the hash and the generation are for is the question a
revert asks: *has the configuration been changed since the release I am going
back to*, which is why `fli deploy:revert` refuses rather than putting old code
onto today's config. Reading the hash as *what the process is running on* is
[`FJS-585`](../../../../ISSUES.md#fjs-585); `01b-env-check` is what turns the
declaration into something the target is actually graded against.

**The digest is absent unless one is passed.** `fli deploy` records what it
built — `core/image.js` asks the daemon and keeps the registry digest where one
exists and the image id otherwise — and `--digest` is how that reaches a mint.
Until an image has been pushed, the honest answer identifies bytes **on one
host** and not across them, which is why the pipeline prints the scope beside
the digest rather than the digest alone. Building centrally and promoting one
digest between environments is the rest of `2.3f`.

A Release with no digest says *not built* rather than showing a tag as though it
were an identity: two servers at one commit hold two images with the same name
and different bytes.

## Bindings

```json5
deploy: {
  bindings: { LOG_LEVEL: 'info' },          // values, committed
  secrets:  { DB_KEY: 'shop-db-key@3' },    // references, pinned

  production: {
    bindings: { LOG_LEVEL: 'warn' },        // per-target beats app-wide
  },
}
```

**Values are committed and secrets are references — never secret values.** They
are two keys rather than one bag because the rule is not a convention to
remember: a value is in the repository and a reference points at something that
is not.

**A reference must name a version, and `latest` is refused.** A secret is
resolved when a process starts, so `latest` means two instances of one immutable
Release hold two different values — the Release is immutable in name only, and
Cloud Run's own documentation says to pin. A rotation moves the binding to a new
pinned version, which is a new generation, which is exactly what a generation is
for.

An app that binds nothing has an empty binding set. That is a set, and it hashes
like any other.
