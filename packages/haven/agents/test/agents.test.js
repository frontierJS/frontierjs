// agents/test/agents.test.js — Ace and Charles on a real Haven, answered by a
// stub `claude` that costs nothing and writes down every prompt it was handed,
// working in a fake checkout whose `fli` and fix loop cost nothing either.
//
// Real sockets on a real app over the env's own Litestone client, with the
// runner signing both agents in through the real login. A line no agent
// answers reads exactly like a runner that never heard it, so every silence
// sits beside a delivery: the line itself reaching another socket.

import { test, expect, describe, beforeAll, beforeEach, afterEach } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createTestEnv } from '@frontierjs/testing'

import { buildHavenApp } from '../../api/src/app.ts'
import { signIn } from '../../api/test/sign-in.ts'
import { AGENTS, benchSpot, checkPlan, claudeArgv, idsIn, names, oneLine, parseMods, PLANNER, promptFor, responders, rollOf, startAgents, taskOf } from '../agents.js'

const SCHEMA = join(import.meta.dir, '..', '..', 'db', 'schema.lite')
const sleep  = (ms) => new Promise(r => setTimeout(r, ms))

let dir, stub, stubLog, tree, planFile, loopLog, fliLog
let env, square, jo, sam, run
const open = []
const said = []

beforeAll(() => {
  dir     = mkdtempSync(join(tmpdir(), 'haven-agents-'))
  stubLog = join(dir, 'claude.log')
  stub    = join(dir, 'claude')
  tree    = join(dir, 'tree')
  planFile = join(dir, 'plan.json')
  loopLog  = join(dir, 'loop-argv.log')
  fliLog   = join(dir, 'fli.log')
  // The checkout: `fli next` ranks three rows, one of them by hand, and `fli
  // file` mints FJS-9; the loop prints the lines `scripts/fix-loop.mjs` does,
  // closing each row it was handed.
  mkdirSync(join(tree, 'scripts'), { recursive: true })
  mkdirSync(join(tree, 'packages', 'cli', 'bin'), { recursive: true })
  const ROWS = [
    { id: 'FJS-6', severity: 'S2', pkg: ['basecamp'], byHand: true,  title: 'a row for a hand' },
    { id: 'FJS-7', severity: 'S3', pkg: ['haven'],    byHand: false, title: 'a typo in the haven README' },
    { id: 'FJS-8', severity: 'S4', pkg: ['haven'],    byHand: false, title: 'a slow frame in the square' },
  ]
  writeFileSync(join(tree, 'packages', 'cli', 'bin', 'fli.js'), `
import { appendFileSync } from 'node:fs'
const argv = process.argv.slice(2)
appendFileSync(${JSON.stringify(fliLog)}, JSON.stringify(argv) + '\\n')
if (argv[0] === 'next') console.log(JSON.stringify({ ready: ${JSON.stringify(ROWS)} }))
if (argv[0] === 'file') console.log('\\n  ✓ FJS-9 filed — ISSUES.md:12\\n')
`)
  writeFileSync(join(tree, 'scripts', 'fix-loop.mjs'), `
import { appendFileSync } from 'node:fs'
const argv = process.argv.slice(2)
appendFileSync(${JSON.stringify(loopLog)}, JSON.stringify(argv) + '\\n')
const ids = argv.includes('--ids') ? argv[argv.indexOf('--ids') + 1].split(',') : ['FJS-8']
for (const [i, id] of ids.entries()) {
  console.log('\\n[fix-loop] ' + (i + 1) + '/' + ids.length + ' ' + id + ' (S3, haven) — a row')
  await Bun.sleep(600)
  console.log('[fix-loop]   sonnet/high: closed · $0.42 · 3 min · 20 turns (fix 20)')
}
console.log('\\n[fix-loop] ' + ids.length + ' closed · 0 waiting on a ruling · $0.42 spent · log /nowhere')
`)
  // The log path is written into the stub: a child gets the environment the
  // test process started with, not one it assigned since. The planner's
  // answer is whatever the test last wrote to the plan file.
  writeFileSync(stub, `#!${process.execPath}
import { appendFileSync, readFileSync } from 'node:fs'
const argv   = process.argv.slice(2)
const prompt = await Bun.stdin.text()
appendFileSync(${JSON.stringify(stubLog)}, JSON.stringify({ argv, prompt, cwd: process.cwd() }) + '\\n')
const soul = argv[argv.indexOf('--system-prompt') + 1]
if (soul.startsWith('You turn a task')) { console.log('Here: ' + readFileSync(${JSON.stringify(planFile)}, 'utf8')); process.exit(0) }
const name = soul.match(/^You are (\\w+)/)?.[1] ?? '?'
const line = prompt.split('\\n').find(l => / just (said|whispered to you): /.test(l))
const other = name === 'Ace' ? 'charles' : 'ace'
console.log(name + ': "heard ' + line + ' -- over to ' + other + '"')
`)
  chmodSync(stub, 0o755)
})

