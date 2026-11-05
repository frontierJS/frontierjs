// test/anthropic.drive.ts — the connector through a real conduit against the sink.
//
// Run: `bun run drive`. Starts and stops its own sink on an ephemeral port. No
// fixture: the vendor is the only implementation.
//
// The negative control is the version header: the same connector against a
// target with `headers` removed must be REFUSED by the sink naming
// `anthropic-version`, or the rows about what is on the wire are about nothing.
//
// What only this drive asks: a billed POST is NOT replayed — a 429 and a 529
// come back after one attempt with the wait attached — while the free count
// IS replayed on a lost response; and a stream is read past the seam, with
// the socket dying between two deltas.

import { createConduit, createStaticResolver } from '@frontierjs/conduit'
import { results, report, control, DRIVE_RESILIENCE } from '../../lib/drive.ts'
import { startAnthropicSink } from '../sink.ts'
import { anthropicTarget, bindSend, bindStream, createMessage, countTokens, runToolLoop, streamMessage, assemble, type MessagesRequest, type StreamEvent } from '../src/index.ts'

const { got, t } = results()
const sink = startAnthropicSink()
const ctl  = control(sink.url)
const credentials = createStaticResolver({ ANTHROPIC_API_KEY: sink.key, FORBIDDEN_KEY: sink.forbiddenKey, WRONG_KEY: 'sk-ant-nope' })
const conduit = createConduit({ credentials, ...DRIVE_RESILIENCE })

// The target's own 120 s timeout is right for a completion and wrong for a
// drive whose lost response must cost under a second; overridden on the
// descriptor, as an app with its own number would.
const target = { ...anthropicTarget({ address: sink.url }), resilience: { timeout_ms: DRIVE_RESILIENCE.timeout_ms } }
await conduit.register(target)
await conduit.register({ ...target, id: 'provider:anthropic:forbidden', auth: { type: 'api_key', ref: 'FORBIDDEN_KEY', header: 'x-api-key' } })
await conduit.register({ ...target, id: 'provider:anthropic:wrong',     auth: { type: 'api_key', ref: 'WRONG_KEY',     header: 'x-api-key' } })
const { headers: _h, ...bare } = target
await conduit.register({ ...bare, id: 'provider:anthropic:noversion' })
const send = bindSend(conduit)

type Seen = { requests: { headers: Record<string, string>; body: string }[] }
const seen  = () => ctl.seen() as unknown as Promise<Seen>
const count = async () => (await seen()).requests.length
const ask   = (text: string, extra: Partial<MessagesRequest> = {}): MessagesRequest => ({ model: 'claude-sonnet-4-5', max_tokens: 64, messages: [{ role: 'user', content: text }], ...extra })
const collect = async (it: AsyncIterable<StreamEvent>) => { const out: StreamEvent[] = []; for await (const e of it) out.push(e); return out }
const weather = { name: 'get_weather', description: 'Weather for a city', input_schema: { type: 'object' as const, properties: { location: { type: 'string' } }, required: ['location'] } }

