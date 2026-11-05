// sink.ts — the chat-completions protocol, standing in for OpenAI and for Ollama.
//
// A dev listener that speaks the protocol's shape: a bearer, JSON in, a
// completion out whose text echoes the last user turn, a `tool_calls` turn
// when a `get_weather` tool is offered and no tool message has come back yet,
// a real `text/event-stream` under `stream: true` that ends in `data: [DONE]`,
// a deterministic embedding, a model list. A SEPARATE LISTENER rather than an
// in-process fake: the bearer and the SSE framing are the features, and
// neither exists off a wire.
//
// Two error dialects, one switch. OpenAI refuses with
// `{ error: { message, type, code } }`; Ollama and llama.cpp serve the same
// protocol and refuse with `{ error: "a sentence" }`. `/_sink/arm` with
// `{ ollamaErrors: true }` switches the envelope until a reset, so the drive
// proves `translate` reads both without a second sink.
//
// It owns the chaos (FJS-D890): `{ lost }` for a request that is applied and
// never answered, `{ rateLimit: { retryAfter } }` for one 429 with the header,
// `{ quota }` for one 429 `insufficient_quota` with no header, `{ failNext }`
// for one 500, `{ dieMidStream }` to close the socket after the first content
// delta and `{ noDone }` to end a stream cleanly without `[DONE]`. `/_sink/seen`
// is what arrived, recorded on arrival; `/_sink/reset` clears it and what is
// armed.
//
// It does NOT pretend to be a model: a model id starting `retired-` is the
// 404, a prompt over `MAX_PROMPT_CHARS` is the 400 `context_length_exceeded`,
// a token is four characters, and `max_tokens` truncates the echo with
// `finish_reason: 'length'`.

import type { ChatMessage, ChatRequest, ChatResponse, EmbeddingsRequest, ToolCall, Usage } from './src/types.ts'

export interface OpenAISinkOptions {
  port?:   number
  /** What this stand-in accepts as the bearer. */
  key?:    string
  models?: string[]
}

export const MAX_PROMPT_CHARS = 8 * 1024
export const EMBEDDING_DIMS   = 8

let counter = 0
const id     = (prefix: string) => `${prefix}-${(++counter).toString().padStart(4, '0')}${Math.random().toString(36).slice(2, 8)}`
const tokens = (text: string) => Math.max(1, Math.ceil(text.length / 4))
const json   = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

const textOf = (m: ChatMessage): string => typeof m.content === 'string' ? m.content : (m.tool_calls ?? []).map(c => c.function.arguments).join('')
const promptText = (req: ChatRequest) => req.messages.map(textOf).join('') + JSON.stringify(req.tools ?? '')

/** A vector from the input's bytes and nothing else, so the same input is the same vector across calls and across restarts. */
export function embeddingOf(input: string): number[] {
  const bytes = new TextEncoder().encode(input)
  const v = new Array<number>(EMBEDDING_DIMS).fill(0)
  bytes.forEach((b, i) => { v[i % EMBEDDING_DIMS] = (v[i % EMBEDDING_DIMS] * 31 + b) % 1009 })
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1
  return v.map(x => Math.round((x / norm) * 1e6) / 1e6)
}

