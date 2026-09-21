// ai-shape.test.ts
//
// `batteries-12`. What junction ships here is the SHAPE an adapter satisfies —
// `IAIModel`, `AIBuilder`, `AIRegistry` — and it had no tests at all, no
// callers anywhere in this repo, and one documentation reference naming a
// function junction has never exported (`FJS-903`). The two vendor connectors
// it used to ship are gone, so the tests are over what remains.
//
// Every model here is a fake and that is the point rather than a shortcut: the
// interface's whole value is that an app's own adapter is substitutable, so a
// test that could only be written against a real vendor would be evidence the
// shape had failed.

import { describe, it, expect } from 'bun:test'
import { AIBuilder, AIRegistry, type IAIModel, type AIRequest } from '../src/ai/index.ts'

function recorder(name = 'fake') {
  const seen: AIRequest[] = []
  const model: IAIModel = {
    name,
    async complete(req) { seen.push(req); return { content: 'ok', model: name } },
    async stream(req, onChunk) { seen.push(req); onChunk('a'); onChunk('b'); return { content: 'ab', model: name } },
  }
  return { model, seen }
}

describe('the builder collects a request', () => {

  it('carries every part in the order it was given', async () => {
    const { model, seen } = recorder()
    await new AIBuilder(model)
      .system('be brief')
      .user('hello')
      .assistant('hi')
      .user('again')
      .temperature(0.2)
      .maxTokens(64)
      .think()
      .complete()

    expect(seen[0].system).toBe('be brief')
    expect(seen[0].messages.map(m => [m.role, m.content])).toEqual([
      ['user', 'hello'], ['assistant', 'hi'], ['user', 'again'],
    ])
    expect(seen[0].temperature).toBe(0.2)
    expect(seen[0].maxTokens).toBe(64)
    expect(seen[0].think).toBe(true)
  })

  it('refuses a request with no message rather than sending an empty one', async () => {
    const { model, seen } = recorder()
    await expect(new AIBuilder(model).system('only a system prompt').complete()).rejects.toThrow('at least one message')
    // Paired: the refusal must not be *everything is refused*.
    await new AIBuilder(model).user('x').complete()
    expect(seen.length).toBe(1)
  })

  it('streams chunks and still answers the whole response', async () => {
    const { model } = recorder()
    const chunks: string[] = []
    const res = await new AIBuilder(model).user('x').stream(c => chunks.push(c))
    expect(chunks).toEqual(['a', 'b'])
    expect(res.content).toBe('ab')
  })
})

describe('the registry', () => {

  it('register is chainable, so it is an expression createApp({ ai }) can take', () => {
    // It returned void, which made the one-line form in every doc set `ai` to
    // undefined — advice that fails when taken.
    const { model } = recorder('claude')
    const registry = new AIRegistry().register(model)
    expect(registry).toBeInstanceOf(AIRegistry)
    expect(registry.list()).toEqual(['claude'])
  })

  it('a model is found by its own name', async () => {
    const { model, seen } = recorder('claude')
    const res = await new AIRegistry().register(model).use('claude').user('x').complete()
    expect(res.model).toBe('claude')
    expect(seen.length).toBe(1)
  })

  it('an unknown name names what IS registered', () => {
    const registry = new AIRegistry().register(recorder('claude').model)
    expect(() => registry.get('cluade')).toThrow('Registered: claude')
    // An empty registry is a different mistake and says so.
    expect(() => new AIRegistry().get('claude')).toThrow('No models are registered')
  })

  it('registering the same name twice replaces rather than doubling', () => {
    const registry = new AIRegistry().register(recorder('m').model).register(recorder('m').model)
    expect(registry.list()).toEqual(['m'])
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

  it('the ai module names no vendor host', async () => {
    const src = await Bun.file(new URL('../src/ai/index.ts', import.meta.url)).text()
    // The doc comment shows an app's own adapter, so a hostname may appear in a
    // comment; what must not appear is one being CALLED.
    const code = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
    expect(code).not.toContain('api.anthropic.com')
    expect(code).not.toContain('api.openai.com')
    expect(code).not.toContain('anthropic-beta')
  })
})
