// tools/schema-layers.js
// The schema as layers: foreign-key clusters on a floor, dependency depth as
// height. Studio's Layers tab draws what this returns and lays nothing out.
//
// Groups come from foreign keys alone (Louvain over the model graph), with each
// key weighted down by how many models point at its target so the models
// everything references do not swallow the rest into one cluster. Both floors
// are laid out here, in the full membership of every group, so the page's
// sliders only hide and show models and never move one.

import { authModelOf } from './principal.js'

const DISC_PER_ROOT = 66
const GOLDEN = 2.39996

// Relation fields that carry a key, one edge per target. A self-reference or a
// target outside the schema is not an edge a layer can show.
function graphOf(schema) {
  const models = schema.models
  const inDeg = {}, outDeg = {}, out = {}, fields = {}
  for (const m of models) { inDeg[m.name] = 0; outDeg[m.name] = 0; out[m.name] = [] }
  const edges = []
  for (const m of models) {
    const seen = new Set()
    fields[m.name] = m.fields.filter(f => f.type.kind !== 'relation').length
    for (const f of m.fields) {
      if (f.type.kind !== 'relation') continue
      const rel = f.attributes.find(a => a.kind === 'relation')
      if (!rel?.fields) continue
      const t = f.type.name
      if (t === m.name || seen.has(t) || inDeg[t] == null) continue
      seen.add(t); out[m.name].push(t); outDeg[m.name]++; inDeg[t]++; edges.push([m.name, t, f.name])
    }
  }
  return { names: models.map(m => m.name), edges, inDeg, outDeg, out, fields }
}

// Longest outgoing key path. A cycle counts as the floor where it re-enters.
function depthsOf(names, out) {
  const depth = {}, state = {}
  const walk = n => {
    if (state[n] === 2) return depth[n]
    if (state[n] === 1) return 0
    state[n] = 1
    let d = 0
    for (const t of out[n]) d = Math.max(d, walk(t) + 1)
    state[n] = 2
    return (depth[n] = d)
  }
  for (const n of names) walk(n)
  return depth
}

function louvain(nodes, edges) {
  let curNodes = nodes.slice(), curE = edges, member = Object.fromEntries(nodes.map(n => [n, [n]]))
  for (let level = 0; level < 10; level++) {
    const adj = {}, k = {}
    let m2 = 0
    for (const n of curNodes) { adj[n] = {}; k[n] = 0 }
    for (const [a, b, x] of curE) {
      adj[a][b] = (adj[a][b] ?? 0) + x; adj[b][a] = (adj[b][a] ?? 0) + x
      k[a] += x; k[b] += x; m2 += 2 * x
    }
    const c = Object.fromEntries(curNodes.map(n => [n, n])), tot = { ...k }
    let moved = true, any = false
    while (moved) {
      moved = false
      for (const n of curNodes) {
        const old = c[n]
        tot[old] -= k[n]
        const links = {}
        for (const [nb, x] of Object.entries(adj[n])) if (nb !== n) links[c[nb]] = (links[c[nb]] ?? 0) + x
        let best = old, gain = (links[old] ?? 0) - tot[old] * k[n] / m2
        for (const [cc, x] of Object.entries(links)) {
          const g = x - tot[cc] * k[n] / m2
          if (g > gain + 1e-12) { gain = g; best = cc }
        }
        c[n] = best; tot[best] += k[n]
        if (best !== old) { moved = true; any = true }
      }
    }
    if (!any) break
    const nm = {}
    for (const n of curNodes) (nm[c[n]] ??= []).push(...member[n])
    const ne = {}
    for (const [a, b, x] of curE) {
      const key = [c[a], c[b]].sort().join('|')
      ne[key] = (ne[key] ?? 0) + x
    }
    member = nm; curNodes = Object.keys(nm)
    curE = Object.entries(ne).map(([key, x]) => [...key.split('|'), x])
  }
  return Object.values(member)
}

// Whole PascalCase words, so Ad is not read inside AdCampaign.
const words = n => n.match(/[A-Z][a-z0-9]*|[a-z0-9]+/g) ?? [n]
function builtFrom(name, lead) {
  const w = words(name), l = words(lead)
  for (let i = 0; i + l.length <= w.length; i++) if (l.every((x, j) => w[i + j] === x)) return true
  return false
}

