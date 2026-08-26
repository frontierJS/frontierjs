// api/config/junction.config.js
//
// This app declares nothing, and says so here rather than by leaving the
// directory out. The two are not the same: an absent config/ is a path the
// framework resolves to nowhere, and an app booting on defaults by accident
// looks exactly like one that chose them.
//
// Everything this fixture needs is computed at boot — the port comes from the
// port broker — so it is passed through `createApp({ config })` in
// api/src/app.ts, which beats this file anyway.
//
// A file this app cannot use even if it wanted to: `configPath` resolves
// against the CWD, and this fixture is started from packages/sierra rather than
// from here, so `./api/config` is a directory one level up from the workspace
// root. That is why `autoload` is passed as an absolute path in app.ts instead
// of being declared as `services.dir` here (`FJS-458`).

export default {}
