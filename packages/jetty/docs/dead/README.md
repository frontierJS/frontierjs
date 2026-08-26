# Dead harnesses

Two HMR harnesses that were in `test/` and that **nothing has ever been able to
run**: they import mesa by an absolute path from a different machine —
`/home/claude/repo/reading-list/frontierjs/mesa/compiler.js` — so they fail at
module resolution before a line executes.

They are the only thing in this package that covered `injectJettyHMR`, which is
why `FJS-481` went unseen: mesa renamed the identifier the plugin's regex
matched, jetty's HMR registration stopped being injected for every component
with a delegated event, and ~450 green tests said nothing.

Moved here rather than deleted because the SHAPE is worth keeping — a full flow
through jsdom, a real mount, and `__jettyMesa.hot_update` swapping a live
component — and `test/phase9.test.js` covers only the wrapper's output. They
need their imports repaired and `jsdom` is not a dependency of this package.

Kept out of `test/` so a directory whose files are run does not also hold files
that are not.
