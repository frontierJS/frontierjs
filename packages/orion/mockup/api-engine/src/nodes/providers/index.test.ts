import { describe, test, expect, vi } from "vitest"
import {
  OpenAIProvider, AnthropicProvider, OllamaProvider,
  AIProviderRegistry, AIProviderError,
} from "./index"

// ─────────────────────────────────────────────
// MOCK FETCH FACTORY
// ─────────────────────────────────────────────

function mockFetch(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })
  )
}

// ─────────────────────────────────────────────
// OPENAI PROVIDER
// ─────────────────────────────────────────────

describe("OpenAIProvider", () => {
  test("complete() sends correct request and parses response", async () => {
    const fetcher = mockFetch({
      choices: [{ message: { content: "Hello!" }, finish_reason: "stop" }],
      usage:   { prompt_tokens: 10, completion_tokens: 5 },
    })
    const p   = new OpenAIProvider("sk-test", "https://api.openai.com/v1", fetcher)
    const res = await p.complete({ model: "gpt-4o", prompt: "Say hi" })

    expect(res.text).toBe("Hello!")
    expect(res.finishReason).toBe("stop")
    expect(res.usage.inputTokens).toBe(10)
    expect(res.usage.outputTokens).toBe(5)

    const [url, init] = fetcher.mock.calls[0]!
    expect(url).toBe("https://api.openai.com/v1/chat/completions")
    expect(init.headers["Authorization"]).toBe("Bearer sk-test")
    expect(JSON.parse(init.body).messages[0].content).toBe("Say hi")
  })

  test("embed() returns embeddings array", async () => {
    const fetcher = mockFetch({
      data:  [{ embedding: [0.1, 0.2, 0.3] }, { embedding: [0.4, 0.5, 0.6] }],
      usage: { prompt_tokens: 8, completion_tokens: 0 },
    })
    const p   = new OpenAIProvider("sk-test", "https://api.openai.com/v1", fetcher)
    const res = await p.embed({ model: "text-embedding-3-small", input: ["hello", "world"] })

    expect(res.embeddings).toHaveLength(2)
    expect(res.embeddings[0]).toEqual([0.1, 0.2, 0.3])
    expect(res.usage.inputTokens).toBe(8)
  })

  test("embed() wraps single string in array", async () => {
    const fetcher = mockFetch({
      data:  [{ embedding: [0.1] }],
      usage: { prompt_tokens: 3, completion_tokens: 0 },
    })
    const p = new OpenAIProvider("sk-test", "https://api.openai.com/v1", fetcher)
    await p.embed({ model: "text-embedding-3-small", input: "single" })

    expect(JSON.parse(fetcher.mock.calls[0]![1].body).input).toEqual(["single"])
  })

  test("classify() picks label from response text", async () => {
    const fetcher = mockFetch({
      choices: [{ message: { content: "positive" }, finish_reason: "stop" }],
      usage:   { prompt_tokens: 20, completion_tokens: 1 },
    })
    const p   = new OpenAIProvider("sk-test", "https://api.openai.com/v1", fetcher)
    const res = await p.classify({ model: "gpt-4o", input: "Great product!", labels: ["positive", "negative", "neutral"] })

    expect(res.label).toBe("positive")
  })

  test("classify() falls back to first label when no match", async () => {
    const fetcher = mockFetch({
      choices: [{ message: { content: "something unrelated" }, finish_reason: "stop" }],
      usage:   { prompt_tokens: 20, completion_tokens: 3 },
    })
    const p   = new OpenAIProvider("sk-test", "https://api.openai.com/v1", fetcher)
    const res = await p.classify({ model: "gpt-4o", input: "hmm", labels: ["positive", "negative"] })
    expect(["positive", "negative"]).toContain(res.label)
  })

  test("extract() parses JSON response", async () => {
    const fetcher = mockFetch({
      choices: [{ message: { content: '{"name":"Alice","age":30}' }, finish_reason: "stop" }],
      usage:   { prompt_tokens: 30, completion_tokens: 10 },
    })
    const p   = new OpenAIProvider("sk-test", "https://api.openai.com/v1", fetcher)
    const res = await p.extract({
      model:  "gpt-4o",
      input:  "Alice is 30 years old",
      schema: { type: "object", properties: { name: { type: "string" }, age: { type: "number" } } },
    })

    expect(res.data.name).toBe("Alice")
    expect(res.data.age).toBe(30)
  })

  test("throws AIProviderError on non-200 response", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response("Unauthorized", { status: 401 })
    )
    const p = new OpenAIProvider("bad-key", "https://api.openai.com/v1", fetcher)
    await expect(p.complete({ model: "gpt-4o", prompt: "hi" })).rejects.toThrow(AIProviderError)
  })

  test("AIProviderError includes status code", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("Not Found", { status: 404 }))
    const p = new OpenAIProvider("sk", "https://api.openai.com/v1", fetcher)
    try {
      await p.complete({ model: "gpt-4o", prompt: "hi" })
    } catch (e) {
      expect(e).toBeInstanceOf(AIProviderError)
      expect((e as AIProviderError).status).toBe(404)
      expect((e as AIProviderError).provider).toBe("openai")
    }
  })

  test("uses custom baseUrl for OpenAI-compatible endpoints", async () => {
    const fetcher = mockFetch({
      choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
      usage:   { prompt_tokens: 5, completion_tokens: 1 },
    })
    const p = new OpenAIProvider("sk", "https://api.together.ai/v1", fetcher)
    await p.complete({ model: "mistral-7b", prompt: "hello" })
    expect(fetcher.mock.calls[0]![0]).toBe("https://api.together.ai/v1/chat/completions")
  })
})

