// tools/schema-layers.js
// The schema as layers: foreign-key clusters on a floor, dependency depth as
// height. Studio's Layers tab draws what this returns and lays nothing out.
//
// Groups come from foreign keys alone (Louvain over the model graph), with each
// key weighted down by how many models point at its target so the models
// everything references do not swallow the rest into one cluster. Three floors
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
      seen.add(t); out[m.name].push(t); outDeg[m.name]++; inDeg[t]++; edges.push([m.name, t])
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

// The group holding the most hubs in the middle, the rest the ring around it,
// far enough out that no disc touches the center one.
function hubCenters(keys, rad, hubCount) {
  const hub = keys.reduce((a, b) => hubCount(b) > hubCount(a) ? b : a)
  const rest = keys.filter(k => k !== hub)
  const out = ringCenters(rest, rad, rad(hub) + Math.max(0, ...rest.map(rad)) + 260)
  out[hub] = { x: 0, y: 0 }
  return out
}

// Groups that share more foreign keys pull harder toward the middle, so the
// ones everything points at land in the center. A fixed number of ticks from a
// fixed start: the same schema is the same map.
function mapCenters(keys, rad, groupOf, edges) {
  const ns = keys.map((k, i) => {
    const a = i * Math.PI * (3 - Math.sqrt(5)), r = 10 * Math.sqrt(0.5 + i)
    return { id: k, x: r * Math.cos(a), y: r * Math.sin(a), vx: 0, vy: 0 }
  })
  const byId = new Map(ns.map(n => [n.id, n]))
  const lm = new Map(), deg = {}
  for (const [a, b] of edges) {
    const s = groupOf(a), t = groupOf(b)
    if (s === t) continue
    const key = s < t ? s + '|' + t : t + '|' + s
    let l = lm.get(key)
    if (!l) lm.set(key, l = { source: byId.get(s), target: byId.get(t), w: 0 })
    l.w++; deg[s] = (deg[s] ?? 0) + 1; deg[t] = (deg[t] ?? 0) + 1
  }
  const links = [...lm.values()], count = new Map(ns.map(n => [n, 0]))
  for (const l of links) { count.set(l.source, count.get(l.source) + 1); count.set(l.target, count.get(l.target) + 1) }
  const pull = n => 0.02 + 0.035 * (deg[n.id] ?? 0)
  const TICKS = 400, alphaDecay = 1 - Math.pow(0.001, 1 / 300)
  let alpha = 1
  for (let t = 0; t < TICKS; t++) {
    alpha -= alpha * alphaDecay
    for (const l of links) {
      const { source: s, target: g } = l
      let x = g.x + g.vx - s.x - s.vx, y = g.y + g.vy - s.y - s.vy
      const len = Math.hypot(x, y) || 1e-6
      const dist = rad(s.id) + rad(g.id) + 460, str = Math.min(1, 0.15 * l.w)
      const f = (len - dist) / len * alpha * str
      x *= f; y *= f
      const bias = count.get(s) / (count.get(s) + count.get(g))
      g.vx -= x * bias; g.vy -= y * bias
      s.vx += x * (1 - bias); s.vy += y * (1 - bias)
    }
    for (const a of ns) for (const b of ns) {
      if (a === b) continue
      const x = b.x - a.x, y = b.y - a.y
      const l = Math.max(1, x * x + y * y)
      a.vx += x * -4200 * alpha / l; a.vy += y * -4200 * alpha / l
    }
    for (let it = 0; it < 4; it++) for (let i = 0; i < ns.length; i++) for (let j = i + 1; j < ns.length; j++) {
      const a = ns[i], b = ns[j], ra = rad(a.id) + 300, rb = rad(b.id) + 300
      let x = a.x + a.vx - b.x - b.vx, y = a.y + a.vy - b.y - b.vy
      const r = ra + rb
      let l = x * x + y * y
      if (l >= r * r) continue
      if (l === 0) { x = 1e-6; y = 1e-6; l = x * x + y * y }
      l = Math.sqrt(l)
      const k = (r - l) / l
      x *= k; y *= k
      const share = rb * rb / (ra * ra + rb * rb)
      a.vx += x * share; a.vy += y * share
      b.vx -= x * (1 - share); b.vy -= y * (1 - share)
    }
    for (const n of ns) { n.vx += -n.x * pull(n) * alpha; n.vy += -n.y * pull(n) * alpha }
    for (const n of ns) { n.vx *= 0.6; n.vy *= 0.6; n.x += n.vx; n.y += n.vy }
  }
  // Centered on the groups' extent, not on the busiest group: the ring is sized
  // to the farthest disc, so an off-center origin leaves half the floor empty.
  const ext = (f, sign) => Math[sign > 0 ? 'max' : 'min'](...ns.map(d => d[f] + sign * rad(d.id)))
  const cx = (ext('x', 1) + ext('x', -1)) / 2, cy = (ext('y', 1) + ext('y', -1)) / 2
  return Object.fromEntries(ns.map(d => [d.id, { x: d.x - cx, y: d.y - cy }]))
}

const round = n => Math.round(n * 10) / 10

/**
 * @param {object} schema parsed schema (parseResult.schema)
 * @returns {{
 *   models: Array<{ n: string, in: number, out: number, d: number, f: number, g: string }>,
 *   edges: Array<[string, string]>,
 *   groups: Array<{ key: string, label: string, members: string[], core: number, r: number }>,
 *   hubs: string[],
 *   floors: Record<'ring'|'hub'|'map', { centers: Record<string, { x: number, y: number }>, at: Record<string, [number, number]> }>,
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
  const centers = {
    ring: ringCenters(keys, rad),
    hub: hubCenters(keys, rad, hubCount),
    map: mapCenters(keys, rad, n => group[n], g.edges),
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
    })),
    hubs,
    floors,
  }
}
