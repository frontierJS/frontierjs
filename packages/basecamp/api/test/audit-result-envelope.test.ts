// api/test/audit-result-envelope.test.ts
//
// The application audit hook reads the subject id off the call's result, and
// the result is one of two shapes: the envelope (`{ kind, data }`) or a custom
// method's own row. Junction's `resultData` is the one owner of telling them
// apart. A hand-written `raw.data ?? raw` cannot: a row that has a `data`
// column of its own is unwrapped into that column's value, and the entry is
// filed under 'unknown' (`FJS-2352`).

import { test, expect } from 'bun:test'
import { wrapResult }   from '@frontierjs/junction'
import { basecampAuditLog } from '../src/core/hooks.ts'

function harness() {
  const written: any[] = []
  const sys = {
    auditEvent: { create: async (args: any) => { written.push(args.data) } },
    $protectedFields: () => ({}),
  }
  const app = { db: { asSystem: () => sys }, services: { get: () => undefined } } as any
  return { app, written }
}

function ctxFor(app: unknown, result: unknown, method: string) {
  return { app, service: 'widgets', method, result, locals: {}, auth: undefined } as any
}

test('a custom method answering a row with its own `data` column is filed under that row', async () => {
  const { app, written } = harness()
  await basecampAuditLog()(ctxFor(app, { id: 'row-1', data: { id: 'inner' } }, 'rotate'))
  expect(written[0].subjectId).toBe('row-1')
})

test('an envelope is unwrapped to its row', async () => {
  const { app, written } = harness()
  await basecampAuditLog()(ctxFor(app, wrapResult({ id: 'row-2' }, 'widgets', 'create'), 'create'))
  expect(written[0].subjectId).toBe('row-2')
})
