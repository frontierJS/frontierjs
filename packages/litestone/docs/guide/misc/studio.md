# Studio

Studio is a browser UI over the schema's own client: browse and edit rows, run SQL, see what a person may do, compare schemas and read the query log. It is a development tool, and it opens on the schema in the current project.

```sh
bunx litestone studio                  # http://localhost:5502, opened in the browser
bunx litestone studio --port=3000 --no-open
bunx litestone studio --readonly       # every mutating endpoint answers 403
```

The sidebar has an **Acting as** picker, the tables, and one panel per tool.

## What else it can do

- **Browse** pages through every model, edits a row in place, toggles soft-deleted rows, and builds one plausible row with `Random`
- **Query** shows the Litestone call behind the current view, to copy or send to the REPL
- **SQL Query** runs raw SQL past every policy, and **REPL** runs the client API as the principal picked in the sidebar
- **Models** draws the schema as an ER diagram, and **Explore** looks up any word in the language
- **Access** shows what the schema declares about who may do what, and whether the live database has drifted from it
- **Compare** reads a second schema out of git and grades the pair as expand or contract, widens or narrows
- **Migrations** shows applied and pending files and the live diff, and can write a migration file
- **Stats** and **Performance** show file health, backup and vacuum buttons, index advice and `EXPLAIN QUERY PLAN`
- **Query Log** lists what Studio's own client ran, and **Schema** is a live `.lite` editor
- The **Acting as** picker runs Browse, the REPL and Random as one of your `@@auth` users, policies enforced; the default is the system
- `--gate ./api/src/core/gate.ts#getLevel` grades previews with the app's own level function
- `--host` beyond loopback is refused without `--token`, so prefer a tunnel to exposing the port

**In depth:** [Studio § Panels](../../studio.md#panels), [§ Acting-as picker](../../studio.md#acting-as-picker), [§ Production use](../../studio.md#production-use)
