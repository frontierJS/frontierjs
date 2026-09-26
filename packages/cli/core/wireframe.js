/**
 * wireframe.js — a screen written in @frontierjs/css's vocabulary, read into
 * the components, the .mesa and the draft schema it implies.
 *
 * A WIREFRAME is a JSON file: `{ screen, names?, models?, tree }`, where every
 * node of `tree` is a vocabulary term — `{ term, mods?, text?, children?,
 * unsure?, dir?, width?, grow?, level? }`. It is what a person or a vision
 * model writes after looking at a screenshot; nothing here looks at pixels.
 *
 * Pure: the vocabulary, the kit the app has installed and the terminal width
 * come in as arguments, and files come out as strings. `commands/make/
 * wireframe.md` reads and writes, and grades what this returns with the APP's
 * own mesa and litestone, since this package depends on neither.
 *
 * ── The analysis has one owner ───────────────────────────────────────────
 *
 * `analyze` decides what a component is and what its props are, and every
 * output reads that one answer. The prototype split it across two scripts and
 * they disagreed about the same badge — a list to one, two props to the other.
 *
 *   group   by shallow shape: a term plus its child terms, a run of one term
 *           folded to one entry, so a card with one Badge matches one with two
 *   merge   a shape whose parts are a subsequence of another's, same term and
 *           same parent term, is that component with OPTIONAL parts
 *   fold    a candidate found exactly once in every copy of another is a part
 *           of it — a lane's header Bar — not a component of its own
 *   slots   what differs between copies; a run whose tone is fixed per
 *           POSITION (a count, then a snoozed count in warning) is several
 *           props that happen to be adjacent, not a list
 *
 * A shape cannot say what to call itself. `names` maps the content-hash id
 * printed in the report to a name, and an unnamed component keeps its id.
 */

import { createHash } from 'node:crypto'

// ─── the vocabulary's facts that vocabulary.json does not carry ───────────

// The terms `packages/css/test/specs/tones.spec.js` grades a tone on. A copy,
// and `test/wireframe.test.js` fails when the spec's list moves without it.
export const TONES       = ['primary', 'secondary', 'muted', 'info', 'success', 'warning', 'danger']
export const TONE_TAKERS = new Set(['Card', 'Tile', 'Alert', 'Toast', 'Popover', 'Button', 'Pill', 'Badge', 'Avatar', 'Link', 'Field'])

// Terms whose children run across rather than down. Drawing only — the
// terminal has no CSS to ask, and nothing grades this list.
const ROW_TERMS = new Set(['Shell', 'Split', 'Cluster', 'Toolbar', 'Bar', 'Topbar', 'Group', 'Tabs', 'Breadcrumb', 'Pagination'])

// The kit components the emitter can use, and the props it passes each one.
// The command asks the app which of these it has installed; the test asks the
// kit whether each prop is still declared.
export const KIT_PROPS = {
  Card:        [],
  Pill:        ['tone'],
  Badge:       ['tone'],
  Avatar:      ['name', 'size'],
  AvatarGroup: ['users'],
  Dot:         ['tone'],
}

const NODE_KEYS = new Set(['term', 'mods', 'text', 'children', 'unsure', 'dir', 'width', 'grow', 'level'])
const ROOT_KEYS = new Set(['screen', 'names', 'models', 'tree', '$comment'])

// ─── read ──────────────────────────────────────────────────────────────────

export class WireframeError extends Error {
  constructor (problems) {
    super(problems.join('\n'))
    this.problems = problems
  }
}

/**
 * Refuses by name rather than dropping: an unknown term is a class the
 * stylesheet does not ship, and an unknown key is a spelling somebody meant.
 */
export function readWireframe (doc, vocab) {
  const terms    = new Map(vocab.terms.map(t => [t.term, t]))
  const problems = []
  if (!doc || typeof doc !== 'object') throw new WireframeError(['a wireframe is a JSON object'])
  for (const k of Object.keys(doc)) if (!ROOT_KEYS.has(k)) problems.push(`unknown key "${k}" at the root — known: ${[...ROOT_KEYS].join(', ')}`)
  if (typeof doc.screen !== 'string' || !/^[A-Z][A-Za-z0-9]*$/.test(doc.screen)) problems.push('"screen" is the page name, PascalCase')
  if (!doc.tree) problems.push('"tree" is missing')
  ;(function walk (n, path) {
    if (!n || typeof n !== 'object') return problems.push(`${path}: not a node`)
    for (const k of Object.keys(n)) if (!NODE_KEYS.has(k)) problems.push(`${path}: unknown key "${k}" — known: ${[...NODE_KEYS].join(', ')}`)
    if (!terms.has(n.term)) problems.push(`${path}: "${n.term}" is not a term — known: ${[...terms.keys()].join(', ')}`)
    ;(n.children || []).forEach((k, i) => walk(k, `${path}.${n.term}[${i}]`))
  })(doc.tree || {}, 'tree')
  if (problems.length) throw new WireframeError(problems)
  return { screen: doc.screen, names: doc.names || {}, models: doc.models || {}, tree: doc.tree, terms }
}

// ─── analyze ───────────────────────────────────────────────────────────────

const toneOf  = n => (n.mods || []).find(m => TONES.includes(m))
const treat   = n => (n.mods || []).filter(m => !TONES.includes(m))
const lcFirst = s => s[0].toLowerCase() + s.slice(1)
const isDot   = n => n?.term === 'Icon' && n.text === '●'

function parts (n) {
  const out = []
  for (const k of n?.children || []) {
    const last = out[out.length - 1]
    if (last && last.term === k.term) { last.nodes.push(k); continue }
    out.push({ term: k.term, nodes: [k] })
  }
  return out
}

const isSubseq = (a, b) => { let i = 0; for (const x of b) if (x === a[i]) i++; return i === a.length }

const LEAF_NAME = { Heading: 'title', Kicker: 'kicker', Text: 'text', Pill: 'count', Badge: 'badge', Avatar: 'avatar', Icon: 'icon', Button: 'action', Link: 'link', Field: 'field' }

