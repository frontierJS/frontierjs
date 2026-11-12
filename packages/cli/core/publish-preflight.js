// publish-preflight.js — every reason a release must not go to npm, and the
// flag that overrides each.
//
// `npm publish` is close to irreversible: a version number is spent the moment
// it lands, and unpublishing is a 72-hour window with conditions. So this
// refuses by default and each refusal carries its own escape hatch, rather than
// warning and proceeding.
//
// It answers ALL of them rather than the first. An operator deciding whether to
// force needs the whole picture, and a checker that stops at the first refusal
// makes them discover the rest one flag at a time — `core/revert.js` learned
// this on the other pipeline.
//
// Pure: every input is passed in, so the whole set is testable without a
// registry, a git tree or a network.

// ─── version ranges ──────────────────────────────────────────────────────────

/**
 * Does `version` satisfy `range` — true, false, or NULL for *cannot tell*.
 *
 * A third answer rather than a guess. This is not a semver implementation and
 * must not become one: it decides the forms this workspace actually declares
 * and says so plainly about the rest, because a range parser that guesses is a
 * release decision made by a regex.
 */
export function satisfiesRange(version, range) {
  const r = String(range ?? '').trim()
  if (!r) return null

  // A workspace protocol spec never reaches a registry — bun rewrites it at
  // pack time — so it constrains nothing here.
  if (r === '*' || r === 'latest' || r.startsWith('workspace:')) return true

  const v = parseVersion(version)
  if (!v) return null

  const exact = parseVersion(r)
  if (exact) return sameVersion(v, exact)

  const caret = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(r)
  if (caret) {
    const [, maj, min, pat] = caret.map(Number)
    // Below 1.0 a caret pins the MINOR, and below 0.1 it pins the patch. That
    // is the whole trap: `^0.1.0` excludes 0.2.0, so a minor bump of a package
    // three others peer on breaks every one of them at install, silently.
    if (maj > 0) return v.major === maj && gte(v, { major: maj, minor: min, patch: pat })
    if (min > 0) return v.major === 0 && v.minor === min && v.patch >= pat
    return v.major === 0 && v.minor === 0 && v.patch === pat
  }

  const tilde = /^~(\d+)\.(\d+)\.(\d+)$/.exec(r)
  if (tilde) {
    const [, maj, min, pat] = tilde.map(Number)
    return v.major === maj && v.minor === min && v.patch >= pat
  }

  return null
}

function parseVersion(s) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(s ?? '').trim())
  return m ? { major: +m[1], minor: +m[2], patch: +m[3] } : null
}

const sameVersion = (a, b) => a.major === b.major && a.minor === b.minor && a.patch === b.patch

const gte = (a, b) =>
  a.major !== b.major ? a.major > b.major
  : a.minor !== b.minor ? a.minor > b.minor
  : a.patch >= b.patch

// ─── the checks ──────────────────────────────────────────────────────────────

/**
 * Sibling ranges this release would step outside of.
 *
 * Read across every workspace member rather than the release set alone: the
 * package that BREAKS is the one declaring the range, and it is usually not one
 * of the packages being bumped.
 *
 * Nothing inside the workspace can notice: a `workspace:*` devDependency
 * answers first, so the range is never consulted until somebody installs from
 * the registry. A hand-typed range in `dependencies` ships just as stale as a
 * peer one (`FJS-3349`); a `workspace:`, `file:` or `link:` spec is rewritten
 * or resolved by the packer and is not a range.
 *
 * @param members  [{ name, pkg }]  every workspace member, published or not
 * @param planned  [{ name, newVersion }]
 */
export function peerDrift(members = [], planned = []) {
  const moving = new Map(planned.map(p => [p.name, p.newVersion]))
  const out    = []

  for (const m of members) {
    const ranges = { ...m.pkg?.optionalDependencies, ...m.pkg?.dependencies, ...m.pkg?.peerDependencies }
    for (const [dep, range] of Object.entries(ranges)) {
      if (!moving.has(dep) || /^[a-z]+:/.test(range)) continue
      const version = moving.get(dep)
      const ok      = satisfiesRange(version, range)
      // `null` is reported, not skipped. A range this cannot decide is the one
      // case where staying quiet would be indistinguishable from a pass.
      if (ok === false) out.push({ kind: 'excluded',    by: m.name, dep, range, version })
      else if (ok === null) out.push({ kind: 'undecidable', by: m.name, dep, range, version })
    }
  }
  return out
}

