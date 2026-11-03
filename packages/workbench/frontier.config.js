// frontier.config.js
//
// What the tooling reads about where an app is deployed (`packages/cli/core/
// utils.js` § loadFrontierConfig). Workbench is the developer's own machine and
// is never deployed, so the object is empty on purpose: `deploy` is the only key
// the loader accepts, and a `deploy` block here would invite a `fli deploy` that
// ships a shell on someone's laptop. Its ports are the global tooling block's
// `workbench` and `workbenchWeb` (`packages/cli/core/ports.js`).

export default {}
