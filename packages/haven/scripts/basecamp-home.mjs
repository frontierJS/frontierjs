// scripts/basecamp-home.mjs — one source for a home's board (`HAVEN_HOME`,
// `components/HomeBoard.mesa`): this machine's Basecamp account, read through
// the `basecamp` CLI, printed as the board's one JSON shape.
//
//   bun scripts/basecamp-home.mjs <home>     e.g. jordan
//
// Haven knows no source, so nothing in `web/` imports this; a member opts in by
// writing the command into `~/.fli/haven/home`. The `<home>` argument is what
// keeps a board in its own house — the board draws only in the home it names,
// so a second member's account never lands on the first one's wall.
//
// pins   the projects this account has bookmarked, with how many of the
//        account's notifications came from each in the last day
// inbox  the newest notifications outside chat, unread first
// pings  the newest chat lines that reached this account
// due    the assignments with a due date, soonest first
import { execFile } from 'node:child_process'

const home = process.argv[2]
if (!home || !/^[a-z]+$/.test(home)) {
  console.error('usage: basecamp-home.mjs <home>   (a home slug, letters only)')
  process.exit(2)
}

const DAY = 24 * 60 * 60 * 1000

const basecamp = (...args) => new Promise((resolve, reject) => {
  execFile('basecamp', [...args, '--json'], { maxBuffer: 16 << 20, timeout: 60_000 }, (err, out) => {
    if (err) return reject(new Error(`basecamp ${args.join(' ')}: ${err.message}`))
    const body = JSON.parse(out)
    if (!body.ok) return reject(new Error(`basecamp ${args.join(' ')}: ${body.error}`))
    resolve(body.data)
  })
})

const [projects, notes, due] = await Promise.all([
  basecamp('projects', 'list'),
  basecamp('notifications', 'list'),
  basecamp('assignments', 'due'),
])

const unread = (notes.unreads ?? []).map((n) => ({ ...n, unread: true }))
const all = [...unread, ...(notes.reads ?? [])]
  .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))

const now = Date.now()
const fresh = (bucket) => all.filter((n) => n.bucket_name === bucket && now - Date.parse(n.created_at) < DAY).length

const pins = projects
  .filter((p) => p.bookmarked)
  .map((p) => ({ name: p.name, when: p.updated_at, fresh: fresh(p.name) }))

const line = (n) => ({
  project: n.bucket_name ?? '',
  who: n.creator?.name ?? '',
  text: (n.section === 'chats' ? n.content_excerpt : n.title)?.replace(/\s+/g, ' ').trim() ?? '',
  when: n.created_at,
  unread: !!n.unread,
})

// A chat reading is stamped with the chat's first line; its newest is `updated_at`.
const pings = all.filter((n) => n.section === 'chats')
  .map((n) => ({ ...line(n), when: n.updated_at ?? n.created_at }))
  .sort((a, b) => Date.parse(b.when) - Date.parse(a.when))
  .slice(0, 12)
const inbox = all.filter((n) => n.section !== 'chats').slice(0, 20).map(line)

const dues = (due ?? [])
  .filter((a) => a.due_on)
  .sort((a, b) => a.due_on.localeCompare(b.due_on))
  .map((a) => ({ project: a.bucket?.name ?? '', text: (a.content ?? a.title ?? '').trim(), when: a.due_on }))

console.log(JSON.stringify({ home, pins, inbox, pings, due: dues }))
