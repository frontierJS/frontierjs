// src/index.ts
// Basecamp entry point.

import { buildBasecampApp } from './core/app.ts'

const app = await buildBasecampApp()
await app.start()
