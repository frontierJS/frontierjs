// A job file whose whole declaration is its timeout — the shape that reached
// the registry with `timeout: undefined` while `defineJob` had accepted it.

import { defineJob } from '../../../src/index.ts'

export default defineJob('bounded', async () => {}, { timeout: 250 })
