// test/example-resource.test.ts
//
// FJS-2111: the Notification.mesa this package ships is the one an app copies,
// and a write it makes straight through `notifications.service` never reaches
// the tether, so the bell's count stays up until a reload. A write is
// `notifications.mutate(id, intent, run)` — the overlay on the row's entry is
// what every view of it reads.

import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const source = readFileSync(join(import.meta.dir, '..', 'examples', 'Notification.mesa'), 'utf8')
// Comments name `service.patch` in prose; only code is graded.
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

describe('examples/Notification.mesa', () => {
  test('markRead goes through mutate, so a held row shows read at once', () => {
    expect(code).toMatch(/notifications\.mutate\(\s*[\w.]+\s*,\s*\{[^}]*readAt/)
  })

  test('the service is called only as the run of a mutate', () => {
    for (const line of code.split('\n').filter(l => /notifications\.service\./.test(l))) {
      expect(line).toMatch(/\(\)\s*=>\s*notifications\.service\./)
    }
  })
})