try {
  // ── outbound: the shape on the wire ────────────────────────────────────
  const made  = await createMessage(send, ask('hello there'))
  const first = (await seen()).requests[0]
  t('create.succeeds', { ok: !made.error, text: made.message?.content[0]?.type === 'text' ? made.message.content[0].text : null, stop: made.message?.stop_reason,
    versionOnWire: first.headers['anthropic-version'], keyHeader: 'x-api-key' in first.headers, contentType: first.headers['content-type'],
    usageShape: made.message ? Object.keys(made.message.usage).sort() : null })
  t('create.sendsNoIdempotencyKeyAndNoStreamFlag', { keyHeader: 'idempotency-key' in first.headers, streamInBody: 'stream' in JSON.parse(first.body) })

  // ── negative control ───────────────────────────────────────────────────
  const wrong = await createMessage(bindSend(conduit, 'provider:anthropic:noversion'), ask('x'))
  t('withoutVersionHeader.isRefused', { kind: wrong.error?.kind, code: wrong.error?.code, status: wrong.error?.status, namesTheCause: (wrong.error?.message ?? '').includes('anthropic-version') })

  // ── the error table ────────────────────────────────────────────────────
  t('authFailed.isTheKey',    { kind: (await createMessage(bindSend(conduit, 'provider:anthropic:wrong'),     ask('x'))).error?.kind })
  t('forbidden.isThePolicy',  { kind: (await createMessage(bindSend(conduit, 'provider:anthropic:forbidden'), ask('x'))).error?.kind })
  const gone = await createMessage(send, ask('x', { model: 'retired-claude-2' }))
  t('retiredModel.isModelGone', { kind: gone.error?.kind, code: gone.error?.code, retryable: gone.error?.retryable })
  const long = await createMessage(send, ask('x'.repeat(40_000)))
  t('oversized.isTooLong', { kind: long.error?.kind, code: long.error?.code })
  await ctl.reset()
  const local = await createMessage(send, ask('x', { max_tokens: 0 }))
  t('badMaxTokens.refusedBeforeSending', { kind: local.error?.kind, sent: await count() })

  // ── chaos: a 429 is handed back with the wait, never replayed ──────────
  await ctl.reset(); await ctl.arm({ rateLimit: { retryAfter: 7 } })
  const t0 = Date.now()
  const limited = await createMessage(send, ask('again'))
  t('rateLimited.handedBackNotReplayed', { kind: limited.error?.kind, retryable: limited.error?.retryable, retryAfterMs: limited.error?.retryAfterMs, attempts: await count(), waitedForIt: Date.now() - t0 >= 7000 })

  // A wait inside the deadline is the one a replay WOULD take: with `retry-after: 7`
  // conduit declines the sleep for running past the deadline, so only this row
  // can tell "not replayed" from "no time to replay".
  await ctl.reset(); await ctl.arm({ rateLimit: { retryAfter: 1 } })
  const t1 = Date.now()
  const short = await createMessage(send, ask('again'))
  t('rateLimited.shortWaitStillNotReplayed', { kind: short.error?.kind, retryAfterMs: short.error?.retryAfterMs, attempts: await count(), under: Date.now() - t1 < 1000 })

  // ── chaos: 529 is server_error, retryable, one attempt ─────────────────
  await ctl.reset(); await ctl.arm({ overloaded: true })
  const busy = await createMessage(send, ask('again'))
  t('overloaded.isRetryableServerError', { kind: busy.error?.kind, code: busy.error?.code, status: busy.error?.status, retryable: busy.error?.retryable, indeterminate: busy.error?.indeterminate ?? false, attempts: await count() })

  // ── chaos: a 500 may have run, so conduit's verdict stands ─────────────
  await ctl.reset(); await ctl.arm({ failNext: true })
  const broke = await createMessage(send, ask('again'))
  t('apiError.isIndeterminate', { kind: broke.error?.kind, code: broke.error?.code, retryable: broke.error?.retryable, indeterminate: broke.error?.indeterminate, attempts: await count() })

  // ── the free call is replayed by conduit ───────────────────────────────
  await ctl.reset(); await ctl.arm({ lost: true })
  const counted = await countTokens(send, { model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'twelve chars' }] })
  t('countTokens.replayedOnLostResponse', { ok: !counted.error, tokens: counted.count?.input_tokens, attempts: await count() })

  // ── prompt cache: the second call reads what the first wrote ───────────
  const cached = (): MessagesRequest => ask('cache me', { system: [{ type: 'text', text: 'You are terse. '.repeat(20), cache_control: { type: 'ephemeral' } }] })
  const c1 = await createMessage(send, cached()), c2 = await createMessage(send, cached())
  t('cache.readTokensSurfaced', { firstCreated: (c1.message?.usage.cache_creation_input_tokens ?? 0) > 0, firstRead: c1.message?.usage.cache_read_input_tokens, secondCreated: c2.message?.usage.cache_creation_input_tokens, secondRead: (c2.message?.usage.cache_read_input_tokens ?? 0) > 0 })

  // ── streaming ──────────────────────────────────────────────────────────
  const link   = bindStream(conduit)
  const before = conduit.stats().streams.opened
  const evs    = await collect(streamMessage(link, ask('stream this please')))
  t('stream.crossesTheSeam', { opened: conduit.stats().streams.opened - before })
  const got1 = assemble(evs)
  t('stream.yieldsDeltasAndFinalUsage', { types: [...new Set(evs.map(e => e.type))], text: got1.text, stop: got1.stopReason, outputTokens: got1.usage.output_tokens, deltas: evs.filter(e => e.type === 'content_block_delta').length > 1, last: evs[evs.length - 1]?.type })

  await ctl.arm({ dieMidStream: true })
  const dead = await collect(streamMessage(link, ask('stream this please')))
  const lastDead = dead[dead.length - 1]
  t('stream.deathYieldsStreamErrorAfterWhatArrived', { arrived: dead.filter(e => e.type === 'content_block_delta').length, started: dead.some(e => e.type === 'message_start'), last: lastDead?.type, kind: lastDead?.type === 'stream_error' ? lastDead.failure.kind : null, noStop: !dead.some(e => e.type === 'message_stop') })

  const tooled = assemble(await collect(streamMessage(link, ask('Paris', { tools: [weather] }))))
  t('stream.assemblesInputJsonDelta', { stop: tooled.stopReason, tool: tooled.toolUse[0]?.name, input: tooled.toolUse[0]?.input })

  const noVersion = await collect(streamMessage(bindStream(conduit, 'provider:anthropic:noversion'), ask('x')))
  t('stream.withoutVersionHeaderIsRefused', { count: noVersion.length, type: noVersion[0]?.type, kind: noVersion[0]?.type === 'stream_error' ? noVersion[0].failure.kind : null, status: noVersion[0]?.type === 'stream_error' ? noVersion[0].failure.status : null })

  // ── the tool loop ──────────────────────────────────────────────────────
  await ctl.reset()
  const calls: unknown[] = []
  const loop = await runToolLoop(send, ask('Paris', { tools: [weather] }), { get_weather: async input => { calls.push(input); return 'sunny, 21C' } }, { maxTurns: 5 })
  const requests = await count()
  // The sink is deterministic, so each turn re-run alone gives the number the loop must have added.
  const turn1 = await createMessage(send, ask('Paris', { tools: [weather] }))
  const turn2 = await createMessage(send, { ...ask('Paris', { tools: [weather] }), messages: loop.messages.slice(0, 3) })
  t('toolLoop.runsTwoTurnsAndSumsUsage', { turns: loop.turns, requests, toolCalledWith: calls, text: loop.message?.content[0]?.type === 'text' ? loop.message.content[0].text : null,
    inputIsSum:  loop.usage.input_tokens  === turn1.message!.usage.input_tokens  + turn2.message!.usage.input_tokens,
    outputIsSum: loop.usage.output_tokens === turn1.message!.usage.output_tokens + turn2.message!.usage.output_tokens,
    secondTurnLonger: turn2.message!.usage.input_tokens > turn1.message!.usage.input_tokens, messages: loop.messages.map(m => m.role) })

  await ctl.reset()
  const capped = await runToolLoop(send, ask('Paris', { tools: [weather] }), { get_weather: async () => 'sunny' }, { maxTurns: 1 })
  t('toolLoop.cappedAtMaxTurns', { kind: capped.error?.kind, turns: capped.turns, requests: await count(), usageKept: capped.usage.input_tokens > 0, resumable: capped.messages.length })

  const unknown = await runToolLoop(send, ask('Paris', { tools: [weather] }), {}, { maxTurns: 3 })
  t('toolLoop.unknownToolIsAnErrorResult', { turns: unknown.turns, ok: !unknown.error, secondTurnCarriesError: JSON.stringify(unknown.messages[2]?.content).includes('"is_error":true') })
} catch (e) {
  console.error('\nThe drive threw:', (e as Error).stack)
  got.__threw = String((e as Error).message)
} finally {
  sink.stop(); await conduit.destroy()
}

