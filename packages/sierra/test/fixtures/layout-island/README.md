# layout-island — the shape that used to hang the build

`FJS-549` and `FJS-550`, which were one failure wearing two descriptions: a
prerendered site whose LAYOUT holds an island, and whose island's module graph
reaches `@frontierjs/sierra/junction` through a store.

It hung with no error, no output and no page — the client bundle finished,
printed its chunk table, and then nothing, forever. Neither shape reproduces
now; this fixture is what says so on every run, and the prerender's own clock
(`prerender.timeout`) is what makes a return of it a failure rather than a
silence.

Four things have to be here together, because the composite is the case:

- `src/routes/_module.mesa` — a layout, and the island lives in IT
- `src/islands/Basket.mesa` — the island, reaching junction through `src/cart.js`
  rather than importing it directly, which is the hop the real one had
- `src/routes/deep/index.meta.js` — a companion that also reaches the store, so
  the route table has a loader to resolve
- more than one route, because the original rendered the routes that did not
  reach it and then stopped

The full-build half — rolldown, the client route table, the island chunks — is
covered by `example`'s `verify:site`. What runs here is the prerender pass,
which is where the stall was.
