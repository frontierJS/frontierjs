// sink.ts — the Messages API, standing in for Anthropic.
//
// A dev listener that speaks the real thing's shape: `x-api-key`, a REQUIRED
// `anthropic-version`, JSON in, a message out whose text echoes the last user
// turn, a `tool_use` turn when a `get_weather` tool is offered and no result
// has come back yet, a real `text/event-stream` under `stream: true`, and the
// vendor's `{ type: 'error', error: { type, message } }` envelope on every
// refusal. A SEPARATE LISTENER rather than an in-process fake: the version
// header and the SSE framing are the features, and neither exists off a wire.
//
// It owns the chaos (FJS-D890): `/_sink/arm` takes `{ lost }` for a request
// that is applied and never answered, `{ rateLimit: { retryAfter } }` for one
// 429, `{ overloaded }` for one 529, `{ failNext }` for one 500 and
// `{ dieMidStream }` to close the socket after the first delta, `{ chop }` to
// send the next stream as two reads cut mid-frame. `rateLimit`
// takes `times` (default 1) and may omit `retryAfter`; `{ reply }` is 'refusal',
// 'max_tokens', 'prose' or 'pause' for the next answer only. A request carrying
// `output_config.format` is answered with JSON built from its schema, and is
// refused 400 where the real API refuses the schema (an open object, a bound).
//
// What a host must send back unchanged, it checks: a request carrying `thinking`
// gets a signed thinking block before a tool call, and a thinking block whose
// text no longer matches its signature is the API's 400. A 'pause' answer is a
// web search stopped at `pause_turn`; the resume (the paused turn as the last
// message) is refused unless that turn came back as it was sent. `fallbacks`
// without the `server-side-fallback-2026-07-01` beta header, or a `betas` field
// in the body, is refused as the API refuses an extra input; with both, an armed
// refusal is answered instead by `FALLBACK_MODEL`.
//
// `/_sink/seen`
// is what arrived, `/_sink/reset` clears it and what is armed; the prompt
// cache survives a reset because the drive's cache rows span two calls.
//
// It does NOT pretend to be a model: a model id starting `retired-` is the
// 404, a body over 32 KiB is the 413, and a token is four characters.

import type { AssistantBlock, ContentBlock, MessagesRequest, MessagesResponse, StreamEvent, Usage } from './src/types.ts'

export interface AnthropicSinkOptions {
  port?:         number
  /** What this stand-in accepts as the key. */
  key?:          string
  /** A key it recognizes and refuses with 403, so the drive can tell `forbidden` from `auth_failed`. */
  forbiddenKey?: string
}

export const MAX_BODY_BYTES = 32 * 1024
export const FALLBACK_BETA  = 'server-side-fallback-2026-07-01'
/** The model a declined request is re-run on when it asked for `fallbacks`. */
export const FALLBACK_MODEL = 'claude-opus-5-5'

let counter = 0
const id     = (prefix: string) => `${prefix}_${(++counter).toString().padStart(4, '0')}${Math.random().toString(36).slice(2, 8)}`
const tokens = (text: string) => Math.max(1, Math.ceil(text.length / 4))
const json   = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
const refuse = (type: string, message: string, status: number, headers: Record<string, string> = {}) =>
  json({ type: 'error', error: { type, message } }, status, headers)

const BOUNDS = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'maxItems', 'uniqueItems']

/** What the API refuses in a structured-output schema, in its words; null when it would accept it. */
function badSchema(s: any): string | null {
  if (!s || typeof s !== 'object') return null
  for (const k of BOUNDS) if (k in s) return `For 'object' type, property '${k}' is not supported`
  if (typeof s.minItems === 'number' && s.minItems > 1) return "minItems values other than 0 or 1 are not supported"
  if ((s.type === 'object' || s.properties) && s.additionalProperties !== false) return 'additionalProperties must be set to false for objects'
  const kids = [...Object.values(s.properties ?? {}), ...Object.values(s.$defs ?? {}), ...Object.values(s.definitions ?? {}), ...[].concat(s.items ?? [], s.anyOf ?? [], s.allOf ?? [])]
  for (const k of kids) { const bad = badSchema(k); if (bad) return bad }
  return null
}

