// ─────────────────────────────────────────────
// AI PROVIDER INTERFACE
// Every provider must implement all four modes.
// Providers that lack native support (e.g. Ollama classify/extract)
// use a prompt-based fallback so the interface is always fully satisfied.
// ─────────────────────────────────────────────

export interface CompleteRequest {
  model:   string
  prompt:  string
  options?: Record<string, unknown>
}
export interface CompleteResult {
  text:         string
  finishReason: string
  usage:        TokenUsage
}

export interface EmbedRequest {
  model: string
  input: string | string[]
}
export interface EmbedResult {
  embeddings: number[][]
  usage:      TokenUsage
}

export interface ClassifyRequest {
  model:   string
  input:   string
  labels:  string[]
  options?: Record<string, unknown>
}
export interface ClassifyResult {
  label: string
  score: number
  usage: TokenUsage
}

export interface ExtractRequest {
  model:   string
  input:   string
  schema:  Record<string, unknown>  // JSON Schema describing the expected output
  options?: Record<string, unknown>
}
export interface ExtractResult {
  data:  Record<string, unknown>
  usage: TokenUsage
}

export interface TokenUsage {
  inputTokens:  number
  outputTokens: number
}

export interface AIProvider {
  readonly name: string
  complete (req: CompleteRequest):  Promise<CompleteResult>
  embed    (req: EmbedRequest):     Promise<EmbedResult>
  classify (req: ClassifyRequest):  Promise<ClassifyResult>
  extract  (req: ExtractRequest):   Promise<ExtractResult>
}

// ─────────────────────────────────────────────
// OPENAI PROVIDER
// Also handles any OpenAI-compatible endpoint:
// Together, Groq, local vLLM — set baseUrl in credential config.
// ─────────────────────────────────────────────

export class OpenAIProvider implements AIProvider {
  readonly name = "openai"

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = "https://api.openai.com/v1",
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async complete(req: CompleteRequest): Promise<CompleteResult> {
    const res = await this.post("/chat/completions", {
      model: req.model,
      messages: [{ role: "user", content: req.prompt }],
      ...(req.options ?? {}),
    })
    const choice = res.choices[0]
    return {
      text:         choice.message.content ?? "",
      finishReason: choice.finish_reason ?? "stop",
      usage:        toUsage(res.usage),
    }
  }

  async embed(req: EmbedRequest): Promise<EmbedResult> {
    const input = Array.isArray(req.input) ? req.input : [req.input]
    const res = await this.post("/embeddings", { model: req.model, input })
    return {
      embeddings: res.data.map((d: { embedding: number[] }) => d.embedding),
      usage:      toUsage(res.usage),
    }
  }

  async classify(req: ClassifyRequest): Promise<ClassifyResult> {
    const prompt = buildClassifyPrompt(req.input, req.labels)
    const res = await this.complete({ model: req.model, prompt, options: { max_tokens: 20, ...req.options } })
    const label = req.labels.find(l => res.text.toLowerCase().includes(l.toLowerCase()))
      ?? req.labels[0]!
    return { label, score: 1, usage: res.usage }
  }

  async extract(req: ExtractRequest): Promise<ExtractResult> {
    const prompt = buildExtractPrompt(req.input, req.schema)
    const res = await this.post("/chat/completions", {
      model: req.model,
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
      ...(req.options ?? {}),
    })
    const text = res.choices[0].message.content ?? "{}"
    return { data: safeParseJson(text), usage: toUsage(res.usage) }
  }