const jsonl = (f) => existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []
const asked = () => jsonl(stubLog)
const loops = () => jsonl(loopLog)
const filed = () => jsonl(fliLog).filter(a => a[0] === 'file')

beforeEach(async () => {
  for (const f of [stubLog, loopLog, fliLog]) writeFileSync(f, '')
  env = await createTestEnv({
    schema: SCHEMA,
    listen: true,
    api:    ({ db }) => buildHavenApp({ db, sessionKey: 'test-session-key', port: 0, mods: ['jo'], wsPerIp: 12 }),
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

async function agents (mods = 'jo', timing = {}, who = AGENTS.filter(a => !a.room)) {
  run = await startAgents({
    api: `http://localhost:${env.port}`, mods, bin: stub, agents: who,
    keysDir: join(dir, 'keys'), wander: false,
    workRoot: tree, loopLock: join(dir, 'loop.json'), loopLog: join(dir, 'loop.out'),
    timing: { replyMs: 0, gatherMs: 80, ...timing },
    log: (l) => said.push(l),
  })
  await sleep(100)
  return Object.fromEntries(run.agents.map(a => [a.nick, a]))
}

async function enter (member, x, y, room = square) {
  const ws = new WebSocket(`ws://localhost:${env.port}/ws?room=${room.slug}`, ['fjs', `fjs.bearer.${member.token}`])
  const s  = { ws, frames: [], callId: 0 }
  ws.onmessage = (e) => { try { s.frames.push(JSON.parse(String(e.data))) } catch {} }
  open.push(s)
  for (let i = 0; i < 200 && !s.frames.some(f => f.type === 'connection'); i++) await sleep(5)
  ws.send(JSON.stringify({ type: 'subscribe', channel: `room:${room.id}`, meta: { x, y } }))
  await sleep(60)
  return s
}

async function say (s, body, extra = {}, room = square) {
  const id = String(++s.callId)
  s.ws.send(JSON.stringify({ type: 'service_call', id, service: 'messages', method: 'create', data: { roomId: room.id, body, ...extra } }))
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

  test("a task is the words after task:, in a line naming the agent or whispered to it", () => {
    expect(taskOf({ body: 'ace task: fix the README' }, 'ace')).toBe('fix the README')
    expect(taskOf({ body: 'task: fix it', toId: 1 }, 'ace')).toBe('fix it')
    expect(taskOf({ body: 'task: fix it' }, 'ace')).toBeNull()
    expect(taskOf({ body: 'ace, multitask: no' }, 'ace')).toBeNull()
    expect(taskOf({ body: 'ace, what is a task?' }, 'ace')).toBeNull()
  })

  test("a task's plan is checked against the rows the loop can take, and no word of it becomes a flag", () => {
    const rows = [{ id: 'FJS-7', severity: 'S3', pkg: ['haven'], title: 't' }, { id: 'FJS-8', severity: 'S4', pkg: ['haven', 'mesa'], title: 't' }]
    expect(idsIn('do fjs-7 then FJS-8, and fjs-7 again')).toEqual(['FJS-7', 'FJS-8'])
    expect(checkPlan({ ids: ['fjs-7'] }, rows)).toEqual({ plan: { ids: ['FJS-7'] } })
    expect(checkPlan({ ids: ['FJS-99'] }, rows).refused).toStartWith("FJS-99 isn't one the loop can take")
    expect(checkPlan({ ids: ['FJS-7', 'FJS-8', 'FJS-7', 'FJS-8'] }, rows).refused).toContain('3 at most')
    expect(checkPlan({ pkg: 'mesa', sev: 'S4' }, rows)).toEqual({ plan: { pkg: 'mesa', sev: 'S4', rows: 1 } })
    expect(checkPlan({ pkg: '--budget' }, rows).refused).toContain('nothing the loop can take')
    expect(checkPlan({ pkg: 'haven', sev: 'S9 --rows 40' }, rows).refused).toContain("isn't a severity")
    expect(checkPlan({ file: { sev: 'S2', area: 'haven', title: 'The well has no rope' } }, rows)).toEqual({ file: { sev: 'S2', area: 'haven', title: 'The well has no rope' } })
    expect(checkPlan({ file: { area: '--sev', title: 'The well has no rope' } }, rows).refused).toContain('which package')
    expect(checkPlan({ none: 'that is a question, not work' }, rows)).toEqual({ refused: 'that is a question, not work' })
    expect(checkPlan(null, rows).refused).toBeTruthy()
    expect(checkPlan({ rows: 40 }, rows).refused).toBeTruthy()
  })

  test('the model is handed the soul and no tool, and the prompt the lines heard', () => {
    const argv = claudeArgv({ soul: 'You are Ace.' })
    expect(argv[argv.indexOf('--system-prompt') + 1]).toBe('You are Ace.')
    expect(argv[argv.indexOf('--tools') + 1]).toBe('')
    expect(argv).toContain('--strict-mcp-config')
    expect(argv[argv.indexOf('--model') + 1]).toBe('haiku')
    expect(argv[argv.indexOf('--effort') + 1]).toBe('low')
    const p = promptFor({ name: 'Ace', room: 'square', speaker: 'jo', line: { body: 'ace?' }, heard: [{ nick: 'sam', body: 'hello' }] })
    expect(p).toContain('sam: hello')
    expect(p).toContain('jo just said: ace?')
  })
})

describe('in the tavern', () => {
  test('the regulars each stand in the tavern, not the square', async () => {
    const tavern = await env.system.room.create({ data: { slug: 'tavern', name: 'The tavern' } })
    const a = await agents('jo', {}, AGENTS.filter(x => x.room === 'tavern'))
    expect(Object.keys(a).sort()).toEqual(['marrow', 'nell', 'pike', 'tam', 'wick'])
    expect(Object.values(a).every(x => x.room === 'tavern' && x.roomId === tavern.id)).toBe(true)
  })

  test("a roll is asked of an agent in words and the dice say it, with the model never asked", () => {
    expect(rollOf({ body: 'pike, roll 2d6' }, 'pike')).toBe('2d6')
    expect(rollOf({ body: 'pike roll d20!' }, 'pike')).toBe('d20')
    expect(rollOf({ body: 'roll', toId: 1 }, 'pike')).toBe('d6')
    expect(rollOf({ body: 'roll 2d6' }, 'pike')).toBeNull()
    expect(rollOf({ body: 'pike, roll 99d6' }, 'pike')).toBeNull()
    expect(rollOf({ body: 'pike, roll the dice for me' }, 'pike')).toBeNull()
  })

  test("a mod's 'pike, roll 2d6' is thrown by Pike and said by the dice", async () => {
    const tavern = await env.system.room.create({ data: { slug: 'tavern', name: 'The tavern' } })
    const a = await agents('jo', {}, AGENTS.filter(x => x.room === 'tavern'))
    const j = await enter(jo, 26, 15, tavern)
    expect((await say(j, 'pike, roll 2d6', {}, tavern)).type).toBe('service_result')
    expect(await until(() => lines(j).some(l => /^pike rolls 2d6: \d \+ \d = \d+$/.test(l.body)))).toBe(true)
    const row = lines(j).find(l => /^pike rolls/.test(l.body))
    expect(row.memberId).not.toBe(a.pike.id)
    expect(asked()).toEqual([])
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

describe('at work', () => {
  beforeEach(async () => {
    await env.system.room.create({ data: { slug: 'workshop', name: 'The workshop' } })
  })

  test("a named row goes to the loop as it stands, the agent stands at its bench, and its outcome comes back to the square", async () => {
    const a = await agents('jo', { watchMs: 30 })
    const j = await enter(jo, 28, 21)
    const s = await enter(sam, 30, 21)
    await say(j, 'ace task: fjs-7 please')
    expect(await until(() => from(s, a.ace).length === 1)).toBe(true)
    expect(from(s, a.ace)[0].body).toBe('Taking FJS-7 — a typo in the haven README — off to the workshop, jo.')
    const spot = benchSpot('haven')
    expect(await until(() => a.ace.room === 'workshop' && a.ace.at?.x === spot.x && a.ace.at?.y === spot.y)).toBe(true)
    expect(await until(() => from(s, a.ace).length === 2, 5000)).toBe(true)
    expect(from(s, a.ace)[1].body).toBe('FJS-7 closed — 1 closed · 0 waiting on a ruling · $0.42 spent.')
    expect(a.ace.room).toBe('square')
    expect(a.ace.at).toMatchObject(AGENTS[0].home)
    expect(loops()).toEqual([['--ids', 'FJS-7']])
    expect(asked()).toEqual([])
    expect(from(s, a.charles)).toEqual([])
  })

  test('a task while the loop runs is refused in a line, and starts nothing', async () => {
    const a = await agents('jo', { watchMs: 30 })
    const j = await enter(jo, 28, 21)
    const s = await enter(sam, 30, 21)
    await say(j, 'ace task: FJS-7')
    expect(await until(() => from(s, a.ace).length === 1)).toBe(true)
    await say(j, 'charles task: FJS-8')
    expect(await until(() => from(s, a.charles).length === 1)).toBe(true)
    expect(from(s, a.charles)[0].body).toBe('Still minding the loop on FJS-7, jo — one at a time.')
    expect(await until(() => from(s, a.ace).length === 2, 5000)).toBe(true)
    expect(loops()).toEqual([['--ids', 'FJS-7']])
  })

  test('free words are planned by a model with no tools, against the ready rows, and a bad plan starts nothing', async () => {
    const a = await agents('jo', { watchMs: 30 })
    const j = await enter(jo, 28, 21)
    const s = await enter(sam, 30, 21)
    writeFileSync(planFile, JSON.stringify({ pkg: 'haven', sev: 'S4' }))
    await say(j, 'ace task: tidy up the small haven stuff')
    expect(await until(() => from(s, a.ace).length === 1)).toBe(true)
    expect(from(s, a.ace)[0].body).toBe('Taking the next S4 row in haven — off to the workshop, jo.')
    expect(await until(() => from(s, a.ace).length === 2, 5000)).toBe(true)
    expect(from(s, a.ace)[1].body).toBe('FJS-8 closed — 1 closed · 0 waiting on a ruling · $0.42 spent.')
    expect(loops()).toEqual([['--pkg', 'haven', '--sev', 'S4', '--rows', '1']])
    const plan = asked()[0]
    expect(plan.argv[plan.argv.indexOf('--system-prompt') + 1]).toBe(PLANNER)
    expect(plan.argv[plan.argv.indexOf('--tools') + 1]).toBe('')
    expect(plan.prompt).toContain('The task: tidy up the small haven stuff')
    expect(plan.prompt).toContain('FJS-7 S3 haven — a typo in the haven README')
    expect(plan.prompt).not.toContain('FJS-6')

    writeFileSync(planFile, JSON.stringify({ pkg: '--budget' }))
    await say(j, 'ace task: spend it all')
    expect(await until(() => from(s, a.ace).length === 3)).toBe(true)
    expect(from(s, a.ace)[2].body).toBe("Can't take that one, jo: nothing the loop can take is in --budget.")
    await sleep(200)
    expect(loops()).toHaveLength(1)
    expect(a.ace.room).toBe('square')
  })

  test('a defect no row covers is filed in the register, then run by its new id', async () => {
    const a = await agents('jo', { watchMs: 30 })
    const j = await enter(jo, 28, 21)
    const s = await enter(sam, 30, 21)
    writeFileSync(planFile, JSON.stringify({ file: { sev: 'S2', area: 'haven', title: 'The well in the square has no rope' } }))
    await say(j, 'ace task: the well has no rope, fix it')
    expect(await until(() => from(s, a.ace).length === 1)).toBe(true)
    expect(from(s, a.ace)[0].body).toBe('Taking FJS-9 — The well in the square has no rope — off to the workshop, jo.')
    expect(filed()).toEqual([['file', '--sev', 'S2', '--area', 'haven', '--title', 'The well in the square has no rope',
      '--detail', 'Handed to Ace in Haven by jo: the well has no rope, fix it']])
    expect(await until(() => from(s, a.ace).length === 2, 5000)).toBe(true)
    expect(loops()).toEqual([['--ids', 'FJS-9']])
  })

  test("a non-mod's task starts nothing, and a task: naming nobody is talk", async () => {
    const a = await agents()
    const j = await enter(jo, 28, 21)
    const s = await enter(sam, 30, 21)
    await say(s, 'ace task: FJS-7')
    expect(await until(() => lines(j).some(l => l.memberId === sam.id))).toBe(true)
    await sleep(400)
    expect(from(j, a.ace)).toEqual([])
    await say(j, 'task: anyone?')
    expect(await until(() => from(s, a.ace).length === 1)).toBe(true)
    expect(asked().every(c => c.argv[c.argv.indexOf('--system-prompt') + 1] !== PLANNER)).toBe(true)
    expect(loops()).toEqual([])
    expect(a.ace.room).toBe('square')
  })
})