/** A value that satisfies `s`, for the shapes a drive writes. */
const sample = (s: any): unknown =>
  s?.type === 'object' || s?.properties ? Object.fromEntries(Object.entries(s.properties ?? {}).map(([k, v]) => [k, sample(v)]))
  : s?.type === 'integer' || s?.type === 'number' ? 1
  : s?.type === 'boolean' ? true
  : s?.type === 'array' ? []
  : 'x'

const textOf = (content: string | ContentBlock[]): string =>
  typeof content === 'string' ? content : content.map(b =>
    b.type === 'text' ? b.text
    : b.type === 'thinking' ? b.thinking
    : b.type === 'tool_result' ? (typeof b.content === 'string' ? b.content : (b.content ?? []).map(t => t.text).join(''))
    : JSON.stringify('input' in b ? b.input : b)).join('')

/** Every text the prompt carries, for the token count. */
function promptText(req: MessagesRequest): string {
  const system = typeof req.system === 'string' ? req.system : (req.system ?? []).map(b => b.text).join('')
  return system + req.messages.map(m => textOf(m.content)).join('') + JSON.stringify(req.tools ?? '')
}

/** The blocks marked `cache_control`, as the strings the cache is keyed on. */
function cacheable(req: MessagesRequest): string[] {
  const out: string[] = []
  const walk = (blocks: unknown) => { for (const b of Array.isArray(blocks) ? blocks : []) if (b && typeof b === 'object' && 'cache_control' in b && b.cache_control) out.push(JSON.stringify(b)) }
  walk(req.system); walk(req.tools)
  for (const m of req.messages) walk(m.content)
  return out
}