export function analyze (wf) {
  const { terms, tree } = wf
  const inline   = n => terms.get(n.term)?.tier === 'Inline'
  const compound = n => (n.children || []).length >= 2 && !inline(n)
  const notes    = []
  const all      = []
  const parent   = new Map()
  ;(function walk (n, p) {
    parent.set(n, p)
    all.push(n)
    for (const k of n.children || []) walk(k, n)
  })(tree, null)

  // group
  const groups = new Map()
  for (const n of all.filter(compound)) {
    const seq = parts(n).map(p => p.term)
    const key = n.term + '(' + seq.join(',') + ')'
    if (!groups.has(key)) groups.set(key, { term: n.term, seq, nodes: [] })
    groups.get(key).nodes.push(n)
  }

  // merge
  let list = [...groups.values()]
  for (let changed = true; changed;) {
    changed = false
    outer: for (const a of list) for (const b of list) {
      if (a === b || a.term !== b.term || a.seq.length > b.seq.length) continue
      const pa = new Set(a.nodes.map(n => parent.get(n)?.term))
      if (!b.nodes.some(n => pa.has(parent.get(n)?.term))) continue
      if (!isSubseq(a.seq, b.seq)) continue
      b.nodes.push(...a.nodes)
      list = list.filter(g => g !== a)
      changed = true
      break outer
    }
  }

  const cand = new Map()   // node → component
  let comps = list.filter(g => g.nodes.length >= 2)
  for (const c of comps) {
    c.id   = createHash('sha1').update(c.term + c.seq.join()).digest('hex').slice(0, 6)
    c.name = wf.names[c.id] || `${c.term}_${c.id}`
    for (const n of c.nodes) cand.set(n, c)
  }

  // fold
  const folded = []
  for (const c of [...comps]) {
    const owners = new Set(c.nodes.map(n => cand.get(parent.get(n))).filter(Boolean))
    if (owners.size !== 1) continue
    const p = [...owners][0]
    const oneEach = p.nodes.every(pn => (pn.children || []).filter(k => cand.get(k) === c).length === 1)
    if (c.nodes.length === p.nodes.length && oneEach) {
      for (const n of c.nodes) cand.delete(n)
      comps = comps.filter(x => x !== c)
      folded.push({ shape: `${c.term}(${c.seq.join(',')})`, into: p.name })
    }
  }

  // slots
  const tones = {}   // value → tone, for slots whose tone followed their value
  function spec (occs, self) {
    const rep = occs.filter(Boolean).sort((a, b) => parts(b).length - parts(a).length)[0]
    return parts(rep).flatMap(({ term }) => {
      const per  = occs.map(o => parts(o).find(p => p.term === term)?.nodes || [])
      const flat = per.flat()
      const nested = flat.map(k => cand.get(k)).find(c => c && c !== self)
      if (nested) {
        const odd = flat.filter(k => cand.get(k) !== nested)
        if (odd.length) notes.push(`${self.name}: ${odd.length} of ${flat.length} ${term}s are not ${nested.name} — two shapes, or one with a variable slot?`)
        return [{ kind: 'comp', term, comp: nested, per }]
      }
      const wrap = flat.find(compound)
      if (wrap) return [{ kind: 'wrap', term, node: wrap, children: spec(per.map(a => a[0]), self), per }]

      const width = Math.max(...per.map(a => a.length))
      if (width > 1 && width <= 3) {
        const at   = i => new Set(per.filter(a => a[i]).map(a => toneOf(a[i]) || ''))
        const cols = [...Array(width).keys()].map(at)
        if (cols.every(c => c.size === 1) && new Set(cols.map(c => [...c][0])).size > 1) {
          return cols.map((c, i) => {
            const pp = per.map(a => a[i] ? [a[i]] : [])
            const tr = new Set(pp.flat().map(k => treat(k).join(' ')))
            return {
              kind: 'leaf', term, per: pp, many: false, optional: pp.some(a => !a.length), sample: pp.flat()[0],
              tone: [...c][0] ? { mode: 'fixed', value: [...c][0] } : { mode: 'none' },
              treatment: tr.size === 1 ? [...tr][0] : '',
            }
          })
        }
      }

      const sample   = flat[0]
      const many     = per.some(a => a.length > 1)
      const optional = per.some(a => !a.length)
      // A tone that is a function of the value goes in tones.js; one that is
      // not (every lane dot is "●", each a different color) is its own prop.
      const byText   = new Map()
      let byValue    = true
      for (const k of flat) {
        if (byText.has(k.text) && byText.get(k.text) !== toneOf(k)) byValue = false
        byText.set(k.text, toneOf(k))
      }
      const distinct = new Set(flat.map(toneOf))
      let tone = { mode: 'none' }
      if (term === 'Avatar') tone = { mode: 'kit' }
      else if (distinct.size === 1 && [...distinct][0]) tone = { mode: 'fixed', value: [...distinct][0] }
      else if (distinct.size > 1 && byValue && !isDot(sample)) {
        tone = { mode: 'map' }
        for (const [v, t] of byText) if (t) {
          if (tones[v] && tones[v] !== t) notes.push(`tones.js: "${v}" is ${tones[v]} in one place and ${t} in another`)
          tones[v] = t
        }
      } else if (distinct.size > 1) tone = { mode: 'prop' }
      const tr = [...new Set(flat.map(k => treat(k).join(' ')))]
      if (tr.length > 1) notes.push(`${self.name}.${LEAF_NAME[term] || term}: treatment varies (${tr.map(t => t || 'none').join(' | ')}) — not carried`)
      return [{ kind: 'leaf', term, per, many, optional, sample, tone, treatment: tr.length === 1 ? tr[0] : '' }]
    })
  }

  // Names come from the term, plural for a list. A collision takes the
  // wrapper's name as a prefix, or a number where there is no wrapper — an
  // empty prefix would capitalize `badge` into `Badge`, the import it shadows.
  function name (slots, prefix = '', used = new Set()) {
    for (const s of slots) {
      if (s.kind === 'wrap') { name(s.children, s.term.toLowerCase(), used); continue }
      let base = s.kind === 'comp' ? lcFirst(s.comp.name) + 's' : (LEAF_NAME[s.term] || lcFirst(s.term)) + (s.many ? 's' : '')
      if (s.kind === 'leaf' && isDot(s.sample)) { base = 'tone'; s.dot = true }
      if (used.has(base)) {
        let n = 2, next = prefix ? prefix + base[0].toUpperCase() + base.slice(1) : base + n
        while (used.has(next)) next = base + ++n
        base = next
      }
      used.add(base)
      s.prop = base
      if (s.tone?.mode === 'prop' && !s.dot) s.toneProp = base + 'Tone'
    }
    return slots
  }

  for (const c of comps) c.slots = name(spec(c.nodes, c))
  return { wf, comps, cand, parent, folded, notes, tones, inline, compound }
}

