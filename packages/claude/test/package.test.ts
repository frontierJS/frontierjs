/*
 * test/package.test.ts — the package is what its manifest says it is.
 *
 * The manifest, and the entry's exports by name: a caller in another package or
 * a prototype imports these, so a rename shows here. The transport is
 * `transport.test.ts`, the recordings `fixtures.test.ts` and `replay.test.ts`.
 */

import { test, expect } from 'bun:test'
import pkg from '../package.json'

test('the entry exports the transport, the live chat, the readers and the subcommands', async () => {
  const mod = await import('../index.ts')
  expect(Object.keys(mod).sort()).toEqual([
    'ASK_BASH', 'ASK_BUDGET_USD', 'ASK_EFFORT', 'ASK_TOOLS', 'BadAnswer', 'ControlError',
    'DRAW_BUDGET_USD', 'EDIT_TOOLS', 'EFFORTS', 'FALLBACK_MODELS', 'IMAGE_TYPES', 'LISTING_LIMIT',
    'LineReader', 'MAX_BYTES', 'MAX_IMAGE', 'MAX_IMAGES', 'MODES', 'Protocol', 'SESSION_ID',
    'SUMMARY_CAP', 'Session', 'TEXT_CAP', 'WORK_BUDGET_USD', 'agentCall', 'agentEventOf', 'allHooks',
    'allItems', 'askArgv', 'askCard', 'askInput', 'askSummary', 'claudeAuthStatus', 'claudeConfigDir',
    'claudeDoor', 'claudeJsonPath', 'commandTools', 'commandsOf', 'configRev', 'contextFor',
    'countContext', 'decide', 'denial', 'encodeCwd', 'expandMcpVars', 'fetchUsage', 'findSession',
    'foldTranscript', 'initOf', 'listSessions', 'mcpConfigOf', 'mergeCommands', 'modelsOf',
    'peekSession', 'read', 'readAskEvent', 'readDoctor', 'readImages', 'readJsonObject',
    'readListedFile', 'readMcpList', 'readMessages', 'readToolCalls', 'readTranscript',
    'resumeCommand', 'runAsk', 'runClaude', 'scanClaude', 'sessionArgv', 'titleOf', 'unreadable',
    'usageOf',
  ])
})

test('the manifest names the package and its one entry', () => {
  expect(pkg.name).toBe('@frontierjs/claude')
  expect(pkg.exports).toEqual({ '.': './index.ts' })
})

// FJS-D2375: the connector is needed only to count context parts, so an install
// without it still reads everything else and answers the count as estimated.
test('conduit-anthropic is optional, and a count without it is estimated with the reason', async () => {
  expect(pkg.optionalDependencies).toEqual({ '@frontierjs/conduit-anthropic': 'workspace:*' })
  expect(Object.keys(pkg.dependencies)).not.toContain('@frontierjs/conduit-anthropic')

  const { countContext, countLogin } = await import('../src/context.ts')
  const missing = () => Promise.reject(new Error("Cannot find package '@frontierjs/conduit-anthropic'"))
  const m = {
    basis: 'estimated' as const, estimatedWhy: 'not counted yet', measuredTotal: 10, alwaysOn: 8,
    parts: [{ name: 'First prompt', chars: 6, tokens: 2 }], model: 'claude-x', version: null, at: null, window: null,
    sent: new Map([['First prompt', { text: 'hello!' }]]),
  }
  const r = await countContext(m, 'no-connector', (model, bodies) => countLogin(model, bodies, { load: missing }))
  expect(r.basis).toBe('estimated')
  expect(r.parts).toEqual(m.parts)
  expect(r.estimatedWhy).toContain('@frontierjs/conduit-anthropic')
  expect('sent' in r).toBe(false)
})
