// core/deps.js — the third-party packages a root depends on, as declared and
// as installed.
//
// One reader for two callers: `fli ws:deps` renders it as deps.snapshot.md and
// pushes it to Basecamp, which adds what a registry says about each name. The
// root is any directory with a package.json — the framework workspace today,
// an app's root tomorrow — so nothing here knows it is reading FrontierJS.
//
// DECLARED is each member's package.json and INSTALLED is bun.lock. Both are
// read rather than only the lock's own `workspaces` copy of the manifests,
// because the lock's copy is the manifest as of the last install: a range
// edited and never installed is the drift this exists to show.
//
// What a registry says — the latest version, an advisory — is absent on
// purpose. It changes daily with no commit, and a committed file that goes
// stale overnight fails CI for nothing.

import { existsSync, readFileSync } from 'fs'
import { join, resolve }            from 'path'

export const DEP_KINDS = [
  ['dependencies',         'dependency'],
  ['devDependencies',      'dev'],
  ['peerDependencies',     'peer'],
  ['optionalDependencies', 'optional'],
]

const readJson = (file) => {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
}

// bun.lock is JSONC — trailing commas — which JSON.parse refuses.
const readLock = (root) => {
  const file = join(root, 'bun.lock')
  if (!existsSync(file)) return null
  try { return Bun.JSONC.parse(readFileSync(file, 'utf8')) } catch { return null }
}

// A lock entry is `["vite@8.3.2", …]`; a scoped name has a leading `@` of its
// own, so the version is after the LAST one.
const lockVersion = (entry) => {
  const spec = Array.isArray(entry) ? entry[0] : null
  if (typeof spec !== 'string') return null
  const at = spec.lastIndexOf('@')
  return at > 0 ? spec.slice(at + 1) : null
}

// A member that needs a version of its own gets a nested entry keyed
// `<member>/<dep>`; everything else resolves to the hoisted `<dep>`.
const installedFor = (lock, memberName, dep) => {
  const pkgs = lock?.packages ?? {}
  return lockVersion(pkgs[`${memberName}/${dep}`]) ?? lockVersion(pkgs[dep])
}

// Internal to the root, not a dependency of it: a sibling member, and anything
// resolved through the workspace or the filesystem rather than a registry.
const isInternal = (range, memberNames, name) =>
  memberNames.has(name) || /^(workspace|link|file|portal):/.test(String(range))

// ─── collectDeps ──────────────────────────────────────────────────────────────
//
//   collectDeps(root) → {
//     root, name,
//     members: [{ path, name, version, private }],
//     uses:    [{ name, member, kind, range, installed }],   sorted
//     deps:    [{ name, installed: [...], ranges: [...], uses: [...] }],
//   }
//
// Members come from the lock's `workspaces` keys (`""` is the root), so a
// nested app the root's globs name is a member exactly when bun installed it.
// No lock means one member, the root.

export function collectDeps(root) {
  root = resolve(root)
  const rootPkg = readJson(join(root, 'package.json'))
  if (!rootPkg) throw new Error(`No package.json at ${root}`)

  const lock  = readLock(root)
  const paths = lock?.workspaces ? Object.keys(lock.workspaces) : ['']

  const members = paths
    .map(path => {
      const pkg = path === '' ? rootPkg : readJson(join(root, path, 'package.json'))
      return pkg && { path, pkg }
    })
    .filter(Boolean)

  const memberNames = new Set(members.map(m => m.pkg.name).filter(Boolean))
  const uses = []

  for (const { path, pkg } of members) {
    for (const [field, kind] of DEP_KINDS) {
      for (const [name, range] of Object.entries(pkg[field] ?? {})) {
        if (isInternal(range, memberNames, name)) continue
        uses.push({
          name,
          member:    pkg.name ?? (path || '(root)'),
          kind,
          range:     String(range),
          installed: lock ? installedFor(lock, pkg.name, name) : null,
        })
      }
    }
  }

  uses.sort((a, b) =>
    a.name.localeCompare(b.name) || a.member.localeCompare(b.member) || a.kind.localeCompare(b.kind))

  const byName = new Map()
  for (const u of uses) {
    if (!byName.has(u.name)) byName.set(u.name, [])
    byName.get(u.name).push(u)
  }

  const deps = [...byName].map(([name, list]) => ({
    name,
    installed: [...new Set(list.map(u => u.installed).filter(Boolean))].sort(),
    ranges:    [...new Set(list.map(u => u.range))].sort(),
    uses:      list,
  }))

  return {
    root,
    name: rootPkg.name ?? null,
    members: members
      .map(({ path, pkg }) => ({ path, name: pkg.name ?? null, version: pkg.version ?? null, private: !!pkg.private }))
      .sort((a, b) => a.path.localeCompare(b.path)),
    uses,
    deps,
  }
}

