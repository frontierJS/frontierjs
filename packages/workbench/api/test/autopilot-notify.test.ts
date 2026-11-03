// The morning report leaves through a transport Workbench owns: an in-app row
// for the member and a ping to the topic their phone holds. Run against the
// real plugin, the real schema and the real notification file, with ntfy's
// HTTP stubbed by path -- what is asserted is what would have been POSTed.

import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createTestEnv } from '@frontierjs/litestone/testing'
import { notifications, ntfy } from '@frontierjs/notifications'
import type { App } from '@frontierjs/junction'

import { sendReport } from '../src/domain/atlas/autopilot-report.ts'
import { pushTopic, pushTopics, type PushServer } from '../src/push.ts'
import { askNow, askable, buttonsFor, pollReplies } from '../src/domain/atlas/autopilot-post.ts'
import { summary, type AutopilotReportPayload } from '../src/notifications/AutopilotReport.notification.ts'

const DB         = join(import.meta.dir, '..', '..', 'db')
const SRC        = join(import.meta.dir, '..', 'src')
const ENC_KEY    = '0'.repeat(64)
const scratch    = mkdtempSync(join(tmpdir(), 'workbench-push-'))
const envs: { close(): void }[] = []
afterAll(() => { for (const e of envs.splice(0)) e.close(); rmSync(scratch, { recursive: true, force: true }) })

const PAYLOAD: AutopilotReportPayload = {
  from: '2026-11-02T08:00:00.000Z', to: '2026-11-03T08:00:00.000Z', on: true,
  ran: 4, closed: 3, blocked: 1, failed: 0, framed: 2, spend: 1.5,
  day: { attempts: 4, dollars: 1.5, capAttempts: 10, capDollars: 20 }, patches: 2, tick: null, review: null,
}

async function makeApp (push: Partial<PushServer> = {}) {
  const env = await createTestEnv({ schema: join(DB, 'schema.lite'), migrations: join(DB, 'migrations'), encryptionKey: ENC_KEY })
  envs.push(env)

  const posts: { url: string, headers: Record<string, string>, body: string }[] = []
  const deliver = (async (url: string, init: { headers: Record<string, string>, body: string }) => {
    posts.push({ url, headers: init.headers, body: init.body })
    return new Response(JSON.stringify({ id: 'n1' }), { status: 200 })
  }) as unknown as typeof fetch

  const l: any = { info () {}, warn () {}, error () {}, debug () {}, child: () => l }
  const app: any = {
    db: env.db, logger: l, root: SRC,
    push: { rung: 3, url: 'https://ntfy.test', topic: 'workbench-abcdefghijkl', reply: 'workbench-reply-abcdefghijkl', ...push },
    channel: () => undefined,
    own (name: string, value: unknown) { (this as any)[name] = value },
  }
  const plugin = notifications({ db: env.db, transports: { push: ntfy({ url: 'https://ntfy.test', deliver }) } }) as any
  plugin.register(app)
  await plugin.boot?.(app)
  return { app: app as App, sys: env.db.asSystem() as any, posts }
}

describe('the AutopilotReport is sent', () => {
  test('writes the member an in-app row and publishes the one-line summary to their topic', async () => {
    const { app, sys, posts } = await makeApp()
    const member = await sys.member.create({ data: { nick: 'jordan' } })

    expect(await sendReport(app, sys, PAYLOAD)).toBe(true)

    const rows = await sys.notification.findMany({ where: { userId: member.id } })
    expect(rows).toHaveLength(1)
    expect(rows[0].type).toBe('AutopilotReport')
    expect(rows[0].readAt).toBeNull()
    expect(rows[0].data.title).toBe('Autopilot overnight')
    expect(rows[0].data.body).toBe(`${summary(PAYLOAD)} 2 patches on the Dock.`)
    expect(rows[0].data.action).toEqual({ label: 'Open the town', url: '/atlas/autopilot/' })

    expect(posts).toHaveLength(1)
    expect(posts[0].url).toBe('https://ntfy.test/workbench-abcdefghijkl')
    expect(posts[0].body).toBe('4 runs · 3 closed · 1 blocked · 2 framed · $1.50')
    expect(posts[0].headers.Title).toBe('Autopilot overnight')
    expect(posts[0].headers.Click).toBe('http://localhost:5508/atlas/autopilot/')
  })

  test('with nobody signed in at the door, nothing is written and nothing is published', async () => {
    const { app, sys, posts } = await makeApp()
    expect(await sendReport(app, sys, PAYLOAD)).toBe(false)
    expect(await sys.notification.findMany({})).toHaveLength(0)
    expect(posts).toHaveLength(0)
  })
})

