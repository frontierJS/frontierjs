/*
 * test/protocol.test.ts — the control protocol with no process: frames in,
 * lines out, a person's answer into a `control_response`.
 *
 * The two recorded chats replay at the bottom: their stdout through
 * `LineReader` and `Protocol`, and the host's recorded answer to each prompt
 * against what `decide` writes for the same choice.
 */

import { describe, expect, test } from 'bun:test'
import { commandsOf, decide, initOf, LineReader, mergeCommands, modelsOf, Protocol, usageOf } from '../index.ts'
import type { Ask, Frame } from '../index.ts'
import { load } from './census.ts'

describe('the control protocol, with no process', () => {
  test('a line split across chunks is one frame, and a line that is not JSON is junk, not the end of the read', () => {
    const r = new LineReader()
    expect(r.push('{"type":"sys')).toEqual({ frames: [], junk: [] })
    expect(r.push('tem"}\nwarning: not json\n[1]\n{"type":"res')).toEqual({ frames: [{ type: 'system' }], junk: ['warning: not json', '[1]'] })
    expect(r.flush()).toEqual({ frames: [], junk: ['{"type":"res'] })
  })
  test('the host\'s requests are matched by id out of order, an id it did not issue is ignored, and a close fails what is left', async () => {
    const wrote: Record<string, any>[] = []
    const p = new Protocol((l) => wrote.push(JSON.parse(l)))
    const a = p.initialize()
    const b = p.interrupt()
    expect(wrote.map((w) => w.request.subtype)).toEqual(['initialize', 'interrupt'])
    const [ia, ib] = wrote.map((w) => w.request_id)
    expect(ia).not.toBe(ib)
    expect(p.receive({ type: 'control_response', response: { subtype: 'success', request_id: ib, response: { still_queued: [] } } })).toEqual({ kind: 'none' })
    expect(await b).toEqual({ still_queued: [] })
    expect(p.receive({ type: 'control_response', response: { subtype: 'success', request_id: 'theirs', response: {} } })).toEqual({ kind: 'none' })
    const c = p.request('set_effort')
    p.receive({ type: 'control_response', response: { subtype: 'error', request_id: wrote.at(-1)!.request_id, error: 'Unsupported control request subtype: set_effort' } })
    await expect(c).rejects.toThrow('Unsupported')
    p.close('gone')
    await expect(a).rejects.toThrow('gone')
  })
  test('a can_use_tool is held until answered once, a withdrawn one is dropped, and a replay is told apart', () => {
    const wrote: Record<string, any>[] = []
    const p = new Protocol((l) => wrote.push(JSON.parse(l)))
    const got = p.receive({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: 't1' } })
    expect(got).toMatchObject({ kind: 'ask', ask: { request: 'r1', tool: 'Bash', input: { command: 'ls' }, toolUseId: 't1' } })
    if (got.kind !== 'ask') return
    expect(decide(got.ask, 'deny')).toMatchObject({ behavior: 'deny' })
    expect(decide(got.ask, 'sure')).toBeNull()
    expect(p.answer('r1', decide(got.ask, 'allow')!)).toBe(true)
    expect(wrote.at(-1)).toEqual({ type: 'control_response', response: { subtype: 'success', request_id: 'r1', response: { behavior: 'allow', updatedInput: { command: 'ls' } } } })
    expect(p.answer('r1', { behavior: 'deny', message: 'x' })).toBe(false)
    p.receive({ type: 'control_request', request_id: 'r2', request: { subtype: 'can_use_tool', tool_name: 'Write', input: {} } })
    expect(p.receive({ type: 'control_cancel_request', request_id: 'r2' })).toEqual({ kind: 'withdrawn', request: 'r2' })
    expect(p.asks.size).toBe(0)
        p.receive({ type: 'control_request', request_id: 'r3', request: { subtype: 'hook_callback' } })
    expect(wrote.at(-1)?.response).toMatchObject({ subtype: 'error', request_id: 'r3' })
    expect(p.receive({ type: 'user', isReplay: true, message: {} }).kind).toBe('replay')
    expect(p.receive({ type: 'result' }).kind).toBe('frame')
  })
})

