// ─── git-status — a porcelain listing grouped the way this tree is shaped ────
//
// `git status` answers in ONE flat alphabetical list, which is the wrong axis
// for a monorepo: a hundred paths sorted by their first character interleaves
// nine packages, six example surfaces and the root registers, and the reader
// has to re-derive the grouping every time. This derives it once.
//
// Two axes, both read off the path alone:
//   ZONE — packages/<pkg>, example/<surface>, website, scripts, IDEAS, root
//   KIND — what the file IS to that zone (schema, snapshot, test, record, …)
//
// Pure: takes the three git readings as strings, returns a model. The command
// renders it; `--json` prints it. No exec here, so it is testable with fixtures.

// ─── zones ────────────────────────────────────────────────────────────────────

// Order matters — first match wins, and `example/db` must beat `example`.
const ZONE_RULES = [
  { re: /^packages\/([^/]+)\//,        name: m => m[1],                 group: 'packages', prefix: m => `packages/${m[1]}/` },
  { re: /^example\/([^/]+)\//,         name: m => `example/${m[1]}`,    group: 'example'  },
  { re: /^example\//,                  name: () => 'example',           group: 'example'  },
  { re: /^website\//,                  name: () => 'website',           group: 'repo'     },
  { re: /^scripts\//,                  name: () => 'scripts',           group: 'repo'     },
  { re: /^IDEAS\//,                    name: () => 'IDEAS',             group: 'repo'     },
  { re: /^\.github\//,                 name: () => '.github',           group: 'repo'     },
  { re: /^\.claude\//,                 name: () => '.claude',           group: 'repo'     },
  { re: /^docs\//,                     name: () => 'docs',              group: 'repo'     },
]

export const zoneOf = (path) => {
  for (const rule of ZONE_RULES) {
    const m = rule.re.exec(path)
    // A place's NAME and its path prefix are not the same string — `litestone`
    // lives at `packages/litestone/`. Trimming by the name alone left every
    // package row printing the prefix it had just been grouped under.
    if (m) return { zone: rule.name(m), group: rule.group, prefix: (rule.prefix ?? (() => `${rule.name(m)}/`))(m) }
  }
  return { zone: '(root)', group: 'repo', prefix: '' }
}

// ─── roles ────────────────────────────────────────────────────────────────────
//
// A role is what the file is FOR, not its extension: `CHANGES.md` and a design
// note are both markdown and are not the same thing to a reader scanning a
// diff. Ordered — a snapshot is generated output before it is anything else.

const RECORDS = new Set(['CHANGES.md', 'DECISIONS.md', 'ISSUES.md', 'CLAUDE.md', 'AGENTS.md', 'README.md', 'PROJECT_STATE.md', 'DRIVES.md', 'HANDOFF.md', 'ARCHITECT.md', 'PHILOSOPHY.md', 'VERIFYING.md'])

const ROLE_RULES = [
  { role: 'snapshot', test: p => /\.snapshot\.[a-z]+$/.test(p) },
  { role: 'schema',   test: p => /\.lite$/.test(p) || /(^|\/)db\//.test(p) },
  { role: 'test',     test: p => /(^|\/)tests?\//.test(p) || /\.(test|spec)\.[a-z]+$/.test(p) || /(^|\/)verify[-.]/.test(p) },
  { role: 'record',   test: p => RECORDS.has(p.split('/').pop()) },
  { role: 'docs',     test: p => /\.(md|mdx)$/.test(p) },
  { role: 'config',   test: p => /(^|\/)config\//.test(p) || /\.config\.[a-z]+$/.test(p) || /(^|\/)(package\.json|tsconfig[^/]*\.json|biome\.json|\.env[^/]*)$/.test(p) },
  { role: 'ui',       test: p => /\.(mesa|css|html)$/.test(p) },
  { role: 'deploy',   test: p => /(^|\/)(deploy|Dockerfile|docker-compose)/.test(p) },
  { role: 'src',      test: () => true },
]

// The print order of roles inside a place. Schema first because everything here
// derives from it, and a `.lite` edit is the one that explains the other rows.
export const ROLE_ORDER = ['schema', 'src', 'ui', 'test', 'config', 'deploy', 'snapshot', 'record', 'docs']

export const roleOf = (path) => ROLE_RULES.find(r => r.test(path)).role

// ─── status codes ─────────────────────────────────────────────────────────────

const STATE = {
  M: { glyph: '~', word: 'modified' },
  A: { glyph: '+', word: 'added'    },
  D: { glyph: '-', word: 'deleted'  },
  R: { glyph: '»', word: 'renamed'  },
  C: { glyph: '»', word: 'copied'   },
  T: { glyph: '~', word: 'retyped'  },
  U: { glyph: '!', word: 'conflict' },
  '?': { glyph: '?', word: 'untracked' },
}

export const stateOf = (code) => STATE[code] ?? { glyph: code, word: code }

// ─── parse ────────────────────────────────────────────────────────────────────
//
// `-z` rather than newline-split: a path with a space is quoted and escaped in
// the default output, so a filename with a quote in it parses as two files.
// A rename carries TWO NUL-terminated fields, the new path then the old.

export const parsePorcelain = (raw) => {
  const parts = raw.split('\0')
  const out = []
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]
    if (!entry) continue
    const index = entry[0]
    const work  = entry[1]
    let path    = entry.slice(3)
    let from    = null
    if (index === 'R' || index === 'C') { from = parts[++i] ?? null }
    out.push({ path, from, index: index === ' ' ? null : index, work: work === ' ' ? null : work })
  }
  return out
}

// `--numstat` answers `added<TAB>deleted<TAB>path`; a binary file answers `-`.
export const parseNumstat = (raw) => {
  const map = new Map()
  for (const line of raw.split('\n')) {
    if (!line) continue
    const [add, del, ...rest] = line.split('\t')
    const path = rest.join('\t')
    if (!path) continue
    const prev = map.get(path) ?? { added: 0, deleted: 0, binary: false }
    if (add === '-') prev.binary = true
    else { prev.added += Number(add) || 0; prev.deleted += Number(del) || 0 }
    map.set(path, prev)
  }
  return map
}

// ─── model ────────────────────────────────────────────────────────────────────

// `blastOf` is a FUNCTION rather than the index itself, so this module stays
// pure: the index is built by `core/blast.js`, which reads the tree and pulls
// in the codegraph. A listing that had to import that to be tested would not be
// testable from fixtures at all.
export const buildStatus = ({ porcelain, unstaged = '', staged = '', branch = null, ahead = 0, behind = 0, blastOf = () => null }) => {
  const files = parsePorcelain(porcelain)
  const churn = parseNumstat(unstaged)
  for (const [path, n] of parseNumstat(staged)) {
    const prev = churn.get(path) ?? { added: 0, deleted: 0, binary: false }
    churn.set(path, { added: prev.added + n.added, deleted: prev.deleted + n.deleted, binary: prev.binary || n.binary })
  }

  const zones = new Map()
  for (const f of files) {
    // An untracked path reports as `??` on both halves; treat it as one state
    // so it does not render as staged AND unstaged at once.
    const untracked = f.index === '?' && f.work === '?'
    const { zone, group, prefix } = zoneOf(f.path)
    const role = roleOf(f.path)
    const n = churn.get(f.path) ?? { added: 0, deleted: 0, binary: false }
    const rec = {
      path: f.path,
      from: f.from,
      rel: prefix && f.path.startsWith(prefix) ? f.path.slice(prefix.length) : f.path,
      role,
      index: untracked ? null : f.index,
      work: untracked ? null : f.work,
      untracked,
      conflict: f.index === 'U' || f.work === 'U',
      blast: blastOf(f.path),
      ...n,
    }
    if (!zones.has(zone)) zones.set(zone, { zone, group, files: [], added: 0, deleted: 0, staged: 0, dirty: 0, untracked: 0, conflicts: 0 })
    const z = zones.get(zone)
    z.files.push(rec)
    z.added += rec.added
    z.deleted += rec.deleted
    if (rec.untracked) z.untracked++
    else {
      if (rec.index) z.staged++
      if (rec.work) z.dirty++
    }
    if (rec.conflict) z.conflicts++
  }

  const list = [...zones.values()]
  for (const z of list) {
    z.churn = z.added + z.deleted
    z.files.sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) || a.rel.localeCompare(b.rel))
  }
  // Heaviest first: a scan wants the zone that changed most at the top, and a
  // conflict outranks any amount of churn.
  list.sort((a, b) => (b.conflicts - a.conflicts) || (b.churn - a.churn) || (b.files.length - a.files.length) || a.zone.localeCompare(b.zone))

  return {
    branch, ahead, behind,
    zones: list,
    total: {
      files: files.length,
      added: list.reduce((s, z) => s + z.added, 0),
      deleted: list.reduce((s, z) => s + z.deleted, 0),
      staged: list.reduce((s, z) => s + z.staged, 0),
      dirty: list.reduce((s, z) => s + z.dirty, 0),
      untracked: list.reduce((s, z) => s + z.untracked, 0),
      conflicts: list.reduce((s, z) => s + z.conflicts, 0),
    },
  }
}

// ─── directory collapse ───────────────────────────────────────────────────────
//
// Five siblings under one directory is one fact, not five. Returns the rows a
// role prints: each is a directory and the basenames under it, so the path
// prefix is paid for once and the eye lands on what actually differs.

export const collapse = (files) => {
  const byDir = new Map()
  for (const f of files) {
    // An untracked DIRECTORY is reported as one entry ending in `/` — git
    // collapses it rather than listing what is inside. Cutting at the last
    // separator gives that entry an empty basename, so the row prints its
    // status glyph and no name at all.
    const folder = f.rel.endsWith('/')
    const body   = folder ? f.rel.slice(0, -1) : f.rel
    const cut    = body.lastIndexOf('/')
    const dir    = cut === -1 ? '' : body.slice(0, cut + 1)
    if (!byDir.has(dir)) byDir.set(dir, [])
    byDir.get(dir).push({ ...f, folder, base: body.slice(cut + 1) + (folder ? '/' : '') })
  }
  return [...byDir.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([dir, entries]) => ({ dir, entries }))
}
