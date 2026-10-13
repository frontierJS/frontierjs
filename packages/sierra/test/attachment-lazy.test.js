// FJS-2752 — the blob queue is a lazy chunk, not part of every app's main bundle.
// Built with vite (Rolldown), the bundler an app ships with: Bun's splitter
// places a statically-shared module in a chunk and would pass either way.
import { test, expect } from 'vitest'
import { build } from 'vite'

test('resource.js keeps the blob queue out of its entry chunk', async () => {
  const warnings = []
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      minify: false,
      lib: { entry: new URL('../src/resource/resource.js', import.meta.url).pathname, formats: ['es'] },
      rollupOptions: {
        external: [/^@frontierjs\//],
        onLog: (level, log) => { if (level === 'warn') warnings.push(log.code) },
      },
    },
  })
  const outputs = (Array.isArray(result) ? result : [result]).flatMap((r) => r.output)
  const entry = outputs.find((o) => o.type === 'chunk' && o.isEntry)
  // `fjs-attachments` is the IndexedDB name only attachments.js knows.
  expect(entry.code).not.toContain('fjs-attachments')
  expect(outputs.some((o) => o.type === 'chunk' && !o.isEntry && o.code.includes('fjs-attachments'))).toBe(true)
  expect(warnings).not.toContain('INEFFECTIVE_DYNAMIC_IMPORT')
})
