// test/anthropic.drive.ts — the connector through a real conduit against the sink.
//
// Run: `bun run drive`. Starts and stops its own sink on an ephemeral port. No
// fixture: the vendor is the only implementation.
//
// The negative control is the version header: the same connector against a
// target with `headers` removed must be REFUSED by the sink naming
// `anthropic-version`, or the rows about what is on the wire are about nothing.
//
// The door rows (`door.*`) run `anthropicDoor` over the same conduit and sink,
// and every reply goes through `checkReply` so a row cannot pass on a reply
// the contract would refuse.
//
// The `host.*` rows are what kos's companion scripts with its own fake
// (`api/test/helpers/fakeAnthropic.ts`), asked of the real connector: a thinking
// block sent back unchanged, streamed tool input, `pause_turn`, the fallback beta.
//
// What only this drive asks: a billed POST is NOT replayed — a 429 and a 529
// come back after one attempt with the wait attached — while the free count
// IS replayed on a lost response; and a stream is read past the seam, with
// the socket dying between two deltas.

import { createConduit, createStaticResolver } from '@frontierjs/conduit'
import { results, report, control, DRIVE_RESILIENCE } from '../../lib/drive.ts'
import { startAnthropicSink } from '../sink.ts'
import { checkReply, type Question, type Reply } from '@frontierjs/toolbelt/ask'
import { anthropicTarget, anthropicDoor, normalizeSchema, bindSend, bindStream, createMessage, countTokens, runToolLoop, streamMessage, assemble, type AssistantBlock, type MessagesRequest, type StreamEvent } from '../src/index.ts'

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
await conduit.register({ ...target, id: 'provider:anthropic:nokey', auth: { type: 'api_key', ref: 'UNSET_KEY', header: 'x-api-key' } })
const send = bindSend(conduit)