describe('a person\'s answer', () => {
  const ask = (tool: string, input: object): Ask => ({ request: 'r', tool, input, suggestions: [], toolUseId: null, description: null })
  test('a plan approved into acceptEdits says so; accepting edits on another tool is refused', () => {
    const plan = ask('ExitPlanMode', { plan: 'p' })
    expect(decide(plan, 'allow', undefined, { edits: true })).toMatchObject({ updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }] })
    expect(decide(plan, 'allow')).toMatchObject({ updatedPermissions: [{ type: 'setMode', mode: 'default', destination: 'session' }] })
    expect(() => decide(ask('Write', {}), 'allow', undefined, { edits: true })).toThrow('plan')
  })
  test('a deny names the host, and the person\'s note after it', () => {
    expect(decide(ask('Bash', {}), 'deny', ' not now ', {}, 'Lathe')).toEqual({ behavior: 'deny', message: 'The person using Lathe denied this Bash call, so it did not run. Their note: not now' })
  })
})

describe('the composer\'s reading of the protocol', () => {
  test('system/init gives the model and the names `/` lists, and any other frame gives nothing', () => {
    expect(initOf({ type: 'system', subtype: 'init', model: 'claude-haiku-5-5', slash_commands: ['compact', '/review', 3, ''], skills: ['ui-hazards'] })).toEqual({ model: 'claude-haiku-5-5', commands: ['compact', 'review'], skills: ['ui-hazards'] })
    expect(initOf({ type: 'system', subtype: 'init' })).toEqual({ model: null, commands: [], skills: [] })
    expect(initOf({ type: 'system', subtype: 'status' })).toBeNull()
  })
  test('the initialize answer\'s commands are read leniently, and init only adds names the list lacks', () => {
    expect(commandsOf({ commands: [{ name: '/compact', description: ' Compact ', argumentHint: '[x]' }, 'bare', { name: 'compact' }, { name: 5 }, null, { name: 'odd', description: 3, argumentHint: {} }] })).toEqual([
      { name: 'compact', description: 'Compact', argumentHint: '[x]' },
      { name: 'bare', description: '', argumentHint: '' },
      { name: 'odd', description: '', argumentHint: '' },
    ])
    expect(commandsOf({ commands: 'no' })).toEqual([])
    expect(commandsOf(null)).toEqual([])
    expect(commandsOf({ commands: Array.from({ length: 700 }, (_, i) => ({ name: `c${i}` })) })).toHaveLength(500)
    const merged = mergeCommands([{ name: 'a', description: 'listed', argumentHint: '' }], { model: null, commands: ['a', 'b'], skills: ['c', 'b'] })
    expect(merged.map((c) => [c.name, c.description])).toEqual([['a', 'listed'], ['b', ''], ['c', '']])
  })
  test('the initialize answer\'s models are read leniently: default is left out, odd entries dropped, the efforts kept', () => {
    expect(modelsOf({ models: [{ value: 'default', displayName: 'Default (recommended)' }, { value: 'claude-fable-5-2[1m]', displayName: ' Fable ', supportedEffortLevels: ['low', 3, 'max'] }, { value: 'sonnet' }, { value: 'sonnet', displayName: 'Again' }, { value: 5 }, { displayName: 'none' }, 'x', null, { value: 'odd', displayName: 7, supportedEffortLevels: 'no' }] })).toEqual([
      { value: 'claude-fable-5-2[1m]', displayName: 'Fable', efforts: ['low', 'max'] },
      { value: 'sonnet', displayName: 'sonnet', efforts: [] },
      { value: 'odd', displayName: 'odd', efforts: [] },
    ])
    expect(modelsOf({ models: 'no' })).toEqual([])
    expect(modelsOf(null)).toEqual([])
    expect(modelsOf({ models: Array.from({ length: 80 }, (_, i) => ({ value: `m${i}` })) })).toHaveLength(50)
  })
  test('the picker offers one model per family, the newest, as Claude Code lists it first', () => {
    // The shape Claude Code's initialize answered on 2026-11-19, abridged.
    const listed = [['default', 'Default (recommended)'], ['opus', 'Opus 5.5'], ['fable', 'Fable 5.2'], ['sonnet', 'Sonnet 5.5'], ['haiku', 'Haiku 5.5'], ['claude-fable-5-1', 'Fable 5.1'], ['claude-haiku-4-5-20251001', 'Haiku 4.5'], ['claude-sonnet-5', 'Sonnet 5'], ['claude-opus-5', 'Opus 5'], ['claude-opus-4-8', 'Opus 4.8'], ['claude-sonnet-4-6', 'Sonnet 4.6']]
    expect(modelsOf({ models: listed.map(([value, displayName]) => ({ value, displayName })) }).map((m) => m.displayName)).toEqual(['Opus 5.5', 'Fable 5.2', 'Sonnet 5.5', 'Haiku 5.5'])
  })
  test('get_context_usage is read for its three numbers, and an answer without them is no reading', () => {
    expect(usageOf({ totalTokens: 42000, maxTokens: 200000, percentage: 21, categories: [] })).toEqual({ total: 42000, max: 200000, percent: 21 })
    expect(usageOf({ commands: [] })).toBeNull()
    expect(usageOf(null)).toBeNull()
  })
  test('a user message carries content blocks as given: the text block, then a base64 image block', () => {
    const lines: string[] = []
    new Protocol((l) => lines.push(l)).user([{ type: 'text', text: 'what is this' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBO' } }])
    expect(JSON.parse(lines[0]).message.content.map((b: { type: string }) => b.type)).toEqual(['text', 'image'])
  })
})

// ─── the recorded chats ──────────────────────────────────────────────────

type Wrote = Record<string, any>

/** A recorded chat's stdout through a reader and a protocol, as a host would hold it. */
function replay(file: string) {
  const lines = load(file)
  const recorded = lines.filter(l => l.dir === 'in').map(l => l.line as Wrote)
  const wrote: Wrote[] = []
  const p = new Protocol(l => wrote.push(JSON.parse(l)))
  const init = p.initialize()
  const reader = new LineReader()
  const kinds: string[] = []
  const asks: Ask[] = []
  const bytes = lines.filter(l => l.dir === 'out').map(l => JSON.stringify(l.line) + '\n').join('')
  // Split mid-line on purpose: a chunk boundary is not a frame boundary.
  const read = [reader.push(bytes.slice(0, 1001)), reader.push(bytes.slice(1001)), reader.flush()]
  for (const { frames, junk } of read) {
    expect(junk).toEqual([])
    for (const f of frames) {
      const got = p.receive(f as Frame)
      kinds.push(got.kind)
      if (got.kind === 'ask') asks.push(got.ask)
    }
  }
  return { recorded, wrote, init, kinds, asks, p }
}

const answerOf = (recorded: Wrote[], request: string) =>
  recorded.find(l => l.type === 'control_response' && l.response.request_id === request)?.response.response

describe('the recorded chats, replayed', () => {
  test('a permission: one Bash prompt, the initialize answered, the echo of the host\'s own answer ignored', async () => {
    const { recorded, wrote, init, kinds, asks } = replay('chat-permission.jsonl')
    expect(wrote[0]).toEqual(recorded[0])
    expect(await init).toHaveProperty('commands')
    expect(asks.map(a => [a.tool, a.toolUseId])).toEqual([['Bash', 'toolu-4']])
    expect(kinds.filter(k => k === 'replay')).toHaveLength(1)
    const allow = decide(asks[0], 'allow')
    expect(allow).toEqual(answerOf(recorded, asks[0].request))
  })

  test('a question: AskUserQuestion, answered by question text, written as the host wrote it', async () => {
    const { recorded, p, asks } = replay('chat-question.jsonl')
    expect(asks.map(a => a.tool)).toEqual(['AskUserQuestion'])
    const said = answerOf(recorded, asks[0].request)
    const decision = decide(asks[0], 'allow', undefined, { answers: said.updatedInput.answers })
    expect(decision).toEqual(said)
    const out: Wrote[] = []
    const q = new Protocol(l => out.push(JSON.parse(l)))
    q.receive({ type: 'control_request', request_id: asks[0].request, request: { subtype: 'can_use_tool', tool_name: asks[0].tool, input: asks[0].input } })
    q.answer(asks[0].request, decision!)
    expect(out[0]).toEqual(recorded.find(l => l.type === 'control_response')!)
    expect(p.asks.size).toBe(1)
  })
})
