// src/domain/atlas/autopilot-post.ts — rulings asked over the phone, and the taps that come back.
//
// The `post` loop (`autopilot.js`'s LOOPS.post) has no script: the tick job
// runs `askNow` in this process, and polls `pollReplies` on every tick.
//
//   ask   a decidable question never asked before goes to the owner's phone
//         (`AutopilotAsk`), with an Open button and, where it may, a Rule button.
//   tap   the button is an ntfy `http` action: the PHONE posts {id, letter} to
//         the reply topic. Nothing here is reachable from outside; the poll is
//         outbound, so it works with the laptop off the LAN (FJS-D1811).
//   rule  fli's `decide`, the loader the Atlas screen's decide uses -- never a
//         second writer into DECISIONS.md.
//
// A reply is a claim, not a ruling. The reply topic takes an anonymous write,
// so everything it carries is re-checked against the paper as it stands NOW:
// the question must still be decidable and asked by us, and the letter must be
// the unqualified recommendation (FJS-D1812). `decide` refuses anything else
// itself, which is the second lock, not the first.

import { appendFileSync, mkdirSync } from 'node:fs'
import { join }                      from 'node:path'
import type { App }                  from '@frontierjs/junction'
import type { PushAction }           from '@frontierjs/notifications'

import { FLI_DIR, forgetAtlas, loadFli, type Asked, type Fli } from './atlas.ts'
import type { Entry, InProcess }                               from './autopilot-run.ts'
import type { PushServer }                                     from '../../push.ts'
import autopilotAsk from '../../notifications/AutopilotAsk.notification.ts'
import { appUrl }   from '../../notifications/AutopilotReport.notification.ts'

type Line = Record<string, any>

const LOG   = 'post-loop.jsonl'
const DAY   = 24 * 60 * 60_000
const fileOf = (logDir: string) => join(logDir, LOG)

function append (logDir: string, now: Date, line: Line) {
  mkdirSync(logDir, { recursive: true })
  appendFileSync(fileOf(logDir), JSON.stringify({ at: now.toISOString(), source: 'autopilot', ...line }) + '\n')
}

/** The questions no `asked` line names yet, the first `asks` of them. A question asked once is not asked again, answered or not. */
export function askable (decidable: Asked[], lines: Line[], asks: number): Asked[] {
  const asked = new Set(lines.filter(l => l.outcome === 'asked').map(l => l.id))
  return decidable.filter(q => !asked.has(q.id)).slice(0, asks)
}

/**
 * The buttons an ask carries. Open always. Rule <letter> only where a tap may
 * rule (FJS-D1812, FJS-D1814): an own server (rung 1) whose sender holds a
 * token, so the reply topic can be ACL'd, and a recommendation that is a bare
 * letter -- a qualified one (`A's first half now`) rules part of its option,
 * and which part is prose only a person restates. No header rides in the
 * action: the phone's POST is anonymous, and the reply topic's name is the
 * capability.
 */
export function buttonsFor (q: Asked, push: PushServer, url: (path: string) => string = appUrl): PushAction[] {
  const open: PushAction = { label: 'Open', url: url('/atlas/decide/') }
  const rec = q.recommend
  if (push.rung !== 1 || !push.token || !rec || rec.qualifier || !q.options.some(o => o.letter === rec.letter)) return [open]
  const rule: PushAction = {
    label: `Rule ${rec.letter}`,
    url:   `${push.url.replace(/\/+$/, '')}/${push.reply}`,
    body:  JSON.stringify({ id: q.id, letter: rec.letter }),
  }
  return [rule, open]
}

type Seams = { fli?: Pick<Fli, 'openDecisions' | 'readLog' | 'decide'>, logDir?: string, now?: Date }

/**
 * Ping the first Member about up to `entry.caps.asks` unasked questions. A
 * question is logged only after its ping went out, so one that failed to send
 * is asked again at the next run rather than lost.
 */