/**
 * `workspace:` dependencies of the release set that are not in it and whose
 * tree has moved past their own tag.
 *
 * bun rewrites `workspace:*` to the sibling's version number as it stands, and a
 * version number says nothing about the commits made under it since it was
 * tagged. So the package published here imports code no published copy of the
 * sibling holds, and it fails at its first import on an installed machine
 * (`FJS-3534`: outpost 0.1.6 against litestone 1.1.10, 62 files later). The
 * dependency has to go first, as a new version. devDependencies are dropped by
 * the packer and never reach an install.
 *
 * @param planned  [{ name, pkg }]
 * @param members  [{ name, dir, pkg }]  every workspace member
 * Uncommitted files are not movement: the pack reads the release commit, so
 * an edit in the main tree reaches no tarball on either side. Nor is a commit
 * that touches only what the packer leaves out: a release commit regenerates
 * `docs/*.snapshot.md`, and counting it refused the next release of every
 * dependent (`FJS-4251`).
 *
 * @param stateOf  (name, dir, paths) => { lastTag, commits }   — `context.git.pkgState`
 */
/**
 * The pathspecs, relative to the package directory, whose bytes reach its
 * tarball: `files` (a negation only removes, so it is dropped and the answer
 * stays a superset) plus what npm packs whatever `files` says. No `files`
 * packs the whole directory.
 */
