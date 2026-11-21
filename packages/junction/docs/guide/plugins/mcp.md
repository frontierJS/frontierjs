# Agents with MCP

`@frontierjs/mcp` mounts an MCP endpoint inside the API you already run. The tool list is your services and each tool call goes through `app.service(name)`, so the gate that grades a browser grades an agent, and a caller with no session sees only a stranger's tools.

```ts
import { createClient } from '@frontierjs/litestone'
import { mcp } from '@frontierjs/mcp'

// The tool list is derived from the schema, so the app needs a database
const db  = await createClient({ db: ':memory:', schema: 'model Note { id Int @id  title String  @@gate(0) }' })
const app = createApp({ db })

app.services.register(createService({ name: 'notes', model: 'Note', methods: 'readOnly' }))
app.configure(mcp())
await app._startForTest()

// An MCP client speaks JSON-RPC over POST; here the app answers in process
const res = await app.http.fetch(new Request('http://localhost/mcp', {
  method:  'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
  body:    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
}))
const { result } = await res.json()
const names = result.tools.map((t: { name: string }) => t.name)

if (res.status !== 200) throw new Error(`expected 200, got ${res.status}`)
// The service is read-only, so there is a find tool and no create tool
if (!names.includes('notes_find')) throw new Error(`expected notes_find, got ${JSON.stringify(names)}`)
if (names.includes('notes_create')) throw new Error('a read-only service offered create')
```

## What else it can do

- `mcp({ path, name, version, keepAliveMs })` moves the endpoint and names the server to a client
- A tool's arguments come from the model's schema, so there is nothing to declare
- A call runs the same hooks, transaction and announcement as an HTTP call
- `projectTools(services, views, level)` answers which tools a standing may see and what decided each
- Every tool carries a verdict: `model-gate`, `transition-floor`, `method-gate`, `method-floor` or `ungraded`
- The app CLI turns the same tool list into a command line for people
- The app CLI and a teaching guide for an agent are in the package README

**In depth:** [MCP README § Mounting it](../../../../mcp/README.md#mounting-it)
