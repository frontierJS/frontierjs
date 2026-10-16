import { defineJob } from '../../../src/index.ts'

export const calls: unknown[] = []

export default defineJob({
  queue: 'email', maxAttempts: 5, retryDelay: [10, 20],
  handler: (job) => {
    calls.push(job.data)
  },
})