  private async post(path: string, body: unknown): Promise<any> {
    const res = await this.fetcher(`${this.baseUrl}${path}`, {
      method:  "POST",
      headers: { "Authorization": `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body:    JSON.stringify(body),
    })
    if (!res.ok) {
      const text = await res.text()
      throw new AIProviderError("openai", res.status, text)
    }
    return res.json()
  }
}

// ─────────────────────────────────────────────
// ANTHROPIC PROVIDER
// complete → Messages API
// embed    → Voyage API (separate service, separate key)
// classify / extract → prompt-based
// ─────────────────────────────────────────────

export class AnthropicProvider implements AIProvider {
  readonly name = "anthropic"

  constructor(
    private readonly apiKey: string,
    private readonly voyageKey?: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async complete(req: CompleteRequest): Promise<CompleteResult> {
    const res = await this.post("https://api.anthropic.com/v1/messages", {
      model:      req.model,
      max_tokens: (req.options?.max_tokens as number | undefined) ?? 1024,
      messages:   [{ role: "user", content: req.prompt }],
      ...(req.options ?? {}),
    }, {
      "x-api-key":         this.apiKey,
      "anthropic-version": "2023-06-01",
    })
    const block = res.content?.find((b: { type: string }) => b.type === "text")
    return {
      text:         (block as any)?.text ?? "",
      finishReason: res.stop_reason ?? "end_turn",
      usage:        { inputTokens: res.usage?.input_tokens ?? 0, outputTokens: res.usage?.output_tokens ?? 0 },
    }
  }

  async embed(req: EmbedRequest): Promise<EmbedResult> {
    if (!this.voyageKey) throw new Error("AnthropicProvider: voyageKey required for embed()")
    const input = Array.isArray(req.input) ? req.input : [req.input]
    const res = await this.post("https://api.voyageai.com/v1/embeddings", {
      model: req.model, input,
    }, { "Authorization": `Bearer ${this.voyageKey}` })
    return {
      embeddings: res.data.map((d: { embedding: number[] }) => d.embedding),
      usage:      { inputTokens: res.usage?.total_tokens ?? 0, outputTokens: 0 },
    }
  }

  async classify(req: ClassifyRequest): Promise<ClassifyResult> {
    const prompt = buildClassifyPrompt(req.input, req.labels)
    const res = await this.complete({ model: req.model, prompt, options: { max_tokens: 20 } })
    const label = req.labels.find(l => res.text.toLowerCase().includes(l.toLowerCase()))
      ?? req.labels[0]!
    return { label, score: 1, usage: res.usage }
  }

  async extract(req: ExtractRequest): Promise<ExtractResult> {
    const prompt = buildExtractPrompt(req.input, req.schema)
    const res = await this.complete({ model: req.model, prompt })
    return { data: safeParseJson(res.text), usage: res.usage }
  }

  private async post(url: string, body: unknown, headers: Record<string, string>): Promise<any> {
    const res = await this.fetcher(url, {
      method:  "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body:    JSON.stringify(body),
    })
    if (!res.ok) {
      const text = await res.text()
      throw new AIProviderError("anthropic", res.status, text)
    }
    return res.json()
  }
}

// ─────────────────────────────────────────────
// OLLAMA PROVIDER
// Local models — no API key, just a baseUrl.
// Uses OpenAI-compatible /api/chat endpoint.
// classify + extract are always prompt-based.
// ─────────────────────────────────────────────

export class OllamaProvider implements AIProvider {
  readonly name = "ollama"

  constructor(
    private readonly baseUrl = "http://localhost:11434",
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async complete(req: CompleteRequest): Promise<CompleteResult> {
    const res = await this.post("/api/chat", {
      model:    req.model,
      messages: [{ role: "user", content: req.prompt }],
      stream:   false,
      options:  req.options,
    })
    return {
      text:         res.message?.content ?? "",
      finishReason: res.done_reason ?? "stop",
      usage: {
        inputTokens:  res.prompt_eval_count ?? 0,
        outputTokens: res.eval_count ?? 0,
      },
    }
  }

  async embed(req: EmbedRequest): Promise<EmbedResult> {
    const inputs = Array.isArray(req.input) ? req.input : [req.input]
    const results: number[][] = []
    for (const text of inputs) {
      const res = await this.post("/api/embeddings", { model: req.model, prompt: text })
      results.push(res.embedding)
    }
    return { embeddings: results, usage: { inputTokens: 0, outputTokens: 0 } }
  }

  async classify(req: ClassifyRequest): Promise<ClassifyResult> {
    const prompt = buildClassifyPrompt(req.input, req.labels)
    const res = await this.complete({ model: req.model, prompt, options: { num_predict: 20 } })
    const label = req.labels.find(l => res.text.toLowerCase().includes(l.toLowerCase()))
      ?? req.labels[0]!
    return { label, score: 1, usage: res.usage }
  }

  async extract(req: ExtractRequest): Promise<ExtractResult> {
    const prompt = buildExtractPrompt(req.input, req.schema)
    const res = await this.complete({ model: req.model, prompt, options: { format: "json" } })
    return { data: safeParseJson(res.text), usage: res.usage }
  }

  private async post(path: string, body: unknown): Promise<any> {
    const res = await this.fetcher(`${this.baseUrl}${path}`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(body),
    })
    if (!res.ok) {
      const text = await res.text()
      throw new AIProviderError("ollama", res.status, text)
    }
    return res.json()
  }
}

// ─────────────────────────────────────────────
// PROVIDER REGISTRY
// Thin map of provider name → factory.
// The `ai` node loads the credential, reads provider name,
// calls providerRegistry.get(name)(credential) → AIProvider.
// ─────────────────────────────────────────────

export type ProviderFactory = (config: Record<string, unknown>) => AIProvider

export class AIProviderRegistry {
  private readonly factories = new Map<string, ProviderFactory>()

  constructor() {
    this.register("openai",    c => new OpenAIProvider(c.apiKey as string, c.baseUrl as string | undefined))
    this.register("anthropic", c => new AnthropicProvider(c.apiKey as string, c.voyageKey as string | undefined))
    this.register("ollama",    c => new OllamaProvider(c.baseUrl as string | undefined))
  }

  register(name: string, factory: ProviderFactory): void {
    this.factories.set(name, factory)
  }

  get(name: string): ProviderFactory {
    const f = this.factories.get(name)
    if (!f) throw new Error(`Unknown AI provider: "${name}". Registered: ${[...this.factories.keys()].join(", ")}`)
    return f
  }

  has(name: string): boolean {
    return this.factories.has(name)
  }
}

// ─────────────────────────────────────────────
// SHARED HELPERS
// ─────────────────────────────────────────────

function toUsage(u: any): TokenUsage {
  return {
    inputTokens:  u?.prompt_tokens ?? u?.input_tokens ?? 0,
    outputTokens: u?.completion_tokens ?? u?.output_tokens ?? 0,
  }
}

function buildClassifyPrompt(input: string, labels: string[]): string {
  return [
    `Classify the following text into exactly one of these categories: ${labels.join(", ")}.`,
    `Respond with only the category name, nothing else.`,
    ``,
    `Text: ${input}`,
  ].join("\n")
}

function buildExtractPrompt(input: string, schema: Record<string, unknown>): string {
  return [
    `Extract structured data from the following text according to this JSON Schema:`,
    JSON.stringify(schema, null, 2),
    ``,
    `Respond with only valid JSON matching the schema, nothing else.`,
    ``,
    `Text: ${input}`,
  ].join("\n")
}

function safeParseJson(text: string): Record<string, unknown> {
  try {
    const cleaned = text.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim()
    return JSON.parse(cleaned)
  } catch {
    return { raw: text }
  }
}

export class AIProviderError extends Error {
  constructor(
    public readonly provider: string,
    public readonly status:   number,
    message: string,
  ) {
    super(`[${provider}] HTTP ${status}: ${message}`)
    this.name = "AIProviderError"
  }
}