// The models the layers are arranged around, named by the schema rather than by
// a count: in-degree alone ranks the models every table points at (an App, a
// Server) above the tenant and the person. The tenancy root is what the row
// tenant column points at, the principal is the @@auth model, and what the
// principal itself points at is the organization it belongs to.
function hubsOf(schema, g) {
  const hubs = new Set()
  const t = schema.tenancy
  if (t?.strategy === 'row' && t.column) {
    const votes = {}
    for (const m of schema.models) for (const f of m.fields) {
      const rel = f.type.kind === 'relation' && f.attributes.find(a => a.kind === 'relation')
      if (rel?.fields?.includes(t.column) && g.inDeg[f.type.name] != null) votes[f.type.name] = (votes[f.type.name] ?? 0) + 1
    }
    const root = Object.entries(votes).sort((a, b) => b[1] - a[1])[0]
    if (root) hubs.add(root[0])
  }
  const principal = authModelOf(schema)
  if (principal && g.inDeg[principal.name] != null) {
    hubs.add(principal.name)
    for (const target of g.out[principal.name]) hubs.add(target)
  }
  if (!hubs.size && g.names.length) {
    hubs.add(g.names.reduce((a, b) => g.inDeg[b] > g.inDeg[a] ? b : a))
  }
  return [...hubs]
}

// ── Floors ────────────────────────────────────────────────────────────────────

function ringCenters(keys, rad, minR = 180) {
  const circ = keys.reduce((s, k) => s + 2 * rad(k) + 260, 0)
  const R = Math.max(minR, circ / (2 * Math.PI))
  let acc = 0
  const out = {}
  for (const k of keys) {
    const r = rad(k), a = (acc + r + 130) / circ * 2 * Math.PI
    acc += 2 * r + 260
    out[k] = { x: Math.cos(a) * R, y: Math.sin(a) * R }
  }
  return out
}

// Groups that share keys side by side. In size order linked groups land across
// the floor from each other and every link between them cuts through the hub.
// Reversals and swaps from the size order until neither shortens the keys'
// total length: a local optimum, and the same one for the same schema.
function ringOrder(keys, rad, links, minR) {
  const cost = order => {
    const at = ringCenters(order, rad, minR)
    let c = 0
    for (const [a, b, w] of links) if (at[a] && at[b]) c += w * Math.hypot(at[a].x - at[b].x, at[a].y - at[b].y)
    return c
  }
  let best = keys.slice(), bestCost = cost(best), better = true
  while (better) {
    better = false
    for (let i = 0; i < best.length; i++) for (let j = i + 1; j < best.length; j++) {
      const swapped = best.slice();
      [swapped[i], swapped[j]] = [swapped[j], swapped[i]]
      for (const next of [[...best.slice(0, i), ...best.slice(i, j + 1).reverse(), ...best.slice(j + 1)], swapped]) {
        const c = cost(next)
        if (c < bestCost - 1e-6) { best = next; bestCost = c; better = true }
      }
    }
  }
  return best
}

// The group holding the most hubs in the middle, the rest the ring around it,
// far enough out that no disc touches the center one.
function hubCenters(keys, rad, hubCount, links) {
  const hub = keys.reduce((a, b) => hubCount(b) > hubCount(a) ? b : a)
  const rest = keys.filter(k => k !== hub)
  const minR = rad(hub) + Math.max(0, ...rest.map(rad)) + 260
  const out = ringCenters(ringOrder(rest, rad, links, minR), rad, minR)
  out[hub] = { x: 0, y: 0 }
  return out
}

// The depth the page opens at: the shallowest at which every pair of clusters a
// key ever joins is already joined. A deeper level only thickens links already
// drawn and adds leaf models, so opening at the full depth buries the clusters.
function settledDepth(edges, depth, group) {
  const first = new Map()
  for (const [a, b] of edges) {
    if (group[a] === group[b]) continue
    const pair = [group[a], group[b]].sort().join('|'), d = Math.max(depth[a], depth[b])
    first.set(pair, Math.min(first.get(pair) ?? Infinity, d))
  }
  return first.size ? Math.max(...first.values()) : Math.max(0, ...Object.values(depth))
}

