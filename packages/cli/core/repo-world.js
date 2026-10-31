/**
 * core/repo-world.js — the workspace as ground: packages, the roads between
 * them, and which plans stand on which package.
 *
 * Read by `fli ws:world`. The atlas gives each package its ring and realm and
 * the open issues filed against it, codegraph gives the imports between them,
 * `git status` the files nobody has committed, and every plan under `IDEAS/`
 * is scored against the package names its text carries. The question it is
 * built for is *who else is working my ground*: a plan's open steps naming a
 * package another open plan also names.
 *
 * ── A claim is a guess from the text ───────────────────────────────────────
 *
 * Nothing in a plan declares the packages it touches, so a claim counts what
 * the prose names: `packages/x` paths, `@frontierjs/x` names, the bare name
 * only where it is distinctive, and the package of every open issue the plan
 * cites. A mention inside an open step counts three times, because that is
 * the ground still to be worked. A program reading this should present it as
 * likely, never as declared.
 *
 * ── Not a snapshot ─────────────────────────────────────────────────────────
 *
 * It counts uncommitted files and the registers, so two runs over one commit
 * differ. Nothing commits it and nothing compares it.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { parsePlan } from './plan.js'

// Bare names that mean the package wherever they appear in prose. `css`,
// `config`, `cli`, `ui` and `testing` are left out: every plan says them
// about something else, and each would claim the whole field.
const BARE = new Set([
  'litestone', 'junction', 'sierra', 'mesa', 'basecamp', 'outpost', 'haven', 'conduit',
  'caravan', 'orion', 'jetty', 'oracle', 'toolbelt', 'site-kit', 'email-kit', 'print-kit',
  'mcp', 'notifications',
])

const OPEN_WEIGHT = 3
const ISSUE_WEIGHT = 4
// A plan named for a package is about it, whatever else its text mentions.
const NAMESAKE_WEIGHT = 50
// Below either floor a mention is a passing reference, not ground.
const CLAIM_FLOOR = 3
const CLAIM_SHARE = 0.04
const MAX_CLAIMS = 6

const escape = s => s.replace(/[-]/g, '\\-')
const count = (text, re) => (text.match(re) ?? []).length

/** Every plan under `IDEAS/` — a paper with at least one step box. */
export function readPlans(root) {
  const dir = join(root, 'IDEAS')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter(f => f.endsWith('.md'))
    .sort()
    .map(f => {
      const text = readFileSync(join(dir, f), 'utf8')
      return { id: f.replace(/\.md$/, ''), text, plan: parsePlan(text, { file: `IDEAS/${f}` }) }
    })
    .filter(p => p.plan.steps.length)
}

/** How often `text` names each package, by the rules in the header. */
function mentions(text, names) {
  const out = {}
  for (const k of names) {
    let n = count(text, new RegExp(`packages/${escape(k)}\\b`, 'g'))
          + count(text, new RegExp(`@frontierjs/${escape(k)}\\b`, 'g'))
    if (BARE.has(k)) n += count(text, new RegExp(`\\b${escape(k)}\\b`, 'gi'))
    if (k === 'example') n += count(text, /\bexample\/|`example`|in example\b|example's\b/g)
    // A fli command is the cli package at work, but a plan cites them in passing.
    if (k === 'cli') n += count(text, /\bfli [a-z]/g) * 0.5
    if (n) out[k] = n
  }
  return out
}

function claimsOf({ id, text, plan }, names, issuePkg) {
  const openText = plan.steps.filter(s => s.box === 'open').map(s => [s.title, ...s.notes].join(' ')).join('\n')
  const all  = mentions(text, names)
  const open = mentions(openText, names)
  const w = { ...all }
  for (const [k, n] of Object.entries(open)) w[k] = (w[k] ?? 0) + n * OPEN_WEIGHT
  for (const ref of new Set(text.match(/\bFJS-\d+\b/g) ?? [])) {
    const k = issuePkg.get(ref)
    if (k) w[k] = (w[k] ?? 0) + ISSUE_WEIGHT
  }
  if (names.includes(id)) w[id] = (w[id] ?? 0) + NAMESAKE_WEIGHT

  const total = Object.values(w).reduce((a, b) => a + b, 0)
  return Object.entries(w)
    .filter(([, v]) => v >= CLAIM_FLOOR && v >= total * CLAIM_SHARE)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_CLAIMS)
    .map(([pkg, v]) => ({ pkg, weight: Math.round(v), open: Math.round(open[pkg] ?? 0) }))
}

