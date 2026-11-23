/*
 * test/package.test.ts — the package is what its manifest says it is.
 *
 * The manifest, and the entry's exports by name: a caller in another package or
 * a prototype imports these, so a rename shows here. The transport is
 * `transport.test.ts`, the recordings `fixtures.test.ts` and `replay.test.ts`.
 */

import { test, expect } from 'bun:test'
import pkg from '../package.json'

test('the entry exports the transport and the live chat', async () => {
  const mod = await import('../index.ts')
  expect(Object.keys(mod).sort()).toEqual([
    'ASK_BASH', 'ASK_BUDGET_USD', 'ASK_EFFORT', 'ASK_TOOLS', 'BadAnswer', 'ControlError', 'DRAW_BUDGET_USD',
    'EDIT_TOOLS', 'EFFORTS', 'FALLBACK_MODELS', 'IMAGE_TYPES', 'LineReader', 'MAX_IMAGE', 'MAX_IMAGES', 'MODES',
    'Protocol', 'SESSION_ID', 'Session', 'WORK_BUDGET_USD',
    'agentCall', 'agentEventOf', 'askArgv', 'askCard', 'askInput', 'askSummary', 'claudeDoor', 'commandsOf', 'decide', 'denial',
    'initOf', 'mcpConfigOf', 'mergeCommands', 'modelsOf', 'readAskEvent', 'readImages', 'resumeCommand',
    'runAsk', 'sessionArgv', 'usageOf',
  ])
})

test('the manifest names the package and its one entry', () => {
  expect(pkg.name).toBe('@frontierjs/claude')
  expect(pkg.exports).toEqual({ '.': './index.ts' })
})