// ─────────────────────────────────────────────
// ANTHROPIC PROVIDER
// ─────────────────────────────────────────────

describe("AnthropicProvider", () => {
  test("complete() sends correct headers and parses response", async () => {
    const fetcher = mockFetch({
      content:     [{ type: "text", text: "42 is the answer." }],
      stop_reason: "end_turn",
      usage:       { input_tokens: 15, output_tokens: 7 },
    })
    const p   = new AnthropicProvider("ant-key", undefined, fetcher)
    const res = await p.complete({ model: "claude-3-5-sonnet-20241022", prompt: "What is the meaning of life?" })

    expect(res.text).toBe("42 is the answer.")
    expect(res.finishReason).toBe("end_turn")
    expect(res.usage.inputTokens).toBe(15)
    expect(res.usage.outputTokens).toBe(7)

    const [, init] = fetcher.mock.calls[0]!
    expect(init.headers["x-api-key"]).toBe("ant-key")
    expect(init.headers["anthropic-version"]).toBe("2023-06-01")
  })

  test("embed() uses Voyage API with voyageKey", async () => {
    const fetcher = mockFetch({
      data:  [{ embedding: [0.1, 0.2] }],
      usage: { total_tokens: 5 },
    })
    const p   = new AnthropicProvider("ant-key", "voy-key", fetcher)
    const res = await p.embed({ model: "voyage-2", input: "hello" })
    expect(res.embeddings[0]).toEqual([0.1, 0.2])

    const [url, init] = fetcher.mock.calls[0]!
    expect(url).toContain("voyageai.com")
    expect(init.headers["Authorization"]).toBe("Bearer voy-key")
  })

  test("embed() throws if no voyageKey", async () => {
    const p = new AnthropicProvider("ant-key")
    await expect(p.embed({ model: "voyage-2", input: "hello" })).rejects.toThrow(/voyageKey/)
  })

  test("classify() uses complete() internally", async () => {
    const fetcher = mockFetch({
      content:     [{ type: "text", text: "negative" }],
      stop_reason: "end_turn",
      usage:       { input_tokens: 25, output_tokens: 1 },
    })
    const p   = new AnthropicProvider("ant-key", undefined, fetcher)
    const res = await p.classify({ model: "claude-3-5-haiku-20241022", input: "bad experience", labels: ["positive", "negative"] })
    expect(res.label).toBe("negative")
  })

  test("extract() parses JSON from complete response", async () => {
    const fetcher = mockFetch({
      content:     [{ type: "text", text: '{"city":"Paris","country":"France"}' }],
      stop_reason: "end_turn",
      usage:       { input_tokens: 30, output_tokens: 10 },
    })
    const p   = new AnthropicProvider("ant-key", undefined, fetcher)
    const res = await p.extract({ model: "claude-3-5-sonnet-20241022", input: "Paris, France", schema: {} })
    expect(res.data.city).toBe("Paris")
  })

  test("throws on HTTP error", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("Unauthorized", { status: 401 }))
    const p = new AnthropicProvider("bad-key", undefined, fetcher)
    await expect(p.complete({ model: "claude-3-5-sonnet-20241022", prompt: "hi" })).rejects.toThrow(AIProviderError)
  })
})