/**
 * The world model. `model` is `repo-map.js`'s `collect()`, `codegraph` is
 * `collectCodegraph()`, `plans` is `readPlans()` and `changed` is
 * `parsePorcelain()`'s rows.
 */
export function worldOf({ model, codegraph, plans, changed, now = new Date() }) {
  // An app is no package and has no ring, but it is where the seams are
  // crossed, so it stands on the outer ring beside the other frontier work.
  const parts = [
    ...model.packages.filter(p => !p.claimed).map(p => ({ name: p.folder, region: `packages/${p.folder}`, ring: p.ring ?? null, realm: p.realm ?? null, desc: p.desc ?? '' })),
    ...model.apps.map(a => ({ name: a.folder, region: a.folder, ring: 'frontier', realm: 'app', desc: a.desc ?? '' })),
  ]
  const byRegion = new Map(parts.map(p => [p.region, p]))
  const names    = parts.map(p => p.name)

  const open = Object.values(model.issues?.bySeverity ?? {}).flat().filter(i => i.status === 'open')
  const issuePkg = new Map(open.map(i => [i.id, i.pkg]))

  const files = {}, lines = {}
  for (const f of codegraph.files) {
    const p = byRegion.get(f.region)
    if (!p) continue
    files[p.name] = (files[p.name] ?? 0) + 1
    lines[p.name] = (lines[p.name] ?? 0) + (f.lines ?? 0)
  }

  const uncommitted = {}
  for (const { path } of changed) {
    const p = parts.find(p => path === p.region || path.startsWith(p.region + '/'))
    if (p) uncommitted[p.name] = (uncommitted[p.name] ?? 0) + 1
  }

  const timeline = codegraph.timeline
  const packages = parts.filter(p => files[p.name]).map(p => ({
    name:        p.name,
    ring:        p.ring,
    realm:       p.realm,
    desc:        p.desc.split(/ — |\. /)[0],
    files:       files[p.name],
    lines:       lines[p.name],
    issues:      open.filter(i => i.pkg === p.name).length,
    uncommitted: uncommitted[p.name] ?? 0,
    edits:       timeline?.regions[p.region]?.[1] ?? [],
  }))
  const drawn = new Set(packages.map(p => p.name))

  const roads = []
  for (const [from, to] of Object.entries(codegraph.uses ?? {})) {
    const a = byRegion.get(from)
    if (!a || !drawn.has(a.name)) continue
    for (const [region, refs] of Object.entries(to)) {
      const b = byRegion.get(region)
      if (b && b !== a && drawn.has(b.name)) roads.push({ from: a.name, to: b.name, refs })
    }
  }
  roads.sort((x, y) => x.from.localeCompare(y.from) || x.to.localeCompare(y.to))

  const boxes = plan => Object.fromEntries(['open', 'done', 'dropped'].map(b => [b, plan.steps.filter(s => s.box === b).length]))

  return {
    head:     codegraph.head ?? null,
    builtAt:  now.toISOString(),
    // One edit slice spans this many days; `edits` holds `timeline.steps` of them, oldest first.
    sliceDays: timeline ? (timeline.end - timeline.start) / timeline.steps / 86400 : null,
    packages,
    roads,
    plans: plans.map(p => ({
      id:     p.id,
      file:   p.plan.file,
      title:  p.plan.title,
      status: p.plan.status,
      steps:  boxes(p.plan),
      next:   p.plan.next ? { id: p.plan.next.id, title: p.plan.next.title } : null,
      claims: claimsOf(p, names, issuePkg),
    })),
  }
}
