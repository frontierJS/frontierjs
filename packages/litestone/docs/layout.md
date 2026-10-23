# litestone — layout

The file-by-file map of `@frontierjs/litestone`, moved out of `CLAUDE.md` so a turn in this package does not pay for it. `CLAUDE.md` keeps the owners and the traps; hazards are `hazards.md`.

```
src/
  index.js · index.d.ts — public API re-exports, no battery · the hand-written declarations
  core/
    parser.js — .lite to AST; the lexer and condition grammar are toolbelt/predicate's
    catalog.js — every word a .lite file can hold; what explain, Studio and the reference read
    advise.js — legal-and-WRONG combinations; every rule in it parses
    opportunities.js — legal-and-MISSING: a word that would have said it better
    schema-maps.js — the schema read once into the maps the client runs on
    ddl.js — AST to CREATE TABLE / INDEX / TRIGGER; isStoredField, isUpdatedAtField
    client.js — createClient, makeTable, every verb, the flavors
    args.js — what a verb may be passed: argument names, where/orderBy/aggregate keys, @guarded on the way in
    databases.js — the database registry, and the handles over a connection: statement cache, @big, @map
    transaction.js — $transaction: nesting by async context, read routing while one is open
    locks.js — $lock / $locks: the advisory-lock primitive over the _locks table
    introspect.js — the `$`-introspection surface: $checkWhere … $claimsFor, built once over the root ctx and handed to every flavor
    write-data.js — the payload boundary of a write: writeKeySets(shape) and makeWriteData(shape, ctx, deps) — writeData, the @guarded/@system/@immutable/@sequence/capability refusals, encryption, enums, @allow(write) on create, @rank minting and the bind-safety floor; built once per table by makeTable
    where-rewrite.js — the rewrites a where takes before buildWhere, in order: $scope → $raw, @@extensible key → slot, write transforms on equality operands, matchable-protected operand encoding; makeWhereRewrite(shape, ctx, deps) hands makeTable buildWhereWithEncryption and whereFragment
    state-guards.js — the rules that read the STORED row before a write lands: the transitions machine (refuseOffEntry, checkTransitions, applyTransitionWhereClause) and the seal (sealWhereClause, sealInsertGuard, sealSelfClause, the refusal readers); NOT_VISIBLE; makeStateGuards(shape, ctx, deps), built once per table by makeTable
    extensible.js — the @@extensible pool for one table: the schema half (_extensible, extPoolFor) and the data half (_extDeclarations, extTenant, extScope, allocateExtSlot, backfillExtSlot, mirrorExtSlots, remirrorMovedRow); EXT_SLOTS; makeExtensible(shape, ctx, deps), built once per table by makeTable — the cold halves of writeData (`FJS-1108`)
    nested-writes.js — the relation half of one row's write: extractNestedWrites (scalar vs nested split, `hasNested` a boolean — `FJS-615`), refuseBulkNested (`FJS-2040`), processBelongsToNested (before the parent statement, hands back FKs), processHasManyNested (after it: hasMany and implicit m2m ops, co-FK propagation); JOINED; makeNestedWrites(shape, ctx, deps), built once per table by makeTable
    group-by.js — the groupBy verb: group keys, aggregates, one optional DateTime interval bucket, HAVING (buildAggHaving lives here), orderBy over keys and aggregates, gap fill on the caller's calendar; makeGroupBy(shape, ctx, deps) returns the one verb, which makeTable puts in the table literal under its own name
    aggregate.js — the aggregate verb: COUNT/SUM/AVG/MIN/MAX, GROUP_CONCAT (_stringAgg) and the named aggregates over the visible rows, one object back; makeAggregate(shape, ctx, deps) returns the one verb
    search.js — the search verb over the @@fts index: step 1 pages the hits on the index (by rank) or collects them all (under a caller's orderBy), step 2 reads the rows from the base table, with the global filter, the plugin read filters and the row policy folded ONCE and bound to both steps (`FJS-262`); makeSearch(shape, ctx, deps) returns the one verb
    find-many-cursor.js — the findManyCursor verb: keyset pagination, one SELECT bounded by the previous page's last values and ordered by the cursor fields, { items, nextCursor, hasMore } back; a cursor from another sort is refused by name (`FJS-779`); makeFindManyCursor(shape, ctx, deps) returns the one verb
    write-events.js — the write announcement, one funnel: fireEvent (held to COMMIT inside a transaction, recorded cross-process before the local-audience guard — `FJS-642`), hasAudience/hasLocalAudience, emitTransitionEvent, fireRowEvent/fireCollectionEvent (`scope` stated, `FJS-307`), tenantPath/tenantsOf (the tenants a write touched, one hop per `@@tenant(via:)` — `FJS-1741`), announceFor/announceBulk; makeWriteEvents(shape, ctx, deps), built once per table by makeTable
    trail-entries.js — the trail's record of a completed verb: the per-table log configuration read once (tableHasLogWork is the hot-path boolean), emitLogs (field-level and model-level entries, the @@anonymous-in-a-logged-transaction refusal `FJS-D349`, `written` narrowing a field entry to the rows that named it `FJS-2048`), the redaction marks (`[redacted]`/`[personal]`/`[opaque:…]`, root `CLAUDE.md` § 7), trailImage (the stored value's mark where the caller's row lacks the column, `FJS-2297`), logReadParse (a logged read selects its id, `FJS-1422`); makeTrailEntries(shape, ctx, deps), built once per table by makeTable
    ledger-notes.js — what a write tells the two commit-time grades: noteCardinality/noteCardinalityBySql (both ends of a relation count; the BySql form reads the parents a WHERE names before it runs, aliased back to field names under @map), noteExclusion/noteExclusionBySql (a landed row's key, the pre-update key with the payload laid over it, and the parents a member range @from's, `FJS-D989`), exclTouched (an update naming no key/range/where/via field keeps its fast path); a delete is never noted; makeLedgerNotes(shape, deps), built once per table by makeTable
    stamps.js — what a write fills in: generated defaults, @createdBy/@updatedBy, @sequence
    computed.js — @computed: load, normalize, apply to a read row
    field-policy.js — field @allow(read) applied to read rows
    include.js — include, and @from on a path that builds its own SQL
    hooks.js — the hooks, onEvent, onQuery and announce options
    audit-log.js — @trail/@@trail: the entry, and the fire-and-forget write of it
    errors.js — every error the client throws; junction builds them by name
    engine.js — the SQL engine seam
    pragmas.js — busy_timeout, the one owner
    db-path.js — where a relative database path lands
    backup.js — how a live file is copied, for $backup and migrate apply
    query.js — buildWhere, buildOrderBy, coercion
    policy.js — @@allow / @@deny / field @allow to SQL (compileSql) and JS (evalJs)
    plugin.js — LitestonePlugin, PluginRunner, AccessDeniedError
    validate.js — field validators, ValidationError, EXACT_INT_MAX
    valuesets.js — @values, enforced through the caller's accessor
    capabilities.js — what a capability IS, derived from the schema (FJS-D139)
    cardinality.js — @minItems/@maxItems on a relation, graded at the outermost commit (FJS-D347)
    commitment.js — @@commitment due times, in SQL and in JS, graded against each other
    seal.js — which states of a machine are sealed, derived from @seals
    personal.js — @personal's closed categories and their regimes, which models are people (FJS-D657)
    three-way.js — @@sync(field)'s per-column merge (FJS-D334)
    cross-process.js — announce crossProcess (FJS-642)
    encryption.js — @encrypted/@hashed + comparisonEncoderFor: value to stored bytes, one owner
    vector.js — float32 layout and the JS half of comparing two (FJS-1193, FJS-D331)
    ids.js — who assigns an @id; the generators are toolbelt/ids
    migrate.js — introspect, buildPristine, diffSchemas, residue
    migrations.js — file migrations, buildShadow, historyGap, autoMigrate
    tenancy.js — resolveTenancy + tenantFrom; four readers, one answer
    retention.js — the database block's retention: the SQLite sweep and the jsonl compaction
    watch.js — under bun --watch/--hot, imports each file parseFile read so a schema edit restarts the process (FJS-1235)
  plugins/
    gate.js — GatePlugin
    capability.js — the capability grid, ANDed with the gate as its floor (FJS-D146)
    reach.js — which models a call touches beyond the one it names
    external-ref.js — ExternalRefPlugin base
  engines/ — bun-sqlite.js · sqlite-wasm.js · none.js
  host/ — node.js · browser.js
  browser/ — worker.js · client.js
  drivers/ — jsonl.js · jsonl-index.js (the sidecar index AND the write lock, FJS-D180)
  storage/ — the ./storage battery: index.js · file-storage.js (FileStorage) · ref-url.js (the one builder of a ref's public URL, FJS-1094) · sigv4.js (the clock and the signing-key cache for toolbelt's `/sigv4`, FJS-D892) · providers/s3.js · providers/local.js
  import/ — index.js · prisma.js · rails.js · sql.js · frappe.js · tiers.js · polymorphic.js · wide-int.js
  tools/ — cli.js · cli-helpers.js (what the commands share) · studio.js (Studio's server) · studio-queries.js (its saved queries, a sidecar) · studio.html · repl.js · introspect.js · typegen.js · replicate.js (./replicate) ·
           assistant.js · eject.js · ddl-snapshot.js · jsonschema-snapshot.js · catalog-snapshot.js ·
           catalog-reference.js · principal.js (who `--as` names, for every tool that boots as somebody)
  transform/ — the ./transform battery: framework.js · runner.js · run.js · split-worker.js · split-worker.source.js
  access.js — the declared access surface as data and prose
  release.js — the release surface; classifyPivot and classifyAccess
  mutate.js — schema mutation testing
  device-schema.js — the schema a DEVICE gets
  validate-rows.js — which STORED rows the schema would now refuse
  export.js — @@export, the governed extract (FJS-D228)
  tenant.js — createTenantRegistry
  jsonschema.js — generateJsonSchema
  testing.js · testing.d.ts — the ./testing subpath
  testdb.js — the migrated template every test copies
  seeder.js · fake.js — Factory/Seeder · the seeded value catalog
  tmp-dirs.js — temp directories a run cannot remove itself
references/ — one .lite per common model, never shipped or imported
test/ — one file per concern; fixtures/scale/openmrp.lite is the 188-model scale fixture
bench/ — scale-schema.mjs · ablation.mjs, timed and asserting nothing
```
