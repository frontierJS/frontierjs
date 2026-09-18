// engines/none.js — what `#sql-engine` resolves to where `bun:sqlite` does not
// exist, so that a bundler building litestone for a browser never follows an
// import into a runtime builtin it would fail on.
//
// It registers nothing. The host says which engine it has, and `openDatabase()`
// refuses by name until it does.

export default null
