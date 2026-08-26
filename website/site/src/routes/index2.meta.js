// site/src/routes/index2.meta.js — the page's 3 code samples.
//
// Round one of the home page. Nothing links it; it is kept as a draft.
//
// They were marked up BY HAND in the page — a `<b>` around every keyword —
// which put HTML where the code was meant to be. Here they are the source a
// reader would copy, and `@frontierjs/toolbelt/glow` marks them up at build
// time. A companion runs at build only, so the page ships no highlighter.

import { block, sniff } from '../data/code.js'

const SAMPLES = {
  S0: `// package.json
"prisma",          // data
"zod",             // validation, again
"casl",            // authorization, again
"next-auth",       // identity
"express",         // transport
"socket.io",       // realtime
"bullmq",          // jobs
"node-cron",       // schedule
"nodemailer",      // mail
"react-email",     // mail, again
"swagger-jsdoc",   // the API, described again
"react",           // ui
"react-hook-form", // the fields, again
"tailwindcss"      // style

// + the glue between all fourteen`,
  S1: `// package.json
"@frontierjs/litestone", // Data
"@frontierjs/junction",  // API
"@frontierjs/sierra",    // UI
"@frontierjs/css"        // style

// batteries, when you want them
"@frontierjs/auth"
"@frontierjs/caravan"    // jobs + cron
"@frontierjs/notifications"

// the glue is the framework`,
  S2: `// db/schema.lite
model Lead {
  + value  Float  @gte(0)
}`,
}

export async function load() {
  return {
    samples: Object.fromEntries(Object.entries(SAMPLES).map(
      ([n, src]) => [n, block(src, sniff(src))])),
  }
}
