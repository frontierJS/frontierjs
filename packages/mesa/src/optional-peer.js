/**
 * The server half of Mesa — rendering to HTML, inlining CSS, compiling `.md` —
 * runs on packages a client-only app never needs, so they are optional peers
 * rather than dependencies. A missing one would otherwise surface as a bare
 * "Cannot find package" thrown from inside mesa, naming neither the feature
 * that wanted it nor the install that fixes it.
 *
 * The match is on the package NAME, not the error code: Node and Bun both
 * report ERR_MODULE_NOT_FOUND for a package missing anywhere below the import
 * too, and a broken transitive dependency is not this message's to explain.
 *
 *   const { Window } = await import('happy-dom').catch(missingPeer('happy-dom', 'renderToHTML'))
 *
 * `install` is the whole set when peers come as a group, so one missing
 * package does not lead to five more errors, one at a time.
 */
export function missingPeer(name, feature, install = name) {
  return (err) => {
    if (!String(err?.message).includes(`'${name}'`)) throw err
    throw new Error(
      `[Mesa] ${feature} needs ${name}, an optional peer of @frontierjs/mesa that is not installed — ` +
      `add it to the app: bun add ${install}`,
      { cause: err },
    )
  }
}

// ─── happy-dom without the network ─────────────────────────────────────────

/**
 * Every happy-dom Window the server half opens takes these settings. Unlike a
 * browser parsing a string, happy-dom requests each stylesheet, script and
 * iframe the markup names, so a rendered page or an email body (which may be
 * one somebody stored) would reach whatever host its URLs point at.
 */
export const NO_LOADING = {
  disableJavaScriptFileLoading: true,
  disableCSSFileLoading:        true,
  disableIframePageLoading:     true,
}
