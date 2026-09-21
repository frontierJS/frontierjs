// Declares a name the file does not carry — the typo autoload must refuse.
// Registered as written, it would answer to 'send-repot' while every dispatch
// says 'send-report' and no job ever runs.

import { defineJob } from '../../../src/index.ts'

export default defineJob('send-repot', () => {})
