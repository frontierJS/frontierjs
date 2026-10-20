// site/src/main.js — the DEV entry's side-effect imports.
//
// A BUILT page mounts its islands and nothing else: what ships is HTML with one
// chunk per island, and this file is in none of it. What it is for is `bun run
// dev:site`, where index.html loads virtual:sierra, which boots the router off
// the generated route table, imports this file and mounts the routes — the
// same boot the SPA uses, so a link behaves the same in both. A storefront
// page reads its data at BUILD time through `api/src/core/db.ts`, and its only
// runtime code is an island, which creates its own client against the API's
// own origin.
import '@frontierjs/css'