// ─── the data a copy carries ───────────────────────────────────────────────

function extract (a, comp, node) {
  const out = {}
  const fill = (slots, n) => {
    const ps = parts(n)
    for (const s of slots) {
      const nodes = ps.find(p => p.term === s.term)?.nodes || []
      if (s.kind === 'wrap') { fill(s.children, nodes[0]); continue }
      if (s.kind === 'comp') { out[s.prop] = nodes.map(k => extract(a, s.comp, k)); continue }
      // A positional slot holds one node per copy; the copy's own is the one it holds.
      const one = s.many ? null : nodes.find(k => s.per.some(p => p.includes(k)))
      if (s.dot) { out[s.prop] = one ? toneOf(one) : undefined; continue }
      const val = k => s.term === 'Avatar' && s.many ? { name: k.text } : k.text
      out[s.prop] = s.many ? nodes.map(val) : one ? val(one) : undefined
      if (s.toneProp) out[s.toneProp] = one ? toneOf(one) : undefined
    }
  }
  fill(comp.slots, node)
  return out
}

// ─── report ────────────────────────────────────────────────────────────────

export function report (a) {
  const lines = [`${a.comps.length} components`]
  const walk = (slots, prefix = '') => slots.flatMap(s => {
    if (s.kind === 'wrap') return walk(s.children, prefix + s.term.toLowerCase() + '.')
    const vals = s.kind === 'leaf' ? s.per.flat().map(k => k.text).filter(Boolean).slice(0, 2) : []
    const note = [
      s.optional && `in ${s.per.filter(p => p.length).length} of ${s.per.length}`,
      s.tone?.mode === 'map' && 'tone follows the value',
      s.tone?.mode === 'fixed' && s.tone.value,
    ].filter(Boolean).join(' · ')
    const kind = s.kind === 'comp' ? '◆' + s.comp.name + '[]' : s.term
    return [`    ${(prefix + s.prop).padEnd(22)} ${kind.padEnd(16)} ${[note, vals.map(v => JSON.stringify(v)).join(' | ')].filter(Boolean).join('  ')}`.trimEnd()]
  })
  for (const c of a.comps) {
    const where = [...new Set(c.nodes.map(n => a.cand.get(a.parent.get(n))?.name || a.parent.get(n)?.term))].join(', ')
    lines.push('', `◆ ${c.name}  id ${c.id} · a ${c.term} · ×${c.nodes.length} in ${where}`, ...walk(c.slots))
  }
  if (a.folded.length) lines.push('', 'folded into their owner: ' + a.folded.map(f => `${f.shape} → ${f.into}`).join('; '))
  for (const n of a.notes) lines.push('note: ' + n)
  return lines.join('\n')
}

// ─── the terminal drawing ──────────────────────────────────────────────────

