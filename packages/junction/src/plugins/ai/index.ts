// ai/index.ts
// AI model adapter — thin abstraction over LLM providers.
// Same IAI interface regardless of provider.
// Fluent builder API inspired by Total.js aimodel.js.

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

  register(model: IAIModel): void {
    this._models.set(model.name, model)
  }

  get(name: string): IAIModel {
    const model = this._models.get(name)
    if (!model) throw new Error(`AI model "${name}" not registered`)
    return model
  }

  use(name: string): AIBuilder {
    return new AIBuilder(this.get(name))
  }

  list(): string[] {
    return Array.from(this._models.keys())
  }
}

// ─── OpenAI adapter ──────────────────────────────────────────────────────

export interface OpenAIOptions {
  apiKey:      string
  model?:      string    // default: 'gpt-4o'
  baseUrl?:    string    // for OpenAI-compatible APIs
}

export function createOpenAIModel(opts: OpenAIOptions): IAIModel {

  const {
    apiKey,
    model:   defaultModel  = 'gpt-4o',
    baseUrl: base          = 'https://api.openai.com/v1'
  } = opts

  async function post(body: unknown): Promise<unknown> {
    const res = await fetch(`${base}/chat/completions`, {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type':  'application/json'
      },
      body: JSON.stringify(body)
    })

    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { error?: { message?: string } }
      throw new Error(`OpenAI error ${res.status}: ${err.error?.message ?? res.statusText}`)
    }

    return res.json()
  }

  function buildMessages(req: AIRequest): unknown[] {
    const msgs: unknown[] = []
    if (req.system) msgs.push({ role: 'system', content: req.system })
    msgs.push(...req.messages)
    return msgs
  }

  return {
    name: opts.model ?? defaultModel,

    async complete(req: AIRequest): Promise<AIResponse> {
      const body: Record<string, unknown> = {
        model:       req.model ?? defaultModel,
        messages:    buildMessages(req),
        max_tokens:  req.maxTokens  ?? 1024,
        temperature: req.temperature ?? 0.7,
      }

      const result = await post(body) as {
        choices: { message: { content: string } }[]
        model:   string
        usage:   { prompt_tokens: number; completion_tokens: number }
      }

      return {
        content:      result.choices[0].message.content,
        model:        result.model,
        inputTokens:  result.usage.prompt_tokens,
        outputTokens: result.usage.completion_tokens,
      }
    },

    async stream(req: AIRequest, onChunk: (chunk: string) => void): Promise<AIResponse> {
      const res = await fetch(`${base}/chat/completions`, {
        method:  'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type':  'application/json'
        },
        body: JSON.stringify({
          model:       req.model ?? defaultModel,
          messages:    buildMessages(req),
          max_tokens:  req.maxTokens  ?? 1024,
          temperature: req.temperature ?? 0.7,
          stream:      true,
        })
      })

      if (!res.ok) throw new Error(`OpenAI stream error ${res.status}`)

      let fullContent = ''
      const reader    = res.body!.getReader()
      const decoder   = new TextDecoder()

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const text = decoder.decode(value)
        for (const line of text.split('\n')) {
          if (!line.startsWith('data: ')) continue
          const data = line.slice(6)
          if (data === '[DONE]') break
          try {
            const parsed = JSON.parse(data) as { choices: { delta: { content?: string } }[] }
            const chunk  = parsed.choices[0]?.delta?.content ?? ''
            if (chunk) { fullContent += chunk; onChunk(chunk) }
          } catch {}
        }
      }

      return { content: fullContent, model: req.model ?? defaultModel }
    }
  }
}

// ─── Anthropic adapter ────────────────────────────────────────────────────

export interface AnthropicOptions {
  apiKey:      string
  model?:      string    // default: 'claude-sonnet-4-6'
}

export function createAnthropicModel(opts: AnthropicOptions): IAIModel {

  const {
    apiKey,
    model: defaultModel = 'claude-sonnet-4-6'
  } = opts

  async function post(body: unknown): Promise<unknown> {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json'
      },
      body: JSON.stringify(body)
    })

    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { error?: { message?: string } }
      throw new Error(`Anthropic error ${res.status}: ${err.error?.message ?? res.statusText}`)
    }

    return res.json()
  }

  return {
    name: opts.model ?? defaultModel,

    async complete(req: AIRequest): Promise<AIResponse> {
      const body: Record<string, unknown> = {
        model:      req.model ?? defaultModel,
        messages:   req.messages,
        max_tokens: req.maxTokens ?? 1024,
      }

      if (req.system) body.system = req.system

      if (req.think) {
        body.thinking = { type: 'enabled', budget_tokens: 8000 }
      }

      const result = await post(body) as {
        content: { type: string; text?: string; thinking?: string }[]
        model:   string
        usage:   { input_tokens: number; output_tokens: number }
      }

      const textBlock  = result.content.find(b => b.type === 'text')
      const thinkBlock = result.content.find(b => b.type === 'thinking')

      return {
        content:      textBlock?.text ?? '',
        model:        result.model,
        inputTokens:  result.usage.input_tokens,
        outputTokens: result.usage.output_tokens,
        thinkContent: thinkBlock?.thinking,
      }
    },

    async stream(req: AIRequest, onChunk: (chunk: string) => void): Promise<AIResponse> {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method:  'POST',
        headers: {
          'x-api-key':         apiKey,
          'anthropic-version': '2023-06-01',
          'content-type':      'application/json',
          'anthropic-beta':    'messages-2023-12-15'
        },
        body: JSON.stringify({
          model:      req.model ?? defaultModel,
          messages:   req.messages,
          system:     req.system,
          max_tokens: req.maxTokens ?? 1024,
          stream:     true,
        })
      })

      if (!res.ok) throw new Error(`Anthropic stream error ${res.status}`)

      let fullContent = ''
      const reader    = res.body!.getReader()
      const decoder   = new TextDecoder()

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const text = decoder.decode(value)
        for (const line of text.split('\n')) {
          if (!line.startsWith('data: ')) continue
          try {
            const evt = JSON.parse(line.slice(6)) as { type: string; delta?: { text?: string } }
            if (evt.type === 'content_block_delta' && evt.delta?.text) {
              fullContent += evt.delta.text
              onChunk(evt.delta.text)
            }
          } catch {}
        }
      }

      return { content: fullContent, model: req.model ?? defaultModel }
    }
  }
}
