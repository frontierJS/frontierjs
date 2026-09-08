#!/usr/bin/env bun
// tools/atlas.ts
// The whole app model, once, as JSON — `junction atlas`.
//
// The four snapshot tools beside this one each boot the app, walk it, and render
// their own committed file. This boots it once, walks it once through
// `describeAppModel`, and prints the result. Nothing is committed and there is no
// `--check`: the four registers are already gated by the `snapshots` phase, and a
// fifth file derived from them would be a second origin for facts those four
// already own.
//
// It exists so a reader OUTSIDE this package can ask cross-register questions.
// `fli app:atlas` is the first one. It cannot import the model directly —
// `@frontierjs/cli` declares no junction dependency and cannot gain one, since
// junction is Bun-only and `fli` runs under plain node — and a copy of junction
// living in the cli would be a DIFFERENT junction than the one that built the
// app, which is version skew nothing downstream can detect.
//
// The alternative was for the caller to spawn the four existing tools and parse
// their markdown. That gives up what stages 1 and 2 bought: a cross-register
// column — *which service does this job call*, *what standing does this raw
// route reach the Data boundary at* — is recoverable from four rendered pages
// only by matching names, and a join by name is a guess (`src/core/app-model.ts`).
// JSON carries the structure the prose drops.
//
// Usage:
//   junction atlas --app api/app.ts [--services api/services]
//   junction atlas --app api/app.ts --pretty

import { getFlag, flag, fatal, loadApp, quietly } from './app-module.ts'
import { describeAppModel }                      from '../src/core/app-model.ts'

if (import.meta.main) {
  const appPath = getFlag('app')
  if (!appPath) fatal('junction atlas needs --app <module> — the module exposing the app or a factory for it')

  const app   = await loadApp(appPath, getFlag('export'), getFlag('services'))
  const model = describeAppModel(app)

  // `loadApp` already moved the build's own chatter to stderr, so stdout holds
  // the document alone and a caller can pipe it. Compact by default because the
  // reader is a program; `--pretty` is for a person at a terminal.
  process.stdout.write(JSON.stringify(model, null, flag('pretty') ? 2 : 0) + '\n')

  // Same reason as every other tool here: an app built for description is holding
  // a database and a poller nobody asked to stop, and a tool that never exits
  // fails its caller as a timeout rather than as an answer.
  //
  // Under `quietly`, unlike the four snapshot tools, because for them stdout is
  // scratch and the file is the document — here stdout IS the document, and the
  // shutdown announces itself on it two lines below the JSON.
  await quietly(async () => { await app.stop?.().catch(() => {}) })
  process.exit(0)
}
