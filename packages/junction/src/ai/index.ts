// ai/index.ts
// The SHAPE an AI model adapter satisfies, and the two things that compose over
// it: a fluent request builder and a registry of named models.
//
// ── There is no vendor in here, and that is the whole design ──────────────
//
// It used to ship `createOpenAIModel` and `createAnthropicModel`: two hardcoded
// vendor URLs, a hardcoded `anthropic-version`, a hardcoded `anthropic-beta`
// naming a preview that went GA years ago, and a pair of bare `fetch` calls
// with no deadline on the slowest request an app makes. `FJS-D153` had already
// answered this for Conduit — *the boundary owns the mechanism, never the
// vendor* — and every one of its three costs applied here unchanged: a vendor's
// API bump would ship a junction release to every app, a connector's
// dependencies would sit in front of every junction user, and a connector needs
// a dev sink nobody had written. Junction has no vendor code left to go stale.
//
// ── Writing one ───────────────────────────────────────────────────────────
//
// An adapter is an object with `name`, `complete` and `stream`. It belongs in
// the app, and it reaches the vendor through `app.conduit` rather than through
// a `fetch` of its own — which is where the deadline, the retry, the breaker,
// the auth header and the body encoding already live, each declared per target
// rather than restated per provider:
//
//   app.conduit.register({
//     name:     'anthropic',
//     url:      'https://api.anthropic.com',
//     encoding: 'json',
//     auth:     { type: 'header', name: 'x-api-key', value: process.env.ANTHROPIC_API_KEY },
//     timeoutMs: 120_000,
//   })
//
//   export const claude: IAIModel = {
//     name: 'claude',
//     async complete(req) {
//       const res = await app.conduit.send('anthropic', {
//         path: '/v1/messages',
//         headers: { 'anthropic-version': '2023-06-01' },
//         body: { model: 'claude-sonnet-5', max_tokens: req.maxTokens ?? 1024, messages: req.messages },
//       })
//       return { content: res.body.content[0].text, model: res.body.model }
//     },
//     async stream(req, onChunk) { … },
//   }
//
// `createApp({ ai })` takes an `AIRegistry`; `app.ai` is where it lands.

// ─── IAI interface ────────────────────────────────────────────────────────

export interface IAIModel {
  name:       string
  complete:   (req: AIRequest) => Promise<AIResponse>
  stream:     (req: AIRequest, onChunk: (chunk: string) => void) => Promise<AIResponse>
}

export interface AIRequest {
  messages:    AIMessage[]
  system?:     string
  maxTokens?:  number
  temperature?: number
  think?:      boolean    // extended thinking (Anthropic)
  model?:      string     // override model name
}

export interface AIMessage {
  role:    'user' | 'assistant' | 'system'
  content: string
}

export interface AIResponse {
  content:    string
  model:      string
  inputTokens?:  number
  outputTokens?: number
  thinkContent?: string
}

// ─── AI Builder — fluent API ──────────────────────────────────────────────

export class AIBuilder {

  private _messages:   AIMessage[] = []
  private _system?:    string
  private _maxTokens?: number
  private _temp?:      number
  private _think       = false
  private _model:      IAIModel

  constructor(model: IAIModel) {
    this._model = model
  }

  system(content: string): this {
    this._system = content
    return this
  }

  user(content: string): this {
    this._messages.push({ role: 'user', content })
    return this
  }

  assistant(content: string): this {
    this._messages.push({ role: 'assistant', content })
    return this
  }

  temperature(value: number): this {
    this._temp = value
    return this
  }

  maxTokens(value: number): this {
    this._maxTokens = value
    return this
  }

  think(): this {
    this._think = true
    return this
  }

  private _buildRequest(): AIRequest {
    if (!this._messages.length)
      throw new Error('AI: at least one message required')
    return {
      messages:    this._messages,
      system:      this._system,
      maxTokens:   this._maxTokens,
      temperature: this._temp,
      think:       this._think,
    }
  }

  async complete(): Promise<AIResponse> {
    return this._model.complete(this._buildRequest())
  }

  async stream(onChunk: (chunk: string) => void): Promise<AIResponse> {
    return this._model.stream(this._buildRequest(), onChunk)
  }
}

// ─── AI registry ─────────────────────────────────────────────────────────

export class AIRegistry {

  private _models = new Map<string, IAIModel>()

  // Chainable, like the builder beside it, so `new AIRegistry().register(m)` is
  // an expression a `createApp({ ai })` can take. It returned void, which made
  // the one-line form in every doc set `ai` to undefined.
  register(model: IAIModel): this {
    this._models.set(model.name, model)
    return this
  }

  get(name: string): IAIModel {
    const model = this._models.get(name)
    // Names what IS registered: the failure is almost always a spelling, and an
    // empty registry and a typo are different mistakes.
    if (!model) throw new Error(
      `AI model "${name}" not registered. ` +
      (this._models.size ? `Registered: ${this.list().join(', ')}` : 'No models are registered.'))
    return model
  }

  use(name: string): AIBuilder {
    return new AIBuilder(this.get(name))
  }

  list(): string[] {
    return Array.from(this._models.keys())
  }
}
