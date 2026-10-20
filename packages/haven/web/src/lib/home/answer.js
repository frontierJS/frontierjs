// src/lib/home/answer.js — what the desk can draw (`components/Desk.mesa`), pure.
//
// The model answering a question at the desk never writes a screen. It picks
// blocks from `BLOCKS` and fills them, `SCHEMA` holds its output to that
// shape, and `readAnswer` drops whatever still does not fit, so a block the
// desk has no drawing for is said by name in the pane instead of drawn wrong.
// `answerRows` lays the blocks out as rows of colored runs, each `{ x, text,
// color }`, for a pane `w` cells wide.
//
// A block names a TONE, never a color (Invariant 13); `TONES` is the one place
// a tone becomes ink, so the model cannot paint a row in a color the room's
// palette never chose.
import { cells, clip } from '../scene/cells.js'

export const TONES = {
  ok:     '#4ade80',
  warn:   '#facc15',
  danger: '#f87171',
  info:   '#38bdf8',
  muted:  '#9ca3af',
}
const INK  = '#e5e7eb'
const HEAD = '#fde68a'
const inkOf = (tone) => TONES[tone] ?? INK

/** Each block's fields as the model is told them; `DESK_PROMPT` lists these. */
export const BLOCKS = {
  heading: '{ kind, text } -- a section title',
  text:    '{ kind, text, tone? } -- a sentence or two, wrapped',
  stats:   '{ kind, items: [{ label, value, note?, tone? }] } -- one to four numbers side by side; value short ("12", "3d", "$4k")',
  table:   '{ kind, columns: [string], rows: [[string]] } -- records; at most 5 columns, 12 rows',
  bars:    '{ kind, items: [{ label, value: number, tone? }] } -- an amount per category, largest first',
  spark:   '{ kind, label, values: [number], note? } -- a value over time, oldest first',
  list:    '{ kind, items: [{ text, note?, tone?, url? }] } -- items with a status; note is a when or a who, url the Basecamp link of what the item names',
  callout: '{ kind, text, tone } -- the one thing to notice',
}

const item = {
  type: 'object',
  properties: {
    label: { type: 'string' },
    value: { type: ['string', 'number'] },
    text:  { type: 'string' },
    note:  { type: 'string' },
    tone:  { enum: Object.keys(TONES) },
    url:   { type: 'string' },
  },
}

/** The `--json-schema` the model's answer is held to. Loose per kind; `readAnswer` is the strict half. */
export const SCHEMA = {
  type: 'object',
  required: ['title', 'blocks'],
  properties: {
    title:  { type: 'string' },
    blocks: {
      type: 'array',
      items: {
        type: 'object',
        required: ['kind'],
        properties: {
          kind:    { enum: Object.keys(BLOCKS) },
          text:    { type: 'string' },
          label:   { type: 'string' },
          note:    { type: 'string' },
          tone:    { enum: Object.keys(TONES) },
          columns: { type: 'array', items: { type: 'string' } },
          rows:    { type: 'array', items: { type: 'array', items: { type: ['string', 'number'] } } },
          values:  { type: 'array', items: { type: 'number' } },
          items:   { type: 'array', items: item },
        },
      },
    },
  },
}

/** The desk's system prompt: where the data is, what may be drawn, and how to choose. */
export const DESK_PROMPT = [
  'You answer a question asked at a desk in Haven, a place drawn in a terminal.',
  'Find what the answer needs in Basecamp with the basecamp CLI. You may only read:',
  'list, show, search, chat messages, schedule entries, assignments, reports.',
  'Every command takes --json; --jq filters the whole envelope { ok, data }, so start it at .data.',
  'Run `basecamp commands` to see what exists. Ask for little: filter with --jq rather than reading everything.',
  '',
  'Then answer with blocks from this list, and nothing else:',
  ...Object.entries(BLOCKS).map(([k, v]) => `- ${k}: ${v}`),
  '',
  'Choose a block by the shape of what you found: a few headline numbers are stats, a value',
  'over time is spark, an amount per category is bars, records are a table, things with a',
  'status are a list, the one thing that matters is a callout. Lead with the answer.',
  'The pane is 90 cells wide and about 20 rows: three to six blocks. Tones are ok, warn,',
  'danger, info, muted -- never a color. Say times relative ("2d ago", "due Fri"). If',
  'Basecamp does not hold the answer, say so in a callout.',
  '',
  'A question may come after what the desk is showing, as JSON: answer about that first and',
  'read Basecamp only for what it lacks. A later question follows on from your last answer.',
].join('\n')

// ─── reading ──────────────────────────────────────────────────────────────────

