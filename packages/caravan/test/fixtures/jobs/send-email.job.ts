import { defineJob } from '../../../src/index.ts'

export const calls: unknown[] = []

export default defineJob('send-email', (job) => {
  calls.push(job.data)
}, { queue: 'email', maxAttempts: 5, retryDelay: [10, 20] })
