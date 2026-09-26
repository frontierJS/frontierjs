#!/usr/bin/env bun
/*
 * src/client/bin.ts — the app CLI for an app with no `cli/` surface of its own.
 *
 *   bun src/client/bin.ts login --api-key - --url http://localhost:8120/mcp   (key on stdin)
 *   bun src/client/bin.ts servers find --status online
 *
 * Everything an app's `cli/config/` would state comes from the environment:
 * FJS_APP (whose config and cache directories), FJS_TENANT_HEADER, and the
 * per-run overrides `main.ts` lists.
 */

import { main } from './main.ts'

await main()