const str  = (v) => (v == null ? '' : String(v))
const num  = (v) => (Number.isFinite(Number(v)) ? Number(v) : null)
const arr  = (v) => (Array.isArray(v) ? v : [])
const tone = (v) => (v in TONES ? v : undefined)
// Only a web link: the terminal opens what it is handed, so a `file:` or a
// scheme of the model's choosing is dropped and the item kept as text.
const url  = (v) => (/^https?:\/\//.test(str(v)) ? str(v) : undefined)
// A filter key is a word a report gives a count and the items it counts; the
// model is never told of it, so an `/ask` answer has none and Tab finds none.
const word = (v) => (/^[a-z][a-z-]{0,23}$/.test(str(v)) ? str(v) : undefined)
const words = (v) => arr(v).map(word).filter(Boolean)

const READERS = {
  heading: (b) => b.text && { text: str(b.text) },
  text:    (b) => b.text && { text: str(b.text), tone: tone(b.tone) },
  callout: (b) => b.text && { text: str(b.text), tone: tone(b.tone) ?? 'info' },
  stats:   (b) => {
    const items = arr(b.items).filter((i) => i?.label != null && i?.value != null)
      .map((i) => ({ label: str(i.label), value: str(i.value), note: str(i.note), tone: tone(i.tone), key: word(i.key) }))
    return items.length && { items: items.slice(0, 4) }
  },
  table:   (b) => {
    const columns = arr(b.columns).map(str).slice(0, 5)
    const rows = arr(b.rows).filter(Array.isArray).map((r) => columns.map((_, i) => str(r[i])))
    return columns.length && { columns, rows: rows.slice(0, 12) }
  },
  bars:    (b) => {
    const items = arr(b.items).filter((i) => i?.label != null && num(i.value) != null)
      .map((i) => ({ label: str(i.label), value: num(i.value), tone: tone(i.tone) }))
    return items.length && { items: items.slice(0, 10) }
  },
  spark:   (b) => {
    const values = arr(b.values).map(num).filter((v) => v != null)
    return values.length && { label: str(b.label), values, note: str(b.note) }
  },
  list:    (b) => {
    const items = arr(b.items).filter((i) => i?.text)
      .map((i) => ({ text: str(i.text), note: str(i.note), tone: tone(i.tone), url: url(i.url), ...(words(i.keys).length ? { keys: words(i.keys) } : {}) }))
    return items.length && { items: items.slice(0, 12) }
  },
}

/**
 * The model's answer as the desk draws it: `{ title, blocks }`, each block one
 * `BLOCKS` names with its fields cut to what it draws. A block of another kind,
 * or one missing what it needs, is kept as `{ kind: 'unknown', named }` so the
 * pane says what it could not draw.
 */
export function readAnswer(raw) {
  const a = raw && typeof raw === 'object' ? raw : {}
  const blocks = arr(a.blocks).map((b) => {
    const read = READERS[b?.kind]?.(b)
    return read ? { kind: b.kind, ...read } : { kind: 'unknown', named: str(b?.kind) || '(none)' }
  })
  return { title: str(a.title), blocks }
}

// ─── filtering ────────────────────────────────────────────────────────────────

/** The counts Tab steps through, in the order drawn: `[{ key, label, value }]`, each with an item carrying its key. */
export function filtersOf(answer) {
  const carried = new Set(answer.blocks.flatMap((b) => b.kind === 'list' ? b.items.flatMap((i) => i.keys ?? []) : []))
  return answer.blocks.flatMap((b) => b.kind === 'stats' ? b.items.filter((i) => i.key && carried.has(i.key)) : [])
}

/**
 * `answer` with its lists cut to the items carrying `key`; a list left empty
 * goes, and so does a heading with no list of its own left under it. The
 * counts stay, so the tile that chose the filter is still there to read.
 */
export function filterAnswer(answer, key) {
  if (!key) return answer
  const cut = answer.blocks.map((b) => b.kind === 'list' ? { ...b, items: b.items.filter((i) => i.keys?.includes(key)) } : b)
    .filter((b) => b.kind !== 'list' || b.items.length)
  const blocks = cut.filter((b, n) => b.kind !== 'heading' || (cut[n + 1] && cut[n + 1].kind !== 'heading'))
  return { ...answer, blocks }
}

// ─── drawing ──────────────────────────────────────────────────────────────────

const pad = (s, n) => {
  const t = clip(s, n)
  return t + ' '.repeat(Math.max(0, n - cells(t)))
}

/** `text` in rows of at most `w` cells, broken between words. */
export function wrap(text, w) {
  const rows = []
  let row = ''
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = row ? `${row} ${word}` : word
    if (cells(next) <= w) { row = next; continue }
    if (row) rows.push(row)
    row = cells(word) > w ? clip(word, w) : word
  }
  if (row) rows.push(row)
  return rows
}

const SPARK = '▁▂▃▄▅▆▇█'

/** `values` as one glyph each, lowest to highest. */
export function sparkline(values) {
  const lo = Math.min(...values), hi = Math.max(...values)
  return values.map((v) => SPARK[hi === lo ? 3 : Math.round(((v - lo) / (hi - lo)) * (SPARK.length - 1))]).join('')
}

