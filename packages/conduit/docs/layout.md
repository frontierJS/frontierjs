# conduit — layout

The file-by-file map of `@frontierjs/conduit`, moved out of `CLAUDE.md` so a turn in this package does not pay for it. `CLAUDE.md` keeps the owners and the traps; hazards are `hazards.md`.

```
src/
  conduit.ts        the core — declare targets and receivers, send, accept, apply resilience
  receive.ts        the receiving end — Delivery, Dialect, Receiver, BrokerReceiver, and the ONE order a delivery or a frame runs
  mirror.ts         the mirror claim — a connector's models, verbs and parse; the Provider half of a forward
  router.ts         target resolution
  observe.ts        the one place an observer is called
  plugin.ts         the Junction plugin (app.conduit)
  credentials.ts    credential resolvers — a target names one, never inlines it
  signers.ts        the signers always installed — HTTP Basic
  resilience.ts     per-target load shedding
  trace.ts          trace-context propagation
  types.ts          the target/message types
  testing.ts        test factory
  transports/       http · websocket · unix · broker · stub · not_implemented · base
    encode.ts       json | form | binary — the ONE place a body becomes bytes
  stores/           sqlite · memory
```
