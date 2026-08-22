import { defineJob } from '../../../src/index.ts'

// A namespaced name. The colon cannot be in the file name — Windows refuses it
// — so the dash spelling is what the file is allowed to be called.
export default defineJob('deployment:run', () => {}, { queue: 'deployments' })