const esc  = code => s => `\x1b[${code}m${s}\x1b[0m`
const dim  = esc('2')
const bold = esc('1')
const inv  = esc('7')
const TIER_PAINT = {
  Frame: esc('34'), Page: esc('36'), Region: esc('35'), Block: esc('33'),
  Inline: esc('32'), Overlay: esc('31'), Layout: esc('90'), Base: esc('37'),
}
const TONE_PAINT = {
  primary: esc('44;97'), secondary: esc('45;97'), muted: esc('100;97'),
  info: esc('46;30'), success: esc('42;30'), warning: esc('43;30'), danger: esc('41;97'),
}
const ANSI_RE = /\x1b\[[0-9;]*m/g
const vis     = s => s.replace(ANSI_RE, '').length

function clip (s, w) {
  if (vis(s) <= w) return s
  let out = '', n = 0
  for (const part of s.split(/(\x1b\[[0-9;]*m)/)) {
    if (/^\x1b\[[0-9;]*m$/.test(part)) { out += part; continue }
    for (const ch of part) {
      if (n >= w - 1) return out + '…\x1b[0m'
      out += ch; n++
    }
  }
  return out
}
const pad = (s, w) => { const c = clip(s, w); return c + ' '.repeat(Math.max(0, w - vis(c))) }

/**
 * Boxes carry `Term .class` in their border; inline terms are chips on a
 * line; Layout terms are dotted because they have no skin; a component copy
 * is drawn heavy. A class is shown only where it is not the term's own name.
 */
export function draw (a, { width = 110, color = true } = {}) {
  const { terms } = a.wf
  const info  = n => terms.get(n.term)
  const inline = a.inline
  const clsOf = n => {
    const t = info(n)
    return t.class ? (t.class === n.term.toLowerCase() ? '' : '.' + t.class) : '<' + t.element.replace(/[<>]/g, '').split(/[ /+]/)[0] + '>'
  }
  const modStr = n => (n.mods || []).map(m => TONES.includes(m) && !TONE_TAKERS.has(n.term) ? inv(esc('31')('✗' + m)) : '.' + m).join('')
  const q = n => n.unsure ? inv('?' + n.unsure.join('|')) : ''

  const label = n => {
    const c = a.cand.get(n)
    return (c ? inv(bold(' ◆' + c.name + ' ')) + ' ' : '') + TIER_PAINT[info(n).tier](bold(n.term)) + ' ' + dim(clsOf(n) + modStr(n)) + (n.unsure ? ' ' + q(n) : '')
  }

  const chip = n => {
    const tone = toneOf(n)
    if (n.term === 'Text')    return n.text ? dim('“') + n.text + dim('”') : dim('¶ text')
    if (n.term === 'Heading') return bold('# ' + (n.text ?? '')) + ' ' + dim('<h' + (n.level || 2) + '>')
    const skin = tone && TONE_TAKERS.has(n.term) ? TONE_PAINT[tone] : TIER_PAINT.Inline
    const [o, c] = n.term === 'Field' ? ['▕', '▏'] : ['[', ']']
    const mods = (n.mods || []).filter(m => !(TONES.includes(m) && TONE_TAKERS.has(n.term)))
    return skin(o + n.term + (n.text ? ' ' + n.text : '') + c) + dim(clsOf(n)) + modStr({ ...n, mods }) + q(n)
  }

  const flow = (nodes, w) => {
    const lines = []
    let line = ''
    for (const n of nodes) {
      const c = chip(n)
      if (line && vis(line) + 1 + vis(c) > w) { lines.push(line); line = '' }
      line = line ? line + ' ' + c : c
    }
    if (line) lines.push(line)
    return lines.map(l => pad(l, w))
  }

  function render (n, w) {
    if (inline(n)) return flow([n], w)
    if (n.flat) return layout({ ...n, flat: false, term: 'Section', dir: 'col' }, w)
    const t = info(n)
    if (!n.children?.length && n.text && !String(n.text).includes('\n'))
      return [pad(TIER_PAINT[t.tier]('┤' + bold(n.term) + '├') + modStr(n) + q(n) + ' ' + n.text, w)]
    const paint = TIER_PAINT[t.tier]
    const [h, v, tl, tr, bl, br] = a.cand.get(n) ? ['━', '┃', '┏', '┓', '┗', '┛']
      : t.tier === 'Layout' ? ['┄', '┆', '┌', '┐', '└', '┘']
      : t.tier === 'Frame' || t.tier === 'Overlay' ? ['═', '║', '╔', '╗', '╚', '╝']
      : ['─', '│', '┌', '┐', '└', '┘']
    const inner = Math.max(4, w - 4)
    const body  = layout(n, inner)
    if (n.text) body.unshift(...String(n.text).split('\n').map(l => pad(dim(l), inner)))
    if (!body.length) body.push(pad('', inner))
    const lab = clip(' ' + label(n) + ' ', w - 4)
    const top = paint(tl + h) + lab + paint(h.repeat(Math.max(0, w - 3 - vis(lab))) + tr)
    return [top, ...body.map(l => paint(v) + ' ' + pad(l, inner) + ' ' + paint(v)), paint(bl + h.repeat(w - 2) + br)]
  }

  function layout (n, w) {
    const kids = n.children || []
    if (!kids.length) return []
    // Shell is a grid: the Sidebar runs full height and Topbar sits over Screen.
    if (n.term === 'Shell') {
      const side = kids.filter(k => k.term === 'Sidebar')
      const rest = kids.filter(k => k.term !== 'Sidebar')
      if (side.length && rest.length) return layout({ term: 'Bar', children: [...side, { term: 'Stack', flat: true, grow: 1, children: rest }] }, w)
    }
    const row = n.dir ? n.dir === 'row' : ROW_TERMS.has(n.term)
    if (row) {
      if (kids.every(inline)) {
        // Split pins its last child right; flowing it left would draw a Cluster.
        if (n.term === 'Split' && kids.length > 1) {
          const left = kids.slice(0, -1).map(chip).join(' '), right = chip(kids[kids.length - 1])
          const gap  = w - vis(left) - vis(right)
          if (gap >= 1) return [left + ' '.repeat(gap) + right]
        }
        return flow(kids, w)
      }
      const fixed  = kids.map(k => k.width || 0)
      const free   = w - (kids.length - 1) - fixed.reduce((x, y) => x + y, 0)
      const unit   = free / (kids.filter((k, i) => !fixed[i]).reduce((x, k) => x + (k.grow || 1), 0) || 1)
      const widths = kids.map((k, i) => fixed[i] || Math.floor(unit * (k.grow || 1)))
      widths[widths.length - 1] += w - (widths.reduce((x, y) => x + y, 0) + kids.length - 1)
      const cols   = kids.map((k, i) => inline(k) ? flow([k], widths[i]) : render(k, widths[i]))
      const height = Math.max(...cols.map(c => c.length))
      const out    = []
      for (let r = 0; r < height; r++) out.push(cols.map((c, i) => pad(c[r] ?? '', widths[i])).join(' '))
      return out
    }
    const out = []
    let run = []
    const drain = () => { if (run.length) { out.push(...flow(run, w)); run = [] } }
    for (const k of kids) {
      if (inline(k)) { run.push(k); continue }
      drain()
      out.push(...render(k, w))
    }
    drain()
    return out
  }

  const legend = Object.entries(TIER_PAINT).filter(([k]) => k !== 'Base').map(([k, p]) => p('■ ' + k)).join('  ')
    + '   ' + dim('━ component  ┄ layout  ═ frame/overlay  ') + inv('?') + dim(' a person decides  ') + inv(esc('31')('✗')) + dim(' a tone with no term to land on')
  const text = [...render(a.wf.tree, width), legend].join('\n')
  return color ? text : text.replace(ANSI_RE, '')
}

// ─── .mesa ─────────────────────────────────────────────────────────────────

const ind = (s, n) => s.split('\n').map(l => l ? ' '.repeat(n) + l : l).join('\n')
const q   = s => JSON.stringify(s ?? '')

// House style for a literal: bare keys, single quotes, a short record on one line.
function lit (v, depth = 0) {
  const p = '  '.repeat(depth + 1), end = '  '.repeat(depth)
  if (Array.isArray(v)) return v.length ? `[\n${v.map(x => p + lit(x, depth + 1)).join(',\n')},\n${end}]` : '[]'
  if (v && typeof v === 'object') {
    const es  = Object.entries(v).filter(([, x]) => x !== undefined)
    const one = `{ ${es.map(([k, x]) => `${k}: ${lit(x)}`).join(', ')} }`
    if (es.every(([, x]) => typeof x !== 'object') && one.length <= 90) return one
    return `{\n${es.map(([k, x]) => `${p}${k}: ${lit(x, depth + 1)}`).join(',\n')},\n${end}}`
  }
  return typeof v === 'string' ? `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'` : String(v)
}

/**
 * One file per component, the page, and tones.js where a tone followed a
 * value. `kit` is { Pill: '<import path>', … } for the kit components the app
 * HAS; a term the kit lacks is written as @frontierjs/css class markup.
 */
export function emitMesa (a, { kit = {} } = {}) {
  const { terms, screen } = a.wf
  const cls = (term, mods) => [terms.get(term).class, ...(mods || [])].filter(Boolean).join(' ')
  const CHIPS = new Set(['Pill', 'Badge', 'Avatar', 'Button', 'Link', 'Icon'])

  function leaf (s, expr, uses) {
    const toneAttr = s.tone.mode === 'fixed' ? ` tone="${s.tone.value}"`
                   : s.tone.mode === 'map'   ? (uses.add('toneFor'), ` tone={toneFor(${expr})}`)
                   : s.tone.mode === 'prop'  ? ` tone={${s.toneProp}}`
                   : ''
    const toneCls  = s.tone.mode === 'fixed' ? ' ' + s.tone.value
                   : s.tone.mode === 'map'   ? (uses.add('toneFor'), ` {toneFor(${expr})}`)
                   : ''
    const extra = s.treatment ? ` class="${s.treatment}"` : ''
    const kitOr = (term, withKit, without) => kit[term] ? (uses.add(term), withKit) : without
    switch (s.term) {
      case 'Heading': return `<h${s.sample.level || 3}>{${expr}}</h${s.sample.level || 3}>`
      case 'Kicker':  return `<div class="kicker">{${expr}}</div>`
      case 'Text':    return `<p>{${expr}}</p>`
      case 'Pill':    return kitOr('Pill',  `<Pill${toneAttr}${extra}>{${expr}}</Pill>`,    `<span class="pill${s.treatment ? ' ' + s.treatment : ''}${toneCls}">{${expr}}</span>`)
      case 'Badge':   return kitOr('Badge', `<Badge${toneAttr}${extra}>{${expr}}</Badge>`, `<span class="badge${s.treatment ? ' ' + s.treatment : ''}${toneCls}">{${expr}}</span>`)
      case 'Avatar':  return kitOr('Avatar', `<Avatar name={${expr}} size="sm" />`,        `<span class="avatar">{${expr}}</span>`)
      case 'Icon':
        if (s.dot) return kitOr('Dot', `<Dot tone={${expr}} />`, `<span class="icon" aria-hidden="true">●</span>`)
        return `<span class="icon" aria-hidden="true">{${expr}}</span>`
      case 'Button':  return `<button class="${cls('Button', [s.tone.value, s.treatment].filter(Boolean))}">{${expr}}</button>`
      case 'Link':    return `<a class="link" href="#">{${expr}}</a>`
      case 'Field':   return `<input class="field" placeholder={${expr}}>`
      default:        return `<span class="${terms.get(s.term).class || ''}">{${expr}}</span>`
    }
  }

  function slot (s, uses) {
    if (s.kind === 'comp') {
      uses.add('./' + s.comp.name)
      const item = lcFirst(s.comp.name)
      const each = `{#each ${s.prop} as ${item}}\n  <${s.comp.name} {...${item}} />\n{/each}`
      return s.comp.term === 'Row' ? `<ul class="rows">\n${ind(each, 2)}\n</ul>` : `<div class="stack">\n${ind(each, 2)}\n</div>`
    }
    if (s.term === 'Avatar' && s.many) {
      if (kit.AvatarGroup) { uses.add('AvatarGroup'); return `<AvatarGroup users={${s.prop}} />` }
      return `{#each ${s.prop} as person}\n  <span class="avatar">{person.name}</span>\n{/each}`
    }
    if (s.many) {
      const item = s.prop.replace(/s$/, '')
      return `{#each ${s.prop} as ${item}}\n  ${leaf(s, item, uses)}\n{/each}`
    }
    const m = leaf(s, s.prop, uses)
    return s.optional ? `{#if ${s.prop}}\n  ${m}\n{/if}` : m
  }

  // Chips next to each other in a column share a line.
  function body (slots, uses, owner) {
    const out = []
    let run = []
    const drain = () => { if (run.length) { out.push(`<div class="cluster">\n${ind(run.join('\n'), 2)}\n</div>`); run = [] } }
    slots.forEach((s, i) => {
      if (s.kind === 'wrap') {
        drain()
        // ANATOMY: a Section's heading strip is its .section-header, not a Bar.
        const header = owner === 'Section' && i === 0 && s.children.some(c => c.term === 'Heading')
        const inner  = s.children.map(c => slot(c, uses)).join('\n')
        out.push(`<div class="${header ? 'section-header' : cls(s.term, treat(s.node))}">\n${ind(inner, 2)}\n</div>`)
        return
      }
      const m = slot(s, uses)
      if (s.kind === 'leaf' && CHIPS.has(s.term)) run.push(m)
      else { drain(); out.push(m) }
    })
    drain()
    return out.join('\n')
  }

  function imports (uses, self) {
    const names = [...uses].filter(u => u !== 'toneFor' && u !== './' + self).map(u => u.replace(/^\.\//, ''))
    const w = Math.max(0, ...names.map(n => n.length))
    const lines = []
    for (const u of uses) {
      if (kit[u])                                          lines.push(`import ${u.padEnd(w)} from '${kit[u]}'`)
      else if (u.startsWith('./') && u !== './' + self)    lines.push(`import ${u.slice(2).padEnd(w)} from '${u}.mesa'`)
    }
    if (uses.has('toneFor')) lines.push(`import { toneFor } from './tones.js'`)
    return lines
  }

  const files = {}

  for (const c of a.comps) {
    const uses  = new Set()
    const inner = body(c.slots, uses, c.term)
    const props = []
    const walkProps = ss => ss.forEach(s => {
      if (s.kind === 'wrap') return walkProps(s.children)
      props.push([s.prop, s.kind === 'comp' || s.many ? '[]' : s.optional ? 'undefined' : "''"])
      if (s.toneProp) props.push([s.toneProp, "''"])
    })
    walkProps(c.slots)
    const title = c.slots.find(s => s.term === 'Heading')
    let markup
    switch (c.term) {
      case 'Card':    markup = kit.Card ? (uses.add('Card'), `<Card>\n${ind(inner, 2)}\n</Card>`) : `<article class="card">\n${ind(inner, 2)}\n</article>`; break
      case 'Row':     markup = `<li class="list-row">\n${ind(inner, 2)}\n</li>`; break
      case 'Section': markup = `<section class="stack"${title ? ` aria-label={${title.prop}}` : ''}>\n${ind(inner, 2)}\n</section>`; break
      default:        markup = `<div class="${cls(c.term)}">\n${ind(inner, 2)}\n</div>`
    }
    const w   = Math.max(...props.map(p => p[0].length))
    const imp = imports(uses, c.name)
    files[`${c.name}.mesa`] = `<script>
  // ${c.name}.mesa — a ${c.term}, seen ${c.nodes.length} times on the ${screen} screen.
  // Written by fli make:wireframe; the props are what differed between copies.
${imp.length ? ind(imp.join('\n'), 2) + '\n' : ''}
${props.map(([p, d]) => `  export let ${p.padEnd(w)} = ${d}`).join('\n')}
</script>

${markup}
`
  }

  // The page: everything seen once, and each run of copies as one {#each}.
  const data = {}
  const uses = new Set()
  const ROWISH = new Set(['Shell', 'Split', 'Cluster', 'Toolbar', 'Bar', 'Topbar', 'Group', 'Tabs', 'Row'])
  function el (n) {
    const t    = terms.get(n.term)
    const kids = n.children || []
    const mods = n.mods || []
    const bad  = mods.filter(m => TONES.includes(m) && !TONE_TAKERS.has(n.term))
    const ok   = mods.filter(m => !bad.includes(m))
    const pre  = [
      n.unsure && `<!-- ? ${n.unsure.join(' | ')} — the screenshot cannot say which -->`,
      bad.length && `<!-- ✗ the screen colors this ${bad.join('/')}, and a ${n.term} takes no tone -->`,
    ].filter(Boolean).join('\n')
    const P = pre ? pre + '\n' : ''
    const tone = toneOf(n)
    if (a.inline(n)) {
      const x = n.text ?? ''
      switch (n.term) {
        case 'Heading': return P + `<h${n.level || 2}>${x}</h${n.level || 2}>`
        case 'Text':    return P + (ROWISH.has(a.parent.get(n)?.term) ? `<span>${x}</span>` : `<p>${x}</p>`)
        case 'Button':  return P + `<button class="${cls('Button', ok)}">${x}</button>`
        case 'Link':    return P + `<a class="${cls('Link', ok)}" href="#">${x}</a>`
        case 'Field':   return P + `<input class="${cls('Field', ok)}" placeholder=${q(x)}>`
        case 'Pill':    if (kit.Pill)  { uses.add('Pill');  return P + `<Pill${tone ? ` tone="${tone}"` : ''}>${x}</Pill>` }  break
        case 'Badge':   if (kit.Badge) { uses.add('Badge'); return P + `<Badge${tone ? ` tone="${tone}"` : ''}>${x}</Badge>` } break
        case 'Icon':    return P + `<span class="icon" aria-hidden="true">${x}</span>`
      }
      return P + `<span class="${cls(n.term, ok)}">${x}</span>`
    }
    if (n.term === 'Kicker') return P + `<div class="kicker">${n.text ?? ''}</div>`
    if (n.term === 'Nav') {
      const items = String(n.text || '').split('\n').filter(Boolean)
        .map(g => `  <li><a class="navlink" href="#" aria-label="TODO">${g}</a></li>`).join('\n')
      return P + `<ul class="navlist">\n${items}\n</ul>`
    }
    const inner = []
    for (let i = 0; i < kids.length;) {
      const c = a.cand.get(kids[i])
      if (c) {
        let j = i
        while (j < kids.length && a.cand.get(kids[j]) === c) j++
        let key = lcFirst(c.name) + 's'
        for (let s = 2; data[key]; s++) key = lcFirst(c.name) + 's' + s
        data[key] = kids.slice(i, j).map(k => extract(a, c, k))
        uses.add('./' + c.name)
        inner.push(`{#each ${key} as ${lcFirst(c.name)}}\n  <${c.name} {...${lcFirst(c.name)}} />\n{/each}`)
        i = j
        continue
      }
      inner.push(el(kids[i]))
      i++
    }
    if (n.text && kids.length) inner.unshift(`<!-- ${n.text} -->`)
    const tag = {
      App: 'div', Shell: 'div', Topbar: 'header', Sidebar: 'nav', Screen: 'main', Pane: 'section',
      Section: 'section', Card: 'article', Tile: 'article', Alert: 'article', Row: 'li',
    }[n.term] || 'div'
    const attrs = [
      t.class || ok.length ? `class="${cls(n.term, ok)}"` : '',
      n.term === 'Toolbar' ? 'role="toolbar"' : '',
      n.term === 'Pane' ? 'aria-label="TODO"' : '',
    ].filter(Boolean).join(' ')
    return P + `<${tag}${attrs ? ' ' + attrs : ''}>\n${ind(inner.join('\n'), 2)}\n</${tag}>`
  }
  const markup = el(a.wf.tree)
  const imp = imports(uses, screen)
  files[`${screen}.mesa`] = `<script>
  // ${screen}.mesa — the screen as the wireframe drew it. Written by fli make:wireframe.
  // The data below is what the screenshot showed, lifted into each component's
  // props; it is what a resource replaces.
${imp.length ? ind(imp.join('\n'), 2) + '\n' : ''}
${Object.entries(data).map(([k, v]) => `  const ${k} = ${lit(v, 1)}`).join('\n\n')}
</script>

${markup}
`

  const entries = Object.entries(a.tones)
  if (entries.length) {
    const tw = Math.max(...entries.map(([k]) => lit(k).length))
    files['tones.js'] = `// tones.js — which tone a value gets, as the screenshot colored it. Written
// by fli make:wireframe. Whether a value is good news is not something a
// screenshot holds, so read this as a first guess.
export const TONES = {
${entries.map(([k, v]) => `  ${(lit(k) + ':').padEnd(tw + 1)} '${v}',`).join('\n')}
}

export const toneFor = (value) => TONES[value] ?? 'muted'
`
  }
  return files
}

// ─── the draft schema ──────────────────────────────────────────────────────

const AGE      = /^\d+\s?(?:[smhdw]|mo)$/
const PHONE    = /^\(?\d{3}\)?[\s.-]?\d{3}-\d{4}$/
const MORE     = /^…\s*\d+\s+more/
const PRIORITY = new Set(['low', 'normal', 'medium', 'high', 'urgent', 'critical'])
const clean    = s => String(s ?? '').replace(/[^\p{L}\p{N})]+$/u, '').trim()
const camel    = s => lcFirst(s.toLowerCase().replace(/[^a-z0-9]+(.)/g, (_, c) => c.toUpperCase()).replace(/[^a-zA-Z0-9]/g, ''))
const plural   = s => s.endsWith('s') ? s + 'es' : s.endsWith('y') ? s.slice(0, -1) + 'ies' : s + 's'
const splitAge = v => {
  const [x, y] = String(v ?? '').split(' · ')
  return y && AGE.test(y.trim()) ? [clean(x), y.trim()] : [clean(v), null]
}

/**
 * A db/schema.lite draft. Every model, field and enum says on a `///` line
 * what on screen it came from, and a gate is always a placeholder — who may
 * read a row is not something a screenshot shows.
 *
 *   a component holding a list of another      a BUCKET: titled by a key
 *   a component that is listed                 a RECORD: one row per copy
 *   a Badge                                    an enum of the values seen
 *   a Pill                                     a count — derived, never stored
 *   a run of Avatars                           people, many-to-many
 *   "name · 6d"                                a name, and createdAt
 *   a name that is another bucket's key        a relation to that model
 */
export function draftSchema (a) {
  const modelName = c => a.wf.models[c.name] || c.name.replace(/(Card|Row|Group|Item|Tile)$/, '') || c.name
  const flat = slots => slots.flatMap(s => s.kind === 'wrap' ? flat(s.children) : [s])
  const vals = s => s.per.flat().map(k => ({ text: k.text, tone: toneOf(k) || null }))

  const models = a.comps.map(c => {
    const slots = flat(c.slots)
    const child = slots.find(s => s.kind === 'comp')?.comp
    return { c, name: modelName(c), slots, child }
  })
  const byComp   = new Map(models.map(m => [m.c, m]))
  const bucketOf = new Map(models.filter(m => m.child).map(m => [m.child, m]))
  const keySlot  = m => m.slots.find(s => s.kind === 'leaf' && s.term === 'Heading')
                     || m.slots.find(s => s.kind === 'leaf' && s.term === 'Text' && !s.many && !vals(s).some(v => MORE.test(v.text ?? '')))
  const keys = new Map(models.filter(m => m.child).map(m => [m, vals(keySlot(m) || { per: [] }).map(v => clean(v.text))]))

  const enums = [], extra = []
  let needUser = false, needTone = false

  function enumFor (model, s, i) {
    const freq = new Map()
    for (const v of vals(s).map(v => v.text).filter(Boolean)) freq.set(v, (freq.get(v) || 0) + 1)
    const words = [...freq.keys()]
    const kind  = words.every(w => PRIORITY.has(w.toLowerCase())) ? 'Priority' : i ? 'Kind' : 'Status'
    const def   = [...freq].sort((x, y) => y[1] - x[1])[0][0]
    const mw    = Math.max(...words.map(w => camel(w).length))
    const tones = [...new Set(vals(s).map(v => v.tone).filter(Boolean))]
    enums.push([
      `/// Seen on screen: ${words.map(w => `"${w}"`).join(', ')}. Only what the screen showed —`,
      `/// a member no row happened to be in is missing.${tones.length ? ` Drawn ${tones.join('/')}.` : ''}`,
      ...(words.length === 1 ? ['/// One value is not a scale; the rest of it is a question for whoever owns the screen.'] : []),
      `enum ${model}${kind} {`,
      ...words.map(w => '  ' + (camel(w) === w ? w : `${camel(w).padEnd(mw)} @label("${w}")`)),
      '}',
    ].join('\n'))
    return { field: lcFirst(kind), type: model + kind, attrs: `@default(${camel(def)})`, doc: 'the commonest value on screen is the default' }
  }

  const blocks = models.map(m => {
    const out  = [{ field: 'id', type: 'Int', attrs: '@id' }]
    const docs = []
    const why  = []
    const key  = m.child ? keySlot(m) : null
    const bucket = bucketOf.get(m.c)
    let aged = false, badges = 0
    for (const s of m.slots) {
      if (s.kind === 'comp' || s === key) continue
      const texts = vals(s).map(v => v.text)
      if (s.dot) { needTone = true; out.push({ field: 'tone', type: 'Tone', attrs: '@default(muted)', doc: 'each copy wore a different colored dot, so someone chooses it' }); continue }
      if (texts.some(v => MORE.test(v ?? ''))) { docs.push(`"${texts[0]}" under the list — the list is paged, not a column`); continue }
      switch (s.term) {
        case 'Pill':
          docs.push(`"${texts.join('", "')}" is a count${s.optional ? ' shown on some copies only' : ''} — derived at read, never stored`)
          break
        case 'Badge':
          out.push(enumFor(m.name, s, badges++))
          break
        case 'Avatar':
          if (!s.many) { docs.push('the avatar is the initial of a name this row already has'); break }
          needUser = true
          extra.push(joinModel(m.name))
          out.push({ field: 'assignees', type: `${m.name}Assignee[]`, doc: 'the avatars: people, one or more to a copy' })
          break
        case 'Heading':
        case 'Kicker':
        case 'Text': {
          const split = texts.map(splitAge)
          if (split.some(([, age]) => age)) aged = true
          const names  = split.map(([n]) => n)
          const target = [...keys].find(([b, ks]) => b !== m && b !== bucket && names.some(n => ks.includes(n)))
          if (target) {
            const tm  = target[0].name
            const hit = names.filter(n => target[1].includes(n))
            out.push({ field: lcFirst(tm), type: tm + '?', attrs: `@relation(fields: [${lcFirst(tm)}Id], references: [id], onDelete: SetNull)`,
                       doc: `the ${s.term.toLowerCase()} named ${hit.map(h => `"${h}"`).join(', ')}, which is also a ${tm} on this screen` })
            out.push({ field: lcFirst(tm) + 'Id', type: 'Int?' })
            break
          }
          const field = s.term === 'Heading' ? 'title' : s.term === 'Kicker' ? 'from' : out.some(f => f.field === 'body') ? s.prop : 'body'
          out.push({ field, type: 'String' + (s.optional ? '?' : ''), doc: texts.some(v => /…$/.test(v ?? '')) ? 'the screen cut it off, so it is longer than it looks' : undefined })
        }
      }
    }
    if (aged) out.push({ field: 'createdAt', type: 'DateTime', attrs: '@default(now())', doc: '"6d", "2w", "49m" — an age, so there is a moment it counts from' })

    if (m.child) {
      const k = keys.get(m), phones = k.filter(x => PHONE.test(x))
      why.push(`${m.c.nodes.length} ${m.c.name}s on screen, each holding a list of ${m.child.name} — a ${m.name} is what they are grouped by.`)
      why.push(`Titled ${k.map(x => `"${x}"`).join(', ')}.`)
      if (vals(key || { per: [] }).some(v => /…$/.test(v.text ?? ''))) why.push('Some titles were cut off on screen; those names are partial.')
      if (phones.length && phones.length < k.length)
        out.splice(1, 0, { field: 'name', type: 'String?', doc: `some groups were titled by a phone number instead: ${phones.join(', ')}` }, { field: 'phone', type: 'String?', attrs: '@phone' })
      else out.splice(1, 0, { field: 'name', type: 'String', attrs: '@unique' })
      const kids = byComp.get(m.child).name
      out.push({ field: plural(lcFirst(kids)), type: kids + '[]' })
      if (m.slots.some(s => s.dot)) out.push({ field: 'position', type: 'Int', attrs: '@default(0)', doc: 'they sit side by side in an order somebody chose' })
    } else {
      why.push(`${m.c.nodes.length} ${m.c.name}s on screen, one row each.`)
    }
    if (bucket) {
      const b = bucket.name
      out.push({ field: lcFirst(b), type: b, attrs: `@relation(fields: [${lcFirst(b)}Id], references: [id], onDelete: Cascade)`, doc: `every ${m.c.name} sat inside a ${bucket.c.name}` })
      out.push({ field: lcFirst(b) + 'Id', type: 'Int' })
      if (bucket.slots.some(s => s.dot)) out.push({ field: 'position', type: 'Int', attrs: '@default(0)', doc: 'stacked in an order, and a board is dragged' })
    }

    const w1 = Math.max(...out.map(f => f.field.length)), w2 = Math.max(...out.map(f => f.type.length))
    const lines = out.flatMap(f => [
      ...(f.doc ? [`  /// ${f.doc}`] : []),
      `  ${f.field.padEnd(w1)} ${f.type.padEnd(w2)}${f.attrs ? ' ' + f.attrs : ''}`.trimEnd(),
    ])
    return [
      ...why.map(l => `/// ${l}`),
      ...docs.map(l => `/// ${l[0].toUpperCase() + l.slice(1)}.`),
      `model ${m.name} {`,
      ...lines,
      '',
      '  /// Who may read or change one is not something a screenshot shows. 4 is a placeholder.',
      '  @@gate("4")',
      '}',
    ].join('\n')
  })

  function joinModel (owner) {
    const o = lcFirst(owner)
    return [
      '/// The avatars on a copy. Nothing on screen says which user is which, or whether order matters.',
      `model ${owner}Assignee {`,
      `  id       Int     @id`,
      `  ${o.padEnd(8)} ${owner.padEnd(7)} @relation(fields: [${o}Id], references: [id], onDelete: Cascade)`,
      `  ${(o + 'Id').padEnd(8)} Int`,
      `  user     User    @relation(fields: [userId], references: [id], onDelete: Cascade)`,
      `  userId   Int`,
      '',
      `  @@unique([${o}Id, userId])`,
      '  @@gate("4")',
      '}',
    ].join('\n')
  }

  const head = `// ${a.wf.screen}.draft.lite — a DRAFT read off one screen by fli make:wireframe.
// Every model, field and enum says on a /// line what on screen it came from;
// a line that cannot say is a guess, and a gate is always one. Nothing reads
// this file: move what survives into db/schema.lite by hand.`
  const tone = needTone ? '/// The seven tones @frontierjs/css draws with — a column that stores one.\nenum Tone { primary secondary muted info success warning danger }' : ''
  const user = needUser ? '/// A stand-in so the draft parses on its own. In an app this is the User\n/// fli auth:install writes, and this block is deleted.\nmodel User {\n  id   Int    @id\n  name String\n\n  @@gate("4")\n}' : ''
  return [head, ...enums, tone, ...blocks, ...extra, user].filter(Boolean).map(b => b.trim()).join('\n\n') + '\n'
}