type Seen = { requests: { path: string; headers: Record<string, string>; body: string }[] }
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

  // ── a long-running host: what it sends back next turn ──────────────────
  const FB = ['server-side-fallback-2026-07-01']
  await ctl.reset()
  const bc = await createMessage(send, ask('beta', { betas: FB, fallbacks: 'default' }))
  const bs = await collect(streamMessage(link, ask('beta', { betas: FB, fallbacks: 'default' })))
  const bn = await countTokens(send, { model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'beta' }], betas: FB })
  const wired = (await seen()).requests
  t('host.betasReachEveryCallAsAHeader', { ok: [!bc.error, bs[bs.length - 1]?.type === 'message_stop', !bn.error], paths: wired.map(r => r.path), header: wired.map(r => r.headers['anthropic-beta'] ?? null),
    betasInBody: wired.some(r => 'betas' in JSON.parse(r.body)), fallbacks: wired.map(r => JSON.parse(r.body).fallbacks ?? null) })
  const unbeta = await createMessage(send, ask('beta', { fallbacks: 'default' }))
  t('host.fallbacksWithoutTheBetaIsRefused', { kind: unbeta.error?.kind, status: unbeta.error?.status, namesIt: (unbeta.error?.message ?? '').includes('fallbacks') })

  await ctl.arm({ reply: 'refusal' })
  const declined = await createMessage(send, ask('borderline'))
  await ctl.arm({ reply: 'refusal' })
  const rerun = await createMessage(send, ask('borderline', { betas: FB, fallbacks: 'default' }))
  t('host.fallbackAnswersADeclineOnAnotherModel', { without: declined.message?.stop_reason, with: rerun.message?.stop_reason, model: rerun.message?.model })

  const thinkReq = ask('Paris', { tools: [weather], thinking: { type: 'adaptive' } })
  const thought  = assemble(await collect(streamMessage(link, thinkReq)))
  const th = thought.content[0]
  t('host.thinkingStreamsWithItsSignature', { types: thought.content.map(b => b.type), thinking: th?.type === 'thinking' ? th.thinking : null, signed: th?.type === 'thinking' && th.signature.startsWith('sig_'), input: thought.toolUse[0]?.input })

  const answerWith = (content: AssistantBlock[]): MessagesRequest => ({ ...thinkReq, messages: [...thinkReq.messages, { role: 'assistant', content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: thought.toolUse[0]!.id, content: 'sunny' }] }] })
  const back   = await createMessage(send, answerWith(thought.content))
  const edited = await createMessage(send, answerWith(thought.content.map(b => b.type === 'thinking' ? { ...b, thinking: `${b.thinking}!` } : b)))
  const thinkingLoop = await runToolLoop(send, thinkReq, { get_weather: () => 'sunny' }, { maxTurns: 3 })
  t('host.thinkingSentBackUnchanged', { accepted: back.message?.content[0]?.type === 'text' ? back.message.content[0].text : back.error?.message, edited: edited.error?.kind, status: edited.error?.status,
    namesIt: (edited.error?.message ?? '').includes('thinking blocks cannot be modified'), loopTurns: thinkingLoop.turns, loopOk: !thinkingLoop.error })

  const searchReq = ask('plumbers in Boise', { tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 3 }] })
  await ctl.arm({ reply: 'pause' })
  const pausedTurn = assemble(await collect(streamMessage(link, searchReq)))
  const search = pausedTurn.content[0], found = pausedTurn.content[1]
  t('host.pauseTurnStreamsServerToolInput', { stop: pausedTurn.stopReason, types: pausedTurn.content.map(b => b.type), query: search?.type === 'server_tool_use' ? search.input.query : null,
    resultKept: found?.type === 'web_search_tool_result' && Array.isArray(found.content) })
  const resumed = await createMessage(send, { ...searchReq, messages: [...searchReq.messages, { role: 'assistant', content: pausedTurn.content }] })
  const altered = await createMessage(send, { ...searchReq, messages: [...searchReq.messages, { role: 'assistant', content: pausedTurn.content.slice(0, 1) }] })
  t('host.pauseTurnResumedUnchanged', { resumed: resumed.message?.content[0]?.type === 'text' ? resumed.message.content[0].text : resumed.error?.message, stop: resumed.message?.stop_reason, altered: altered.error?.kind })

  await ctl.reset(); await ctl.arm({ reply: 'pause' })
  const pauseLoop = await runToolLoop(send, searchReq, {}, { maxTurns: 3 })
  t('toolLoop.resumesPauseTurn', { turns: pauseLoop.turns, requests: await count(), ok: !pauseLoop.error, text: pauseLoop.message?.content[0]?.type === 'text' ? pauseLoop.message.content[0].text : null, roles: pauseLoop.messages.map(m => m.role) })

  await ctl.arm({ chop: true })
  const chopped = assemble(await collect(streamMessage(link, ask('Paris', { tools: [weather] }))))
  t('stream.frameCutAcrossReadsAssembles', { text: chopped.text, input: chopped.toolUse[0]?.input, stop: chopped.stopReason })

  const truncated = assemble([
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_cut', name: 'get_weather', input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"location":"Par' } },
    { type: 'message_delta', delta: { stop_reason: 'max_tokens', stop_sequence: null }, usage: { output_tokens: 5 } },
  ])
  t('stream.truncatedToolInputIsKeptNotThrown', { stop: truncated.stopReason, input: truncated.toolUse[0]?.input, raw: truncated.invalidInput })

  // ── the door ───────────────────────────────────────────────────────────
  const door = anthropicDoor({ send })
  const sent = async () => (await seen()).requests
  const bodyOf = async (i = 0) => JSON.parse((await sent())[i].body)
  const view = async (r: Reply, question: Question, extra: Record<string, unknown> = {}) =>
    ({ ok: r.ok, reason: r.ok ? null : r.failure.reason, retryable: r.ok ? null : r.failure.retryable, problems: checkReply(r, question), sends: await count(), ...extra })

  const person = { type: 'object', properties: { name: { type: 'string', minLength: 1 }, age: { type: 'integer', minimum: 0 }, address: { type: 'object', properties: { city: { type: 'string', maxLength: 5 } } } }, required: ['name'] }
  await ctl.reset()
  const q1: Question = { prompt: 'who', schema: person }
  const r1 = await door(q1)
  t('door.schemaAnswer', await view(r1, q1, { answer: r1.ok ? r1.answer : null, door: r1.door, model: r1.model, costPriced: r1.ok && r1.costUsd === ((r1.usage?.inputTokens ?? 0) * 2 + (r1.usage?.outputTokens ?? 0) * 10) / 1e6, usageCounted: r1.ok && (r1.usage?.inputTokens ?? 0) > 0 && (r1.usage?.outputTokens ?? 0) > 0 }))
  const wire = await bodyOf()
  const schemaOnWire = wire.output_config?.format
  t('door.schemaNormalizedOnTheWire', { type: schemaOnWire?.type, topClosed: schemaOnWire?.schema?.additionalProperties, nestedClosed: schemaOnWire?.schema?.properties?.address?.additionalProperties,
    minLengthGone: !('minLength' in schemaOnWire.schema.properties.name), minimumGone: !('minimum' in schemaOnWire.schema.properties.age), maxLengthGone: !('maxLength' in schemaOnWire.schema.properties.address.properties.city),
    callerSchemaUntouched: !('additionalProperties' in person) && 'minLength' in person.properties.name, effort: 'effort' in (wire.output_config ?? {}) })

  await ctl.reset()
  const q2: Question = { prompt: 'hello', system: 'Be terse.' }
  const r2 = await door(q2)
  const w2 = await bodyOf()
  t('door.textAnswerWithSystem', await view(r2, q2, { answer: r2.ok ? r2.answer : null, system: w2.system, messages: w2.messages, maxTokens: w2.max_tokens, model: w2.model, outputConfig: 'output_config' in w2 }))

  await ctl.reset()
  const tuned = anthropicDoor({ send, model: 'claude-opus-4-1', maxTokens: 500, effort: 'low' })
  const q3: Question = { prompt: 'hello' }
  const r3 = await tuned(q3, { model: 'claude-haiku-4-5' })
  const w3 = await bodyOf()
  t('door.optionsAndModelOverride', await view(r3, q3, { model: r3.model, wireModel: w3.model, maxTokens: w3.max_tokens, outputConfig: w3.output_config }))

  // A zero would read as free; a model the table does not name is unpriced.
  await ctl.reset()
  const r3u = await tuned(q3, { model: 'claude-unlisted-9' })
  t('door.unpricedModelCostsNull', await view(r3u, q3, { costUsd: r3u.ok ? r3u.costUsd : 'failed' }))

  await ctl.reset(); await ctl.arm({ rateLimit: { retryAfter: 1 } })
  const q4: Question = { prompt: 'again' }
  const m0 = Date.now()
  const r4 = await door(q4)
  t('door.rateLimitedThenAnswered', await view(r4, q4, { waited: Date.now() - m0 >= 1000, answer: r4.ok ? r4.answer : null }))

  await ctl.reset(); await ctl.arm({ rateLimit: { retryAfter: 1, times: 2 } })
  const r5 = await door(q4)
  t('door.rateLimitedTwice', await view(r5, q4, { message: r5.ok ? null : r5.failure.message.length > 0 }))

  await ctl.reset(); await ctl.arm({ overloaded: true })
  const m1 = Date.now()
  const r6 = await door(q4)
  t('door.overloadedThenAnswered', await view(r6, q4, { waitedTheDefault: Date.now() - m1 >= 1000 }))

  await ctl.reset(); await ctl.arm({ rateLimit: { retryAfter: 31 } })
  const m2 = Date.now()
  const r7 = await door(q4)
  t('door.retryAfterOverTheCapIsNotWaited', await view(r7, q4, { quick: Date.now() - m2 < 1000 }))

  await ctl.reset(); await ctl.arm({ failNext: true })
  t('door.serverErrorIsNotResent', await view(await door(q4), q4))

  await ctl.reset()
  t('door.badKeyIsSignedOut', await view(await anthropicDoor({ send: bindSend(conduit, 'provider:anthropic:wrong') })(q4), q4))
  await ctl.reset()
  t('door.forbiddenKeyIsForbidden', await view(await anthropicDoor({ send: bindSend(conduit, 'provider:anthropic:forbidden') })(q4), q4))
  await ctl.reset()
  const r10 = await anthropicDoor({ send: bindSend(conduit, 'provider:anthropic:nokey') })(q4)
  t('door.noKeyIsNotSetUp', await view(r10, q4, { namesTheKey: !r10.ok && r10.failure.message.includes('ANTHROPIC_API_KEY') }))

  await ctl.reset()
  const r11 = await door(q4, { model: 'retired-claude-2' })
  t('door.retiredModelIsModelGone', await view(r11, q4, { model: r11.model }))

  await ctl.reset(); await ctl.arm({ reply: 'refusal' })
  const r12 = await door(q4)
  t('door.safeguardDeclineIsRefused', await view(r12, q4, { message: r12.ok ? null : r12.failure.message }))

  await ctl.reset(); await ctl.arm({ reply: 'max_tokens' })
  const q13: Question = { prompt: 'who', schema: person }
  const r13 = await door(q13)
  t('door.maxTokensIsCutOff', await view(r13, q13, { detail: r13.ok ? null : r13.failure.detail }))

  await ctl.reset(); await ctl.arm({ reply: 'prose' })
  t('door.proseWithASchemaIsNoAnswer', await view(await door(q13), q13))

  await ctl.reset(); await ctl.arm({ rateLimit: { retryAfter: 5 } })
  const ac = new AbortController(); setTimeout(() => ac.abort(), 150)
  const m3 = Date.now()
  t('door.abortWhileWaitingIsAborted', await view(await door(q4, { signal: ac.signal }), q4, { quick: Date.now() - m3 < 1000 }))

  await ctl.reset()
  const already = new AbortController(); already.abort()
  t('door.alreadyAbortedSendsNothing', await view(await door(q4, { signal: already.signal }), q4))

  const thrower = anthropicDoor({ send: (() => { throw new Error('send blew up') }) as never })
  t('door.aThrowIsLost', await view(await thrower(q4), q4, { sends: 0 }))

  const input = { type: 'object', properties: { minimum: { type: 'integer', minimum: 1 }, list: { type: 'array', minItems: 2, items: { type: 'object', properties: { a: { type: 'string', maxLength: 3 } } } }, one: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'string' } }, pick: { anyOf: [{ type: 'object', properties: {} }, { type: 'string', minLength: 2 }] } }, $defs: { d: { type: 'object', properties: { n: { type: 'number', multipleOf: 2 } } } } }
  const frozen = JSON.stringify(input)
  const n = normalizeSchema(input) as any
  t('door.normalizeSchema', { input: JSON.stringify(input) === frozen, propertyNamedMinimumKept: 'minimum' in n.properties && !('minimum' in n.properties.minimum), minItems2Gone: !('minItems' in n.properties.list), minItems1Kept: n.properties.one.minItems, maxItemsGone: !('maxItems' in n.properties.one),
    itemsClosed: n.properties.list.items.additionalProperties, itemsBoundGone: !('maxLength' in n.properties.list.items.properties.a), anyOfClosed: n.properties.pick.anyOf[0].additionalProperties, anyOfBoundGone: !('minLength' in n.properties.pick.anyOf[1]), defsClosed: n.$defs.d.additionalProperties, defsBoundGone: !('multipleOf' in n.$defs.d.properties.n) })
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
  'host.betasReachEveryCallAsAHeader':     { ok: [true, true, true], paths: ['/v1/messages', '/v1/messages', '/v1/messages/count_tokens'], header: ['server-side-fallback-2026-07-01', 'server-side-fallback-2026-07-01', 'server-side-fallback-2026-07-01'], betasInBody: false, fallbacks: ['default', 'default', null] },
  'host.fallbacksWithoutTheBetaIsRefused': { kind: 'refused', status: 400, namesIt: true },
  'host.fallbackAnswersADeclineOnAnotherModel': { without: 'refusal', with: 'end_turn', model: 'claude-opus-5-5' },
  'host.thinkingStreamsWithItsSignature':  { types: ['thinking', 'text', 'tool_use'], thinking: 'The person asked about Paris; get_weather answers that.', signed: true, input: { location: 'Paris' } },
  'host.thinkingSentBackUnchanged':        { accepted: 'The weather is sunny.', edited: 'refused', status: 400, namesIt: true, loopTurns: 2, loopOk: true },
  'host.pauseTurnStreamsServerToolInput':  { stop: 'pause_turn', types: ['server_tool_use', 'web_search_tool_result'], query: 'plumbers in Boise', resultKept: true },
  'host.pauseTurnResumedUnchanged':        { resumed: 'Searched.', stop: 'end_turn', altered: 'refused' },
  'toolLoop.resumesPauseTurn':             { turns: 2, requests: 2, ok: true, text: 'Searched.', roles: ['user', 'assistant', 'assistant'] },
  'stream.frameCutAcrossReadsAssembles':   { text: 'Let me check.', input: { location: 'Paris' }, stop: 'tool_use' },
  'stream.truncatedToolInputIsKeptNotThrown': { stop: 'max_tokens', input: {}, raw: { toolu_cut: '{"location":"Par' } },
  'door.schemaAnswer':                     { ok: true, reason: null, retryable: null, problems: [], sends: 1, answer: { name: 'x', age: 1, address: { city: 'x' } }, door: 'anthropic', model: 'claude-sonnet-5-5', costPriced: true, usageCounted: true },
  'door.schemaNormalizedOnTheWire':        { type: 'json_schema', topClosed: false, nestedClosed: false, minLengthGone: true, minimumGone: true, maxLengthGone: true, callerSchemaUntouched: true, effort: false },
  'door.textAnswerWithSystem':             { ok: true, reason: null, retryable: null, problems: [], sends: 1, answer: 'You said: hello', system: 'Be terse.', messages: [{ role: 'user', content: 'hello' }], maxTokens: 16000, model: 'claude-sonnet-5-5', outputConfig: false },
  'door.optionsAndModelOverride':          { ok: true, reason: null, retryable: null, problems: [], sends: 1, model: 'claude-haiku-4-5', wireModel: 'claude-haiku-4-5', maxTokens: 500, outputConfig: { effort: 'low' } },
  'door.unpricedModelCostsNull':           { ok: true, reason: null, retryable: null, problems: [], sends: 1, costUsd: null },
  'door.rateLimitedThenAnswered':          { ok: true, reason: null, retryable: null, problems: [], sends: 2, waited: true, answer: 'You said: again' },
  'door.rateLimitedTwice':                 { ok: false, reason: 'rate_limited', retryable: true, problems: [], sends: 2, message: true },
  'door.overloadedThenAnswered':           { ok: true, reason: null, retryable: null, problems: [], sends: 2, waitedTheDefault: true },
  'door.retryAfterOverTheCapIsNotWaited':  { ok: false, reason: 'rate_limited', retryable: true, problems: [], sends: 1, quick: true },
  'door.serverErrorIsNotResent':           { ok: false, reason: 'model_error', retryable: true, problems: [], sends: 1 },
  'door.badKeyIsSignedOut':                { ok: false, reason: 'signed_out', retryable: false, problems: [], sends: 1 },
  'door.forbiddenKeyIsForbidden':          { ok: false, reason: 'forbidden', retryable: false, problems: [], sends: 1 },
  'door.noKeyIsNotSetUp':                  { ok: false, reason: 'not_set_up', retryable: false, problems: [], sends: 0, namesTheKey: true },
  'door.retiredModelIsModelGone':          { ok: false, reason: 'model_gone', retryable: false, problems: [], sends: 1, model: 'retired-claude-2' },
  'door.safeguardDeclineIsRefused':        { ok: false, reason: 'refused', retryable: false, problems: [], sends: 1, message: 'declined by safeguards' },
  'door.maxTokensIsCutOff':                { ok: false, reason: 'cut_off', retryable: false, problems: [], sends: 1, detail: '{"name":' },
  'door.proseWithASchemaIsNoAnswer':       { ok: false, reason: 'no_answer', retryable: true, problems: [], sends: 1 },
  'door.abortWhileWaitingIsAborted':       { ok: false, reason: 'aborted', retryable: false, problems: [], sends: 1, quick: true },
  'door.alreadyAbortedSendsNothing':       { ok: false, reason: 'aborted', retryable: false, problems: [], sends: 0 },
  'door.aThrowIsLost':                     { ok: false, reason: 'lost', retryable: true, problems: [], sends: 0 },
  'door.normalizeSchema':                  { input: true, propertyNamedMinimumKept: true, minItems2Gone: true, minItems1Kept: 1, maxItemsGone: true, itemsClosed: false, itemsBoundGone: true, anyOfClosed: false, anyOfBoundGone: true, defsClosed: false, defsBoundGone: true },
}))
