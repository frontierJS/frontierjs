// polymorphic.js — find the (typeName, id) pairs in converted output, and
// refuse to guess what they mean.
//
// `.lite` answers polymorphism in three shapes, and which one is right depends
// on a fact the schema does not carry (references/Tag.lite, docs/schema.md
// § Exclusive foreign keys):
//
//   closed and small → @@arc, one nullable FK per target and a CHECK saying
//                      exactly one is set — keeps every foreign key and the
//                      cross-model query, stops scaling somewhere around six
//   open            → the (subjectType, subjectId) pair itself, with NO
//                      referential integrity and a sweep job owed for rows
//                      whose subject is gone
//
// The same pass reports single-table inheritance — a string `type` column — and
// on the same terms. It found 21 across seven schemas, but a `type` column is
// also just a category in plenty of them, and only reading the application
// separates the two. Rails names its STI column `type` by convention, which is
// why the heuristic is worth having and why it cannot be trusted alone.
//
// **It is a CANDIDATE list, not a finding.** Measured over seven real schemas:
// the first run gave three hits, of which one was real (a GitHub app install
// targets a User or an Organization, a closed set of two, which is exactly
// @@arc's case) and two were not (`SelectedCalendar.googleChannelKind`
// is a Google push-channel's `api#channel` string beside its channel id, no
// association anywhere). Nothing in a schema separates those, so the pass is
// deliberately broad and says so, rather than being tuned until it looks clean.
//
// **The target set lives in application code and in the data, never in the
// schema.** A `commentable_type` column says nothing about how many values it
// takes. So this reports the pair and names the column, and NEVER emits an
// @@arc: a converter that guessed `closed` would invent integrity the source
// does not have, and one that guessed `open` would hide an arc the author
// should have written. The pair is reported as a decision, never as a defect:
// which of the two shapes is right is the one thing the importer cannot know.

const TYPE_SUFFIX = /^(.*?)(Type|Kind|Class)$/

export function detectPolymorphic(lite, gap) {
  return scan(lite, gap)
}

function scan(lite, gap) {
  const models = new Map()
  let cur = null

  for (const line of lite.split('\n')) {
    const open = line.match(/^model (\w+) \{/)
    if (open) { cur = { name: open[1], fields: [], rel: new Set() }; models.set(open[1], cur); continue }
    if (/^\}/.test(line)) { cur = null; continue }
    if (!cur) continue

    const f = line.match(/^  (\w+) (\w+)(\[\])?(\??)(.*)$/)
    if (!f) continue
    cur.fields.push({ name: f[1], type: f[2], rest: f[5] || '' })
    // Every column already spoken for by a real foreign key.
    const rel = (f[5] || '').match(/@relation\([^)]*fields:\s*\[([^\]]*)\]/)
    if (rel) for (const c of rel[1].split(',')) cur.rel.add(c.trim())
  }

  let found = 0
  for (const model of models.values()) {
    // Single-table inheritance: Rails puts several classes in one table and
    // tells them apart with a string `type`. A model IS a table here, so there
    // is no spelling — the column stays an ordinary String and the fact that it
    // partitions the table is lost. Detected here rather than in one reader so
    // every front-end sees it; a dump carries no hint that its source was Rails.
    const sti = model.fields.find(f => f.name === 'type' && f.type === 'String' && !f.rest.includes('@relation'))
    if (sti)
      gap('sti-candidate', model.name, 'type',
          'a string `type` column — the Rails STI shape, one table holding several classes — CANDIDATE, a plain category column looks identical',
          'emitted as an ordinary String; where it IS inheritance, .lite has no way to say the table is partitioned by it')

    const byName = new Map(model.fields.map(f => [f.name, f]))
    for (const f of model.fields) {
      const m = f.name.match(TYPE_SUFFIX)
      if (!m || f.type !== 'String') continue
      const base = m[1]
      if (!base) continue

      const idField = byName.get(`${base}Id`) ?? byName.get(`${base}ID`)
      if (!idField) continue
      if (model.rel.has(idField.name)) continue          // a real FK — not this shape
      if (models.has(f.type)) continue                    // the type column IS a relation

      gap('polymorphic-candidate', model.name, `${f.name} + ${idField.name}`,
          `a (type, id) pair with no foreign key on '${idField.name}' — CANDIDATE, confirm by reading what the column holds`,
          'emitted as written — @@arc is the answer when the target set is CLOSED and small, and no schema can say ' +
          'whether it is; an open set keeps this shape and owes a sweep job (references/Tag.lite)')
      found++
    }
  }
  return found
}
