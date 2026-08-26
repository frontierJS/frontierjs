// site/src/routes/index.meta.js — the front page's nine code samples.
//
// They live here, as SOURCE, for two reasons.
//
// The first is that they used to be marked up BY HAND — `<b>` on every
// keyword, `<em>` on every string — which meant the samples on the page that
// says "the code samples are the product" were the one place in the repo
// where the code was not code. Copying one out of the file gave you HTML.
// Here they are the text a reader gets, and `@frontierjs/toolbelt/glow`
// marks them up at build time.
//
// The second is Mesa: `{` in markup opens an expression, so a `<pre>` holding
// `{#each leads.data as lead}` is a block tag to the compiler and the page
// does not compile. A companion is plain JavaScript and has no such reading.
//
// Nothing here reaches the browser — a companion is build-time only — so the
// page ships marked-up HTML and no highlighter.

import { block } from '../data/code.js'

const SAMPLES = {
  SCHEMA: ['lite', `// db/schema.lite — the seed
model Lead {
  id        Int      @id
  name      String   @length(1, 200) @trim
  email     String   @email @unique @lower
  status    LeadStatus @default(new)
  value     Float    @gte(0)
  createdAt DateTime @default(now())

  // read · create · update · delete
  @@gate("0.4.4.5")
  @@allow('read', ownerId == auth().id)
}`],
  API: ['js', `import { createApp, createService, publish } from '@frontierjs/junction'

const app = createApp({ db, auth, config: { port: 3200 } })
const live = publish(() => app.channel('leads'))

app.services.register(createService({
  name:  'leads',
  model: 'lead',
  hooks: { after: { create: [live], patch: [live] } },

  // custom action, dispatched by X-Service-Method
  async getStats(ctx) {
    const leads = await ctx.locals.db.lead.findMany()
    return { count: leads.length }
  },
}))

await app.start()`],
  UI: ['mesa', `<script>
  import { createResource } from '@frontierjs/sierra'

  // Same four hook phases as the API realm.
  const leads = createResource('leads', {
    hooks: {
      around: { all: [async (ctx, next) => {
        busy = true; await next(); busy = false
      }] },
    },
  })

  let busy = false
  await leads.find()
</script>

<table class="table">
  {#each leads.data as lead}
    <tr><td>{lead.name}</td><td>{lead.email}</td></tr>
  {/each}
</table>`],
  DECLARATION: ['lite', `model Invoice {
  total Float @gte(0)
  @@gate("0.4.4.8")
  @@allow('read', ownerId == auth().id)
  @@log(audit)
}`],
  HOOK: ['js', `// Same four phases in the API and the UI.
hooks: {
  around: { all:    [timing] },
  before: { create: [setDefaults] },
  after:  { create: [broadcast] },
  error:  { all:    [report] },
}`],
  PLUGIN: ['js', `export function audit(opts) {
  return {
    name: 'audit',
    register(app) { app.provide('audit', inst) },
    async boot(app)     { await inst.init() },
    async shutdown(app) { await inst.close() },
  }
}

app.configure(audit({ … }))`],
  PROVIDER: ['ts', `// A Plugin adds. A Provider replaces.
const auth: IAuth = {
  verifySession, login, logout,
  createUser, deleteUser, createApiKey,
}

createApp({ db, auth })`],
  SCAFFOLD: ['sh', `# scaffold a new app
$ npx @frontierjs/cli new my-app
$ cd my-app

# add a model, apply it, run both halves
$ fli scaffold Note --fields "title:string done:boolean"
$ fli db:push
$ bun run dev

  → api :3000   web :5173`],
  PIECEMEAL: ['sh', `# or add pieces to an existing project
$ npm i @frontierjs/litestone   # Data
$ npm i @frontierjs/junction    # API
$ npm i @frontierjs/sierra      # UI

# batteries, when you want them
$ npm i @frontierjs/auth @frontierjs/caravan`],
}

export async function load() {
  // One entry per sample: the language it is written in, and the source.
  return {
    samples: Object.fromEntries(
      Object.entries(SAMPLES).map(([name, [lang, src]]) => [name, block(src, lang)])
    ),
  }
}