// How knotted a group is: every key it holds past a spanning tree is a knot,
// sorted by what it costs a reader. A loop (a model keyed to itself) is a
// hierarchy and a pair (a second key to a model already keyed) is a second role.
// A diamond is two routes between the same models, and it asks what the schema
// never says: must both routes arrive at the same row? Often yes (an
// AppDrill's App and its Deployment's App), sometimes no (an AppBackup's
// destination and its App's replica destination). Nearly every
// diamond in a group passes through its core (AppBackup reaches App directly and
// through Deployment), so those are counted apart; the score is the diamonds
// that do not, and a raw count only measured how big a group and its hub were.
function knotsOf(schema, members, core) {
  const S = new Set(members), loops = [], pairs = [], simple = []
  const seen = new Set()
  for (const m of schema.models) {
    if (!S.has(m.name)) continue
    for (const f of m.fields) {
      const rel = f.type.kind === 'relation' && f.attributes.find(a => a.kind === 'relation')
      if (!rel?.fields || !S.has(f.type.name)) continue
      const key = { from: m.name, field: f.name, to: f.type.name }
      const pair = [m.name, f.type.name].sort().join('\n')
      if (m.name === f.type.name) loops.push({ kind: 'loop', ...key, route: [m.name] })
      else if (seen.has(pair)) pairs.push({ kind: 'pair', ...key, route: [m.name, f.type.name] })
      else { seen.add(pair); simple.push(key) }
    }
  }
  // Kruskal with the keys clear of the core first: a key rejected in that pass
  // closes a cycle the core takes no part in.
  const parent = Object.fromEntries(members.map(n => [n, n]))
  const root = x => parent[x] === x ? x : (parent[x] = root(parent[x]))
  const offCore = k => !core.has(k.from) && !core.has(k.to)
  const diamonds = []
  for (const k of [...simple.filter(offCore), ...simple.filter(k => !offCore(k))]) {
    const a = root(k.from), b = root(k.to)
    if (a !== b) parent[a] = b
    else diamonds.push({ kind: 'diamond', ...k, viaCore: !offCore(k) })
  }
  // The other route shown is the shortest one without the key itself, not the
  // spanning tree's path, which wanders (AppDrill through AppBackup and
  // BackupDestination to App, when Deployment reaches App in one step).
  const routeOf = d => {
    const back = { [d.from]: null }, q = [d.from]
    while (q.length && !(d.to in back)) {
      const x = q.shift()
      for (const k of simple) {
        if (k.from === d.from && k.field === d.field) continue
        const y = k.from === x ? k.to : k.to === x ? k.from : null
        if (y == null || y in back || (!d.viaCore && core.has(y))) continue
        back[y] = x; q.push(y)
      }
    }
    const path = []
    for (let x = d.to; x != null; x = back[x]) path.unshift(x)
    return path
  }
  for (const d of diamonds) d.route = routeOf(d)
  const list = [...diamonds.sort((a, b) => a.viaCore - b.viaCore), ...pairs, ...loops]
  return { offCore: diamonds.filter(d => !d.viaCore).length, all: list.length, list }
}

const round = n => Math.round(n * 10) / 10

/**
 * @param {object} schema parsed schema (parseResult.schema)
 * @returns {{
 *   models: Array<{ n: string, in: number, out: number, d: number, f: number, g: string }>,
 *   edges: Array<[from: string, to: string, field: string]>,
 *   groups: Array<{ key: string, label: string, members: string[], core: number, r: number, knots: { offCore: number, all: number, list: Array<{ kind: 'diamond'|'pair'|'loop', from: string, field: string, to: string, route: string[], viaCore?: boolean }> } }>,
 *   hubs: string[],
 *   depth: number,
 *   floors: Record<'ring'|'hub', { centers: Record<string, { x: number, y: number }>, at: Record<string, [number, number]> }>,
 * }}
 */
