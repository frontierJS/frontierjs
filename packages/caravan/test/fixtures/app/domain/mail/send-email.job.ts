import { defineJob } from '../../../../../src/index.ts'

export default defineJob({
  queue: 'email', maxAttempts: 5, retryDelay: [10, 20],
  handler: () => {},
})
