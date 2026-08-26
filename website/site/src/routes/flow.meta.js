// site/src/routes/flow.meta.js — the page's 9 code samples.
//
// The request flow, one sample per seam.
//
// They were marked up BY HAND in the page — a `<b>` around every keyword —
// which put HTML where the code was meant to be. Here they are the source a
// reader would copy, and `@frontierjs/toolbelt/glow` marks them up at build
// time. A companion runs at build only, so the page ships no highlighter.

import { block, sniff } from '../data/code.js'

/* The page points at one run in each sample — the field the seam is about.
   That is glow's own mark syntax, •like this•, which @frontierjs/css draws;
   it used to be a <u> in the sample text with a rule in the page to colour
   it, which meant the sample was not the code. */

const SAMPLES = {
  S0: `enum LeadStatus { new  contacted  won  lost }

model Lead {
  id        Int        @id
  name      String     @length(1, 120) @trim
  •email     String     @email @unique @lower•
  status    LeadStatus @default(new)
  value     Float      @gte(0)
  ownerId   Int
  createdAt DateTime   @default(now())

  // Gate — the ordinal level check, per operation
  @@gate(read: READER, write: USER, delete: ADMINISTRATOR)

  // Policy — a row predicate, compiled into the SQL
  @@allow('read', ownerId == auth().id)
}`,
  S1: `// name  ← the filename      ('leads.service.ts' → /api/leads)
// model ← the service name  ('leads' → db.lead)
// db    ← app.db, scoped per call to the caller

export function createLeadsService() {
  return createBaseService({})
}`,
  S2: `export function createLeadsService() {
  return createBaseService({
    hooks: {
      around: { all:    [timing] },        // wraps the whole call
      before: { create: [stampOwner] },    // may mutate ctx.data or halt
      after:  { create: [queueWelcome] },  // sees ctx.result
      error:  { all:    [report] },        // sees ctx.error
    },
  })
}

function stampOwner(ctx) {
  ctx.data.ownerId = ctx.auth.user.userId   // who, from the Context
}`,
  S3: `const app = createApp({ db, auth })

app.configure(createCaravan({ jobsDir: './jobs' }))  // → app.jobs
app.configure(conduit({ … }))                        // → app.conduit

// the after Hook from the previous stop
async function queueWelcome(ctx) {
  await ctx.app.jobs.dispatch('send-welcome', { •email•: ctx.result.data.email })
}`,
  S4: `return createBaseService({
  channel: 'leads',   // the declared broadcast target
})

// one mutation, announced twice, from the same place:
app.events.on('leads:created', …)   // in-process Event bus
// 'leads created'                   → over the Channel, to the UI`,
  S5: `const leads = createResource('leads', {
  coerce:      true,   // "42" → 42, by the Model's declared type
  blankToNull: true,   // '' → null, on nullable fields only
  validate:    true,   // check here before spending a round trip
})

leads.fields.•email•   // { type, required, maxLength, format: 'email', … }
leads.can('delete')  // the Gate's answer, for hiding a control
leads.gate           // the four levels, as declared on the Model`,
  S6: `const leads = createResource('leads', {
  hooks: {
    around: { all: [async (ctx, next) => {
      busy = true; await next(); busy = false
    }] },
    error: { all: [(ctx) => toast(ctx.error.message)] },
  },
})

// and the Channel from the API realm arrives as an Event here —
// the list updates without asking again`,
  S7: `<script>
  import { Input, Select, Button } from '@frontierjs/ui'

  const leads = createResource('leads', { coerce: true, validate: true })
  let draft = leads.make()          // shaped by the Model

  // validate() returns [{ field, message }] — the components want a map
  $: errors = Object.fromEntries(
    leads.validate(draft, 'create').map(e => [e.field, e.message])
  )
</script>

<Input  label="Email" name="email" type="email"
        bind:value={draft.•email•} {errors} />

<Input  label="Name"  name="name"  bind:value={draft.name}  {errors} />
<Select label="Status" name="status" options={leads.fields.status.enum}
        bind:value={draft.status} {errors} />

<Button on:click={() => leads.service.create(draft)}>Save</Button>`,
  S8: `# the Model
db/schema.lite            16 lines

# the Service
leads.service.ts          3 lines

# the UI
leads/index.mesa          the form you wanted`,
}

export async function load() {
  return {
    samples: Object.fromEntries(Object.entries(SAMPLES).map(
      ([n, src]) => [n, block(src, sniff(src))])),
  }
}
