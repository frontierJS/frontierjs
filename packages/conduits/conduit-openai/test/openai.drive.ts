// test/openai.drive.ts — the connector through a real conduit against the sink,
// and against a conforming server when `FIXTURE_URL` is set.
//
// Run: `bun run drive`. Starts and stops its own sink on an ephemeral port.
// `FIXTURE_URL=http://127.0.0.1:11434 FIXTURE_MODEL=qwen2.5:0.5b bun run drive`
// adds the protocol rows against Ollama or llama.cpp (`test/fixture/README.md`);
// chaos rows stay on the sink.
//
// The negative control is `translate.readsBothDialects`: the sink switched to
// Ollama's bare-string envelope must still read as `model_gone`, so a reader
// of OpenAI's object shape alone fails the row.

import { createConduit, createStaticResolver } from '@frontierjs/conduit'
import { results, report, control, DRIVE_RESILIENCE } from '../../lib/drive.ts'
import { startOpenAISink } from '../sink.ts'
import { openaiTarget, bindSend, bindStream, chatCompletion, embeddings, listModels, runToolLoop, streamChatCompletion, assemble, translate, type Send, type ChatChunk, type ChatRequest, type Usage } from '../src/index.ts'

const { got, t } = results()
const KEY = 'sk-dev-key'

const sink    = startOpenAISink({ key: KEY })
const ctl     = control(sink.url)
const creds   = createStaticResolver({ OPENAI_API_KEY: KEY, WRONG_KEY: 'sk-wrong' })
const conduit = createConduit({ credentials: creds, ...DRIVE_RESILIENCE })
const target  = openaiTarget({ name: 'sink', address: sink.url, timeoutMs: DRIVE_RESILIENCE.timeout_ms })
await conduit.register(target)
const send = bindSend(conduit, target.id)
const link = bindStream(conduit, target.id)

type Seen = { requests: { method: string; path: string; headers: Record<string, string>; body: string }[] }
const seen      = () => ctl.seen<never>() as unknown as Promise<Seen>
const seenCount = async () => (await seen()).requests.length
const collect   = async (it: AsyncIterable<ChatChunk>) => { const out: ChatChunk[] = []; for await (const c of it) out.push(c); return out }
const ask       = (text: string, more: Partial<ChatRequest> = {}): ChatRequest => ({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: text }], ...more })
const WEATHER   = { type: 'function' as const, function: { name: 'get_weather', description: 'Weather at a place', parameters: { type: 'object' as const, properties: { location: { type: 'string' } }, required: ['location'] } } }