export function schemaLayers(schema) {
  const g = graphOf(schema)
  const depth = depthsOf(g.names, g.out)
  const hubs = hubsOf(schema, g)
  const hubSet = new Set(hubs)

  const comms = louvain(g.names, g.edges.map(([a, b]) => [a, b, 1 / Math.log2(1 + g.inDeg[b])]))
  const group = {}
  for (const c of comms) {
    if (c.length === 1) { group[c[0]] = 'unlinked'; continue }
    const lead = c.slice().sort((a, b) => g.inDeg[b] - g.inDeg[a] || g.outDeg[b] - g.outDeg[a])[0]
    for (const n of c) group[n] = 'around ' + lead
  }

  // A model keyed into two groups as often lands by a near tie in the weights;
  // the group its name is built from wins (ClientAdBudget beside Client, not
  // User). More keys into its own group is no tie (ClientRequest stays with
  // Project and Deliverable).
  for (const n of g.names) {
    const own = group[n]
    if (own === 'unlinked' || builtFrom(n, own.slice(7))) continue
    const keysInto = k => g.out[n].filter(t => group[t] === k).length
    const named = g.out[n].map(t => group[t])
      .filter(k => k !== 'unlinked' && k !== own && builtFrom(n, k.slice(7)) && keysInto(k) >= keysInto(own))
      .sort((a, b) => b.length - a.length)[0]
    if (named) group[n] = named
  }

  const byKey = new Map()
  for (const n of g.names) {
    const k = group[n]
    if (!byKey.has(k)) byKey.set(k, [])
    byKey.get(k).push(n)
  }
  const keys = [...byKey.keys()].sort((a, b) =>
    (a === 'unlinked') - (b === 'unlinked') || byKey.get(b).length - byKey.get(a).length || a.localeCompare(b))

  // A group's core is the model it is named around plus any hub in it; the rest
  // follow by how few foreign keys separate them from a core model.
  const core = new Set()
  for (const k of keys) for (const n of byKey.get(k)) if (hubSet.has(n) || k === 'around ' + n) core.add(n)
  const hop = {}
  let q = [...core]
  for (const n of q) hop[n] = 0
  const into = Object.fromEntries(g.names.map(n => [n, []]))
  for (const [a, b] of g.edges) into[b].push(a)
  while (q.length) {
    const next = []
    for (const n of q) for (const a of into[n]) if (hop[a] == null) { hop[a] = hop[n] + 1; next.push(a) }
    q = next
  }
  const ranked = new Map(keys.map(k => [k, byKey.get(k).slice().sort((a, b) =>
    (core.has(b) - core.has(a)) || (hop[a] ?? Infinity) - (hop[b] ?? Infinity) || g.inDeg[b] - g.inDeg[a] || a.localeCompare(b))]))

  const rad = k => DISC_PER_ROOT * Math.sqrt(byKey.get(k).length) + 44
  const hubCount = k => byKey.get(k).filter(n => hubSet.has(n)).length
  const between = new Map()
  for (const [a, b] of g.edges) {
    if (group[a] === group[b]) continue
    const pair = [group[a], group[b]].sort().join('|')
    between.set(pair, (between.get(pair) ?? 0) + 1)
  }
  const links = [...between].map(([pair, w]) => [...pair.split('|'), w])
  const centers = {
    ring: ringCenters(ringOrder(keys, rad, links), rad),
    hub: hubCenters(keys, rad, hubCount, links),
  }
  const floors = {}
  for (const [name, at] of Object.entries(centers)) {
    const pos = {}
    for (const k of keys) ranked.get(k).forEach((n, j, all) => {
      // The ring around the lead starts off its center and spreads to the disc's
      // edge, or the core models beside the lead pile onto it.
      const r = rad(k), r0 = 0.4 * r, step = (0.88 * r - r0) / Math.max(1, Math.sqrt(all.length - 2))
      const rr = j === 0 ? 0 : r0 + step * Math.sqrt(j - 1)
      pos[n] = [round(at[k].x + Math.cos(j * GOLDEN) * rr), round(at[k].y + Math.sin(j * GOLDEN) * rr)]
    })
    floors[name] = {
      centers: Object.fromEntries(keys.map(k => [k, { x: round(at[k].x), y: round(at[k].y) }])),
      at: pos,
    }
  }

  return {
    models: g.names.map(n => ({ n, in: g.inDeg[n], out: g.outDeg[n], d: depth[n], f: g.fields[n], g: group[n] })),
    edges: g.edges,
    groups: keys.map(k => ({
      key: k,
      label: k === 'unlinked' ? 'No foreign keys' : k.slice(7) + ' cluster',
      members: ranked.get(k),
      core: ranked.get(k).filter(n => core.has(n)).length,
      r: round(rad(k)),
      knots: k === 'unlinked' ? { offCore: 0, all: 0, list: [] } : knotsOf(schema, byKey.get(k), core),
    })),
    hubs,
    depth: settledDepth(g.edges, depth, group),
    floors,
  }
}
