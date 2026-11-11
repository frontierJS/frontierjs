# Fixtures: Airtable response bodies, scrubbed

Captured 2026-11-10 for `IDEAS/conduit-airtable.md` step 0.2, 0.3 and 0.4: raw HTTP
bodies from `curl` with a personal access token against a scratch base ("Web
Project Tracker", free plan, no client data). `{base}` is `appM9ah85uDdYnwCC`,
Clients is `tblXOKo8QVlaAbSRo`, Projects `tbl7lWGJOf1ERTEOv`, Tasks
`tblb9QlowzztTU60L`. Base, table, record and field ids are kept as they are.

Scrubbed: the user id is `usr000000000000000`, the collaborator email is
`person-1@example.com`, the user's name is `Person 1`, and the webhook
`macSecretBase64` is `c2NydWJiZWQ=`. `headers.json` keeps one entry per
response with `set-cookie`, `cf-ray`, `date` and `x-airtable-action-id` dropped.
A 429 and a 403 are real answers from the live API, not constructed.

Unmeasured: a webhook ping's raw bytes and `X-Airtable-Content-MAC` header (needs
a tunnel, owner's), and the field types the base lacks (checkbox, dateTime,
attachment, lookup, rollup, formula, multipleSelects). The delete answers
and a 404 on a deleted record are unmeasured: the cleanup was refused by the
session's permission classifier.

| File | Request | Status |
| --- | --- | --- |
| `list-projects-p1.json` | GET /v0/{base}/{table}?returnFieldsByFieldId=true&pageSize=2 | 200 |
| `list-projects-p2.json` | the same with &offset= from page 1 (last page, no offset) | 200 |
| `list-projects-filtered.json` | POST /v0/{base}/{table}/listRecords with filterByFormula, fields[], returnFieldsByFieldId in the body | 200 |
| `list-projects-names.json` | GET /v0/{base}/{table}?pageSize=1 (no returnFieldsByFieldId: keys are names) | 200 |
| `list-tasks.json` | GET /v0/{base}/{table}?returnFieldsByFieldId=true (a singleCollaborator and a number) | 200 |
| `get-client-sparse.json` | GET /v0/{base}/{table}/{rec} on a record created with one field: empty fields are omitted | 200 |
| `get-client-filled.json` | GET a record with five text-ish fields filled | 200 |
| `get-project.json` | GET a record with links, a count, a currency, a select and a date | 200 |
| `create-1.json` | POST single record {fields} (answers a bare record, keyed by name) | 200 |
| `create-10.json` | POST {records:[10]} | 200 |
| `create-11.json` | POST {records:[11]} (accepted: 200, not 422) | 200 |
| `create-101-422.json` | POST {records:[101]}: refused, cap named in the message | 422 |
| `patch-fill.json` | PATCH a record, five fields (query returnFieldsByFieldId ignored: answer keyed by name) | 200 |
| `patch-null.json` | PATCH one field to null: cleared | 200 |
| `get-after-null.json` | GET after the null patch | 200 |
| `patch-empty-string.json` | PATCH a multilineText to "": cleared | 200 |
| `get-after-empty-string.json` | GET after the "" patch | 200 |
| `patch-body-by-id.json` | PATCH with returnFieldsByFieldId in the BODY: answer keyed by id | 200 |
| `put-one-field.json` | PUT one field: every other field cleared | 200 |
| `get-after-put.json` | GET after the PUT | 200 |
| `upsert-creates.json` | PATCH {performUpsert:{fieldsToMergeOn:[Client Name]}, records} on no match | 200 |
| `upsert-updates.json` | the same on one match | 200 |
| `upsert-two-422.json` | the same on two matches | 422 |
| `record-missing-403.json` | GET a well-formed record id that does not exist (403, not 404) | 403 |
| `record-missing-patch-403.json` | PATCH a well-formed record id that does not exist | 403 |
| `table-missing-403.json` | GET /v0/{base}/tblXXXXXXXXXXXXXX | 403 |
| `base-missing-403.json` | GET /v0/appXXXXXXXXXXXXXX/{table} | 403 |
| `unknown-field-id-422.json` | POST a create with fldXXXXXXXXXXXXXX | 422 |
| `unknown-field-name-422.json` | POST a create with a field name that does not exist | 422 |
| `bogus-token-401.json` | GET with a bogus bearer token | 401 |
| `computed-field-422.json` | POST a create writing a count field | 422 |
| `unknown-view-422.json` | GET ?view=NoSuchView | 422 |
| `bad-formula-422.json` | GET ?filterByFormula=NOPE( | 422 |
| `bad-page-size-422.json` | GET ?pageSize=500 | 422 |
| `bad-offset-422.json` | GET ?offset=itrBOGUS/recBOGUS | 422 |
| `rate-limit-429.json` | one of 20 refused out of 60 parallel GETs on one base (40 got 200) | 429 |
| `select-by-name.json` | POST a project: select by name, link by [recId], date, currency as a number | 200 |
| `select-by-id.json` | POST a project: select by choice id (answers the name) | 200 |
| `select-unknown-422.json` | POST a select value that is not a choice, no typecast | 422 |
| `select-unknown-typecast.json` | the same with typecast:true (a choice is created) | 200 |
| `date-us-format.json` | POST a date "11/10/2026" without typecast: accepted and parsed | 200 |
| `date-us-format-typecast-422.json` | the same with typecast:true: refused | 422 |
| `link-by-name-422.json` | POST a record link as a primary-field value | 422 |
| `link-missing-422.json` | POST a record link to a record that does not exist | 422 |
| `task-collaborator.json` | POST a task with a singleCollaborator as {id} | 200 |
| `webhook-create.json` | POST /v0/bases/{base}/webhooks, notificationUrl omitted | 200 |
| `webhook-payloads.json` | GET /v0/bases/{base}/webhooks/{id}/payloads after one create and one update | 200 |
| `webhook-payloads-past-end.json` | the same with ?cursor= the cursor the last pull answered | 200 |
| `webhook-refresh.json` | POST /v0/bases/{base}/webhooks/{id}/refresh | 200 |
| `webhook-list.json` | GET /v0/bases/{base}/webhooks | 200 |
| `webhook-delete.json` | DELETE /v0/bases/{base}/webhooks/{id} | 200 |
| `list-bases.json` | GET /v0/meta/bases | 200 |
| `tables.json` | GET /v0/meta/bases/{base}/tables, the real schema of the scratch base | 200 |