try {
  // ── the shape on the wire ──────────────────────────────────────────────
  const hello = await chatCompletion(send, ask('hello', { extra: { response_format: { type: 'json_object' } } }))
  const first = (await seen()).requests[0]
  const wire  = JSON.parse(first.body)
  t('chat.echoes', { ok: !hello.error, content: hello.completion?.choices[0].message.content, finish: hello.completion?.choices[0].finish_reason, hasUsage: !!hello.completion?.usage })
  t('chat.wire', { path: first.path, bearer: first.headers.authorization === `Bearer ${KEY}`, idempotencyKey: first.headers['idempotency-key'] ?? null, streamFlag: wire.stream ?? null, extraPassedThrough: wire.response_format?.type, extraNotNested: 'extra' in wire })

  const models = await listModels(send)
  t('models.list', { ok: !models.error, ids: models.models?.data.map(m => m.id) })

  const e1 = await embeddings(send, { model: 'text-embedding-3-small', input: 'the same words' })
  const e2 = await embeddings(send, { model: 'text-embedding-3-small', input: ['the same words', 'other words'] })
  t('embeddings.deterministic', { ok: !e1.error && !e2.error, dims: e1.embeddings?.data[0].embedding.length, sameInputSameVector: JSON.stringify(e1.embeddings?.data[0].embedding) === JSON.stringify(e2.embeddings?.data[0].embedding), differs: JSON.stringify(e2.embeddings?.data[0].embedding) !== JSON.stringify(e2.embeddings?.data[1].embedding) })

  // ── a 429 is HANDED BACK on a completion: conduit does not replay an unkeyed bill ──
  await ctl.reset()
  await ctl.arm({ rateLimit: { retryAfter: 2 } })
  const limited = await chatCompletion(send, ask('again'))
  t('rateLimit.handedBackUnreplayed', { kind: limited.error?.kind, retryable: limited.error?.retryable, retryAfterMs: limited.error?.retryAfterMs, code: limited.error?.code, attempts: await seenCount() })

  await ctl.reset()
  await ctl.arm({ quota: true })
  const quota = await chatCompletion(send, ask('again'))
  t('quota.notRetryable', { kind: quota.error?.kind, retryable: quota.error?.retryable, retryAfterMs: quota.error?.retryAfterMs ?? null, code: quota.error?.code, attempts: await seenCount() })

  await ctl.reset()
  await ctl.arm({ failNext: true })
  const broke = await chatCompletion(send, ask('again'))
  t('serverError.handedBackIndeterminate', { kind: broke.error?.kind, retryable: broke.error?.retryable, indeterminate: broke.error?.indeterminate ?? false, attempts: await seenCount() })

  // ── a lost response: billed, unreplayed, indeterminate — unless the call is a read ──
  await ctl.reset()
  await ctl.arm({ lost: true })
  const lostChat = await chatCompletion(send, ask('lost'))
  t('chat.lostNotReplayed', { kind: lostChat.error?.kind, retryable: lostChat.error?.retryable, indeterminate: lostChat.error?.indeterminate ?? false, attempts: await seenCount() })

  await ctl.reset()
  await ctl.arm({ lost: true })
  const lostEmb = await embeddings(send, { model: 'text-embedding-3-small', input: 'lost then found' })
  t('embeddings.lostReplayed', { ok: !lostEmb.error, attempts: await seenCount() })

  // ── streaming ──────────────────────────────────────────────────────────
  await ctl.reset()
  const before = conduit.stats().streams.opened
  const plain = assemble(await collect(streamChatCompletion(link, ask('stream me', { stream_options: { include_usage: true } }))))
  const streamed = (await seen()).requests[0]
  t('stream.crossesTheSeam', { opened: conduit.stats().streams.opened - before })
  t('stream.deltasAndUsage', { text: plain.text, finish: plain.finishReason, usage: plain.usage ? { prompt: plain.usage.prompt_tokens > 0, completion: plain.usage.completion_tokens > 0, total: plain.usage.total_tokens === plain.usage.prompt_tokens + plain.usage.completion_tokens } : null, error: plain.error, wireStream: JSON.parse(streamed.body).stream, bearer: streamed.headers.authorization === `Bearer ${KEY}` })

  const tooled = assemble(await collect(streamChatCompletion(link, ask('Paris', { tools: [WEATHER] }))))
  t('stream.toolCallArgumentsAssembled', { finish: tooled.finishReason, calls: tooled.toolCalls.map(c => ({ name: c.function.name, hasId: c.id.length > 0, args: JSON.parse(c.function.arguments) })), error: tooled.error })

  await ctl.arm({ noDone: true })
  const noDone = assemble(await collect(streamChatCompletion(link, ask('no terminator'))))
  t('stream.missingDoneIsStreamError', { textArrived: noDone.text, finish: noDone.finishReason, kind: noDone.error?.kind, retryable: noDone.error?.retryable })

  await ctl.arm({ dieMidStream: true })
  const died = assemble(await collect(streamChatCompletion(link, ask('die on me'))))
  t('stream.dieMidStreamIsStreamErrorAfterPartial', { partial: died.text, kind: died.error?.kind, endedCleanly: died.finishReason })

  const streamRefusal = await collect(streamChatCompletion(link, ask('retired', { model: 'retired-davinci' })))
  t('stream.refusalBeforeFirstChunk', { chunks: streamRefusal.length, kind: streamRefusal[0]?.object === 'stream_error' ? streamRefusal[0].failure.kind : null, status: streamRefusal[0]?.object === 'stream_error' ? streamRefusal[0].failure.status : null })


  // ── the tool loop ──────────────────────────────────────────────────────
  await ctl.reset()
  const perTurn: Usage[] = []
  const counting: Send = async req => { const r = await send<{ usage?: Usage }>(req); if (r.data?.usage) perTurn.push(r.data.usage); return r as never }
  const loop = await runToolLoop(counting, ask('Lisbon', { tools: [WEATHER] }), { get_weather: args => `sunny in ${args.location}` }, { maxTurns: 5 })
  const expected = perTurn.reduce((s, u) => ({ prompt_tokens: s.prompt_tokens + u.prompt_tokens, completion_tokens: s.completion_tokens + u.completion_tokens, total_tokens: s.total_tokens + u.total_tokens }), { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 })
  t('toolLoop.twoTurnsUsageSummed', { turns: loop.turns, text: loop.completion?.choices[0].message.content, usageIsSum: JSON.stringify(loop.usage) === JSON.stringify(expected), roles: loop.messages.map(m => m.role), toolAnswered: loop.messages.find(m => m.role === 'tool')?.content })

  const capped = await runToolLoop(send, ask('Rome', { tools: [WEATHER] }), { get_weather: () => 'rain' }, { maxTurns: 1 })
  t('toolLoop.maxTurnsCap', { kind: capped.error?.kind, turns: capped.turns, usageCounted: capped.usage.total_tokens > 0, resumable: capped.messages.length })

  // ── two dialects, one reader ───────────────────────────────────────────
  await ctl.reset()
  const openaiGone = await chatCompletion(send, ask('x', { model: 'retired-davinci' }))
  await ctl.arm({ ollamaErrors: true })
  const ollamaGone = await chatCompletion(send, ask('x', { model: 'retired-llama' }))
  const ollamaBad  = await chatCompletion(send, { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'x'.repeat(9000) }] })
  await ctl.reset()
  t('translate.readsBothDialects', {
    openai: { kind: openaiGone.error?.kind, code: openaiGone.error?.code, type: openaiGone.error?.type },
    ollama: { kind: ollamaGone.error?.kind, code: ollamaGone.error?.code ?? null, sentence: ollamaGone.error?.message },
    ollamaTooLong: ollamaBad.error?.kind,
  })
  // The pure reader, off the wire, with the raw shapes each server really sends.
  const err = (raw: unknown) => ({ kind: 'client_error' as const, target: 't', protocol: 'http' as const, message: 'HTTP 404', retryable: false, raw })
  t('translate.unit', {
    openaiObject: translate(err(JSON.stringify({ error: { message: 'The model `x` does not exist', type: 'invalid_request_error', param: null, code: 'model_not_found' } })), 404).kind,
    ollamaString: translate(err(JSON.stringify({ error: "model 'x' not found, try pulling it first" })), 404).kind,
    llamacppNumericCode: translate(err(JSON.stringify({ error: { code: 400, message: 'context length exceeded', type: 'invalid_request_error' } })), 400).kind,
    unrelated404: translate(err(JSON.stringify({ error: { message: 'Invalid URL (POST /v2/x)', type: 'invalid_request_error', code: null } })), 404).kind,
  })

  const tooLong = await chatCompletion(send, { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'x'.repeat(9000) }] })
  t('contextLength.isTooLong', { kind: tooLong.error?.kind, code: tooLong.error?.code, retryable: tooLong.error?.retryable })

  const short = await chatCompletion(send, ask('a long sentence that will be cut', { max_tokens: 3 }))
  t('finishReason.length', { finish: short.completion?.choices[0].finish_reason, cut: (short.completion?.choices[0].message.content?.length ?? 0) <= 12 })

  await ctl.reset()
  const local = await chatCompletion(send, ask('x', { extra: { stream: true } }))
  t('extra.cannotSmuggleProtocolField', { kind: local.error?.kind, sent: await seenCount() })

  // ── auth: the wrong key is refused by the sink and read as auth_failed ──
  const wrong = openaiTarget({ name: 'wrong', ref: 'WRONG_KEY', address: sink.url })
  await conduit.register(wrong)
  const refused = await chatCompletion(bindSend(conduit, wrong.id), ask('x'))
  t('auth.wrongKeyFails', { kind: refused.error?.kind, code: refused.error?.code, id: wrong.id })

  // ── fixture: the same protocol rows against a real implementation ──────
  if (process.env.FIXTURE_URL) {
    const fx = createStaticResolver({ FIXTURE_KEY: process.env.FIXTURE_KEY ?? 'none' })
    const fxConduit = createConduit({ credentials: fx, timeout_ms: 120_000 })
    const fxTarget  = openaiTarget({ name: 'fixture', ref: 'FIXTURE_KEY', address: process.env.FIXTURE_URL })
    await fxConduit.register(fxTarget)
    const fxSend  = bindSend(fxConduit, fxTarget.id)
    const fxModels = await listModels(fxSend)
    const model    = process.env.FIXTURE_MODEL ?? fxModels.models?.data[0]?.id ?? ''
    t('fixture.listModels', { ok: !fxModels.error, hasModel: !!model })
    const fxChat = await chatCompletion(fxSend, { model, messages: [{ role: 'user', content: 'Reply with the single word: pong' }], max_tokens: 8 })
    t('fixture.chat', { ok: !fxChat.error, answered: (fxChat.completion?.choices[0].message.content ?? '').length > 0, finish: !!fxChat.completion?.choices[0].finish_reason, usage: !!fxChat.completion?.usage, error: fxChat.error?.message ?? null })
    const fxStream = assemble(await collect(streamChatCompletion(bindStream(fxConduit, fxTarget.id), { model, messages: [{ role: 'user', content: 'Reply with the single word: pong' }], max_tokens: 8, stream_options: { include_usage: true } })))
    t('fixture.stream', { answered: fxStream.text.length > 0, finished: !!fxStream.finishReason, error: fxStream.error?.message ?? null })
    const fxEmb = await embeddings(fxSend, { model: process.env.FIXTURE_EMBED_MODEL ?? model, input: 'pong' })
    t('fixture.embeddings', { ok: !fxEmb.error, dims: (fxEmb.embeddings?.data[0].embedding.length ?? 0) > 0, error: fxEmb.error?.message ?? null })
    await fxConduit.destroy()
  }
} catch (e) {
  console.error('\nThe drive threw:', (e as Error).stack)
  got.__threw = String((e as Error).message)
} finally {
  sink.stop(); await conduit.destroy()
}