describe('the topic', () => {
  test('is minted once into the push file and read back, never re-minted', () => {
    const file = join(scratch, 'config', 'push.json')
    const first = pushTopic(file)
    expect(first).toMatch(/^workbench-[a-z0-9]{12}$/)
    // The reply topic is minted beside it, and independently: knowing the subscribe topic must not be enough to rule.
    const kept = JSON.parse(readFileSync(file, 'utf8'))
    expect(kept).toEqual({ topic: first, reply: expect.stringMatching(/^workbench-reply-[a-z0-9]{12}$/) })
    expect(kept.reply.slice('workbench-reply-'.length)).not.toBe(first.slice('workbench-'.length))
    expect(pushTopic(file)).toBe(first)
    expect(pushTopics(file)).toEqual(kept)
  })

  test('a file from before the reply topic keeps its topic and gains one', () => {
    const file = join(scratch, 'old', 'push.json')
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ topic: 'workbench-abcdefghijkl' }))
    expect(pushTopics(file).topic).toBe('workbench-abcdefghijkl')
    expect(JSON.parse(readFileSync(file, 'utf8')).reply).toMatch(/^workbench-reply-[a-z0-9]{12}$/)
  })
})

// ─── the Post ────────────────────────────────────────────────────────────────

const OWN: PushServer = { rung: 1, url: 'https://ntfy.own.test', token: 'tk_sender', topic: 'workbench-abcdefghijkl', reply: 'workbench-reply-abcdefghijkl' }
const PUBLIC: PushServer = { rung: 3, url: 'https://ntfy.sh', topic: 'workbench-abcdefghijkl', reply: 'workbench-reply-abcdefghijkl' }

const opt = (letter: string, text = `option ${letter}`) => ({ letter, text })
const ask = (id: string, recommend: { letter: string, qualifier: string | null, why: string } | null = { letter: 'B', qualifier: null, why: 'because' }): any =>
  ({ id, question: `Which way, ${id}?`, body: '', options: [opt('A'), opt('B')], recommend, paper: null, status: '', file: 'IDEAS/x.md', line: 9 })