// ─────────────────────────────────────────────
// OLLAMA PROVIDER
// ─────────────────────────────────────────────

describe("OllamaProvider", () => {
  test("complete() sends to /api/chat", async () => {
    const fetcher = mockFetch({
      message:          { content: "Hello from Ollama!" },
      done_reason:      "stop",
      prompt_eval_count: 8,
      eval_count:        5,
    })
    const p   = new OllamaProvider("http://localhost:11434", fetcher)
    const res = await p.complete({ model: "llama3.2", prompt: "Hello" })

    expect(res.text).toBe("Hello from Ollama!")
    expect(res.usage.inputTokens).toBe(8)
    expect(res.usage.outputTokens).toBe(5)
    expect(fetcher.mock.calls[0]![0]).toBe("http://localhost:11434/api/chat")
    expect(JSON.parse(fetcher.mock.calls[0]![1].body).stream).toBe(false)
  })

  test("embed() calls /api/embeddings once per input", async () => {
    const fetcher = vi.fn().mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ embedding: [0.1, 0.2, 0.3] }), {
        status: 200, headers: { "content-type": "application/json" },
      }))
    )
    const p   = new OllamaProvider("http://localhost:11434", fetcher)
    const res = await p.embed({ model: "nomic-embed-text", input: ["a", "b"] })

    expect(res.embeddings).toHaveLength(2)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  test("classify() prompt-based fallback", async () => {
    const fetcher = mockFetch({ message: { content: "spam" }, done_reason: "stop", eval_count: 1, prompt_eval_count: 20 })
    const p   = new OllamaProvider("http://localhost:11434", fetcher)
    const res = await p.classify({ model: "llama3.2", input: "Buy now!!", labels: ["spam", "ham"] })
    expect(res.label).toBe("spam")
  })

  test("extract() sends format:json option", async () => {
    const fetcher = mockFetch({ message: { content: '{"name":"Bob"}' }, done_reason: "stop", eval_count: 5, prompt_eval_count: 40 })
    const p   = new OllamaProvider("http://localhost:11434", fetcher)
    const res = await p.extract({ model: "llama3.2", input: "Bob", schema: {} })
    expect(res.data.name).toBe("Bob")
    expect(JSON.parse(fetcher.mock.calls[0]![1].body).options?.format).toBe("json")
  })

  test("uses default localhost baseUrl", async () => {
    const fetcher = mockFetch({ message: { content: "hi" }, done_reason: "stop" })
    const p = new OllamaProvider(undefined, fetcher)
    await p.complete({ model: "llama3.2", prompt: "hi" })
    expect(fetcher.mock.calls[0]![0]).toContain("localhost:11434")
  })
})

// ─────────────────────────────────────────────
// AI PROVIDER REGISTRY
// ─────────────────────────────────────────────

describe("AIProviderRegistry", () => {
  test("ships with openai, anthropic, ollama pre-registered", () => {
    const r = new AIProviderRegistry()
    expect(r.has("openai")).toBe(true)
    expect(r.has("anthropic")).toBe(true)
    expect(r.has("ollama")).toBe(true)
  })

  test("get() returns a factory that produces the correct provider", () => {
    const r = new AIProviderRegistry()
    const p = r.get("openai")({ apiKey: "sk-test" })
    expect(p.name).toBe("openai")
  })

  test("get() throws for unknown provider", () => {
    const r = new AIProviderRegistry()
    expect(() => r.get("notreal")).toThrow(/Unknown AI provider/)
  })

  test("register() adds a custom provider", () => {
    const r = new AIProviderRegistry()
    r.register("custom", () => new OllamaProvider("http://my-server"))
    expect(r.has("custom")).toBe(true)
  })

  test("custom provider is retrievable via get()", () => {
    const r = new AIProviderRegistry()
    r.register("local", (c) => new OllamaProvider(c.baseUrl as string))
    const p = r.get("local")({ baseUrl: "http://my-ollama:11434" })
    expect(p.name).toBe("ollama")
  })
})