const run = (x, text, color = INK, url) => (url ? { x, text, color, url } : { x, text, color })

const DRAW = {
  heading: (b, w) => [[run(0, clip(b.text, w), HEAD)], [run(0, '─'.repeat(Math.min(w, cells(b.text))), HEAD)]],
  text:    (b, w) => wrap(b.text, w).map((t) => [run(0, t, inkOf(b.tone))]),
  callout: (b, w) => wrap(b.text, w - 2).map((t) => [run(0, '▌', inkOf(b.tone)), run(2, t, inkOf(b.tone))]),

  stats: (b, w, { picked }) => {
    const tile = Math.floor(w / b.items.length)
    const inner = tile - 2
    const row = (pick) => b.items.flatMap((i, n) => {
      const [text, color] = pick(i)
      return text ? [run(n * tile, clip(text, inner), color)] : []
    })
    return [
      row((i) => i.key && i.key === picked ? [`▸ ${i.label}`, HEAD] : [i.label, TONES.muted]),
      row((i) => [i.value, inkOf(i.tone)]),
      row((i) => [i.note, TONES.muted]),
    ].filter((r) => r.length)
  },

  table: (b, w) => {
    const all = [b.columns, ...b.rows]
    const want = b.columns.map((_, c) => Math.max(...all.map((r) => cells(r[c]))) + 2)
    const total = want.reduce((s, n) => s + n, 0)
    // The widest column gives up width a cell at a time; taking it from the last
    // column cut a short "Who" or "Late" to two letters beside a long title.
    const widths = want.slice()
    for (let over = total - w; over > 0; over--) {
      const c = widths.indexOf(Math.max(...widths))
      if (widths[c] <= 6) break
      widths[c]--
    }
    const xs = widths.map((_, c) => widths.slice(0, c).reduce((s, n) => s + n, 0))
    const line = (r, color) => r.map((t, c) => run(xs[c], clip(t, widths[c] - 2), color)).filter((x) => x.text)
    return [line(b.columns, TONES.muted), [run(0, '─'.repeat(Math.min(w, xs.at(-1) + widths.at(-1) - 2)), TONES.muted)], ...b.rows.map((r) => line(r, INK))]
  },

  bars: (b, w) => {
    const label = Math.min(24, Math.max(...b.items.map((i) => cells(i.label))))
    const figures = b.items.map((i) => String(i.value))
    const fig = Math.max(...figures.map((f) => f.length))
    const room = Math.min(48, Math.max(4, w - label - fig - 3))
    const max = Math.max(...b.items.map((i) => i.value), 0)
    return b.items.map((i, n) => {
      const len = max > 0 ? Math.max(i.value > 0 ? 1 : 0, Math.round((i.value / max) * room)) : 0
      return [
        run(0, pad(i.label, label), INK),
        run(label + 1, '█'.repeat(len), inkOf(i.tone ?? 'info')),
        run(label + 2 + len, figures[n], TONES.muted),
      ].filter((x) => x.text)
    })
  },

  spark: (b, w) => {
    const label = b.label ? clip(b.label, Math.floor(w / 3)) : ''
    const at = label ? cells(label) + 2 : 0
    const line = sparkline(b.values.slice(-(w - at - 12)))
    const last = String(b.values.at(-1))
    return [
      [run(0, label, INK), run(at, line, TONES.info), run(at + line.length + 1, last, INK)].filter((x) => x.text),
      ...(b.note ? [[run(at, clip(b.note, w - at), TONES.muted)]] : []),
    ]
  },

  list: (b, w, { urls }) => {
    const note = Math.min(16, Math.max(0, ...b.items.map((i) => cells(i.note))))
    const text = w - 2 - (note ? note + 2 : 0)
    return b.items.flatMap((i) => [
      [
        run(0, '•', inkOf(i.tone ?? 'muted')),
        run(2, clip(i.text, text), inkOf(i.tone), i.url),
        ...(i.note ? [run(w - note, clip(i.note, note), TONES.muted)] : []),
      ],
      // Broken across rows rather than clipped: a URL cut short opens nothing.
      ...(urls && i.url ? i.url.match(new RegExp(`.{1,${w - 2}}`, 'g')).map((part) => [run(2, part, TONES.muted)]) : []),
    ])
  },

  unknown: (b) => [[run(0, `(the desk has no drawing for a "${b.named}" block)`, TONES.muted)]],
}

/**
 * Every row of an answer for a pane `w` cells wide: its blocks, a blank row
 * between each. A run carrying `url` is a link; `urls` prints each under its
 * item, for a terminal that cannot open a hyperlink and would lose it;
 * `picked` marks the count whose key the lists are filtered by.
 */
export function answerRows(answer, w, { urls = false, picked = null } = {}) {
  const rows = []
  for (const b of answer.blocks) {
    if (rows.length) rows.push([])
    rows.push(...DRAW[b.kind](b, w, { urls, picked }))
  }
  return rows
}
