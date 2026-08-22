import { defineJob } from '../../../../src/index.ts'

// Same basename, different directory — one name, and the registry is a map.
export default defineJob('cleanup', () => {})