export function startAnthropicSink(opts: AnthropicSinkOptions = {}) {
  const KEY       = opts.key ?? 'sk-ant-dev'
  const FORBIDDEN = opts.forbiddenKey ?? 'sk-ant-forbidden'
  const seen: { method: string; path: string; headers: Record<string, string>; body: string; at: number }[] = []
  const disarmed = () => ({ lost: false, rateLimit: null as null | { retryAfter?: number; times?: number }, overloaded: false, failNext: false, dieMidStream: false, chop: false, reply: null as null | 'refusal' | 'max_tokens' | 'prose' | 'pause' })
  const armed = disarmed()
  const cache = new Set<string>()
  /** signature → the thinking it signed. */
  const signed = new Map<string, string>()
  /** Every paused turn's content, as JSON, for the resume check. */
  const paused = new Set<string>()
  const sign = (thinking: string) => { const sig = `sig_${Buffer.from(thinking).toString('base64url').slice(0, 24)}${id('')}`; signed.set(sig, thinking); return sig }
  const hanging: Array<() => void> = []

  /** What the API refuses in the history a host sent back; null when it would accept it. */
  function badHistory(req: MessagesRequest): string | null {
    for (const [i, m] of req.messages.entries()) {
      if (m.role !== 'assistant' || typeof m.content === 'string') continue
      for (const [j, b] of m.content.entries()) {
        if (b.type === 'thinking' && signed.get(b.signature) !== b.thinking) return `messages.${i}.content.${j}: thinking blocks cannot be modified. These blocks must remain as they were in the original response.`
      }
    }
    const last = req.messages[req.messages.length - 1]
    if (last.role === 'assistant' && !paused.has(JSON.stringify(last.content))) return `messages.${req.messages.length - 1}: a paused turn is resumed by sending it back unchanged`
    return null
  }

  /** The canned answer. Decides between a `tool_use` turn and the echo. */
  function answer(req: MessagesRequest): { content: AssistantBlock[]; stop_reason: MessagesResponse['stop_reason']; stop_details?: MessagesResponse['stop_details']; model?: string } {
    const mode = armed.reply; armed.reply = null
    const asked = textOf(req.messages.find(m => m.role === 'user')?.content ?? '')
    if (mode === 'refusal' && req.fallbacks === 'default') return { model: FALLBACK_MODEL, stop_reason: 'end_turn', content: [{ type: 'text', text: `You said: ${asked}` }] }
    if (mode === 'refusal')   return { stop_reason: 'refusal', content: [], stop_details: { type: 'refusal', category: 'cyber', explanation: 'declined by safeguards' } }
    if (mode === 'pause') {
      const call = id('srvtoolu')
      const content: AssistantBlock[] = [
        { type: 'server_tool_use', id: call, name: 'web_search', input: { query: asked } },
        { type: 'web_search_tool_result', tool_use_id: call, content: [{ type: 'web_search_result', url: 'https://example.com/', title: 'Example', encrypted_content: id('enc') }] },
      ]
      paused.add(JSON.stringify(content))
      return { stop_reason: 'pause_turn', content }
    }
    if (req.messages[req.messages.length - 1].role === 'assistant') return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Searched.' }] }
    if (mode === 'max_tokens') return { stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"name":' }] }
    if (mode === 'prose')     return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Sorry, I would rather answer in prose.' }] }
    const wanted = req.output_config?.format?.schema
    if (wanted) return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(sample(wanted)) }] }
    const last     = req.messages[req.messages.length - 1]
    const results  = req.messages.flatMap(m => typeof m.content === 'string' ? [] : m.content.filter(b => b.type === 'tool_result'))
    const weather  = req.tools?.find(t => t.name === 'get_weather')
    if (weather && results.length === 0) {
      const thinks  = req.thinking && req.thinking.type !== 'disabled'
      const thought = `The person asked about ${asked}; get_weather answers that.`
      return { stop_reason: 'tool_use', content: [
        ...(thinks ? [{ type: 'thinking' as const, thinking: thought, signature: sign(thought) }] : []),
        { type: 'text', text: 'Let me check.' },
        { type: 'tool_use', id: id('toolu'), name: 'get_weather', input: { location: asked } },
      ] }
    }
    if (results.length) return { stop_reason: 'end_turn', content: [{ type: 'text', text: `The weather is ${textOf(results[results.length - 1].content ?? '')}.` }] }
    return { stop_reason: 'end_turn', content: [{ type: 'text', text: `You said: ${textOf(last.content)}` }] }
  }

  function usageFor(req: MessagesRequest, out: string): Usage {
    const marked = cacheable(req)
    let created = 0, read = 0
    for (const m of marked) { if (cache.has(m)) read += tokens(m); else { cache.add(m); created += tokens(m) } }
    return { input_tokens: tokens(promptText(req)) - created - read, output_tokens: tokens(out), cache_creation_input_tokens: created, cache_read_input_tokens: read }
  }

  function streamOf(message: MessagesResponse, die: boolean, chop: boolean): Response {
    const events: StreamEvent[] = [{ type: 'message_start', message: { ...message, content: [], stop_reason: null, usage: { ...message.usage, output_tokens: 1 } } }, { type: 'ping' }]
    message.content.forEach((block, index) => {
      if (block.type === 'text') {
        events.push({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
        for (const word of block.text.match(/\S+\s*/g) ?? []) events.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: word } })
      } else if (block.type === 'thinking') {
        events.push({ type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } })
        for (const word of block.thinking.match(/\S+\s*/g) ?? []) events.push({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: word } })
        events.push({ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: block.signature } })
      } else if (block.type === 'tool_use' || block.type === 'server_tool_use') {
        events.push({ type: 'content_block_start', index, content_block: { ...block, input: {} } })
        const whole = JSON.stringify(block.input)
        for (let i = 0; i < whole.length; i += 7) events.push({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: whole.slice(i, i + 7) } })
      } else events.push({ type: 'content_block_start', index, content_block: block })
      events.push({ type: 'content_block_stop', index })
    })
    events.push({ type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: message.usage.output_tokens } })
    events.push({ type: 'message_stop' })

    const enc = new TextEncoder()
    const frame = (ev: StreamEvent) => `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        // Two reads cut inside a frame: a reader that parses per read loses an event.
        if (chop) {
          const whole = enc.encode(events.map(frame).join('')), cut = Math.floor(whole.length / 3) + 5
          controller.enqueue(whole.slice(0, cut)); await new Promise(r => setTimeout(r, 5))
          controller.enqueue(whole.slice(cut)); controller.close(); return
        }
        let deltas = 0
        for (const ev of events) {
          controller.enqueue(enc.encode(frame(ev)))
          await new Promise(r => setTimeout(r, 2))
          // The death: the first delta is on the wire and the socket goes away
          // with no terminating chunk, which is what a crashed upstream looks like.
          if (die && ev.type === 'content_block_delta' && ++deltas === 1) { controller.error(new Error('upstream died')); return }
        }
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
      if (path === '/_sink/reset') { seen.length = 0; Object.assign(armed, disarmed()); return json({ ok: true }) }
      if (path === '/_sink/arm')   { Object.assign(armed, await req.json()); return json({ ok: true, armed }) }

      const text = req.method === 'POST' ? await req.text() : ''
      seen.push({ method: req.method, path, headers: Object.fromEntries(req.headers), body: text, at: Date.now() })

      const key = req.headers.get('x-api-key')
      if (key === FORBIDDEN) return refuse('permission_error', 'Your API key does not have permission to use the specified resource.', 403)
      if (key !== KEY)       return refuse('authentication_error', 'invalid x-api-key', 401)
      // Refused by name before anything is parsed: this is the drive's negative control.
      if (!req.headers.get('anthropic-version')) return refuse('invalid_request_error', 'anthropic-version header is required', 400)
      if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) return refuse('request_too_large', `Request body is ${text.length} bytes, over the ${MAX_BODY_BYTES} byte limit`, 413)

      if (armed.rateLimit)  {
        const { retryAfter, times = 1 } = armed.rateLimit
        armed.rateLimit = times > 1 ? { retryAfter, times: times - 1 } : null
        return refuse('rate_limit_error', 'This request would exceed your rate limit', 429, retryAfter === undefined ? {} : { 'retry-after': String(retryAfter) })
      }
      if (armed.overloaded) { armed.overloaded = false; return refuse('overloaded_error', 'Overloaded', 529) }
      if (armed.failNext)   { armed.failNext = false;   return refuse('api_error', 'An unexpected error has occurred internal to Anthropic’s systems.', 500) }

      let body: MessagesRequest & { stream?: boolean }
      try { body = JSON.parse(text) } catch { return refuse('invalid_request_error', 'body is not valid JSON', 400) }
      if (!body.model) return refuse('invalid_request_error', 'model: Field required', 400)
      if (body.model.startsWith('retired-')) return refuse('not_found_error', `model: ${body.model}`, 404)
      if (!Array.isArray(body.messages) || !body.messages.length) return refuse('invalid_request_error', 'messages: at least one message is required', 400)
      if ('betas' in body) return refuse('invalid_request_error', 'betas: Extra inputs are not permitted', 400)
      const betas = (req.headers.get('anthropic-beta') ?? '').split(',').map(b => b.trim())
      if ('fallbacks' in body && !betas.includes(FALLBACK_BETA)) return refuse('invalid_request_error', 'fallbacks: Extra inputs are not permitted', 400)
      const history = badHistory(body)
      if (history) return refuse('invalid_request_error', history, 400)

      let response: Response
      if (path === '/v1/messages/count_tokens' && req.method === 'POST') {
        response = json({ input_tokens: tokens(promptText(body)) })
      } else if (path === '/v1/messages' && req.method === 'POST') {
        if (!Number.isInteger(body.max_tokens) || body.max_tokens < 1) return refuse('invalid_request_error', 'max_tokens: Field required', 400)
        const schemaProblem = badSchema(body.output_config?.format?.schema)
        if (schemaProblem) return refuse('invalid_request_error', `output_config.format.schema: ${schemaProblem}`, 400)
        const { content, stop_reason, stop_details, model } = answer(body)
        const message: MessagesResponse = {
          id: id('msg'), type: 'message', role: 'assistant', model: model ?? body.model, content, stop_reason, stop_sequence: null, ...(stop_details ? { stop_details } : {}),
          usage: usageFor(body, textOf(content)),
        }
        if (body.stream) { const { dieMidStream, chop } = armed; armed.dieMidStream = armed.chop = false; response = streamOf(message, dieMidStream, chop) }
        else response = json(message)
      } else return refuse('not_found_error', `Not found: ${req.method} ${path}`, 404)

      // A lost response: the completion is BILLED and the answer never leaves.
      if (armed.lost) { armed.lost = false; await new Promise<void>(resolve => hanging.push(resolve)) }
      return response
    },
  })

  return {
    port: server.port,
    url:  `http://127.0.0.1:${server.port}`,
    key:  KEY,
    forbiddenKey: FORBIDDEN,
    stop() { for (const r of hanging) r(); server.stop(true) },
  }
}

if (import.meta.main) {
  const s = startAnthropicSink({ port: Number(process.env.ANTHROPIC_SINK_PORT ?? 0) })
  console.log(`[anthropic-sink] ${s.url}`)
}
