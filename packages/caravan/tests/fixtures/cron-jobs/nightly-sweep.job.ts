// A job file that declares WHEN it runs as well as what it does. Its own
// directory, because the fixtures under jobs/ are asserted as a complete list.

import { defineJob } from '../../../src/index.ts'

export const fired: unknown[] = []

export default defineJob('nightly-sweep', (job) => {
  fired.push(job.data)
}, { queue: 'maintenance', cron: '0 3 * * *', timeZone: 'UTC' })
