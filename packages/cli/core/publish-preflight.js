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
 * Packages in the release whose working tree has uncommitted files.
 *
 * `npm publish` packs the WORKING DIRECTORY and not the commit, so a dirty tree
 * ships whatever is sitting there under a git tag whose tree does not contain
 * it — and the tag is then a lie about what people installed.
 *
 * @param planned  [{ name, dir }]
 * @param stateOf  (name, dir) => { dirty, files }   — `context.git.pkgState`
 */
export function dirtyPackages(planned = [], stateOf = () => ({})) {
  const out = []
  for (const p of planned) {
    const state = stateOf(p.name, p.dir) ?? {}
    if (state.dirty) out.push({ name: p.name, files: state.files ?? [] })
  }
  return out
}

/**
 * Peer ranges this release would step outside of.
 *
 * Read across every workspace member rather than the release set alone: the
 * package that BREAKS is the one declaring the peer, and it is usually not one
 * of the packages being bumped.
 *
 * Nothing in the publish path has ever read `peerDependencies`, and nothing
 * inside the workspace can notice: a `workspace:*` devDependency answers first,
 * so the range is never consulted until somebody installs from the registry.
 *
 * @param members  [{ name, pkg }]  every workspace member, published or not
 * @param planned  [{ name, newVersion }]
 */
export function peerDrift(members = [], planned = []) {
  const moving = new Map(planned.map(p => [p.name, p.newVersion]))
  const out    = []

  for (const m of members) {
    for (const [dep, range] of Object.entries(m.pkg?.peerDependencies ?? {})) {
      if (!moving.has(dep)) continue
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
export function publishRefusals({ dirty = [], drift = [], cycles = [], force = {} } = {}) {
  const out = []

  if (dirty.length && !force.dirty) {
    const total = dirty.reduce((n, d) => n + d.files.length, 0)
    out.push({
      check:   'dirty-tree',
      message: `${total} uncommitted file(s) in ${dirty.length} package(s) being published: ${dirty.map(d => d.name).join(', ')}`,
      // The reason rather than the rule — somebody reading this at a terminal
      // needs to know why a clean tree is not merely tidy.
      because:  'npm packs the working directory, not the commit, so these files ship under a tag whose tree does not contain them',
      fix:      'commit or stash them',
      override: '--allow-dirty',
      detail:   dirty.flatMap(d => d.files.slice(0, 5).map(f => `${d.name}  ${f}`)),
    })
  }

  const excluded = drift.filter(d => d.kind === 'excluded')
  if (excluded.length && !force.peers) {
    out.push({
      check:   'peer-range',
      message: `${excluded.length} peer range(s) would no longer resolve`,
      because: 'a caret below 1.0 pins the minor, and nothing in the publish path rewrites a peer range',
      fix:     'bump `patch`, or move the ranges in the same commit',
      override: '--allow-peer-drift',
      detail:  excluded.map(d => `${d.by} peers ${d.dep} ${d.range} — this release makes it ${d.version}`),
    })
  }

  const unsure = drift.filter(d => d.kind === 'undecidable')
  if (unsure.length && !force.peers) {
    out.push({
      check:   'peer-range-undecidable',
      message: `${unsure.length} peer range(s) could not be decided`,
      // Refused rather than passed. A check that cannot tell and says nothing
      // is indistinguishable from one that checked and approved.
      because: 'this is not a full semver implementation, deliberately — it decides exact, caret and tilde, and refuses to guess at the rest',
      fix:     'state the range as an exact, caret or tilde version, or check it by hand',
      override: '--allow-peer-drift',
      detail:  unsure.map(d => `${d.by} peers ${d.dep} ${d.range} — this release makes it ${d.version}`),
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