export function packedPaths(pkg = {}) {
  if (!Array.isArray(pkg.files)) return ['.']
  const bin = typeof pkg.bin === 'string' ? [pkg.bin] : Object.values(pkg.bin ?? {})
  const always = ['package.json', ...(pkg.main ? [pkg.main] : []), ...bin]
  const paths  = [...pkg.files.filter(f => typeof f === 'string' && !f.startsWith('!')), ...always]
  return [...new Set(paths.map(f => f.replace(/^\.\//, '')))]
}

export function movedDependencies(planned = [], members = [], stateOf = () => ({})) {
  const releasing = new Set(planned.map(p => p.name))
  const byName    = new Map(members.map(m => [m.name, m]))
  const states    = new Map()
  const out       = []

  for (const p of planned) {
    const deps = { ...p.pkg?.optionalDependencies, ...p.pkg?.dependencies, ...p.pkg?.peerDependencies }
    for (const [dep, spec] of Object.entries(deps)) {
      const m = byName.get(dep)
      if (!m || releasing.has(dep) || !String(spec).startsWith('workspace:')) continue
      if (!states.has(dep)) states.set(dep, stateOf(dep, m.dir, packedPaths(m.pkg)) ?? {})
      const s = states.get(dep)
      const commits = s.commits?.length ?? 0
      if (s.lastTag && !commits) continue
      out.push({ by: p.name, dep, version: m.pkg?.version ?? null, tag: s.lastTag || null, commits })
    }
  }
  return out
}

/**
 * The exact sibling versions each tarball will pin, as `bun pm pack` writes
 * them from the commit it packs.
 *
 * `workspace:*` becomes the sibling's version ON THAT COMMIT, and a release in
 * flight is packed from its tag, so the pin can name a version the working tree
 * left behind and the registry never received (`FJS-4044`: ui@0.1.10 pinned
 * toolbelt 0.1.9 while the run shipped toolbelt 0.1.10). A range is not a pin and
 * is `peerDrift`'s question; devDependencies are dropped by the packer.
 *
 * @param shipping  [{ name, version, pkg, siblings }] -- `pkg` is the manifest
 *                  packed, `siblings` a Map name → manifest on the same commit
 * @returns [{ by, dep, version }]
 */
export function siblingPins(shipping = []) {
  const out = []
  for (const s of shipping) {
    const deps = { ...s.pkg?.optionalDependencies, ...s.pkg?.dependencies, ...s.pkg?.peerDependencies }
    for (const [dep, spec] of Object.entries(deps)) {
      const sibling = s.siblings?.get(dep)
      if (!sibling) continue
      const version = pinnedVersion(spec, sibling.version)
      if (version) out.push({ by: `${s.name}@${s.version}`, dep, version })
    }
  }
  return out
}

/**
 * Members this release leaves out whose published copy pins a sibling it ships.
 *
 * `workspace:*` is written as the sibling's exact version when a package is
 * packed, so a package not in the release keeps the version it was packed with
 * until it is released again. Outpost 0.1.16 kept litestone 1.1.19 after
 * 1.1.20 shipped a fix every fleet machine needed, and nothing said so
 * (`FJS-D2084`). A range (`workspace:^`) resolves to the new one on its own.
 */
export function pinsLeftBehind(members = [], planned = []) {
  const moving = new Map(planned.map(p => [p.name, p]))
  const out    = []
  for (const m of members) {
    if (moving.has(m.name) || m.pkg?.private) continue
    const deps = { ...m.pkg?.optionalDependencies, ...m.pkg?.dependencies }
    for (const [dep, spec] of Object.entries(deps)) {
      const p = moving.get(dep)
      if (!p || !/^workspace:\*?$/.test(String(spec).trim())) continue
      out.push({ by: m.name, dep, to: p.newVersion })
    }
  }
  return out
}

function pinnedVersion(spec, siblingVersion) {
  const s = String(spec ?? '').trim()
  const w = s.startsWith('workspace:') ? s.slice('workspace:'.length) : null
  const exact = w === '*' || w === '' ? String(siblingVersion ?? '') : (w ?? s)
  return parseVersion(exact) ? exact.trim() : null
}

/**
 * The pins a destination will not hold once this run is done: neither held
 * already nor received from this run. `held` is the destination's answer per
 * `name@version` -- true, false, or NULL where it could not be asked, which is
 * returned rather than guessed.
 *
 * @param pins      [{ by, dep, version }]  from `siblingPins`
 * @param received  Set of `name@version` this run ships there
 * @param held      Map `name@version` → true | false | null
 */
export function unheldPins(pins = [], received = new Set(), held = new Map()) {
  return pins
    .filter(p => !received.has(`${p.dep}@${p.version}`) && held.get(`${p.dep}@${p.version}`) !== true)
    .map(p => ({ ...p, held: held.get(`${p.dep}@${p.version}`) ?? null }))
}

/**
 * The release set, ordered so a package is published after everything it
 * depends on.
 *
 * Not a refusal — an ordering. A dependency published second resolves for
 * nobody in the window between the two, and the window is as long as a
 * registry takes to serve a new version.
 *
 * Derived from the manifests rather than declared, so it cannot go stale. A
 * cycle is answered rather than thrown: it is reported and the input order is
 * kept for the packages in it, because refusing to publish over a devDependency
 * cycle would refuse most real workspaces.
 */
export function publishOrder(planned = []) {
  const inSet = new Map(planned.map(p => [p.name, p]))
  const deps  = (p) => Object.keys({ ...(p.pkg?.dependencies ?? {}), ...(p.pkg?.peerDependencies ?? {}) })
                        .filter(d => inSet.has(d) && d !== p.name)

  const done = new Set(), out = [], cycles = []
  const walk = (p, seen) => {
    if (done.has(p.name)) return
    if (seen.has(p.name)) { cycles.push([...seen, p.name]); return }
    seen.add(p.name)
    for (const d of deps(p)) walk(inSet.get(d), seen)
    seen.delete(p.name)
    if (!done.has(p.name)) { done.add(p.name); out.push(p) }
  }
  for (const p of planned) walk(p, new Set())
  return { order: out, cycles }
}

// ─── the verdict ─────────────────────────────────────────────────────────────

/**
 * Every reason this release must not proceed, each with the flag that overrides
 * it. All of them, never the first.
 *
 * A refusal carries `fix` and `override` separately on purpose: the fix is what
 * an operator should usually do, and the override is what is available when
 * they know better. Printing only the override teaches everyone to reach for it.
 */
export function publishRefusals({ drift = [], moved = [], unheld = [], cycles = [], heldBack = [], leftBehind = [], force = {} } = {}) {
  const out = []

  if (unheld.length) {
    // No override: every install of the tarball fails resolving the pin, and
    // the npm versions spent before anyone notices cannot be taken back.
    const missing = [...new Set(unheld.map(u => `${u.dep}@${u.version}`))]
    out.push({
      check:   'pin-not-on-npm',
      message: `${missing.length} exact sibling pin(s) name a version npm does not hold and this run does not publish: ${missing.join(', ')}`,
      because: 'bun pm pack writes workspace:* as the version on the commit it packs, and a release in flight packs its tag',
      fix:     'publish each named version to npm first -- `gh release download <name>@<version>` then `npm publish <tgz>` -- and run again',
      override: null,
      detail:  unheld.map(u => `${u.by} pins ${u.dep} ${u.version}${u.held === null ? ' -- npm could not say whether it holds it' : ''}`),
    })
  }

  if (moved.length) {
    // No override: what it would ship is a package that fails at its first
    // import, and the fix costs one more name on the command line.
    const deps = [...new Set(moved.map(m => m.dep))]
    out.push({
      check:   'workspace-dep-moved',
      message: `${deps.length} workspace dependenc${deps.length === 1 ? 'y has' : 'ies have'} moved past ${deps.length === 1 ? 'its' : 'their'} published tag and ${deps.length === 1 ? 'is' : 'are'} not in this release: ${deps.join(', ')}`,
      because: 'bun pins workspace:* to the version number as it stands, so the package published here imports code no published copy of that dependency holds',
      fix:     'publish the dependency first, as a new version — add it to --filter, or run without one',
      override: null,
      detail:  moved.map(m => `${m.by} → ${m.dep} ${m.version ?? '?'}: ${m.tag
        ? `${m.commits} commit(s) since ${m.tag}`
        : 'never tagged'}`),
    })
  }

  const excluded = drift.filter(d => d.kind === 'excluded')
  if (excluded.length && !force.peers) {
    out.push({
      check:   'peer-range',
      message: `${excluded.length} sibling range(s) would no longer resolve`,
      because: 'a caret below 1.0 pins the minor, and nothing in the publish path rewrites a hand-typed range',
      fix:     'bump `patch`, or move the ranges in the same commit',
      override: '--allow-peer-drift',
      detail:  excluded.map(d => `${d.by} wants ${d.dep} ${d.range} — this release makes it ${d.version}`),
    })
  }

  const unsure = drift.filter(d => d.kind === 'undecidable')
  if (unsure.length && !force.peers) {
    out.push({
      check:   'peer-range-undecidable',
      message: `${unsure.length} sibling range(s) could not be decided`,
      // Refused rather than passed. A check that cannot tell and says nothing
      // is indistinguishable from one that checked and approved.
      because: 'this is not a full semver implementation, deliberately — it decides exact, caret and tilde, and refuses to guess at the rest',
      fix:     'state the range as an exact, caret or tilde version, or check it by hand',
      override: '--allow-peer-drift',
      detail:  unsure.map(d => `${d.by} wants ${d.dep} ${d.range} — this release makes it ${d.version}`),
    })
  }

  if (leftBehind.length) {
    // A note: the release is right as it stands, and a dependent often has no
    // reason to move. Where it does, the run after this one is the fix.
    const by = [...new Set(leftBehind.map(l => l.by))]
    out.push({
      check:    'pins-left-behind',
      note:     true,
      message:  `${by.length} package(s) not in this release pin a sibling it ships, and their published copies keep the old version: ${by.join(', ')}`,
      because:  'bun packs workspace:* as the exact version, so a dependent picks up the new one only when it is released itself',
      fix:      `where one needs it, after this run: ${by.map(b => `fli ws:pub patch --filter ${b.replace(/^@[^/]+\//, '')} --all`).join(' · ')}`,
      override: null,
      detail:   leftBehind.map(l => `${l.by} pins ${l.dep} exactly — this release ships ${l.to}`),
    })
  }

  if (cycles.length) {
    // A note rather than a refusal: the order is still published, and most real
    // cycles are through devDependencies that no install ever walks.
    out.push({
      check:    'dependency-cycle',
      note:     true,
      message:  `${cycles.length} dependency cycle(s) in the release set — publish order within them is the order you gave`,
      because:  'a cycle has no first package, so nothing here can put one before the other',
      fix:      'publish them in two runs if the order matters',
      override: null,
      detail:   cycles.map(c => c.join(' → ')),
    })
  }

  if (heldBack.length) {
    // A note: the release is the event that makes the site's reason false, and
    // the site's own staleness check cannot see a registry, so nothing else
    // notices that a package just became installable and is still undescribed.
    out.push({
      check:    'website-held-back',
      note:     true,
      message:  `${heldBack.length} package(s) in this release are held back from the website: ${heldBack.map(h => h.name).join(', ')}`,
      because:  'the website names each package it does not describe with a reason, and a first release is what makes that reason stale',
      fix:      'after publishing, delete the HELD_BACK entry in website/site/content/data/packages.js and describe the package in website/packages.js',
      override: null,
      detail:   heldBack.map(h => `${h.name} — ${h.reason}`),
    })
  }

  return out
}

/** The refusals as a person reads them. Returns lines; the caller prints. */
export function formatRefusals(refusals = []) {
  const lines = []
  const hard  = refusals.filter(r => !r.note)

  lines.push('')
  lines.push(hard.length
    ? `Not publishable — ${hard.length} refusal(s)`
    : 'Publishable, with notes')
  lines.push('')

  for (const r of refusals) {
    lines.push(`  ${r.note ? 'note' : '✗'}  ${r.check}`)
    lines.push(`      ${r.message}`)
    lines.push(`      ${r.because}`)
    for (const d of r.detail ?? []) lines.push(`        ${d}`)
    lines.push(r.override
      ? `      fix: ${r.fix}   ·   override: ${r.override}`
      : `      fix: ${r.fix}`)
    lines.push('')
  }
  return lines
}

// ─── a release in flight ─────────────────────────────────────────────────────

/**
 * The packages a release VERSIONED and never published: the `<name>@<version>`
 * tag is written and the registry does not hold that version.
 *
 * The state a lapsed npm session leaves. Every package then has no commits
 * since its own tag, so the affected filter reads the release as finished and
 * the run says *nothing to publish* — and a bump over it skips that version for
 * good. A package with no tag at its version is never pending: that is an
 * ordinary release, a first one included, and it goes through the bump.
 *
 * `published` is the registry's answer, NULL where it could not be asked. An
 * unknown is returned rather than guessed, because a guess of *published* bumps
 * over a version nobody installed and a guess of *not* republishes one.
 *
 * A pending package with commits since its tag is packed from the TAG's
 * checkout, so those commits cannot reach the tarball. Where the remote holds
 * the tag it is public already and is simply shipped (`fromTag`, `FJS-D1722`).
 * Where only this clone holds it, it is `moved`: that tag was never public and
 * its sha is usually the commit the pre-push hook refused, so shipping from it
 * would publish the bytes the hook turned away (`FJS-D1725`).
 *
 * @param members  [{ name, version, tagged, published, moved, pushed }] --
 *                 `pushed` is whether the remote holds the tag: true, false, or
 *                 NULL where it could not be asked, which reads as not held
 */
export function unpublished(members = []) {
  const pending = []
  const unknown = []
  const moved   = []
  const fromTag = []
  for (const m of members) {
    if (!m.tagged) continue
    if (m.published === null || m.published === undefined) unknown.push(m.name)
    else if (m.published) continue
    else if (!m.moved) pending.push(m.name)
    else if (m.pushed === true) { pending.push(m.name); fromTag.push(m.name) }
    else moved.push(m.name)
  }
  return { pending, unknown, moved, fromTag }
}

/**
 * The packages whose manifest holds a bumped version that was never tagged and
 * that no destination holds: a release whose CI gate failed before the tag was
 * written. Nothing public names that version, so the next run tags HEAD once it
 * passes rather than bumping over it (`FJS-D1720`).
 *
 * A package with no tag at all is a first release and goes through the bump, and
 * a version at or below its last tag is not a bump, so neither is listed.
 *
 * @param members  [{ name, version, lastTagVersion, tagged, none }] -- `none` is
 *                 true only when every destination answered and holds nothing
 */
export function untaggedBumps(members = []) {
  return members.filter(m => {
    if (m.tagged || !m.none || !m.lastTagVersion) return false
    const now = parseVersion(m.version), last = parseVersion(m.lastTagVersion)
    return Boolean(now && last && gte(now, last) && !sameVersion(now, last))
  }).map(m => m.name)
}

// ─── selecting packages ──────────────────────────────────────────────────────

/**
 * Does a package answer to one of the selectors a person typed?
 *
 * `--filter` and `--except` are the same question asked in two directions, so
 * they share the rule rather than each carrying a copy — two implementations
 * would drift the first time one learned about scopes and the other did not.
 *
 * Substring against the full name and the folder, which is what makes `outpost`
 * find `@frontierjs/outpost`.
 */
export function matchesSelector(pkg = {}, folder = '', selectors = []) {
  const list = (Array.isArray(selectors) ? selectors : [selectors]).filter(Boolean)
  if (!list.length) return false
  const name = String(pkg.name ?? '')
  return list.some(s => name.includes(s) || String(folder).includes(s))
}

// ─── the scaffold's pins ─────────────────────────────────────────────────────

/**
 * `core/app-config.js` with its exact pins moved to the versions this release
 * publishes.
 *
 * `fli new` installs exact versions out of a table in the cli's own source
 * (`FJS-2973`), so a cli published with the last release's table scaffolds the
 * last release's framework under this release's templates — cli 0.1.8 wrote a
 * bare `@@gate(8)` into an app pinned to a litestone that refused it
 * (`FJS-3356`). Only an exact pin on a name in `versions` moves; a range is
 * somebody's choice.
 *
 * @param source    the file's text
 * @param versions  Map name → version
 * @returns { text, moved: [{ name, from, to }] }
 */
export function writePins(source, versions) {
  const moved = []
  const text  = String(source).replace(/^(\s*'([^']+)':\s*)'(\d+\.\d+\.\d+)'/gm, (line, head, name, from) => {
    const to = versions.get(name)
    if (!to || to === from) return line
    moved.push({ name, from, to })
    return `${head}'${to}'`
  })
  return { text, moved }
}
