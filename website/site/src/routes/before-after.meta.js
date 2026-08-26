// site/src/routes/before-after.meta.js — the page's 38 code samples.
//
// Nineteen pairs: how a thing is done elsewhere, and how it is declared here.
//
// They were marked up BY HAND in the page — a `<b>` around every keyword —
// which put HTML where the code was meant to be. Here they are the source a
// reader would copy, and `@frontierjs/toolbelt/glow` marks them up at build
// time. A companion runs at build only, so the page ships no highlighter.

import { block, sniff } from '../data/code.js'

/* Stated where the sniffer cannot tell — it reads this repo's own
   languages, and these are somebody else's. */
const LANG = {
  S25: 'yaml',
}

const SAMPLES = {
  S0: `CREATE POLICY lead_owner ON leads
  FOR SELECT USING (owner_id = current_setting('app.user')::int);`,
  S1: `router.get('/leads', requireAuth, async (req, res) => {
  const rows = await db.lead.findMany({
    where: { ownerId: req.user.id },  // don't forget this
  })
  res.json(rows)
})`,
  S2: `{lead.ownerId === session.user.id && (
  <EditButton />  // a third opinion, in a third language
)}`,
  S3: `model Lead {
  ownerId Int
  @@allow('read', ownerId == auth().id)
}`,
  S4: `ALTER TABLE leads
  ADD CONSTRAINT leads_email_unique UNIQUE (email),
  ADD CONSTRAINT leads_value_positive CHECK (value >= 0);`,
  S5: `const LeadInput = z.object({
  name:  z.string().min(1).max(200).trim(),
  email: z.string().email().toLowerCase(),
  value: z.number().min(0),
})`,
  S6: `<input {...register('email', {
  required: true,
  pattern: /^\\S+@\\S+$/,   // the fourth spelling of "email"
})} />`,
  S7: `model Lead {
  name  String @length(1, 200) @trim
  email String @email @unique @lower
  value Float  @gte(0)
}`,
  S8: `router.get   ('/leads',     leads.list)
router.post  ('/leads',     requireRole('member'), leads.create)
router.patch ('/leads/:id', requireRole('member'), leads.update)
router.delete('/leads/:id', requireRole('admin'),  leads.remove)
// repeat, per resource, forever`,
  S9: `const canDelete = user?.role === 'admin'
// the role names now live in two repos`,
  S10: `model Lead {
  // read · create · update · delete
  @@gate("0.4.4.5")
}`,
  S11: `onChange={e => setValue(parseFloat(e.target.value))}
// NaN when the box is empty

const payload = {
  ...form,
  value:    Number(form.value),
  nickname: form.nickname || null,   // remember this one
  notes:    form.notes    || null,   // and this one
}`,
  S12: `-- meanwhile, in the column you thought was empty
SELECT * FROM leads WHERE nickname IS NULL;
-- 0 rows. They are all ''.
-- and String? @unique accepted exactly one ''`,
  S13: `const leads = createResource('leads', {
  coerce:     true,   // "42" → 42, by the schema's type
  blankToNull: true,  // '' → null, nullable fields only
  validate:   true,   // check before it leaves the browser
})`,
  S14: `router.get('/leads', async (req, res) => {
  const page  = Number(req.query.page ?? 1)
  const limit = Math.min(Number(req.query.limit ?? 20), 100)
  const [rows, total] = await Promise.all([…])
  res.json({ data: rows, total, page })   // this endpoint's shape
})`,
  S15: `const res  = await fetch('/api/leads?page=2')
const body = await res.json()
const rows = body.data ?? body.items ?? body   // hope`,
  S16: `GET /leads?$limit=20&$offset=40&$orderBy=createdAt

// $ is transport syntax and stops at the bridge:
ctx.query      // your filters
ctx.directives // { limit, offset, orderBy, select }`,
  S17: `app.use((err, req, res, next) => {
  if (err instanceof ZodError)        return res.status(400)…
  if (err instanceof PrismaKnownError) return res.status(409)…
  if (err.name === 'JsonWebTokenError') return res.status(401)…
  if (err instanceof HttpException)   return res.status(err.status)…
  res.status(500).json({ error: 'Internal' })  // everything else
})`,
  S18: `export class QuotaExceeded extends Error {
  status = 429            // that is the whole integration
}

throw new QuotaExceeded()   // raw route, service or plugin`,
  S19: `1. migrations/0034_add_value.sql   // hand-written
2. schema.prisma                   // the model
3. lib/validators/lead.ts          // the zod schema
4. openapi.yaml                    // the documented shape
5. types/lead.d.ts                 // what the client believes
6. components/LeadForm.tsx         // the input and its rules

// forget 3 → it saves unvalidated
// forget 4 → the docs quietly lie
// forget 5 → the client is wrong at runtime only`,
  S20: `model Lead {
  + value Float @gte(0)
}`,
  S21: `$ fli db:migrate`,
  S22: `const lead = await db.lead.create({ data })
io.to(\`org:\${req.user.orgId}\`).emit('lead:created', lead)

// …and in update. and in bulk import.
// and in the admin tool. and in the job.`,
  S23: `socket.on('lead:created', l => setLeads(p => [...p, l]))
socket.on('lead:updated', l => setLeads(p => p.map(…)))
// event names agreed by convention across two repos`,
  S24: `export function createLeadsService() {
  return createBaseService({
    channel: 'leads',   // the declared broadcast target
  })
}
// name and model come from the filename`,
  S25: `# docker-compose.yml
redis:
  image: redis:7
worker:
  command: node dist/worker.js   # a second deploy target`,
  S26: `const queue  = new Queue('email', { connection })
const worker = new Worker('email', handler, { connection })
// plus a separate node-cron in yet another process`,
  S27: `export default defineJob('send-email', async (job) => {
  await mailer.send(job.data)
}, { maxAttempts: 5, retryDelay: [60_000, 300_000] })`,
  S28: `await app.jobs.dispatch('send-email', { to: lead.email })
app.jobs.schedule('digest', '0 9 * * *', sendDigest)`,
  S29: `await db.notification.create({ data: { userId, title: 'Payment received', … } })
await sendgrid.send({ to: user.email, subject: 'Payment received', html: render(…) })
io.to(\`user:\${userId}\`).emit('notification', { title: 'Payment received' })

// three wordings, one of which is now out of date
// and no per-user preference unless you add a fourth thing`,
  S30: `class PaymentReceived extends Notification {
  via(user)     { return user.notificationPreferences ?? ['inApp', 'email'] }
  toInApp(user) { return inApp().title('Payment received')… }
  toEmail(user) { return mail().subject('Payment received')… }
}`,
  S31: `await app.notify(user, new PaymentReceived(payment))`,
  S32: `<mjml><mj-body><mj-section><mj-column>
  <mj-text>Hi {{firstName}}</mj-text>
</mj-column></mj-section></mj-body></mjml>

// a second syntax, a second component library,
// and a text/plain part that is either absent
// or full of leftover markup`,
  S33: `<Button href={url}>View order</Button>
// the same component language as your pages`,
  S34: `const { html, text, subject } =
  await renderEmailFile('./emails/Welcome.mesa', { data })`,
  S35: `await fetch(\`https://api.hetzner.cloud/v1/servers/\${id}\`, {
  headers: { Authorization: \`Bearer \${process.env.HETZNER_TOKEN}\` },
})
// a token read at the call site, a timeout nobody set,
// a retry policy that exists in three variants`,
  S36: `target('provider:hetzner', {
  base: 'https://api.hetzner.cloud/v1',
  auth: { ref: 'HETZNER_TOKEN' },   // a reference, not the secret
})`,
  S37: `const result = await app.conduit.send({
  target: 'provider:hetzner',
  method: 'GET',
  path:   '/servers/123',
})`,
}

export async function load() {
  return {
    samples: Object.fromEntries(Object.entries(SAMPLES).map(
      ([n, src]) => [n, block(src, LANG[n] ?? sniff(src))])),
  }
}