// ─── depsFindings ─────────────────────────────────────────────────────────────
//
// What is decidable without a registry. Two installed copies of one name is two
// trees in one bundle; two ranges is a disagreement about what the name means;
// a declared name with no lock entry was never installed.
//
// A peer range is left out of the range comparison. It states what a CONSUMER
// may bring, so `>=5.0.0` beside the workspace's own `^5.9.3` is the design and
// not a disagreement.

export function depsFindings(report) {
  const out = []
  for (const d of report.deps) {
    const ranges = [...new Set(d.uses.filter(u => u.kind !== 'peer').map(u => u.range))].sort()
    if (d.installed.length > 1) out.push({ kind: 'copies', name: d.name, detail: d.installed.join(' · ') })
    if (ranges.length > 1)      out.push({ kind: 'ranges', name: d.name, detail: ranges.join(' · ') })
    for (const u of d.uses.filter(u => !u.installed && u.kind !== 'peer' && u.kind !== 'optional')) {
      out.push({ kind: 'missing', name: d.name, detail: `${u.member} (${u.kind} ${u.range})` })
    }
  }
  return out
}

// ─── depsPayload ──────────────────────────────────────────────────────────────
// The push body Basecamp's `dependencies.ingest` takes. `root` is a path on
// this machine and stays here.

export const depsPayload = (report, extra = {}) => ({
  name:    report.name,
  members: report.members,
  uses:    report.uses,
  ...extra,
})

// ─── renderDepsSnapshot ───────────────────────────────────────────────────────

const FINDING_LABEL = {
  copies:  'More than one installed copy',
  ranges:  'Declared with different ranges',
  missing: 'Declared, not installed',
}

export function renderDepsSnapshot(report, { command = 'fli ws:deps' } = {}) {
  const findings = depsFindings(report)
  const out = []

  out.push('# Dependency snapshot')
  out.push('')
  out.push(`<!-- generated by: ${command} -->`)
  out.push('')
  out.push(`Generated by \`${command}\`. **Do not edit.**`)
  out.push('')
  out.push('Every third-party package a member declares, the range it declares, and the')
  out.push('version `bun.lock` installed. Workspace siblings are not dependencies and are')
  out.push('left out. The latest version and any advisory are NOT here: they change with')
  out.push('no commit, so they live in Basecamp, which `fli ws:deps --push` feeds.')
  out.push('')
  out.push('```')
  out.push(`${report.deps.length} package(s) · ${report.uses.length} declaration(s) · ${report.members.length} member(s) · ${findings.length} finding(s)`)
  out.push('```')
  out.push('')

  out.push('## Findings')
  out.push('')
  if (findings.length) {
    for (const f of findings) out.push(`- **${FINDING_LABEL[f.kind]}** — \`${f.name}\`: ${f.detail}`)
  } else {
    out.push('None — one installed copy and one range per package, and every declaration installed.')
  }
  out.push('')

  out.push('## Packages')
  out.push('')
  out.push('| Package | Installed | Declared by |')
  out.push('| --- | --- | --- |')
  for (const d of report.deps) {
    const installed = d.installed.length ? d.installed.map(v => `\`${v}\``).join(' · ') : '—'
    const by = d.uses.map(u => `${u.member} ${u.kind === 'dependency' ? '' : `(${u.kind}) `}\`${u.range}\``).join('<br>')
    out.push(`| \`${d.name}\` | ${installed} | ${by} |`)
  }

  return out.join('\n') + '\n'
}
