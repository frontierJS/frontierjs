#!/usr/bin/env bun
// cli/src/main.js — `basecamp` on a command line.
//
//   bun cli/src/main.js login --api-key -        (key on stdin; the dev API by default)
//   bun cli/src/main.js servers status

import config   from '../config/cli.config.js'
import { main } from '@frontierjs/mcp/client'

await main({ ...config, routes: new URL('./routes/', import.meta.url) })
