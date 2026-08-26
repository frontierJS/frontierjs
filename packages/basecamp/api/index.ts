// api/index.ts
// Basecamp entry point. It starts the app; src/app.ts builds one.

import { buildBasecampApp } from './src/app.ts'

const app = await buildBasecampApp()
await app.start()