export function startOpenAISink(opts: OpenAISinkOptions = {}) {
  const KEY    = opts.key ?? 'sk-dev'
  const MODELS = opts.models ?? ['gpt-4o-mini', 'text-embedding-3-small']
  const seen: { method: string; path: string; headers: Record<string, string>; body: string; at: number }[] = []
  const armed = { lost: false, rateLimit: null as null | { retryAfter: number }, quota: false, failNext: false, dieMidStream: false, noDone: false, ollamaErrors: false }
  const hanging: Array<() => void> = []

  /** The refusal in whichever dialect is armed. Ollama carries no `type`/`code` and no `param`: the sentence is all a reader gets. */
  const refuse = (type: string, code: string | null, message: string, status: number, headers: Record<string, string> = {}) =>
    armed.ollamaErrors
      ? json({ error: message }, status, headers)
      : json({ error: { message, type, param: null, code } }, status, headers)

  /** The canned answer. Decides between a `tool_calls` turn, the echo of a tool result, and the echo of the last user turn. */
  function answer(req: ChatRequest): { content: string | null; tool_calls?: ToolCall[]; finish_reason: ChatResponse['choices'][0]['finish_reason'] } {
    const toolMsgs = req.messages.filter(m => m.role === 'tool')
    const weather  = req.tools?.find(t => t.function.name === 'get_weather')
    if (weather && toolMsgs.length === 0) {
      const asked = req.messages.find(m => m.role === 'user')
      return { content: null, finish_reason: 'tool_calls', tool_calls: [{ id: id('call'), type: 'function', function: { name: 'get_weather', arguments: JSON.stringify({ location: asked ? textOf(asked) : '' }) } }] }
    }
    if (toolMsgs.length) return { content: `The weather is ${toolMsgs[toolMsgs.length - 1].content}.`, finish_reason: 'stop' }
    const last = req.messages[req.messages.length - 1]
    const full = `You said: ${textOf(last)}`
    if (req.max_tokens !== undefined && tokens(full) > req.max_tokens) return { content: full.slice(0, req.max_tokens * 4), finish_reason: 'length' }
    return { content: full, finish_reason: 'stop' }
  }

  function usageFor(req: ChatRequest, out: string): Usage {
    const p = tokens(promptText(req)), c = tokens(out)
    return { prompt_tokens: p, completion_tokens: c, total_tokens: p + c }
  }

  function streamOf(completion: ChatResponse, includeUsage: boolean, die: boolean, noDone: boolean): Response {
    const choice = completion.choices[0]
    const head   = { id: completion.id, object: 'chat.completion.chunk', created: completion.created, model: completion.model }
    const frames: unknown[] = [{ ...head, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] }]
    for (const word of choice.message.content?.match(/\S+\s*/g) ?? []) frames.push({ ...head, choices: [{ index: 0, delta: { content: word }, finish_reason: null }] })
    ;(choice.message.tool_calls ?? []).forEach((call, index) => {
      frames.push({ ...head, choices: [{ index: 0, delta: { tool_calls: [{ index, id: call.id, type: 'function', function: { name: call.function.name, arguments: '' } }] }, finish_reason: null }] })
      const whole = call.function.arguments
      for (let i = 0; i < whole.length; i += 7) frames.push({ ...head, choices: [{ index: 0, delta: { tool_calls: [{ index, function: { arguments: whole.slice(i, i + 7) } }] }, finish_reason: null }] })
    })
    frames.push({ ...head, choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason }] })
    if (includeUsage) frames.push({ ...head, choices: [], usage: completion.usage })

    const enc = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        let deltas = 0
        for (const f of frames) {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(f)}\n\n`))
          await new Promise(r => setTimeout(r, 2))
          const isDelta = !!(f as { choices: { delta: { content?: string; tool_calls?: unknown } }[] }).choices[0]?.delta.content || !!(f as { choices: { delta: { tool_calls?: unknown } }[] }).choices[0]?.delta.tool_calls
          // The death: the first delta is on the wire and the socket goes away
          // with no terminating chunk, which is what a crashed upstream looks like.
          if (die && isDelta && ++deltas === 1) { controller.error(new Error('upstream died')); return }
        }
        // A clean close with no `[DONE]`: a proxy that cut the upstream and
        // flushed what it held, or a server that forgot the terminator.
        if (!noDone) controller.enqueue(enc.encode('data: [DONE]\n\n'))
        controller.close()
      },
    })
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } })
  }

  const server = Bun.serve({
    port: opts.port ?? 0,
    idleTimeout: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname

      if (path === '/_sink/seen')  return json({ requests: seen })
      if (path === '/_sink/reset') { seen.length = 0; Object.assign(armed, { lost: false, rateLimit: null, quota: false, failNext: false, dieMidStream: false, noDone: false, ollamaErrors: false }); return json({ ok: true }) }
      if (path === '/_sink/arm')   { Object.assign(armed, await req.json()); return json({ ok: true, armed }) }

      const text = req.method === 'POST' ? await req.text() : ''
      seen.push({ method: req.method, path, headers: Object.fromEntries(req.headers), body: text, at: Date.now() })

      const auth = req.headers.get('authorization') ?? ''
      if (auth !== `Bearer ${KEY}`) return refuse('invalid_request_error', 'invalid_api_key', 'Incorrect API key provided.', 401)

      if (armed.rateLimit) { const { retryAfter } = armed.rateLimit; armed.rateLimit = null; return refuse('rate_limit_error', 'rate_limit_exceeded', 'Rate limit reached for requests. Please try again later.', 429, { 'retry-after': String(retryAfter) }) }
      if (armed.quota)     { armed.quota = false;    return refuse('insufficient_quota', 'insufficient_quota', 'You exceeded your current quota, please check your plan and billing details.', 429) }
      if (armed.failNext)  { armed.failNext = false; return refuse('server_error', 'server_error', 'The server had an error while processing your request.', 500) }

      let response: Response
      if (path === '/v1/models' && req.method === 'GET') {
        response = json({ object: 'list', data: MODELS.map(m => ({ id: m, object: 'model', created: 1_700_000_000, owned_by: 'sink' })) })
      } else if (req.method === 'POST' && (path === '/v1/chat/completions' || path === '/v1/embeddings')) {
        let body: (ChatRequest & EmbeddingsRequest & { stream?: boolean }) | null
        try { body = JSON.parse(text) } catch { return refuse('invalid_request_error', null, 'We could not parse the JSON body of your request.', 400) }
        if (!body?.model) return refuse('invalid_request_error', null, "you must provide a model parameter", 400)
        if (body.model.startsWith('retired-')) return refuse('invalid_request_error', 'model_not_found', `The model \`${body.model}\` does not exist or you do not have access to it.`, 404)

        if (path === '/v1/embeddings') {
          const inputs = Array.isArray(body.input) ? body.input : [body.input]
          if (!inputs.length || inputs.some(i => typeof i !== 'string' || !i)) return refuse('invalid_request_error', null, "'$.input' is invalid.", 400)
          const used = inputs.reduce((s, i) => s + tokens(i), 0)
          response = json({ object: 'list', model: body.model, data: inputs.map((input, index) => ({ object: 'embedding', index, embedding: embeddingOf(input) })), usage: { prompt_tokens: used, total_tokens: used } })
        } else {
          if (!Array.isArray(body.messages) || !body.messages.length) return refuse('invalid_request_error', null, "[] is too short - 'messages'", 400)
          const prompt = promptText(body)
          if (prompt.length > MAX_PROMPT_CHARS) return refuse('invalid_request_error', 'context_length_exceeded', `This model's maximum context length is ${tokens(' '.repeat(MAX_PROMPT_CHARS))} tokens. However, your messages resulted in ${tokens(prompt)} tokens.`, 400)
          const { content, tool_calls, finish_reason } = answer(body)
          const completion: ChatResponse = {
            id: id('chatcmpl'), object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: body.model,
            choices: [{ index: 0, message: { role: 'assistant', content, ...(tool_calls ? { tool_calls } : {}) }, finish_reason }],
            usage: usageFor(body, (content ?? '') + (tool_calls ?? []).map(c => c.function.arguments).join('')),
          }
          if (body.stream) {
            const die = armed.dieMidStream, noDone = armed.noDone
            armed.dieMidStream = false; armed.noDone = false
            response = streamOf(completion, body.stream_options?.include_usage === true, die, noDone)
          } else response = json(completion)
        }
      } else return refuse('invalid_request_error', null, `Invalid URL (${req.method} ${path})`, 404)

      // A lost response: the completion is BILLED and the answer never leaves.
      if (armed.lost) { armed.lost = false; await new Promise<void>(resolve => hanging.push(resolve)) }
      return response
    },
  })

  return {
    port: server.port,
    url:  `http://127.0.0.1:${server.port}`,
    key:  KEY,
    models: MODELS,
    stop() { for (const r of hanging) r(); server.stop(true) },
  }
}

if (import.meta.main) {
  const s = startOpenAISink({ port: Number(process.env.OPENAI_SINK_PORT ?? 0) })
  console.log(`[openai-sink] ${s.url}`)
}
