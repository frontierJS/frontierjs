// A worker that answers with the setup data it was constructed with, alongside
// each task — so a test can tell "the data arrived" from "the data arrived for
// the first message only", and can see a respawned pool worker's setup too.

import { workerHandler, workerData } from '../../../src/workers/index.ts'

const setup = workerData<{ factor?: number; tag?: string }>()

workerHandler((data: unknown) => {
  const n = typeof data === 'number' ? data : 0
  if (n === -1) throw new Error('asked to fail')
  return { setup, product: n * (setup?.factor ?? 1) }
})