/** A fli that serves `decidable`, reads the real jsonl log, and records what it was asked to rule. */
function fakeFli (decidable: any[]) {
  const ruled: any[] = []
  return {
    ruled,
    fli: {
      openDecisions: () => ({ decidable, open: [] }),
      readLog: (file: string) => { try { return readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } },
      decide: (o: any) => { ruled.push(o); return { ok: true as const, ruling: 'FJS-D900', pick: o.pick, closed: null, files: [] } },
    },
  }
}
const logOf = (dir: string) => readFileSync(join(dir, 'post-loop.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
const logDir = () => mkdtempSync(join(scratch, 'post-'))
const ndjson = (...msgs: any[]) => msgs.map(m => JSON.stringify({ event: 'message', ...m })).join('\n') + '\n'

describe('the buttons an ask carries', () => {
  const url = (p: string) => `https://app.test${p}`
  test('an own server with a token and a bare recommendation: Rule <letter> posts {id, letter} to the reply topic, beside Open', () => {
    expect(buttonsFor(ask('FJS-D1'), OWN, url)).toEqual([
      { label: 'Rule B', url: 'https://ntfy.own.test/workbench-reply-abcdefghijkl', body: '{"id":"FJS-D1","letter":"B"}' },
      { label: 'Open', url: 'https://app.test/atlas/decide/' },
    ])
  })
  test('public ntfy.sh, no token, no recommendation, or a qualified one: Open only', () => {
    const open = [{ label: 'Open', url: 'https://app.test/atlas/decide/' }]
    expect(buttonsFor(ask('FJS-D1'), PUBLIC, url)).toEqual(open)
    expect(buttonsFor(ask('FJS-D1'), { ...OWN, token: undefined }, url)).toEqual(open)
    expect(buttonsFor(ask('FJS-D1', null), OWN, url)).toEqual(open)
    expect(buttonsFor(ask('FJS-D1', { letter: 'B', qualifier: "B's first half now", why: '' }), OWN, url)).toEqual(open)
  })
  test('questions asked before are not asked again, and at most `asks` go out', () => {
    const lines = [{ outcome: 'asked', id: 'FJS-D1' }, { outcome: 'ruled', id: 'FJS-D2' }]
    expect(askable([ask('FJS-D1'), ask('FJS-D2'), ask('FJS-D3'), ask('FJS-D4')], lines, 2).map(q => q.id)).toEqual(['FJS-D2', 'FJS-D3'])
  })
})

describe('asking', () => {
  const entry = { caps: { asks: 5, section: 'Repo conventions' } }
  test('on an own server the ntfy message carries an http action with the reply URL and an Open view; the ask is logged once', async () => {
    const { app, sys, posts } = await makeApp(OWN)
    await sys.member.create({ data: { nick: 'jordan' } })
    const dir = logDir()
    const { fli } = fakeFli([ask('FJS-D1')])

    expect((await askNow({ app, sys, root: '/x', entry, fli, logDir: dir })).asked).toEqual(['FJS-D1'])
    expect(posts).toHaveLength(1)
    expect(posts[0].url).toBe('https://ntfy.test/workbench-abcdefghijkl')
    expect(posts[0].headers.Title).toBe('Ruling asked: Which way, FJS-D1?')
    const actions = JSON.parse(posts[0].headers.Actions)
    expect(actions[0]).toEqual({ action: 'http', label: 'Rule B', url: 'https://ntfy.own.test/workbench-reply-abcdefghijkl', method: 'POST', body: '{"id":"FJS-D1","letter":"B"}', clear: true })
    expect(actions[1]).toMatchObject({ action: 'view', label: 'Open', url: 'http://localhost:5508/atlas/decide/' })
    // The phone's POST is anonymous: no credential rides in the action.
    expect(posts[0].headers.Actions).not.toContain('tk_sender')
    expect(logOf(dir)).toEqual([expect.objectContaining({ outcome: 'asked', id: 'FJS-D1', section: 'Repo conventions', rung: 1, buttons: true, source: 'autopilot' })])

    await askNow({ app, sys, root: '/x', entry, fli, logDir: dir })
    expect(posts).toHaveLength(1)
  })

  test('on public ntfy.sh the ask is Open only and nothing can be ruled from it', async () => {
    const { app, sys, posts } = await makeApp(PUBLIC)
    await sys.member.create({ data: { nick: 'jordan' } })
    const dir = logDir()
    await askNow({ app, sys, root: '/x', entry, fli: fakeFli([ask('FJS-D1')]).fli, logDir: dir })
    expect(JSON.parse(posts[0].headers.Actions).map((a: any) => [a.action, a.label])).toEqual([['view', 'Open']])
    expect(logOf(dir)[0].buttons).toBe(false)
  })
})

describe('polling the reply topic', () => {
  const NOW = new Date('2026-11-03T10:00:00Z')
  const seed = (dir: string, ...lines: any[]) => writeFileSync(join(dir, 'post-loop.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n')
  const asked = (id: string, extra: any = {}) => ({ at: '2026-11-03T08:00:00.000Z', source: 'autopilot', outcome: 'asked', id, section: 'Repo conventions', rung: 1, buttons: true, ...extra })
  const replying = (text: string) => { const urls: string[] = []; const heads: any[] = []; return { urls, heads, deliver: (async (u: string, init: any) => { urls.push(u); heads.push(init.headers); return new Response(text, { status: 200 }) }) as unknown as typeof fetch } }

  test('the recommended letter rules through decide with the entry section; the reply id is kept so it rules once', async () => {
    const dir = logDir(); seed(dir, asked('FJS-D1'))
    const { fli, ruled } = fakeFli([ask('FJS-D1')])
    const r = replying(ndjson({ id: 'm1', message: '{"id":"FJS-D1","letter":"B"}' }, { event: 'open', id: 'o1' }))

    expect(await pollReplies({ root: '/x', push: OWN, deliver: r.deliver, fli, logDir: dir, now: NOW })).toEqual({ polled: true, ruled: 1, refused: 0 })
    expect(r.urls).toEqual([`https://ntfy.own.test/workbench-reply-abcdefghijkl/json?poll=1&since=${Date.parse('2026-11-03T08:00:00Z') / 1000}`])
    expect(r.heads[0]).toEqual({ Authorization: 'Bearer tk_sender' })
    expect(ruled).toEqual([{ root: '/x', id: 'FJS-D1', pick: 'B', why: '', section: 'Repo conventions' }])
    expect(logOf(dir).at(-1)).toMatchObject({ outcome: 'ruled', id: 'FJS-D1', ruling: 'FJS-D900', reply: 'm1' })

    // Ruled: nothing is outstanding, so the next poll fetches nothing.
    const again = replying(ndjson({ id: 'm1', message: '{"id":"FJS-D1","letter":"B"}' }))
    expect(await pollReplies({ root: '/x', push: OWN, deliver: again.deliver, fli, logDir: dir, now: NOW })).toEqual({ polled: false, ruled: 0, refused: 0 })
    expect(again.urls).toEqual([])
  })

  test('a letter that is not the recommendation is refused and decide is never called', async () => {
    const dir = logDir(); seed(dir, asked('FJS-D1'))
    const { fli, ruled } = fakeFli([ask('FJS-D1')])
    const r = replying(ndjson({ id: 'm1', message: '{"id":"FJS-D1","letter":"A"}' }))
    expect(await pollReplies({ root: '/x', push: OWN, deliver: r.deliver, fli, logDir: dir, now: NOW })).toMatchObject({ ruled: 0, refused: 1 })
    expect(ruled).toEqual([])
    expect(logOf(dir).at(-1)).toMatchObject({ outcome: 'refused', id: 'FJS-D1', reply: 'm1', why: expect.stringContaining('A is not the unqualified recommendation (B)') })
  })

  test('a recommendation qualified since the ask, an id never asked, and a body that is not {id, letter} are all refused', async () => {
    const dir = logDir(); seed(dir, asked('FJS-D1'))
    const { fli, ruled } = fakeFli([ask('FJS-D1', { letter: 'B', qualifier: "B's first half now", why: '' }), ask('FJS-D7')])
    const r = replying(ndjson(
      { id: 'm1', message: '{"id":"FJS-D1","letter":"B"}' },
      { id: 'm2', message: '{"id":"FJS-D7","letter":"B"}' },
      { id: 'm3', message: 'B' },
    ))
    expect(await pollReplies({ root: '/x', push: OWN, deliver: r.deliver, fli, logDir: dir, now: NOW })).toMatchObject({ ruled: 0, refused: 3 })
    expect(ruled).toEqual([])
    expect(logOf(dir).slice(1).map(l => [l.id, l.reply])).toEqual([['FJS-D1', 'm1'], ['FJS-D7', 'm2'], [null, 'm3']])
  })

  test('with nothing outstanding -- no ask, a Open-only ask, or one older than a day -- nothing is fetched', async () => {
    const dir = logDir()
    const r = replying('')
    const poll = () => pollReplies({ root: '/x', push: OWN, deliver: r.deliver, fli: fakeFli([]).fli, logDir: dir, now: NOW })
    expect((await poll()).polled).toBe(false)
    seed(dir, asked('FJS-D1', { buttons: false }), asked('FJS-D2', { at: '2026-11-01T08:00:00.000Z' }))
    expect((await poll()).polled).toBe(false)
    expect(r.urls).toEqual([])
  })
})
