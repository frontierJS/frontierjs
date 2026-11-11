// test/airtable.drive.ts — the connector against the sink, and 0.2's fixtures.
// What only this drive asks: every read and write keys fields by id, in the
// BODY; `PUT` is never on the wire; a batch of 11 is refused before the send
// (and the sink's own refusal of a raw 11 is the negative control); a 403 is
// `forbidden` for a missing record, table and base alike, so no good token is
// forgotten over it; a lost create is found by what it wrote and a lost update
// or upsert is simply resent; `formula` is the one builder, and a value that
// closes the literal matches every row once the escape is taken away.
// Phase 3: a computed field and a non-ISO date never reach the wire, a select
// writes by name or id and reads as its name, a currency is minor units only
// where the caller named a code, and a renamed field still reads.

import { readdirSync, readFileSync } from 'node:fs'
import { createConduit, type ConduitError } from '@frontierjs/conduit'
import type { CredentialResolver } from '@frontierjs/conduit'
import { results, report, control, DRIVE_RESILIENCE } from '@frontierjs/conduit/testing'
import { startAirtableSink, BASE_ID, T } from '../sink.ts'
import {
  airtableTarget, bindSend, translate, listBases, baseSchema, listRecords, getRecord, createRecords, updateRecords, upsertRecords, deleteRecords, findCreated,
  eq, and, or, not, createdSince, fieldId, MAX_BATCH, type Table, type Send,
} from '../src/index.ts'

const { got, t } = results()
const sink = startAirtableSink(), ctl = control(sink.url)
const credentials: CredentialResolver = { async get(ref) { return ref === 'AIRTABLE_PAT' ? sink.token : ref === 'AIRTABLE_BAD' ? 'pat_wrong' : null } }
const conduit = createConduit({ credentials, ...DRIVE_RESILIENCE })
const target = airtableTarget({ ref: 'AIRTABLE_PAT', address: sink.url })
await conduit.register(target)
await conduit.register({ ...target, id: 'provider:airtable:bad', auth: { type: 'bearer', ref: 'AIRTABLE_BAD' } })
const send = bindSend(conduit)
const badSend = bindSend(conduit, 'provider:airtable:bad')

type Seen = { method: string; path: string; authorization: string; body: any; status: number }
const requests = () => ctl.seen<Seen>()
const methods = new Set<string>()
/** Notes what the last scenario sent, then clears the sink: the drive proves `PUT` never left across all of them. */
const fresh = async () => {
  for (const r of await requests()) methods.add(r.method)
  await ctl.reset()
}
const throws = (fn: () => unknown) => { try { fn(); return null } catch (e) { return (e as Error).constructor.name } }
const rejects = (p: Promise<unknown>) => p.then(() => null, e => (e as Error).constructor.name)
const raw = (s: Send, method: string, path: string, body?: unknown, query?: Record<string, string>) => s<any>({ method, path, ...(body ? { body } : {}), ...(query ? { query } : {}), replayable: method === 'GET' })

const PROJECT_NAME = 'fldGLjkP7ISABFTIW', STATUS = 'fldhktP7HMBZBpjDB', BUDGET = 'fldDj8JqduKljGaeY', START = 'fldsAlR13YynmWoGx', TOTAL = 'fldXpSjobWZEa5pNo'
const CLIENT_NAME = 'fldD43y3R1OTAMPAj', CONTACT = 'fldWMIGS13rkm3Flb', NOTES = 'fldQtJDdYXTGSn9IU'
const base = { baseId: BASE_ID }
const clients = { ...base, table: T.clients }, projects = { ...base, table: T.projects }

const schema = async (): Promise<Record<string, Table>> => {
  const { tables } = await baseSchema(send, BASE_ID)
  return Object.fromEntries(tables!.map(x => [x.name, x]))
}
const names = async (o: Parameters<typeof listRecords>[1]) => ((await listRecords(send, o)).records ?? []).map(r => r.fields[o.table === T.clients ? CLIENT_NAME : PROJECT_NAME])

