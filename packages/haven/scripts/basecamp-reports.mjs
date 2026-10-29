// scripts/basecamp-reports.mjs — one source for the desk's reports
// (`HAVEN_REPORTS`, `components/Desk.mesa`'s `/report`): this machine's
// Basecamp account, read through the `basecamp` CLI and laid out as the same
// `{ title, blocks }` a `/ask` answer is (`web/src/lib/home/answer.js`), so the
// desk draws a report with no model in the middle.
//
//   bun scripts/basecamp-reports.mjs            the menu, [{ name, help }]
//   bun scripts/basecamp-reports.mjs overdue    one report
//
// Haven knows no source, so nothing in `web/` imports this; a member opts in by
// writing the command into `~/.fli/haven/reports`.
//
// overdue  the team's past-due to-dos: how late, who holds them, which can still be saved
// week     what falls due in the next seven days, by day, and what nobody is on
// mine     this account's own last fourteen days of activity
// leaders  who checked off the most to-dos in fourteen days, against the fourteen before
// team     each teammate's open to-dos: how many, how many late, what falls due this week
// daily    the newest daily check posted in the Kobami chat, each item a link
// plans    open to-dos per client plan (the Daily Checklist doc's table), project by project
import { execFile } from 'node:child_process'

const basecamp = (...args) => new Promise((resolve, reject) => {
  execFile('basecamp', [...args, '--json'], { maxBuffer: 32 << 20, timeout: 60_000 }, (err, out) => {
    if (err) return reject(new Error(`basecamp ${args.join(' ')}: ${err.message}`))
    const body = JSON.parse(out)
    if (!body.ok) return reject(new Error(`basecamp ${args.join(' ')}: ${body.error}`))
    resolve(body.data)
  })
})

const DAY = 24 * 60 * 60 * 1000
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