export async function askNow ({ app, sys, root, entry, fli, logDir = FLI_DIR(), now = new Date() }: { app: App, sys: any, root: string, entry: Pick<Entry, 'caps'> } & Seams): Promise<{ asked: string[] }> {
  const f      = fli ?? await loadFli()
  const asks   = Number(entry.caps.asks)
  const section = String(entry.caps.section)
  const todo   = askable(f.openDecisions(root).decidable, f.readLog(fileOf(logDir)), asks)
  const member = todo.length ? await sys.member.findFirst({ orderBy: { id: 'asc' } }) : null
  if (!member) return { asked: [] }
  const push = (app as any).push as PushServer
  const asked: string[] = []
  for (const q of todo) {
    const buttons = buttonsFor(q, push)
    const rec     = q.recommend && { letter: q.recommend.letter, text: q.options.find(o => o.letter === q.recommend!.letter)?.text ?? '' }
    await app.notify({ id: member.id, pushTopic: push.topic }, autopilotAsk({
      id: q.id, question: q.question, recommend: rec, options: q.options, file: q.file, line: q.line, buttons,
    }))
    append(logDir, now, { outcome: 'asked', id: q.id, section, rung: push.rung, buttons: buttons.some(b => b.body !== undefined) })
    asked.push(q.id)
  }
  return { asked }
}

/**
 * Read the reply topic and rule what the phone tapped. Asks with a Rule button
 * from the last 24 hours that nothing has ruled or refused are outstanding; with
 * none, nothing is fetched. Each message is answered once -- its ntfy id is
 * kept on the `ruled`/`refused` line it produced -- so a window that re-reads
 * old messages rules nothing twice.
 */
export async function pollReplies ({ root, push, deliver = fetch, fli, logDir = FLI_DIR(), now = new Date() }: { root: string, push: PushServer, deliver?: typeof fetch } & Seams): Promise<{ polled: boolean, ruled: number, refused: number }> {
  const f     = fli ?? await loadFli()
  const lines = f.readLog(fileOf(logDir)) as Line[]
  const closed = (a: Line) => lines.some(l => (l.outcome === 'ruled' || l.outcome === 'refused') && l.id === a.id && Date.parse(l.at) >= Date.parse(a.at))
  let outstanding = lines.filter(l => l.outcome === 'asked' && l.buttons && now.getTime() - Date.parse(l.at) <= DAY && !closed(l))
  const out = { polled: false, ruled: 0, refused: 0 }
  if (!outstanding.length) return out

  const since = Math.floor(Math.min(...outstanding.map(a => Date.parse(a.at))) / 1000)
  const res   = await deliver(`${push.url.replace(/\/+$/, '')}/${push.reply}/json?poll=1&since=${since}`, {
    headers: push.token ? { Authorization: `Bearer ${push.token}` } : {},
  })
  if (!res.ok) throw new Error(`[autopilot-post] ntfy at ${push.url} answered ${res.status} for the reply topic`)
  out.polled = true

  const seen = new Set(lines.map(l => l.reply).filter(Boolean))
  for (const raw of (await res.text()).split('\n')) {
    let msg: Line
    try { msg = JSON.parse(raw) } catch { continue }
    if (msg.event !== 'message' || typeof msg.id !== 'string' || seen.has(msg.id)) continue
    seen.add(msg.id)

    const refuse = (id: string | null, why: string) => { append(logDir, now, { outcome: 'refused', id, why, reply: msg.id }); out.refused++ }
    let body: Line | null = null
    try { body = JSON.parse(String(msg.message)) } catch {}
    if (!body || typeof body.id !== 'string' || typeof body.letter !== 'string') { refuse(null, 'the reply is not {id, letter}'); continue }
    const { id } = body
    const letter = body.letter.trim().toUpperCase()

    const ask = outstanding.find(a => a.id === id)
    if (!ask) { refuse(id, 'no ask with a Rule button is outstanding for it'); continue }
    const q = f.openDecisions(root).decidable.find(x => x.id === id)
    if (!q) { refuse(id, 'it is no longer a decidable question'); continue }
    const rec = q.recommend
    if (!rec || rec.qualifier || rec.letter !== letter) { refuse(id, `${letter} is not the unqualified recommendation (${rec ? rec.qualifier ?? rec.letter : 'none'})`); continue }

    const done = f.decide({ root, id, pick: letter, why: '', section: ask.section })
    if (done.ok) {
      append(logDir, now, { outcome: 'ruled', id, ruling: done.ruling, reply: msg.id })
      outstanding = outstanding.filter(a => a !== ask)
      forgetAtlas()
      out.ruled++
    } else refuse(id, done.reason)
  }
  return out
}

/** What the tick job and Run now hand `startEntry` for a script-less loop: the one such loop is `post`.
 *  `db` is the caller's -- the job's system handle, Run now's administrator -- so the Member lookup runs at a level someone already holds. */
export const inProcess = (app: App, root: string, db: any): InProcess => async (entry) => {
  if (entry.loop !== 'post') throw new Error(`${entry.loop} has no script and no in-process runner`)
  await askNow({ app, sys: db, root, entry })
}
