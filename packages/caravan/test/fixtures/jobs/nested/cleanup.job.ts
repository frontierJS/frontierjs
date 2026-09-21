import { defineJob } from '../../../../src/index.ts'

// Lives one directory down to prove the '**' in the glob is real.
export default defineJob('cleanup', () => {})
