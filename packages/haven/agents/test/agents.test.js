// agents/test/agents.test.js — Ace and Charles on a real Haven, answered by a
// stub `claude` that costs nothing and writes down every prompt it was handed.
//
// Real sockets on a real app over the env's own Litestone client, with the
// runner signing both agents in through the real login. A line no agent
// answers reads exactly like a runner that never heard it, so every silence
// sits beside a delivery: the line itself reaching another socket.

import { test, expect, describe, beforeAll, beforeEach, afterEach } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createTestEnv } from '@frontierjs/testing'

import { buildHavenApp } from '../../api/src/app.ts'
import { signIn } from '../../api/test/sign-in.ts'
import { AGENTS, claudeArgv, names, oneLine, parseMods, promptFor, responders, startAgents } from '../agents.js'

const SCHEMA = join(import.meta.dir, '..', '..', 'db', 'schema.lite')
const sleep  = (ms) => new Promise(r => setTimeout(r, ms))

let dir, stub, stubLog
let env, square, jo, sam, run
const open = []
const said = []

beforeAll(() => {
  dir     = mkdtempSync(join(tmpdir(), 'haven-agents-'))
  stubLog = join(dir, 'claude.log')
  stub    = join(dir, 'claude')
  // The log path is written into the stub: a child gets the environment the
  // test process started with, not one it assigned since.
  writeFileSync(stub, `#!${process.execPath}
import { appendFileSync } from 'node:fs'
const argv   = process.argv.slice(2)
const soul   = argv[argv.indexOf('--system-prompt') + 1]
const prompt = await Bun.stdin.text()
appendFileSync(${JSON.stringify(stubLog)}, JSON.stringify({ argv, prompt }) + '\\n')
const name = soul.match(/^You are (\\w+)/)?.[1] ?? '?'
const line = prompt.split('\\n').find(l => / just (said|whispered to you): /.test(l))
const other = name === 'Ace' ? 'charles' : 'ace'
console.log(name + ': "heard ' + line + ' -- over to ' + other + '"')
`)
  chmodSync(stub, 0o755)
})

