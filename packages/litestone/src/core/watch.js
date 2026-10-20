// watch.js — puts the schema files into a watching runtime's module graph.
//
// createClient reads a schema with `fs`, and `bun --watch` / `--hot` restart on
// the files a process IMPORTED, so the one file that defines the data was the one
// the dev loop ignored: a column added to schema.lite never reached the running
// API, and the app answered confidently from the old schema (FJS-1235). Importing
// each file as text adds it to that graph and costs one cached read.
//
// Outside a watcher this does nothing, and a refused import is not an error:
// registering a watch must never be the reason a client fails to open.

const WATCHING = /^--(watch|hot)\b/

/**
 * @param {string[]} files  absolute paths `parseFile` read, imports included
 */
export async function watchSchemaFiles(files) {
  const argv = typeof process !== 'undefined' && typeof Bun !== 'undefined' ? process.execArgv : []
  if (!argv.some(a => WATCHING.test(a))) return
  await Promise.all(files.map(file =>
    import(/* @vite-ignore */ file, { with: { type: 'text' } }).catch(() => {})))
}
