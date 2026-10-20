// ─── git-history — commits per day as a column chart, time across ───────────
//
// Pure: `git log --shortstat` or `--name-status` text in, a series out, rows of
// text out. The
// command runs git and prints. No exec here, so it is testable with fixtures.
//
// Time is the x axis and it must be CONTINUOUS: a day with no commits is a
// zero-height column, never a skipped one, or two busy weeks either side of a
// quiet one read as one stretch.

const DAY = 86_400_000
const COMMIT_ZERO = { commits: 0, added: 0, deleted: 0, created: 0, edited: 0, removed: 0 }
const EIGHTHS = ['', '▁', '▂', '▃', '▄', '▅', '▆', '▇']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// Dates are handled as UTC midnights of the LOCAL calendar day git printed
// (`--date=short-local`), so stepping by 86400000 never crosses a DST seam.
const toTime = (ymd) => Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10))
const toYmd = (t) => new Date(t).toISOString().slice(0, 10)

// A name-status line: the letter, a similarity score on R and C, a tab. A
// rename is an edit to a file that already existed; git detects copies only
// when asked, so C is rare and counts as a new file.
const STATUS = /^([ACDMRT])\d*\t/
const FILE_FIELD = { A: 'created', C: 'created', M: 'edited', T: 'edited', R: 'edited', D: 'removed' }

// The log format the command asks for: `--format=@%ad` with `--shortstat` or
// `--name-status` (git prints one or the other, never both). The `@` marks a
// commit line, because a shortstat line also starts with a digit.
export const parseLog = (text) => {
  const days = new Map()
  let day = null
  for (const line of text.split('\n')) {
    if (line.startsWith('@')) {
      day = line.slice(1).trim()
      const d = days.get(day) ?? { ...COMMIT_ZERO }
      d.commits++
      days.set(day, d)
    } else if (!day) continue
    // Checked before the shortstat test: a path can contain the word "changed".
    else if (STATUS.test(line)) days.get(day)[FILE_FIELD[line[0]]]++
    else if (line.includes('changed')) {
      const d = days.get(day)
      d.added += +(line.match(/(\d+) insertion/)?.[1] ?? 0)
      d.deleted += +(line.match(/(\d+) deletion/)?.[1] ?? 0)
    }
  }
  return days
}

// One bucket per day from `from` to `to` inclusive, or per week (Monday start)
// when `by` is 'week'. Every bucket exists, zero or not. `zero` names the fields
// a bucket sums, so a second source charts on the same columns.
export const buildSeries = (days, { from, to, by = 'day', zero = COMMIT_ZERO }) => {
  let start = toTime(from)
  const end = toTime(to)
  if (by === 'week') start -= ((new Date(start).getUTCDay() + 6) % 7) * DAY
  const step = by === 'week' ? 7 * DAY : DAY
  const buckets = []
  for (let t = start; t <= end; t += step) buckets.push({ date: toYmd(t), ...zero })
  for (const [ymd, d] of days) {
    const t = toTime(ymd)
    if (t < start || t > end) continue
    const b = buckets[Math.floor((t - start) / step)]
    for (const k in zero) b[k] += d[k] ?? 0
  }
  return { by, buckets }
}

// A tick step for the y axis that lands on 1·2·5 × 10ⁿ, so labels read as round
// numbers whatever the peak is.
const niceMax = (max, rows) => {
  if (max <= rows) return Math.max(max, 1)
  const raw = max / rows
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 5, 10].map(m => m * mag).find(s => s >= raw)
  return step * rows
}

// The chart as plain rows — `bar` is applied to each column's glyphs so the
// caller decides color. `width` is the whole line, axis included. `max` puts
// two charts drawn one above the other on one scale, so their heights compare.
export const renderChart = (series, { height = 12, width = 100, value = (b) => b.commits, max = 0, bar = (s) => s, dim = (s) => s, label = (v) => String(Math.round(v)) } = {}) => {
  const { buckets, by } = series
  const values = buckets.map(value)
  const top = niceMax(Math.max(max, ...values), height)
  // Measured over every tick, because a compact label is not widest at the top: 4.5M over 6M.
  const axisW = Math.max(1, ...Array.from({ length: height }, (_, i) => label((top * (height - i)) / height).length))

  // Column width: as wide as the screen allows, up to three cells. The last
  // cell of a wide column is a gap so neighbors stay apart.
  const avail = width - axisW - 2
  const col = Math.max(1, Math.min(3, Math.floor(avail / buckets.length)))
  const barW = col > 1 ? col - 1 : 1
  const pad = ' '.repeat(col - barW)

  const rows = []
  for (let r = height; r >= 1; r--) {
    // Label every other row from the top, and always the top one.
    const tick = (height - r) % 3 === 0
    const y = tick ? label((top * r) / height).padStart(axisW) : ' '.repeat(axisW)
    let line = ''
    for (const v of values) {
      // How many eighths of THIS row the column fills.
      const eighths = Math.round(((v / top) * height - (r - 1)) * 8)
      const cell = eighths >= 8 ? '█' : eighths > 0 ? EIGHTHS[eighths] : ''
      // A day with any commit shows at least a sliver, so 1 is never 0.
      const glyph = cell || (r === 1 && v > 0 ? '▁' : ' ')
      line += (glyph === ' ' ? ' '.repeat(barW) : bar(glyph.repeat(barW))) + pad
    }
    rows.push(`${dim(y)} ${dim(tick ? '┤' : '│')}${line.replace(/\s+$/, '')}`)
  }
  rows.push(`${' '.repeat(axisW)} ${dim('└' + '─'.repeat(buckets.length * col))}`)

  // Two label rows: day of month on Mondays (every bucket when weekly), and the
  // month name where a month starts. A label that would overlap the one before
  // it is dropped rather than shifted, so a label always sits under its column.
  const dayRow = Array(buckets.length * col).fill(' ')
  const monRow = Array(buckets.length * col).fill(' ')
  const place = (row, at, text) => {
    if (at + text.length > row.length) return
    if (at > 0 && row[at - 1] !== ' ') return
    for (let i = 0; i < text.length; i++) if (row[at + i] !== ' ') return
    for (let i = 0; i < text.length; i++) row[at + i] = text[i]
  }
  let lastMonth = null
  buckets.forEach((b, i) => {
    const d = new Date(toTime(b.date))
    const at = i * col
    if (by === 'week' || d.getUTCDay() === 1) place(dayRow, at, String(d.getUTCDate()))
    if (d.getUTCMonth() !== lastMonth) {
      place(monRow, at, MONTHS[d.getUTCMonth()] + (d.getUTCMonth() === 0 || lastMonth === null ? ` ${d.getUTCFullYear()}` : ''))
      lastMonth = d.getUTCMonth()
    }
  })
  const indent = ' '.repeat(axisW + 2)
  rows.push(indent + dim(dayRow.join('').replace(/\s+$/, '')))
  rows.push(indent + dim(monRow.join('').replace(/\s+$/, '')))
  return rows
}

export const summarize = (series, value = (b) => b.commits) => {
  const { buckets } = series
  const sum = (k) => buckets.reduce((a, b) => a + b[k], 0)
  const busiest = buckets.reduce((a, b) => (value(b) > value(a) ? b : a), buckets[0])
  const active = buckets.filter(b => b.commits).length
  return {
    commits: sum('commits'), added: sum('added'), deleted: sum('deleted'),
    created: sum('created'), edited: sum('edited'), removed: sum('removed'),
    active, buckets: buckets.length, busiest,
  }
}