const asked = () => existsSync(stubLog) ? readFileSync(stubLog, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []

beforeEach(async () => {
  writeFileSync(stubLog, '')
  env = await createTestEnv({
    schema: SCHEMA,
    listen: true,
    api:    ({ db }) => buildHavenApp({ db, sessionKey: 'test-session-key', port: 0, mods: ['jo'] }),
  })
  square = await env.system.room.create({ data: { slug: 'square', name: 'The square' } })
  jo     = await signIn(env.port, 'jo')
  sam    = await signIn(env.port, 'sam')
})

afterEach(async () => {
  run?.stop()
  run = null
  for (const s of open.splice(0)) s.ws.close()
  said.length = 0
  await env?.close?.()
})

async function agents (mods = 'jo', timing = {}) {
  run = await startAgents({
    api: `http://localhost:${env.port}`, mods, bin: stub,
    keysDir: join(dir, 'keys'), wander: false,
    timing: { replyMs: 0, gatherMs: 80, ...timing },
    log: (l) => said.push(l),
  })
  await sleep(100)
  return Object.fromEntries(run.agents.map(a => [a.nick, a]))
}

async function enter (member, x, y) {
  const ws = new WebSocket(`ws://localhost:${env.port}/ws?room=square`, ['fjs', `fjs.bearer.${member.token}`])
  const s  = { ws, frames: [], callId: 0 }
  ws.onmessage = (e) => { try { s.frames.push(JSON.parse(String(e.data))) } catch {} }
  open.push(s)
  for (let i = 0; i < 200 && !s.frames.some(f => f.type === 'connection'); i++) await sleep(5)
  ws.send(JSON.stringify({ type: 'subscribe', channel: `room:${square.id}`, meta: { x, y } }))
  await sleep(60)
  return s
}

async function say (s, body, extra = {}) {
  const id = String(++s.callId)
  s.ws.send(JSON.stringify({ type: 'service_call', id, service: 'messages', method: 'create', data: { roomId: square.id, body, ...extra } }))
  for (let i = 0; i < 200; i++) {
    const answer = s.frames.find(f => f.id === id && (f.type === 'service_result' || f.type === 'service_error'))
    if (answer) return answer
    await sleep(5)
  }
  throw new Error(`no answer to ${body}`)
}

const lines = (s) => s.frames.filter(f => f.type === 'event' && f.event === 'messages created').map(f => f.data)
const from  = (s, agent) => lines(s).filter(l => l.memberId === agent.id)

async function until (fn, ms = 3000) {
  for (let t = 0; t < ms; t += 20) { if (fn()) return true; await sleep(20) }
  return false
}

describe('who answers', () => {
  test('a line names an agent as a word, and not inside another', () => {
    expect(['ace, hi', 'hey @Ace', 'ACE?', 'is that you ace'].every(b => names(b, 'ace'))).toBe(true)
    expect(['grace', 'aces high', 'place'].some(b => names(b, 'ace'))).toBe(false)
  })

  test('the named, else the nearest hearer, and a whisper only by its own', () => {
    const ace = { id: 1, nick: 'ace', at: { x: 26, y: 21 } }
    const charles = { id: 2, nick: 'charles', at: { x: 36, y: 21 } }
    expect(responders({ body: 'charles?' }, [ace, charles], { x: 27, y: 21 })).toEqual([charles])
    expect(responders({ body: 'ace and charles' }, [ace, charles], null)).toEqual([ace, charles])
    expect(responders({ body: 'evening' }, [ace, charles], { x: 34, y: 21 })).toEqual([charles])
    expect(responders({ body: 'evening' }, [ace], { x: 34, y: 21 })).toEqual([ace])
    expect(responders({ body: 'charles, psst', toId: 1 }, [ace], null)).toEqual([ace])
    expect(responders({ body: 'ace' }, [], null)).toEqual([])
  })

  test('a reply is one line a Message can hold, and never a shout', () => {
    expect(oneLine('Ace: "Right\n  you are."', 'Ace')).toBe('Right you are.')
    expect(oneLine('!!everyone listen', 'Ace')).toBe('everyone listen')
    expect(oneLine('x'.repeat(400), 'Ace')).toHaveLength(280)
    expect(oneLine('   ', 'Ace')).toBeNull()
    expect(parseMods(' Jo, ,sam ')).toEqual(new Set(['jo', 'sam']))
  })

  test('the model is handed the soul and no tool, and the prompt the lines heard', () => {
    const argv = claudeArgv({ soul: 'You are Ace.' })
    expect(argv[argv.indexOf('--system-prompt') + 1]).toBe('You are Ace.')
    expect(argv[argv.indexOf('--tools') + 1]).toBe('')
    expect(argv).toContain('--strict-mcp-config')
    const p = promptFor({ name: 'Ace', room: 'square', speaker: 'jo', line: { body: 'ace?' }, heard: [{ nick: 'sam', body: 'hello' }] })
    expect(p).toContain('sam: hello')
    expect(p).toContain('jo just said: ace?')
  })
})

describe('in the square', () => {
  test('both stand where they were put, on keys of their own', async () => {
    const a = await agents()
    const s = await enter(sam, 30, 21)
    const sync = s.frames.filter(f => f.event === 'presence:sync').at(-1).data.members
    const where = (id) => sync.find(m => String(m.userId) === String(id))?.meta
    expect(where(a.ace.id)).toMatchObject(AGENTS[0].home)
    expect(where(a.charles.id)).toMatchObject(AGENTS[1].home)
    expect(existsSync(join(dir, 'keys', 'ace', 'key.json'))).toBe(true)
    expect(existsSync(join(dir, 'keys', 'charles', 'key.json'))).toBe(true)
  })

  test("a mod's line is answered by the agent it names, and a second member sees the answer", async () => {
    const a  = await agents()
    const j  = await enter(jo, 28, 21)
    const s  = await enter(sam, 30, 21)
    expect((await say(j, 'charles, how are the lamps?')).type).toBe('service_result')
    expect(await until(() => from(s, a.charles).length === 1)).toBe(true)
    expect(from(s, a.charles)[0].body).toBe('heard jo just said: charles, how are the lamps? -- over to ace')
    await sleep(300)
    expect(from(s, a.ace)).toEqual([])
    expect(asked()).toHaveLength(1)
    expect(asked()[0].argv[asked()[0].argv.indexOf('--system-prompt') + 1]).toStartWith('You are Charles')
  })

  test("a line naming nobody is answered once, by the nearest", async () => {
    const a = await agents()
    const j = await enter(jo, 28, 21)
    const s = await enter(sam, 30, 21)
    await say(j, 'evening all')
    expect(await until(() => from(s, a.ace).length === 1)).toBe(true)
    await sleep(300)
    expect(from(s, a.charles)).toEqual([])
    expect(asked()).toHaveLength(1)
  })

  test("a non-mod's line is heard by everyone and answered by nobody", async () => {
    const a = await agents()
    const j = await enter(jo, 28, 21)
    const s = await enter(sam, 30, 21)
    await say(s, 'ace, what is the shortcut to the docks?')
    expect(await until(() => lines(j).some(l => l.memberId === sam.id))).toBe(true)
    await sleep(500)
    expect(from(j, a.ace)).toEqual([])
    expect(from(j, a.charles)).toEqual([])
    expect(asked()).toEqual([])
    expect(said.some(l => l.startsWith('sam is not a mod'))).toBe(true)
  })

  test('Ace and Charles never answer each other, even listed as mods', async () => {
    const a = await agents('jo,ace,charles')
    const j = await enter(jo, 28, 21)
    const s = await enter(sam, 30, 21)
    await say(j, 'ace, who keeps the lamps?')
    expect(await until(() => from(s, a.ace).length === 1)).toBe(true)
    expect(from(s, a.ace)[0].body).toEndWith('over to charles')
    // Charles stands in earshot of Ace and heard the line that names him.
    expect(await until(() => a.charles.heard.some(l => l.memberId === a.ace.id))).toBe(true)
    await sleep(600)
    expect(from(s, a.charles)).toEqual([])
    expect(from(s, a.ace)).toHaveLength(1)
    expect(asked()).toHaveLength(1)
  })

  test('an agent answers once per its gap, and the line meanwhile is dropped', async () => {
    const a = await agents('jo', { replyMs: 5_000 })
    const j = await enter(jo, 28, 21)
    const s = await enter(sam, 30, 21)
    await say(j, 'ace, one')
    expect(await until(() => from(s, a.ace).length === 1)).toBe(true)
    await say(j, 'ace, two')
    expect(await until(() => lines(s).filter(l => l.memberId === jo.id).length === 2)).toBe(true)
    await sleep(400)
    expect(from(s, a.ace)).toHaveLength(1)
    expect(said.some(l => l.includes('too soon after the last'))).toBe(true)
  })

  test("a whisper is answered in a whisper, which the bystander never receives", async () => {
    const a = await agents()
    const j = await enter(jo, 28, 21)
    const s = await enter(sam, 30, 21)
    await say(j, 'are you there?', { toId: a.charles.id })
    expect(await until(() => from(j, a.charles).length === 1)).toBe(true)
    expect(from(j, a.charles)[0].toId).toBe(jo.id)
    await sleep(300)
    expect(from(s, a.charles)).toEqual([])
    expect(asked()[0].prompt).toContain('jo just whispered to you: are you there?')
  })
})