try {
  // ─── The target ──────────────────────────────────────────────────────
  const real = airtableTarget({ ref: 'AIRTABLE_PAT' })
  t('target.shape', { id: real.id, address: real.address, auth: real.auth, protocol: real.protocol })
  t('target.refusesNoRef', throws(() => airtableTarget({ ref: ' ' })))

  // ─── 3.1 schema ──────────────────────────────────────────────────────
  const bases = await listBases(send)
  t('schema.listBases', { bases: bases.bases, fixture: JSON.stringify(bases.bases) === JSON.stringify(JSON.parse(readFileSync(new URL('./fixture/list-bases.json', import.meta.url), 'utf8')).bases) })
  const S = await schema()
  t('schema.tablesKeyedById', {
    tables: Object.keys(S), primary: S.Projects.primaryFieldId, budget: S.Projects.fields[BUDGET],
    types: Object.values(S.Projects.fields).map(f => f.type),
  })
  t('schema.missingBaseIsForbidden', await baseSchema(send, 'appXXXXXXXXXXXXXX').then(r => [r.error?.kind, r.error?.code]))

  // ─── 2.3 reads ───────────────────────────────────────────────────────
  await fresh()
  const P = S.Projects
  const all = await listRecords(send, { ...projects, schema: P })
  t('read.keyedByIdAndEveryFieldFilled', all.records?.[1])
  const sent = await listRecords(send, projects)
  t('read.noSchemaIsWhatAirtableSent', Object.keys(sent.records![1].fields))
  const wire = (await requests())[0]
  t('read.listIsAPostWithIdsInTheBody', { method: wire.method, path: wire.path, returnFieldsByFieldId: wire.body.returnFieldsByFieldId, bearer: wire.authorization })
  t('read.fieldsNarrow', (await listRecords(send, { ...projects, schema: P, fields: [PROJECT_NAME, START] })).records?.map(r => Object.keys(r.fields)))
  await fresh()
  const one = await getRecord(send, { ...projects, id: 'rec4RrneJSWMfHXyu', schema: P })
  const getWire = (await requests())[0]
  t('read.getIsTheOneGet', { method: getWire.method, path: getWire.path, name: one.record?.fields[PROJECT_NAME], total: one.record?.fields[TOTAL] })
  const fx = (n: string) => JSON.parse(readFileSync(new URL(`./fixture/${n}.json`, import.meta.url), 'utf8'))
  t('read.sinkAnswersThe0_2Fixture', { project: Bun.deepEquals((await getRecord(send, { ...projects, id: 'rec4RrneJSWMfHXyu' })).record, fx('get-project')) })
  await fresh()
  await fetch(`${sink.url}/_sink/seed`, { method: 'POST', body: JSON.stringify({ table: T.clients, count: 250 }) })
  const many = await listRecords(send, { ...clients, schema: S.Clients })
  t('read.pagesByOffsetTo100', { rows: many.records?.length, posts: (await requests()).length })
  await fresh()
  await ctl.arm({ offsetDies: 1 })
  const restarted = await listRecords(send, { ...projects, pageSize: 1 })
  t('read.aDeadOffsetRestartsTheWalkOnce', { ids: restarted.records?.map(r => r.id), posts: (await requests()).length })
  await fresh()
  await ctl.arm({ offsetDies: 2 })
  const died = await listRecords(send, { ...projects, pageSize: 1 })
  t('read.aSecondDeathIsTheCallers', { records: died.records ?? null, kind: died.error?.kind, code: died.error?.code, posts: (await requests()).length })

  // ─── 2.2 errors ──────────────────────────────────────────────────────
  await fresh()
  const missing = await getRecord(send, { ...projects, id: 'rec00000000000000' })
  const noTable = await getRecord(send, { ...base, table: 'tblXXXXXXXXXXXXXX', id: 'rec00000000000000' })
  const noBase = await getRecord(send, { baseId: 'appXXXXXXXXXXXXXX', table: T.projects, id: 'rec00000000000000' })
  t('error.403IsForbiddenForRecordTableAndBaseAlike', [missing.error, noTable.error, noBase.error].map(e => [e?.kind, e?.code, e?.retryable]))
  t('error.403KeepsTheCredential', { bearerStillGood: (await getRecord(send, { ...projects, id: 'rec4RrneJSWMfHXyu' })).record?.id })
  const bad = await getRecord(badSend, { ...projects, id: 'rec4RrneJSWMfHXyu' })
  t('error.401IsAuthFailed', [bad.error?.kind, bad.error?.code, bad.error?.retryable])
  const asConduit = (raw: unknown): ConduitError => ({ kind: 'client_error', target: 'x', protocol: 'http', message: 'm', retryable: false, raw })
  t('error.404IsGone', translate(asConduit({ error: { type: 'NOT_FOUND' } }), 404).kind)
  t('error.bothBodyShapes', [
    translate(asConduit({ error: { type: 'UNKNOWN_FIELD_NAME', message: 'Unknown field name: "x"' } }), 422),
    translate(asConduit({ error: 'NOT_FOUND' }), 422).code,
    translate(asConduit({ errors: [{ error: 'RATE_LIMIT_REACHED', message: 'slow down' }] }), 429).code,
  ])
  const computed = await updateRecords(send, { ...projects, records: [{ id: 'rec4RrneJSWMfHXyu', fields: { [TOTAL]: 9 } }] })
  t('error.422IsInvalidRequestWithAirtablesType', [computed.error?.kind, computed.error?.code, computed.error?.retryable])
  await fresh()
  await ctl.arm({ failNext: true })
  const five = await createRecords(send, { ...clients, records: [{ fields: { [CLIENT_NAME]: 'Five' } }] })
  t('error.5xxIsServerErrorAndTheCreateIsNotResent', { kind: five.error?.kind, posts: (await requests()).length, indeterminate: five.error?.indeterminate ?? false })
  await fresh()
  await ctl.arm({ rateLimit: true })
  const slow = await createRecords(send, { ...clients, records: [{ fields: { [CLIENT_NAME]: 'Slow' } }] })
  t('error.429SuppliesThe30sWait', { kind: slow.error?.kind, retryable: slow.error?.retryable, retryAfterMs: slow.error?.retryAfterMs, posts: (await requests()).length })

  // ─── 2.5 writes ──────────────────────────────────────────────────────
  await fresh()
  const made = await createRecords(send, { ...clients, schema: S.Clients, records: [{ fields: { [CLIENT_NAME]: 'Made', [CONTACT]: 'Pat' } }] })
  const madeWire = (await requests())[0]
  t('create.wire', { method: madeWire.method, body: madeWire.body, answer: made.records?.map(r => r.fields) })
  t('create.refusesElevenBeforeTheSend', { cap: MAX_BATCH, refused: await rejects(createRecords(send, { ...clients, records: Array.from({ length: 11 }, (_, i) => ({ fields: { [CLIENT_NAME]: `n${i}` } })) })), requests: (await requests()).length - 1 })
  const elevenRaw = await raw(send, 'POST', `/v0/${BASE_ID}/${T.clients}`, { records: Array.from({ length: 11 }, () => ({ fields: {} })) })
  t('create.sinkRefusesARawEleven', [elevenRaw.error && translate(elevenRaw.error, elevenRaw.meta.status).kind, elevenRaw.error && translate(elevenRaw.error, elevenRaw.meta.status).code])
  t('create.keysByIdOnly', { name: await rejects(createRecords(send, { ...clients, records: [{ fields: { 'Client Name': 'x' } }] })), undef: await rejects(createRecords(send, { ...clients, records: [{ fields: { [CLIENT_NAME]: undefined } }] })), requests: (await requests()).length - 2 })
  const ten = await createRecords(send, { ...clients, records: Array.from({ length: 10 }, (_, i) => ({ fields: { [CLIENT_NAME]: `Ten ${i}` } })) })
  t('create.tenIsTheCap', ten.records?.length)

  await fresh()
  const target1 = (await listRecords(send, { ...clients, schema: S.Clients, formula: eq(CLIENT_NAME, 'Scratch 2') })).records![0]
  await updateRecords(send, { ...clients, schema: S.Clients, records: [{ id: target1.id, fields: { [NOTES]: 'two\nlines', [CONTACT]: 'Pat' } }] })
  const patched = await getRecord(send, { ...clients, id: target1.id, schema: S.Clients })
  await updateRecords(send, { ...clients, records: [{ id: target1.id, fields: { [NOTES]: null } }] })
  const cleared = await getRecord(send, { ...clients, id: target1.id, schema: S.Clients })
  t('update.patchSetsAndNullClears', { set: [patched.record?.fields[NOTES], patched.record?.fields[CONTACT], patched.record?.fields[CLIENT_NAME]], cleared: [cleared.record?.fields[NOTES], cleared.record?.fields[CONTACT]] })
  await fresh()
  await ctl.arm({ lost: true })
  const resent = await updateRecords(send, { ...clients, records: [{ id: target1.id, fields: { [CONTACT]: 'Resent' } }] })
  t('update.aLostAnswerIsResent', { ok: resent.records?.[0].id === target1.id, patches: (await requests()).filter(r => r.method === 'PATCH').length })
  await fresh()
  t('update.refusesMissingId', await rejects(updateRecords(send, { ...clients, records: [{ id: 'Scratch 2', fields: {} }] })))
  const noRec = await updateRecords(send, { ...clients, records: [{ id: 'rec00000000000000', fields: { [CONTACT]: 'x' } }] })
  t('update.aMissingRecordIsForbidden', noRec.error?.kind)

  await fresh()
  const up1 = await upsertRecords(send, { ...clients, mergeOn: [CLIENT_NAME], records: [{ fields: { [CLIENT_NAME]: 'Upsert A', [CONTACT]: 'first' } }] })
  const up2 = await upsertRecords(send, { ...clients, mergeOn: [CLIENT_NAME], records: [{ fields: { [CLIENT_NAME]: 'Upsert A', [CONTACT]: 'second' } }] })
  const upWire = (await requests())[0]
  t('upsert.createsThenUpdates', { created: [up1.createdIds?.length, up2.createdIds?.length], updated: [up1.updatedIds?.length, up2.updatedIds?.length], same: up1.records?.[0].id === up2.records?.[0].id, contact: up2.records?.[0].fields[CONTACT], wire: { method: upWire.method, performUpsert: upWire.body.performUpsert } })
  await ctl.arm({ lost: true })
  await upsertRecords(send, { ...clients, mergeOn: [CLIENT_NAME], records: [{ fields: { [CLIENT_NAME]: 'Upsert B' } }] })
  t('upsert.aLostAnswerIsResentAndOneRowResults', { rows: (await names(clients)).filter(n => n === 'Upsert B').length })
  await createRecords(send, { ...clients, records: [{ fields: { [CLIENT_NAME]: 'Dup' } }, { fields: { [CLIENT_NAME]: 'Dup' } }] })
  const before = (await names(clients)).length
  const two = await upsertRecords(send, { ...clients, mergeOn: [CLIENT_NAME], records: [{ fields: { [CLIENT_NAME]: 'Dup', [CONTACT]: 'x' } }] })
  t('upsert.twoMatchesIsAmbiguousAndWritesNothing', { kind: two.error?.kind, code: two.error?.code, retryable: two.error?.retryable, rows: (await names(clients)).length - before, contacts: (await listRecords(send, { ...clients, formula: eq(CLIENT_NAME, 'Dup') })).records?.map(r => r.fields[CONTACT] ?? null) })
  t('upsert.refusesBadMergeBeforeTheSend', { none: await rejects(upsertRecords(send, { ...clients, mergeOn: [], records: [{ fields: {} }] })), four: await rejects(upsertRecords(send, { ...clients, mergeOn: [CLIENT_NAME, CONTACT, NOTES, 'fldBhAu0fSsuKp6PB'], records: [{ fields: {} }] })), absent: await rejects(upsertRecords(send, { ...clients, mergeOn: [CLIENT_NAME], records: [{ fields: { [CONTACT]: 'x' } }] })) })

  await fresh()
  const victims = (await listRecords(send, { ...clients, formula: or(eq(CLIENT_NAME, 'Scratch 3'), eq(CLIENT_NAME, 'Scratch 4')) })).records!.map(r => r.id)
  const del = await deleteRecords(send, { ...clients, ids: victims })
  const delWire = (await requests()).find(r => r.method === 'DELETE')!
  t('delete.deletesAndSendsTheIdsAsRecords[]', { deleted: del.deleted?.map(d => d.deleted), left: (await names({ ...clients, formula: or(eq(CLIENT_NAME, 'Scratch 3'), eq(CLIENT_NAME, 'Scratch 4')) })).length, method: delWire.method, path: delWire.path.includes('records%5B%5D=') })
  await fresh()
  const doomed = (await createRecords(send, { ...clients, records: [{ fields: { [CLIENT_NAME]: 'Doomed' } }] })).records![0].id
  await ctl.arm({ lost: true })
  const replayDelete = await deleteRecords(send, { ...clients, ids: [doomed] })
  t('delete.aReplayOfADeleteIsNotCalledGone', { kind: replayDelete.error?.kind, deletes: (await requests()).filter(r => r.method === 'DELETE').length, stillThere: (await names(clients)).includes('Doomed') })
  t('delete.capIsTenToo', await rejects(deleteRecords(send, { ...clients, ids: Array.from({ length: 11 }, () => 'rec00000000000000') })))

  // ─── 2.6 C4 and C6 ───────────────────────────────────────────────────
  await fresh()
  const partials: unknown[] = []
  for (const word of ['partialSuccess', 'cellsRedactedDueToLimitedPermissions']) {
    await ctl.arm({ partial: word })
    const r = await createRecords(send, { ...clients, records: [{ fields: { [CLIENT_NAME]: `P ${word}` } }] })
    partials.push([r.error?.kind, r.error?.code])
  }
  t('validate.aTwoHundredThatIsAPartialIsRefused', partials)
  await fresh()
  await ctl.arm({ lost: true })
  const lostWrite = await createRecords(send, { ...clients, records: [{ fields: { [CLIENT_NAME]: 'Lost A', [CONTACT]: 'x' } }, { fields: { [CLIENT_NAME]: 'Lost B' } }] })
  const lostRead = await findCreated(send, lostWrite.attempt)
  t('lost.aCreateIsIndeterminateAndSentOnce', { kind: lostWrite.error?.kind, indeterminate: lostWrite.error?.indeterminate, posts: (await requests()).filter(r => r.method === 'POST' && !r.path.endsWith('listRecords') && r.body.records.length === 2).length })
  t('lost.findCreatedFindsWhatItWrote', { names: lostRead.found?.map(r => r?.fields[CLIENT_NAME]) })
  const notSent = await findCreated(send, { ...lostWrite.attempt, records: [{ [CLIENT_NAME]: 'Never sent' }, { [CLIENT_NAME]: 'Lost B', [CONTACT]: 'other' }] })
  t('lost.nothingNeverSentOrDifferentIsFound', notSent.found)
  await fresh()
  const identical = await createRecords(send, { ...clients, records: [{ fields: { [CLIENT_NAME]: 'Same' } }] })
  const twice = await findCreated(send, { ...identical.attempt, records: [{ [CLIENT_NAME]: 'Same' }, { [CLIENT_NAME]: 'Same' }] })
  t('lost.oneRowAnswersOneRecord', twice.found?.map(r => r?.fields[CLIENT_NAME] ?? null))
  const reading = (await requests()).find(r => r.path.endsWith('listRecords'))
  t('lost.readsByCreatedTime', /IS_AFTER\(CREATED_TIME\(\), '\d{4}-/.test(reading?.body.filterByFormula))

  // ─── 2.4 formula ─────────────────────────────────────────────────────
  await fresh()
  t('formula.quotesAndEscapes', [eq(CLIENT_NAME, "it's a \\ test").text, eq(CLIENT_NAME, 'two\nlines').text, eq(CLIENT_NAME, 3).text, eq(CLIENT_NAME, true).text])
  t('formula.combinators', [and(eq(CLIENT_NAME, 'a'), not(eq(CONTACT, 'b'))).text, or(eq(CLIENT_NAME, 'a')).text])
  t('formula.refusesNamesAndStrings', {
    name: throws(() => eq('Client Name', 'x')), noArgs: throws(() => and()), raw: throws(() => and({ text: '1=1' } as never)), nan: throws(() => eq(CLIENT_NAME, NaN)),
    read: await rejects(listRecords(send, { ...clients, formula: "{fldD43y3R1OTAMPAj} = 'x'" as never })), requests: (await requests()).length,
  })
  t('formula.createdSinceTakesADate', { ok: createdSince('2026-11-10T00:00:00Z').text, bad: throws(() => createdSince('yesterday')) })
  // The negative control. This value closes the literal, and `!= 'y")` then makes the comparison true for every row. Escaped, the whole thing is one string matching none; with the escape removed (a hand-built formula sent past the builder), it matches all.
  const evil = `x' != 'y")`
  const total = (await listRecords(send, clients)).records!.length
  const escaped = await listRecords(send, { ...clients, formula: eq(CLIENT_NAME, evil) })
  const unescaped = await raw(send, 'POST', `/v0/${BASE_ID}/${T.clients}/listRecords`, { filterByFormula: `{${CLIENT_NAME}} = '${evil}'`, returnFieldsByFieldId: true })
  t('formula.negativeControlEveryRowOnceTheEscapeIsGone', { escaped: escaped.records?.length, unescapedMatchesAll: unescaped.data?.records.length === total, total: total > 5, text: eq(CLIENT_NAME, evil).text })
  t('formula.combinatorsFilter', {
    or: (await names({ ...clients, formula: or(eq(CLIENT_NAME, 'Scratch 2'), eq(CLIENT_NAME, 'Scratch 5')) })),
    and: (await names({ ...clients, formula: and(eq(CLIENT_NAME, 'Scratch 2'), eq(CLIENT_NAME, 'Scratch 5')) })),
    not: (await names({ ...clients, formula: and(not(eq(CLIENT_NAME, 'Scratch 2')), createdSince('2000-01-01')) })).length === total - 1,
  })

  // ─── 3.2 codecs ──────────────────────────────────────────────────────
  await fresh()
  t('codec.computedIsRefusedByIdBeforeTheSend', { create: await rejects(createRecords(send, { ...projects, schema: P, records: [{ fields: { [TOTAL]: 3 } }] })), update: await rejects(updateRecords(send, { ...projects, schema: P, records: [{ id: 'rec4RrneJSWMfHXyu', fields: { [TOTAL]: 3 } }] })), requests: (await requests()).length })
  const usUs = await createRecords(send, { ...projects, records: [{ fields: { [PROJECT_NAME]: 'US date', [START]: '11/10/2026' } }] })
  t('codec.dateIsIsoOrRefused', { local: await rejects(createRecords(send, { ...projects, schema: P, records: [{ fields: { [START]: '11/10/2026' } }] })), badDay: await rejects(createRecords(send, { ...projects, schema: P, records: [{ fields: { [START]: '2026-02-30' } }] })), iso: (await createRecords(send, { ...projects, schema: P, records: [{ fields: { [START]: '2026-11-10', [PROJECT_NAME]: 'Iso' } }] })).records?.[0].fields[START], rawReinterpreted: usUs.records?.[0].fields[START] })
  const choices = (P.fields[STATUS].options!.choices!)
  const byName = await createRecords(send, { ...projects, schema: P, records: [{ fields: { [PROJECT_NAME]: 'Sel name', [STATUS]: 'Design' } }, { fields: { [PROJECT_NAME]: 'Sel id', [STATUS]: choices[3].id } }] })
  t('codec.selectWritesNameOrIdAndReadsName', byName.records?.map(r => r.fields[STATUS]))
  const unknown = await createRecords(send, { ...projects, schema: P, records: [{ fields: { [STATUS]: 'Nonesuch' } }] })
  t('codec.unknownSelectIsInvalidRequestNeverTypecast', { kind: unknown.error?.kind, code: unknown.error?.code, typecasts: [...new Set((await requests()).filter(r => r.body?.records && !r.path.endsWith('listRecords')).map(r => r.body.typecast))] })
  const usd = { currencies: { [BUDGET]: 'USD' } }, jpy = { currencies: { [BUDGET]: 'JPY' } }
  const budgetOf = async (o: object) => (await getRecord(send, { ...projects, id: 'rec4RrneJSWMfHXyu', schema: P, ...o })).record?.fields[BUDGET]
  t('codec.currencyIsMinorUnitsOnlyWithACode', { none: await budgetOf({}), usd: await budgetOf(usd), jpy: await budgetOf(jpy), emptyIsNull: (await getRecord(send, { ...projects, id: 'recC2oSW4KkaziPa8', schema: P, ...usd })).record?.fields[BUDGET] })
  const wrote = await createRecords(send, { ...projects, schema: P, ...usd, records: [{ fields: { [PROJECT_NAME]: 'Priced', [BUDGET]: { amount: 150000, currency: 'USD' } } }] })
  t('codec.currencyWritesMinorUnitsNeverAMajorNumber', { wireBudget: ((await requests()).at(-1))?.body.records[0].fields[BUDGET], answer: wrote.records?.[0].fields[BUDGET], major: await rejects(createRecords(send, { ...projects, schema: P, ...usd, records: [{ fields: { [BUDGET]: 1500 } }] })), wrongCode: await rejects(createRecords(send, { ...projects, schema: P, ...usd, records: [{ fields: { [BUDGET]: { amount: 1, currency: 'EUR' } } }] })), noCodePlainNumber: (await createRecords(send, { ...projects, schema: P, records: [{ fields: { [BUDGET]: 99.5 } }] })).records?.[0].fields[BUDGET], badCode: await rejects(getRecord(send, { ...projects, id: 'rec4RrneJSWMfHXyu', schema: P, currencies: { [BUDGET]: 'ZZZ' } })) })

  // Q5: a rename changes nothing.
  await fresh()
  await fetch(`${sink.url}/_sink/rename`, { method: 'POST', body: JSON.stringify({ id: BUDGET, name: 'Cost' }) })
  const renamed = (await schema()).Projects
  const afterRename = await getRecord(send, { ...projects, id: 'rec4RrneJSWMfHXyu', schema: renamed })
  const byNameRead = await raw(send, 'GET', `/v0/${BASE_ID}/${T.projects}/rec4RrneJSWMfHXyu`)
  t('rename.aRenamedFieldStillReadsById', { sameId: fieldId(renamed, 'Cost') === BUDGET, value: afterRename.record?.fields[BUDGET], oldNameGone: throws(() => fieldId(renamed, 'Budget')), nameKeyed: Object.keys(byNameRead.data.fields).includes('Cost') })

  // ─── the wire as a whole ─────────────────────────────────────────────
  await fresh()
  t('wire.putIsNeverSent', { methods: [...methods].sort(), put: methods.has('PUT') })

  // ─── fixtures ────────────────────────────────────────────────────────
  const files = readdirSync(new URL('./fixture/', import.meta.url))
  const text = files.map(f => readFileSync(new URL(`./fixture/${f}`, import.meta.url), 'utf8')).join('\n')
  t('fixtures.scrubbed', {
    files: files.filter(f => f.endsWith('.json')).length,
    parse: files.filter(f => f.endsWith('.json')).every(f => { try { JSON.parse(readFileSync(new URL(`./fixture/${f}`, import.meta.url), 'utf8')); return true } catch { return false } }),
    strayEmails: [...new Set(text.match(/[\w.+-]+@[\w-]+\.[\w.]+/g) ?? [])].filter(e => !/^person-\d+@example\.com$/.test(e)),
    tokens: (text.match(/\bpat[A-Za-z0-9]{10,}\.[0-9a-f]{20,}/g) ?? []).length,
  })
} catch (e) {
  t('__threw', String((e as Error)?.stack ?? e))
} finally {
  sink.stop()
}

const expected: Record<string, unknown> = {
  'target.shape': {"id": "provider:airtable", "address": "https://api.airtable.com", "auth": {"type": "bearer", "ref": "AIRTABLE_PAT"}, "protocol": "http"},
  'target.refusesNoRef': "TypeError",
  'schema.listBases': {"bases": [{"id": "appM9ah85uDdYnwCC", "name": "Web Project Tracker", "permissionLevel": "create"}], "fixture": true},
  'schema.tablesKeyedById': {"tables": ["Clients", "Projects", "Milestones", "Tasks"], "primary": "fldGLjkP7ISABFTIW", "budget": {"type": "currency", "options": {"precision": 0, "symbol": "$"}, "id": "fldDj8JqduKljGaeY", "name": "Budget"}, "types": ["singleLineText", "multipleRecordLinks", "singleSelect", "singleSelect", "singleSelect", "date", "date", "currency", "multilineText", "multipleRecordLinks", "multipleRecordLinks", "count", "count"]},
  'schema.missingBaseIsForbidden': ["forbidden", "INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND"],
  'read.keyedByIdAndEveryFieldFilled': {"id": "recC2oSW4KkaziPa8", "createdTime": "2026-11-10T19:20:20.000Z", "fields": {"fldGLjkP7ISABFTIW": "Scratch P2", "fld82AOTZNbZNtR8T": [], "fldhktP7HMBZBpjDB": "Design", "fldNpbjuocunt9OYP": null, "fld2I33MOMtmJN1nv": null, "fldsAlR13YynmWoGx": null, "fldus18mC36vf63TE": null, "fldDj8JqduKljGaeY": null, "fldbfMBiDyZtkRbTy": "", "fldyjkzPDX4HlGNWf": [], "fldqYELlDiwc6t5nm": [], "fldXpSjobWZEa5pNo": 0, "fldB0NptMjdvvqt5D": 0}},
  'read.noSchemaIsWhatAirtableSent': ["fldGLjkP7ISABFTIW", "fldhktP7HMBZBpjDB", "fldXpSjobWZEa5pNo", "fldB0NptMjdvvqt5D"],
  'read.listIsAPostWithIdsInTheBody': {"method": "POST", "path": "/v0/appM9ah85uDdYnwCC/tbl7lWGJOf1ERTEOv/listRecords", "returnFieldsByFieldId": true, "bearer": "Bearer pat_dev"},
  'read.fieldsNarrow': [["fldGLjkP7ISABFTIW", "fldsAlR13YynmWoGx"], ["fldGLjkP7ISABFTIW", "fldsAlR13YynmWoGx"], ["fldGLjkP7ISABFTIW", "fldsAlR13YynmWoGx"], ["fldGLjkP7ISABFTIW", "fldsAlR13YynmWoGx"]],
  'read.getIsTheOneGet': {"method": "GET", "path": "/v0/appM9ah85uDdYnwCC/tbl7lWGJOf1ERTEOv/rec4RrneJSWMfHXyu?returnFieldsByFieldId=true", "name": "Scratch P1", "total": 1},
  'read.sinkAnswersThe0_2Fixture': {"project": true},
  'read.pagesByOffsetTo100': {"rows": 261, "posts": 3},
  'read.aDeadOffsetRestartsTheWalkOnce': {"ids": ["rec4RrneJSWMfHXyu", "recC2oSW4KkaziPa8", "recM4GxiMTV2gH8tl", "rectfgJq4PbeV85zt"], "posts": 6},
  'read.aSecondDeathIsTheCallers': {"records": null, "kind": "refused", "code": "iterator_expired", "posts": 4},
  'error.403IsForbiddenForRecordTableAndBaseAlike': [["forbidden", "INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND", false], ["forbidden", "INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND", false], ["forbidden", "INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND", false]],
  'error.403KeepsTheCredential': {"bearerStillGood": "rec4RrneJSWMfHXyu"},
  'error.401IsAuthFailed': ["auth_failed", "AUTHENTICATION_REQUIRED", false],
  'error.404IsGone': "gone",
  'error.bothBodyShapes': [{"kind": "invalid_request", "message": "Unknown field name: \"x\"", "retryable": false, "code": "UNKNOWN_FIELD_NAME"}, "NOT_FOUND", "RATE_LIMIT_REACHED"],
  'error.422IsInvalidRequestWithAirtablesType': ["invalid_request", "INVALID_VALUE_FOR_COLUMN", false],
  'error.5xxIsServerErrorAndTheCreateIsNotResent': {"kind": "server_error", "posts": 1, "indeterminate": true},
  'error.429SuppliesThe30sWait': {"kind": "rate_limited", "retryable": true, "retryAfterMs": 30000, "posts": 1},
  'create.wire': {"method": "POST", "body": {"records": [{"fields": {"fldD43y3R1OTAMPAj": "Made", "fldWMIGS13rkm3Flb": "Pat"}}], "typecast": false, "returnFieldsByFieldId": true}, "answer": [{"fldD43y3R1OTAMPAj": "Made", "fldWMIGS13rkm3Flb": "Pat"}]},
  'create.refusesElevenBeforeTheSend': {"cap": 10, "refused": "TypeError", "requests": 0},
  'create.sinkRefusesARawEleven': ["invalid_request", "INVALID_RECORDS"],
  'create.keysByIdOnly': {"name": "TypeError", "undef": "TypeError", "requests": 0},
  'create.tenIsTheCap': 10,
  'update.patchSetsAndNullClears': {"set": ["two\nlines", "Pat", "Scratch 2"], "cleared": ["", "Pat"]},
  'update.aLostAnswerIsResent': {"ok": true, "patches": 2},
  'update.refusesMissingId': "TypeError",
  'update.aMissingRecordIsForbidden': "forbidden",
  'upsert.createsThenUpdates': {"created": [1, 0], "updated": [0, 1], "same": true, "contact": "second", "wire": {"method": "PATCH", "performUpsert": {"fieldsToMergeOn": ["fldD43y3R1OTAMPAj"]}}},
  'upsert.aLostAnswerIsResentAndOneRowResults': {"rows": 1},
  'upsert.twoMatchesIsAmbiguousAndWritesNothing': {"kind": "conflict", "code": "ambiguous_match", "retryable": false, "rows": 0, "contacts": [null, null]},
  'upsert.refusesBadMergeBeforeTheSend': {"none": "TypeError", "four": "TypeError", "absent": "TypeError"},
  'delete.deletesAndSendsTheIdsAsRecords[]': {"deleted": [true, true], "left": 0, "method": "DELETE", "path": true},
  'delete.aReplayOfADeleteIsNotCalledGone': {"kind": "forbidden", "deletes": 2, "stillThere": false},
  'delete.capIsTenToo': "TypeError",
  'validate.aTwoHundredThatIsAPartialIsRefused': [["invalid_response", "partialSuccess"], ["invalid_response", "cellsRedactedDueToLimitedPermissions"]],
  'lost.aCreateIsIndeterminateAndSentOnce': {"kind": "timeout", "indeterminate": true, "posts": 1},
  'lost.findCreatedFindsWhatItWrote': {"names": ["Lost A", "Lost B"]},
  'lost.nothingNeverSentOrDifferentIsFound': [null, null],
  'lost.oneRowAnswersOneRecord': ["Same", null],
  'lost.readsByCreatedTime': true,
  'formula.quotesAndEscapes': ["{fldD43y3R1OTAMPAj} = 'it\\'s a \\\\ test'", "{fldD43y3R1OTAMPAj} = 'two\\nlines'", "{fldD43y3R1OTAMPAj} = 3", "{fldD43y3R1OTAMPAj} = TRUE()"],
  'formula.combinators': ["AND({fldD43y3R1OTAMPAj} = 'a', NOT({fldWMIGS13rkm3Flb} = 'b'))", "OR({fldD43y3R1OTAMPAj} = 'a')"],
  'formula.refusesNamesAndStrings': {"name": "TypeError", "noArgs": "TypeError", "raw": "TypeError", "nan": "TypeError", "read": "TypeError", "requests": 0},
  'formula.createdSinceTakesADate': {"ok": "IS_AFTER(CREATED_TIME(), '2026-11-10T00:00:00.000Z')", "bad": "TypeError"},
  'formula.negativeControlEveryRowOnceTheEscapeIsGone': {"escaped": 0, "unescapedMatchesAll": true, "total": true, "text": "{fldD43y3R1OTAMPAj} = 'x\\' != \\'y\")'"},
  'formula.combinatorsFilter': {"or": ["Scratch 2", "Scratch 5"], "and": [], "not": true},
  'codec.computedIsRefusedByIdBeforeTheSend': {"create": "TypeError", "update": "TypeError", "requests": 0},
  'codec.dateIsIsoOrRefused': {"local": "TypeError", "badDay": "TypeError", "iso": "2026-11-10", "rawReinterpreted": "2026-11-10"},
  'codec.selectWritesNameOrIdAndReadsName': ["Design", "Development"],
  'codec.unknownSelectIsInvalidRequestNeverTypecast': {"kind": "invalid_request", "code": "INVALID_MULTIPLE_CHOICE_OPTIONS", "typecasts": [false]},
  'codec.currencyIsMinorUnitsOnlyWithACode': {"none": 1234.5, "usd": {"amount": 123450, "currency": "USD"}, "jpy": {"amount": 1235, "currency": "JPY"}, "emptyIsNull": null},
  'codec.currencyWritesMinorUnitsNeverAMajorNumber': {"wireBudget": 1500, "answer": 1500, "major": "TypeError", "wrongCode": "TypeError", "noCodePlainNumber": 99.5, "badCode": "TypeError"},
  'rename.aRenamedFieldStillReadsById': {"sameId": true, "value": 1234.5, "oldNameGone": "TypeError", "nameKeyed": true},
  'wire.putIsNeverSent': {"methods": ["DELETE", "GET", "PATCH", "POST"], "put": false},
  'fixtures.scrubbed': {"files": 54, "parse": true, "strayEmails": [], "tokens": 0},
}
process.exit(report(got, expected))