const expected: Record<string, unknown> = {
  'chat.echoes':                       { ok: true, content: 'You said: hello', finish: 'stop', hasUsage: true },
  'chat.wire':                         { path: '/v1/chat/completions', bearer: true, idempotencyKey: null, streamFlag: null, extraPassedThrough: 'json_object', extraNotNested: false },
  'models.list':                       { ok: true, ids: ['gpt-4o-mini', 'text-embedding-3-small'] },
  'embeddings.deterministic':          { ok: true, dims: 8, sameInputSameVector: true, differs: true },
  'rateLimit.handedBackUnreplayed':    { kind: 'rate_limited', retryable: true, retryAfterMs: 2000, code: 'rate_limit_exceeded', attempts: 1 },
  'quota.notRetryable':                { kind: 'quota', retryable: false, retryAfterMs: null, code: 'insufficient_quota', attempts: 1 },
  'serverError.handedBackIndeterminate': { kind: 'server_error', retryable: false, indeterminate: true, attempts: 1 },
  'chat.lostNotReplayed':              { kind: 'timeout', retryable: false, indeterminate: true, attempts: 1 },
  'embeddings.lostReplayed':           { ok: true, attempts: 2 },
  'stream.deltasAndUsage':             { text: 'You said: stream me', finish: 'stop', usage: { prompt: true, completion: true, total: true }, error: null, wireStream: true, bearer: true },
  'stream.toolCallArgumentsAssembled': { finish: 'tool_calls', calls: [{ name: 'get_weather', hasId: true, args: { location: 'Paris' } }], error: null },
  'stream.crossesTheSeam':             { opened: 1 },
  'stream.missingDoneIsStreamError':   { textArrived: 'You said: no terminator', finish: 'stop', kind: 'stream_error', retryable: false },
  'stream.dieMidStreamIsStreamErrorAfterPartial': { partial: 'You ', kind: 'stream_error', endedCleanly: null },
  'stream.refusalBeforeFirstChunk':    { chunks: 1, kind: 'model_gone', status: 404 },
  'toolLoop.twoTurnsUsageSummed':      { turns: 2, text: 'The weather is sunny in Lisbon.', usageIsSum: true, roles: ['user', 'assistant', 'tool', 'assistant'], toolAnswered: 'sunny in Lisbon' },
  'toolLoop.maxTurnsCap':              { kind: 'turn_limit', turns: 1, usageCounted: true, resumable: 3 },
  'translate.readsBothDialects':       { openai: { kind: 'model_gone', code: 'model_not_found', type: 'invalid_request_error' }, ollama: { kind: 'model_gone', code: null, sentence: 'The model `retired-llama` does not exist or you do not have access to it.' }, ollamaTooLong: 'too_long' },
  'translate.unit':                    { openaiObject: 'model_gone', ollamaString: 'model_gone', llamacppNumericCode: 'too_long', unrelated404: 'refused' },
  'contextLength.isTooLong':           { kind: 'too_long', code: 'context_length_exceeded', retryable: false },
  'finishReason.length':               { finish: 'length', cut: true },
  'extra.cannotSmuggleProtocolField':  { kind: 'refused', sent: 0 },
  'auth.wrongKeyFails':                { kind: 'auth_failed', code: 'invalid_api_key', id: 'provider:openai:wrong' },
}
if (process.env.FIXTURE_URL) Object.assign(expected, {
  'fixture.listModels': { ok: true, hasModel: true },
  'fixture.chat':       { ok: true, answered: true, finish: true, usage: true, error: null },
  'fixture.stream':     { answered: true, finished: true, error: null },
  'fixture.embeddings': { ok: true, dims: true, error: null },
})

process.exit(report(got, expected))
