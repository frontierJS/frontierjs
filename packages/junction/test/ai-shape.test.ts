// ai-shape.test.ts
//
// What junction ships here is the lookup of an app's named doors, not a model.
// Every door is a fake and that is the point rather than a shortcut: the
// contract (`@frontierjs/toolbelt/ask`) is what makes a door substitutable, so a
// test that could only be written against a real vendor would be evidence the
// shape had failed.

import { describe, it, expect } from 'bun:test'
import { createApp } from '../index.ts'
import { ai } from '../src/ai/index.ts'
import { checkReply, unanswered } from '@frontierjs/toolbelt/ask'
import type { AskOptions, Door, Question, Reply } from '@frontierjs/toolbelt/ask'

function recorder(name = 'fake') {
  const seen: Array<{ question: Question, opts?: AskOptions }> = []
  const door: Door = async (question, opts) => {
    seen.push({ question, opts })
    return { ok: true, answer: 'ok', door: name, model: opts?.model ?? 'm', usage: null, costUsd: null, ms: 1 }
  }
  return { door, seen }
}

function doors(registered: Record<string, Door>) {
  const app = createApp()
  app.configure(ai({ doors: registered }))
  return app.ai
}

describe('the doors', () => {

  it('a registered door answers, and its reply passes through untouched', async () => {
    const reply: Reply = { ok: true, answer: { n: 1 }, door: 'x', model: 'm', usage: { inputTokens: 3, outputTokens: 4 }, costUsd: 0.01, ms: 7 }
    const door: Door = async () => reply
    const asked = await doors({ x: door }).ask('x', { prompt: 'p', schema: { type: 'object' } })
    expect(asked).toBe(reply)
  })

  it('the question and the options reach the door', async () => {
    const { door, seen } = recorder()
    const controller = new AbortController()
    const question: Question = { prompt: 'p', system: 's', schema: { type: 'object' } }
    await doors({ x: door }).ask('x', question, { model: 'other', signal: controller.signal })
    expect(seen[0].question).toEqual(question)
    expect(seen[0].opts?.model).toBe('other')
    expect(seen[0].opts?.signal).toBe(controller.signal)
  })

  it('an unknown name is an Unanswered naming what IS registered', async () => {
    const question = { prompt: 'p' }
    const reply = await doors({ claude: recorder('claude').door }).ask('cluade', question)
    expect(reply.ok).toBe(false)
    if (reply.ok) throw new Error('unreachable')
    expect(reply.failure.reason).toBe('not_set_up')
    expect(reply.failure.retryable).toBe(false)
    expect(reply.failure.message).toContain('Registered: claude')
    expect(reply.door).toBe('cluade')
    expect(checkReply(reply, question)).toEqual([])
  })

  it('an empty registry is a different mistake and says so', async () => {
    const reply = await doors({}).ask('claude', { prompt: 'p' })
    if (reply.ok) throw new Error('unreachable')
    expect(reply.failure.message).toContain('No doors are registered')
    expect(checkReply(reply)).toEqual([])
  })

  it('a door that cannot answer returns its own Unanswered untouched', async () => {
    const lost: Reply = { ok: false, failure: unanswered('rate_limited'), door: 'x', model: 'm', ms: 2 }
    const reply = await doors({ x: async () => lost }).ask('x', { prompt: 'p' })
    expect(reply).toBe(lost)
  })

  it('names() lists the registered doors in the order given', () => {
    expect(doors({ a: recorder().door, b: recorder().door }).names()).toEqual(['a', 'b'])
    expect(doors({}).names()).toEqual([])
  })
})

describe('the plugin', () => {

  it('puts the doors on app.ai, and an app that did not install it has none', () => {
    const bare = createApp()
    expect('ai' in bare).toBe(false)
    const app = createApp()
    app.configure(ai({ doors: { x: recorder().door } }))
    expect('ai' in app).toBe(true)
    expect(app.ai.names()).toEqual(['x'])
  })
})

describe('no vendor is shipped', () => {

  it('the package exports no named-vendor connector', async () => {
    // `FJS-D153` for junction: the boundary owns the mechanism, never the
    // vendor. A connector added back here would ship a vendor's API cadence to
    // every app that installs junction.
    const pkg = await import('../index.ts') as Record<string, unknown>
    for (const name of ['createOpenAIModel', 'createAnthropicModel'])
      expect(pkg[name]).toBeUndefined()
  })

  it('the ai module imports no vendor adapter and calls no vendor host', async () => {
    const src = await Bun.file(new URL('../src/ai/index.ts', import.meta.url)).text()
    // The header names the adapters in a comment; what must not appear is one
    // being imported (junction sits below both) or a host being called.
    const code = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
    expect(code).not.toContain('@frontierjs/claude')
    expect(code).not.toContain('@frontierjs/conduit-anthropic')
    expect(code).not.toContain('api.anthropic.com')
    expect(code).not.toContain('api.openai.com')
  })
})
