// test/no-ambient-color.js — preloaded into every `bun test` here (bunfig.toml).
//
// fli prove starts this suite with FORCE_COLOR=1 (core/children.js), and chalk
// then colors a pipe: a rendered tree, a prompt and a child's stack trace carry
// escape codes, and every assertion on their text fails under prove and passes
// run directly (FJS-4282). A test that means to see color sets FORCE_COLOR
// itself, as color.test.js does.

delete process.env.FORCE_COLOR
