---
title: db:push
description: Apply schema.lite changes to the database directly — no migration file created
alias: db-push
examples:
  - fli db:push
  - fli db:push --dry
flags:
  dry:
    type: boolean
    description: Preview the SQL that would be run without executing it
    defaultValue: false
  accept-data-loss:
    type: boolean
    description: Apply a push that drops columns or tables and the values in them
    defaultValue: false
---

<script>
function previewPush($, schema) {
  $.echo`{dim ·} Previewing schema changes (dry run)...`
  $.exec({ command: `${litestone($)} migrate dry-run --schema ${schema}` })
}

// `db push` diffs the schema against the live database. `migrate apply`
// replays migration FILES — on a project that has none it reports success
// having done nothing, which is a new model that silently never got a table.
function applyPush($, schema, env) {
  const { flag, tty, echo } = $
  const args = `db push --schema ${schema}${flag['accept-data-loss'] ? ' --accept-data-loss' : ''}`
  const push = litestoneQuiet($, args, env)
  if (push.ok) return push

  // Litestone asks before dropping values only of a terminal, and the capture is
  // not one: the refusal comes back instead. Running it again live is what puts
  // the question in front of the person; a push is a diff, so a repeat is safe.
  if (tty.interactive && !flag['accept-data-loss'] && /--accept-data-loss/.test(push.raw)) {
    const live = $.exec({ command: `${litestone($)} ${args}`, stdio: 'inherit', allowFailure: true, env })
    return live instanceof Error ? null : { ok: true, warnings: [], body: [] }
  }
  echo(push.raw.trimEnd())
  return null
}

// The first row is litestone's banner and everything from its verdict on is the
// footer; what is between is one row per database, which is the result.
function reportPush($, push, t0) {
  const { echo } = $
  const verdict = push.body.findIndex((r) => /DB (not )?pushed|DB is already in sync/.test(r.plain))
  const rows    = push.body.slice(push.body.length && /^\s*litestone /.test(push.body[0].plain) ? 1 : 0, verdict < 0 ? undefined : verdict)
  const changed = verdict >= 0 && /DB pushed/.test(push.body[verdict].plain)
  for (const r of rows) echo(r.line)

  showWarnings($, push.warnings)

  const took = `${(performance.now() - t0).toFixed(0)}ms`
  if (changed) echo`{green ✓} Schema applied  {dim ${took}}
{dim · Applied directly, no migration file. For a deploy: fli db:migrate}`
  else echo`{green ✓} Schema already in sync  {dim ${took}}`
}

// `<db>/.json/schema.json`, not beside the .lite. It is a DERIVED document
// meant to be copied out — into an editor, a validator, a client generator —
// and it is regenerated on every push, so committing it means committing a
// file nothing gates and everything can outdate. The dot-directory is this
// repo's mark for exactly that (`api/src/emails/.preview/`), and it is
// gitignored for the same reason.
async function writeJsonSchema($, schema) {
  const { jsonSchemaPath } = await import(path.resolve(global.fliRoot, 'core/derived-paths.js'))
  const out  = jsonSchemaPath(path.dirname(schema))
  const json = litestoneQuiet($, `jsonschema --schema ${schema} --out ${out}`)
  if (json.ok) return jsonSchemaDone($, json, out)
  $.echo(json.raw.trimEnd())
  $.config.abort = true
}
</script>

A schema that encrypts, with no `ENCRYPTION_KEY` set, is offered one at a
terminal. Over a database with nothing encrypted in it the offer is a generated
key. Over one holding encrypted values it asks for the key that sealed them and
writes it to `.env` only if it opens one, because a new key cannot read them.

```js
if (!requireSchema($)) return

const { schema } = resolveDb($, flag)
if (flag.dry) { previewPush($, schema); return }

const keyEnv = await keyFor($, schema)
if (!keyEnv) { $.config.abort = true; return }

const t0 = performance.now()
echo`{dim ·} Pushing schema...`

const push = applyPush($, schema, { ...process.env, ...keyEnv })
if (!push) { $.config.abort = true; return }

reportPush($, push, t0)
await writeJsonSchema($, schema)
```