// A `due_on` is a calendar day; read it as local midnight, so "today" and "due
// today" are the same day wherever the member is.
const today = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d })()
const dayOf = (ymd) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(y, m - 1, d) }
const daysFrom = (ymd) => Math.round((dayOf(ymd) - today) / DAY)
const dayLabel = (ymd) => { const d = dayOf(ymd); return daysFrom(ymd) === 0 ? 'today' : `${WEEKDAY[d.getDay()]} ${d.getDate()}` }
const ago = (iso) => {
  const h = Math.round((Date.now() - Date.parse(iso)) / 3_600_000)
  return h < 1 ? 'just now' : h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`
}

const first = (name) => String(name ?? '').split(/\s+/)[0]
const who = (people = []) => people.length === 0 ? 'nobody' : people.length === 1 ? first(people[0].name) : `${first(people[0].name)} +${people.length - 1}`
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()

/** `[{ label, value }]` from counting `keysOf(row)` over `rows`, largest first, the top `n`. */
function tally(rows, keysOf, n) {
  const counts = new Map()
  for (const r of rows) for (const k of keysOf(r)) counts.set(k, (counts.get(k) ?? 0) + 1)
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, n).map(([label, value]) => ({ label, value }))
}

// The daily check is judged by a Claude run on another machine and posted to
// the Kobami chat, so the post IS the judged run: this reads it back rather
// than judging again. Its HTML is the daily-check skill's `render.py`, the
// same shape the daily-check-audit skill reads its links from.
const KOBAMI_CHAT = '/buckets/29933190/chats/5472184725/lines.json'

const unescapeHtml = (s) => s.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' })[e])
const plain = (html) => oneLine(unescapeHtml(html.replace(/<[^>]+>/g, '')))

// A summary line's number is its first <strong>; the label is shortened by its
// emoji, and a line this does not know keeps its own words.
const SHORT = { '📣': 'ads / SEO', '💬': 'waiting on us', '🆕': 'new, no reply', '⏰': 'overdue',
  '📅': 'due today/tmrw', '🙋': 'unassigned', '💤': 'gone quiet', '❓': 'unknown plan' }
const TONE_OF = { '💬': 'danger', '⏰': 'warn', '🆕': 'warn', '❓': 'muted' }
// A count's `key` is what Tab filters the desk's list items by; an item says
// which counts it falls under in `keys`, read from its own words, since the
// post tags none but ads. A count no item carries (most of overdue, all of
// gone quiet) is not itemized in the post, so Tab passes it by.
const KEY_OF = { '📣': 'ads', '💬': 'waiting', '🆕': 'new', '⏰': 'overdue', '📅': 'due', '🙋': 'unassigned', '💤': 'quiet', '❓': 'unknown' }
const keysOf = (head, who, timing) => [
  head.includes('📣') && 'ads',
  /^waiting\b/.test(timing) && 'waiting',
  /\blate$/.test(timing) && 'overdue',
  /^due (today|tomorrow)/.test(timing) && 'due',
  who === 'unassigned' && 'unassigned',
].filter(Boolean)

const TAG = [['🤖', 'info'], ['🧑‍💼', 'muted'], ['👤', undefined]]
const shortTiming = (t) => t.replace(/ days?\b/, 'd').replace('due tomorrow', 'due tmrw')

/** One bullet: `📣 👤 Team · ⚠︎ overdue reply · <a href>title</a> — who · timing · reason`. */
function itemOf(html, customer) {
  const a = html.match(/<a href="([^"]+)">([\s\S]*?)<\/a>/)
  if (!a) return { text: plain(html), tone: 'muted' }
  const [who = '', timing = ''] = plain(html.slice(a.index + a[0].length)).replace(/^—\s*/, '').split(' · ')
  const head = plain(html.slice(0, a.index))
  const late = /overdue reply/.test(head)
  return {
    text: [plain(a[2]), who, customer].filter(Boolean).join(' · '),
    note: shortTiming(timing),
    tone: late ? 'danger' : TAG.find(([e]) => head.includes(e))?.[1],
    url: unescapeHtml(a[1]),
    keys: keysOf(head, who, timing),
    waited: Number(timing.match(/^waiting (\d+) days?\b/)?.[1]) || undefined,
  }
}

/** The post's HTML as blocks: the counts, then each section's items under its heading. */
function dailyBlocks(html) {
  const blocks = [], stats = []
  let section = null, customer = null, lines = null
  const flush = () => { if (lines?.length) blocks.push({ kind: 'list', items: lines }); lines = null }
  for (const m of html.matchAll(/<div dir="auto"><strong>([\s\S]*?)<\/strong><\/div>(\s*<ul)?|<li>([\s\S]*?)<\/li>|⏸ On hold:([\s\S]*?)<\/div>/g)) {
    if (m[4] != null) {
      flush()
      blocks.push({ kind: 'heading', text: '⏸ On hold' })
      blocks.push({ kind: 'list', items: [...m[4].matchAll(/<a href="([^"]+)">([\s\S]*?)<\/a>/g)].map((a) => ({ text: plain(a[2]), tone: 'muted', url: unescapeHtml(a[1]) })) })
    } else if (m[1] != null && (m[2] == null || plain(m[1]) === 'Notes')) {
      flush()
      section = plain(m[1]); customer = null
      blocks.push({ kind: 'heading', text: section })
    } else if (m[1] != null) {
      customer = plain(m[1])
    } else if (!section) {
      const text = plain(m[3])
      const emoji = [...text][0]
      const value = m[3].match(/<strong>([\s\S]*?)<\/strong>/)?.[1]
      if (text.startsWith("Who's up")) blocks.push({ kind: 'text', text, tone: 'muted' })
      else if (value != null) stats.push({ label: SHORT[emoji] ?? text.split(':')[0], key: KEY_OF[emoji], value: plain(value), tone: Number(plain(value)) ? TONE_OF[emoji] : 'ok',
        note: emoji === '⏰' ? `${plain(m[3].match(/<strong>[\s\S]*?<strong>([\s\S]*?)<\/strong>/)?.[1] ?? '')} ≤7d late` : '' })
    } else {
      ;(lines ??= []).push(itemOf(m[3], section === 'Notes' ? null : customer))
      if (lines.length === 12) flush()
    }
  }
  flush()
  const rows = []
  for (let i = 0; i < stats.length; i += 4) rows.push({ kind: 'stats', items: stats.slice(i, i + 4) })
  return [...rows, ...blocks]
}

// The plan each client project is on is the plan table in the "Daily
// Checklist" doc, which the team edits and the daily-check skill's
// `collect.py` reads; this reads the same table, so the two never disagree.
const CHECKLIST = ['files', 'show', '10338849264', '--in', '29933190']
const PLANS = ['established', 'pro', 'starter', 'unset']
const chunks = (xs, n) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n))
const projectUrl = (id) => `https://app.basecamp.com/5483754/projects/${id}`

/** `{ projectId: { plan, status } }` from the checklist's table and its "Internal / unmapped" list. */
function planTable(html) {
  const plans = {}
  const cell = (c) => plain(c)
  const table = html.match(/<table[\s\S]*?<\/table>/)?.[0]
  if (!table) throw new Error('no plan table in the Daily Checklist doc')
  for (const [, row] of table.matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1])
    const id = cells[1]?.match(/\/(?:projects|buckets)\/(\d+)/)?.[1]
    const plan = cell(cells[0] ?? '').split(' ')[0].toLowerCase()
    if (cells.length < 4 || !id || !PLANS.includes(plan)) continue
    plans[id] = { plan, status: cell(cells[3]).toLowerCase() || 'active' }
  }
  const internal = html.split('Internal / unmapped')[1] ?? ''
  for (const [, id] of internal.matchAll(/<li[^>]*><a href="[^"]*\/projects\/(\d+)">/g)) plans[id] ??= { plan: 'unset', status: 'active' }
  return plans
}

