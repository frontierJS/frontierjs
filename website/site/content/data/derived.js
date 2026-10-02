// site/content/data/derived.js — what the schema gives you without being written.
//
// The splash marquee reads this, strongest first: the four the lede already
// names, then the ones that kill a large pain in a few words, then the ones
// that show depth. `tag` is the real spelling in the framework, so a reader who
// goes looking finds it; one that no longer exists is a claim the site cannot
// back.

export const derived = [
  { title: 'Validation',      line: 'Every write checked against the field rules in the schema.',        tag: 'autoValidate()' },
  { title: 'Authorization',   line: 'Who can read and write a row is declared on the model.',            tag: '@@gate' },
  { title: 'Pagination',      line: 'Limits, offsets and cursors on every list, with no slicing in memory.', tag: '$after' },
  { title: 'Live updates',    line: 'Lists change on screen when the rows change.',                      tag: 'publish()' },

  { title: 'Migrations',      line: 'The schema is diffed against the live database. You never write a migration file.' },
  { title: 'Typed client',    line: 'The browser knows every service, field and filter.',                tag: 'ServiceTypes' },
  { title: 'Forms',           line: 'The right control, label and options per field, and server errors on the right input.', tag: '@label' },
  { title: 'Audit trail',     line: 'Every write is logged, with protected fields redacted.' },
  { title: 'AI agent access', line: 'An MCP endpoint over your app, with the gate as the permission model.', tag: 'mcpPlugin()' },

  { title: 'Encryption at rest',    line: 'Sensitive fields are sealed at the data boundary.',            tag: '@encrypted' },
  { title: 'State machines',        line: 'The UI shows only the actions allowed now, and the server refuses the rest.', tag: '@@transitions' },
  { title: 'Conflict detection',    line: 'Two people editing one record cannot overwrite each other.',   tag: 'x-version' },
  { title: 'Field-level redaction', line: 'Who sees what, per field rather than per row.',                tag: '$readAs' },
  { title: 'Safe filter and sort',  line: 'Nobody filters or sorts on a field they cannot read.',         tag: '$checkWhere' },
  { title: 'Multi-tenancy',         line: 'One app, many tenants, each kept to its own data.',            tag: 'resolveTenancy' },
  { title: 'Admin UI',              line: 'Browse and edit every model from the schema alone.',           tag: 'Litestone Studio' },
  { title: 'Test environment',      line: 'A real app over a real database, in every test.',              tag: 'createTestEnv' },
]
