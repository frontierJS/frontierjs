// site/src/routes/index3.meta.js — the page's 7 code samples.
//
// Round two of the home page. Nothing links it; it is kept as a draft.
//
// They were marked up BY HAND in the page — a `<b>` around every keyword —
// which put HTML where the code was meant to be. Here they are the source a
// reader would copy, and `@frontierjs/toolbelt/glow` marks them up at build
// time. A companion runs at build only, so the page ships no highlighter.

import { block, sniff } from '../data/code.js'

const SAMPLES = {
  S0: `my-app/
├── db/              the seed — one schema, above both consumers
│   └── schema.lite
├── api/             API realm
│   ├── config/  src/  public/
│   └── test/    dist/ deploy/
└── web/             UI realm
    ├── config/  src/  public/
    └── test/    dist/ deploy/

# the same six folders in every sub-project,
# so nothing has to be looked up twice`,
  S1: `// package.json
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
  S2: `// package.json
"@frontierjs/litestone", // Data
"@frontierjs/junction",  // API
"@frontierjs/sierra",    // UI
"@frontierjs/css"        // style

// batteries, when you want them
"@frontierjs/auth"
"@frontierjs/caravan"    // jobs + cron
"@frontierjs/notifications"

// the glue is the framework`,
  S3: `CREATE POLICY lead_owner ON leads
  FOR SELECT USING (owner_id = current_setting('app.user')::int);`,
  S4: `router.get('/leads', requireAuth, async (req, res) => {
  const rows = await db.lead.findMany({
    where: { ownerId: req.user.id },   // don't forget this
  })
})`,
  S5: `{lead.ownerId === session.user.id && (
  <EditButton />   // a third opinion, in a third language
)}`,
  S6: `model Lead {
  @@allow('read', ownerId == auth().id)
}

// the query is filtered, the API returns 403,
// and resource.can('read', lead) knows in the browser`,
}

export async function load() {
  return {
    samples: Object.fromEntries(Object.entries(SAMPLES).map(
      ([n, src]) => [n, block(src, sniff(src))])),
  }
}