// The leaderboard's team, by Basecamp id: a name search for Vlad answers
// "Ambiguous person", and the account itself is read as `me`.
const BOARD = [['Jordan', 'me'], ['Vlad', '--person', '41640225'], ['Colin', '--person', '52968940']]

const REPORTS = {
  plans: {
    help: 'open to-dos per client plan, each plan its projects with the most open first',
    async run() {
      // An archived to-do is not open, and the listing leaves it out.
      const [doc, buckets] = await Promise.all([basecamp(...CHECKLIST), basecamp('todos', 'list', '--all-projects', '--all')])
      const table = planTable(doc.content ?? '')
      // A project the table does not name is counted with unset, as the plan's own name says.
      const groups = new Map([...PLANS, 'on hold'].map((p) => [p, []]))
      for (const { bucket: project, todos } of buckets) {
        const open = todos.filter((t) => !t.completed)
        if (!open.length) continue
        const row = table[project.id]
        const late = open.filter((t) => t.due_on && daysFrom(t.due_on) < 0)
        groups.get(row?.status === 'on-hold' ? 'on hold' : row?.plan ?? 'unset').push({
          name: project.name.trim(), id: project.id, open: open.length, late: late.length,
          oldest: late.length ? -Math.min(...late.map((t) => daysFrom(t.due_on))) : 0,
          undated: open.filter((t) => !t.due_on).length,
        })
      }
      const sum = (rows, key) => rows.reduce((n, r) => n + r[key], 0)
      const all = [...groups.values()].flat()
      const title = (p) => p[0].toUpperCase() + p.slice(1)
      // A card and its projects share a key: Tab filters the list to one plan,
      // and the desk counts a card's snoozed projects by it.
      const keyOf = (p) => p.replace(' ', '-')
      return {
        title: `${sum(all, 'open')} open to-dos by plan`,
        blocks: [
          { kind: 'stats', items: [...groups].filter(([p, rows]) => p !== 'on hold' || rows.length).map(([p, rows]) => ({
            label: title(p), value: sum(rows, 'open'), key: keyOf(p),
            note: `${sum(rows, 'late')} late`, noteTone: sum(rows, 'late') ? 'danger' : 'muted',
            foot: `${rows.length} project${rows.length === 1 ? '' : 's'}`,
            tone: p === 'unset' || p === 'on hold' ? 'muted' : undefined,
          })) },
          ...[...groups].filter(([, rows]) => rows.length).flatMap(([p, rows]) => [
            { kind: 'heading', text: `${title(p)} — ${sum(rows, 'open')} open in ${rows.length} project${rows.length === 1 ? '' : 's'}` },
            // The desk keeps twelve items a list, so a long plan is several lists in a row.
            ...chunks(rows.sort((a, b) => b.open - a.open || a.name.localeCompare(b.name)), 12).map((part) => ({ kind: 'list', items: part.map((r) => ({
              text: `${r.name} · ${r.open} open`,
              note: r.late ? `${r.late} late · ${r.oldest}d` : r.undated === r.open ? 'none dated' : '',
              noteTone: r.late ? 'danger' : undefined,
              url: projectUrl(r.id),
              keys: [keyOf(p)],
            })) })),
          ]),
        ],
      }
    },
  },

  overdue: {
    help: "the team's past-due to-dos: how late, who holds them, which can still be saved",
    async run() {
      const late = await basecamp('reports', 'overdue')
      const fresh  = late.under_a_week_late ?? []
      const week   = late.over_a_week_late ?? []
      const month  = late.over_a_month_late ?? []
      const stale  = late.over_three_months_late ?? []
      const all = [...fresh, ...week, ...month, ...stale]
      if (!all.length) return { title: 'Nothing overdue', blocks: [{ kind: 'callout', text: 'No to-do in this account is past due.', tone: 'ok' }] }
      return {
        title: `${all.length} overdue to-dos`,
        blocks: [
          { kind: 'stats', items: [
            { label: 'under a week',  value: fresh.length, note: 'still savable', tone: 'warn' },
            { label: 'over a week',   value: week.length,  tone: 'warn' },
            { label: 'over a month',  value: month.length, tone: 'danger' },
            { label: 'over 3 months', value: stale.length, note: 'abandoned?', tone: 'danger' },
          ] },
          ...(stale.length > all.length / 2
            ? [{ kind: 'callout', tone: 'danger', text: `${stale.length} of ${all.length} are over three months late -- most of this list is dead to-dos, not late work.` }]
            : []),
          { kind: 'heading', text: 'Late this week -- still savable' },
          { kind: 'table', columns: ['To-do', 'Project', 'Who', 'Late'],
            rows: fresh.sort((a, b) => a.due_on.localeCompare(b.due_on))
              .map((t) => [oneLine(t.content), t.bucket?.name ?? '', who(t.assignees), `${-daysFrom(t.due_on)}d`]) },
          { kind: 'heading', text: 'Who holds the last month' },
          { kind: 'bars', items: tally([...fresh, ...week, ...month], (t) => t.assignees?.length ? t.assignees.map((p) => p.name) : ['(nobody)'], 8) },
          { kind: 'heading', text: 'Which projects' },
          { kind: 'bars', items: tally([...fresh, ...week, ...month], (t) => [t.bucket?.name ?? '(none)'], 8) },
        ],
      }
    },
  },

  week: {
    help: 'what falls due in the next seven days, by day, and what nobody is on',
    async run() {
      const ahead = await basecamp('reports', 'schedule', '--start', 'today', '--end', '+7')
      const items = (ahead.assignables ?? []).filter((a) => a.due_on && !a.completed)
        .sort((a, b) => a.due_on.localeCompare(b.due_on))
      if (!items.length) return { title: 'Nothing due this week', blocks: [{ kind: 'callout', text: 'No to-do falls due in the next seven days.', tone: 'ok' }] }
      const nobody = items.filter((a) => !a.assignees?.length)
      const days = tally(items, (a) => [a.due_on], 8).sort((a, b) => a.label.localeCompare(b.label))
      const busiest = days.reduce((m, d) => (d.value > m.value ? d : m))
      return {
        title: `${items.length} due in the next 7 days`,
        blocks: [
          { kind: 'stats', items: [
            { label: 'due in 7 days', value: items.length },
            { label: 'due today',     value: items.filter((a) => daysFrom(a.due_on) === 0).length, tone: 'warn' },
            { label: 'nobody on it',  value: nobody.length, tone: nobody.length ? 'danger' : 'ok' },
            { label: 'busiest day',   value: dayLabel(busiest.label), note: `${busiest.value} due` },
          ] },
          ...(nobody.length ? [{ kind: 'callout', tone: 'warn', text: `Nobody is assigned: ${nobody.map((a) => oneLine(a.content)).join('; ')}` }] : []),
          { kind: 'bars', items: days.map((d) => ({ label: dayLabel(d.label), value: d.value, tone: d.label === busiest.label ? 'warn' : 'info' })) },
          { kind: 'table', columns: ['Due', 'To-do', 'Project', 'Who'],
            rows: items.map((a) => [dayLabel(a.due_on), oneLine(a.content), a.bucket?.name ?? '', who(a.assignees)]) },
        ],
      }
    },
  },

  mine: {
    help: "this account's own last fourteen days of activity",
    async run() {
      const since = Date.now() - 14 * DAY
      const events = (await basecamp('timeline', 'me', '--limit', '500')).filter((e) => Date.parse(e.created_at) >= since)
      if (!events.length) return { title: 'No activity in 14 days', blocks: [{ kind: 'callout', text: 'This account did nothing Basecamp records in the last fourteen days.', tone: 'muted' }] }
      const week = events.filter((e) => Date.parse(e.created_at) >= Date.now() - 7 * DAY)
      const count = (kind) => week.filter((e) => e.kind === kind).length
      const perDay = Array.from({ length: 14 }, (_, i) => {
        const start = today.getTime() - (13 - i) * DAY
        return events.filter((e) => { const t = Date.parse(e.created_at); return t >= start && t < start + DAY }).length
      })
      const done = events.filter((e) => e.kind === 'todo_completed').slice(0, 8)
      return {
        title: 'My last two weeks',
        blocks: [
          { kind: 'stats', items: [
            { label: 'events, 7d',    value: week.length },
            { label: 'to-dos added',  value: count('todo_created') },
            { label: 'checked off',   value: count('todo_completed'), tone: 'ok' },
            { label: 'comments',      value: count('comment_created') },
          ] },
          { kind: 'spark', label: 'per day, 14d', values: perDay, note: `today ${perDay.at(-1)}, peak ${Math.max(...perDay)}` },
          { kind: 'heading', text: 'Where, this week' },
          { kind: 'bars', items: tally(week, (e) => [e.bucket?.name ?? '(none)'], 6) },
          ...(done.length
            ? [{ kind: 'heading', text: 'Checked off' }, { kind: 'list', items: done.map((e) => ({ text: `${oneLine(e.summary_excerpt)} -- ${e.bucket?.name ?? ''}`, note: ago(e.created_at), tone: 'ok' })) }]
            : [{ kind: 'callout', tone: 'warn', text: 'Nothing checked off in fourteen days.' }]),
        ],
      }
    },
  },

  leaders: {
    help: 'who checked off the most to-dos in fourteen days, against the fourteen before',
    async run() {
      // Fourteen calendar days with today the last, as `mine` counts them, and the fourteen before for the arrows.
      const start = today.getTime() - 13 * DAY, prior = start - 14 * DAY
      const timelines = await Promise.all(BOARD.map(([, ...args]) => basecamp('timeline', ...args, '--limit', '1000')))
      const rows = BOARD.map(([name], i) => {
        const events = timelines[i]
        const todos = events.filter((e) => e.kind === 'todo_completed' || e.kind === 'todo_created')
        const now = todos.filter((e) => Date.parse(e.created_at) >= start)
        const closed = now.filter((e) => e.kind === 'todo_completed')
        const perDay = Array.from({ length: 14 }, (_, d) => closed.filter((e) => Math.floor((Date.parse(e.created_at) - start) / DAY) === d).length)
        let streak = 0, run = 0
        for (const n of perDay) { run = n ? run + 1 : 0; streak = Math.max(streak, run) }
        const best = perDay.indexOf(Math.max(...perDay))
        return {
          name, perDay, streak,
          closed: closed.length,
          opened: now.length - closed.length,
          projects: new Set(now.map((e) => e.bucket?.id)).size,
          best: { n: perDay[best], on: new Date(start + best * DAY) },
          before: todos.filter((e) => e.kind === 'todo_completed' && Date.parse(e.created_at) >= prior && Date.parse(e.created_at) < start).length,
          // A thousand events that end inside the earlier fortnight have cut it short, and its count with it.
          cut: events.length >= 1000 && Date.parse(events.at(-1).created_at) > prior,
        }
      })
      const rank = (key) => [...rows].sort((a, b) => b[key] - a[key] || a.name.localeCompare(b.name))
      const was = rank('before')
      const board = rank('closed')
      const moved = (r) => { const n = was.indexOf(r) - board.indexOf(r); return n > 0 ? `${r.name} ▲${n}` : n < 0 ? `${r.name} ▼${-n}` : r.name }
      const signed = (n) => (n > 0 ? `+${n}` : String(n))
      const day = (d) => `${WEEKDAY[d.getDay()]} ${d.getDate()}`
      const cut = rows.filter((r) => r.cut)
      const width = Math.max(...rows.map((r) => r.name.length))
      return {
        title: `Leaderboard · ${board[0].name} leads with ${board[0].closed} checked off`,
        blocks: [
          { kind: 'stats', items: board.map((r, i) => ({
            label: `${i + 1}. ${moved(r)}`, value: r.closed, tone: i === 0 ? 'ok' : undefined,
            note: `${r.opened} added`, foot: `${r.before} the 14 before`,
          })) },
          ...(cut.length ? [{ kind: 'callout', tone: 'warn', text: `${cut.map((r) => r.name).join(', ')}: a thousand events do not reach back 28 days, so the arrows undercount the fortnight before.` }] : []),
          { kind: 'heading', text: 'Checked off, last 14 days' },
          { kind: 'bars', items: board.map((r, i) => ({ label: r.name, value: r.closed, tone: i === 0 ? 'ok' : 'info' })) },
          // Net is checked off less added: above zero shrank the pile, below grew it.
          { kind: 'table', columns: ['Who', 'Checked off', 'Added', 'Net', 'Projects'],
            rows: board.map((r) => [moved(r), r.closed, r.opened, signed(r.closed - r.opened), r.projects]) },
          { kind: 'heading', text: 'Streaks' },
          { kind: 'table', columns: ['Who', 'Longest streak', 'Best day'],
            rows: rank('streak').map((r) => [r.name, `${r.streak}d`, r.best.n ? `${r.best.n} on ${day(r.best.on)}` : '--']) },
          // A spark starts where its label ends, so the names are padded to one width to line the days up.
          ...board.map((r) => ({ kind: 'spark', label: r.name.padEnd(width), values: r.perDay, note: `today ${r.perDay.at(-1)}, peak ${r.best.n}` })),
        ],
      }
    },
  },

  team: {
    help: "each teammate's open to-dos: how many, how many late, what falls due this week",
    async run() {
      // `reports assignable` leaves out the account itself, so "me" is read on its own.
      const [people, mine] = await Promise.all([basecamp('reports', 'assignable'), basecamp('reports', 'assigned')])
      const others = await Promise.all(people.filter((p) => p.employee && p.id !== mine.person.id)
        .map((p) => basecamp('reports', 'assigned', String(p.id))))
      const rows = [mine, ...others].map(({ person, todos }) => {
        const open = todos.filter((t) => !t.completed)
        return {
          name: first(person.name),
          open,
          late: open.filter((t) => t.due_on && daysFrom(t.due_on) < 0),
          week: open.filter((t) => t.due_on && daysFrom(t.due_on) >= 0 && daysFrom(t.due_on) < 7),
          undated: open.filter((t) => !t.due_on),
        }
      }).sort((a, b) => b.open.length - a.open.length)
      const sum = (key) => rows.reduce((n, r) => n + r[key].length, 0)
      // A to-do with two assignees is in both their lists, so it is listed once, by id.
      const slipped = new Map()
      for (const r of rows) for (const t of r.late) if (daysFrom(t.due_on) >= -7) slipped.set(t.id, t)
      const recent = [...slipped.values()].sort((a, b) => b.due_on.localeCompare(a.due_on))
      const heaviest = rows.reduce((m, r) => (r.week.length > m.week.length ? r : m))
      return {
        title: `${sum('open')} open to-dos across ${rows.length}`,
        blocks: [
          { kind: 'stats', items: [
            { label: 'open',       value: sum('open') },
            { label: 'late',       value: sum('late'), tone: 'danger' },
            { label: 'due in 7d',  value: sum('week'), tone: 'warn' },
            { label: 'no due date', value: sum('undated'), tone: 'muted' },
          ] },
          ...(heaviest.week.length >= 2 * Math.max(1, sum('week') - heaviest.week.length)
            ? [{ kind: 'callout', tone: 'warn', text: `${heaviest.name} holds ${heaviest.week.length} of the ${sum('week')} due this week.` }]
            : []),
          { kind: 'table', columns: ['Who', 'Open', 'Late', 'Due 7d', 'No date'],
            rows: rows.map((r) => [r.name, r.open.length, r.late.length, r.week.length, r.undated.length]) },
          { kind: 'heading', text: 'Due this week, by who' },
          { kind: 'bars', items: rows.map((r) => ({ label: r.name, value: r.week.length, tone: r === heaviest ? 'warn' : 'info' })) },
          ...(recent.length
            ? [{ kind: 'heading', text: 'Slipped in the last week' },
               { kind: 'list', items: recent.slice(0, 8).map((t) => ({ text: `${oneLine(t.content)} -- ${t.bucket?.name ?? ''}`, note: `${who(t.assignees)}, ${-daysFrom(t.due_on)}d`, tone: 'warn' })) }]
            : []),
        ],
      }
    },
  },

  daily: {
    help: 'the newest daily check posted in the Kobami chat, each item a link',
    async run() {
      const lines = await basecamp('api', 'get', KOBAMI_CHAT)
      const post = lines.find((l) => /Daily check —/.test(l.content) && !/Daily check audit/.test(l.content))
      if (!post) return { title: 'No daily check', blocks: [{ kind: 'callout', tone: 'warn', text: 'No "Daily check" line on the first page of the Kobami chat.' }] }
      const when = plain(post.content.match(/<strong>(Daily check —[^<]*)<\/strong>/)?.[1] ?? 'Daily check')
      const old = Date.now() - Date.parse(post.created_at) > 36 * 60 * 60 * 1000
      return {
        title: `${when} · posted ${ago(post.created_at)}`,
        blocks: [
          ...(old ? [{ kind: 'callout', tone: 'warn', text: `This check was posted ${ago(post.created_at)}; no newer one is in the chat.` }] : []),
          ...dailyBlocks(post.content),
          { kind: 'list', items: [{ text: 'the post in the Kobami chat', tone: 'muted', url: post.app_url }] },
        ],
      }
    },
  },
}

const name = process.argv[2]
if (!name) {
  console.log(JSON.stringify(Object.entries(REPORTS).map(([n, r]) => ({ name: n, help: r.help }))))
} else if (!REPORTS[name]) {
  console.error(`no report "${name}" -- ${Object.keys(REPORTS).join(', ')}`)
  process.exit(2)
} else {
  console.log(JSON.stringify(await REPORTS[name].run()))
}