process.exit(report(got, {
  'create.succeeds':                       { ok: true, text: 'You said: hello there', stop: 'end_turn', versionOnWire: '2023-06-01', keyHeader: true, contentType: 'application/json', usageShape: ['cache_creation_input_tokens', 'cache_read_input_tokens', 'input_tokens', 'output_tokens'] },
  'create.sendsNoIdempotencyKeyAndNoStreamFlag': { keyHeader: false, streamInBody: false },
  'withoutVersionHeader.isRefused':        { kind: 'refused', code: 'invalid_request_error', status: 400, namesTheCause: true },
  'authFailed.isTheKey':                   { kind: 'auth_failed' },
  'forbidden.isThePolicy':                 { kind: 'forbidden' },
  'retiredModel.isModelGone':              { kind: 'model_gone', code: 'not_found_error', retryable: false },
  'oversized.isTooLong':                   { kind: 'too_long', code: 'request_too_large' },
  'badMaxTokens.refusedBeforeSending':     { kind: 'refused', sent: 0 },
  'rateLimited.handedBackNotReplayed':     { kind: 'rate_limited', retryable: true, retryAfterMs: 7000, attempts: 1, waitedForIt: false },
  'rateLimited.shortWaitStillNotReplayed': { kind: 'rate_limited', retryAfterMs: 1000, attempts: 1, under: true },
  'overloaded.isRetryableServerError':     { kind: 'server_error', code: 'overloaded_error', status: 529, retryable: true, indeterminate: false, attempts: 1 },
  'apiError.isIndeterminate':              { kind: 'server_error', code: 'api_error', retryable: false, indeterminate: true, attempts: 1 },
  'countTokens.replayedOnLostResponse':    { ok: true, tokens: 4, attempts: 2 },
  'cache.readTokensSurfaced':              { firstCreated: true, firstRead: 0, secondCreated: 0, secondRead: true },
  'stream.yieldsDeltasAndFinalUsage':      { types: ['message_start', 'ping', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop'], text: 'You said: stream this please', stop: 'end_turn', outputTokens: 7, deltas: true, last: 'message_stop' },
  'stream.crossesTheSeam':                 { opened: 1 },
  'stream.deathYieldsStreamErrorAfterWhatArrived': { arrived: 1, started: true, last: 'stream_error', kind: 'stream_error', noStop: true },
  'stream.assemblesInputJsonDelta':        { stop: 'tool_use', tool: 'get_weather', input: { location: 'Paris' } },
  'stream.withoutVersionHeaderIsRefused':  { count: 1, type: 'stream_error', kind: 'refused', status: 400 },
  'toolLoop.runsTwoTurnsAndSumsUsage':     { turns: 2, requests: 2, toolCalledWith: [{ location: 'Paris' }], text: 'The weather is sunny, 21C.', inputIsSum: true, outputIsSum: true, secondTurnLonger: true, messages: ['user', 'assistant', 'user', 'assistant'] },
  'toolLoop.cappedAtMaxTurns':             { kind: 'turn_limit', turns: 1, requests: 1, usageKept: true, resumable: 3 },
  'toolLoop.unknownToolIsAnErrorResult':   { turns: 2, ok: true, secondTurnCarriesError: true },
}))
