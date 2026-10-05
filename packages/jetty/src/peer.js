// peer.js — load a tool jetty runs but does not install.
//
// vite, chokidar and ws are optional peers: the extension a user installs is
// bundled output and never needs them, so they are the APP's devDependencies,
// which `fli new --extension` and `fli make:extension` write. Without this the
// first sign of a missing one is "Cannot find package 'ws'" from inside jetty,
// which reads as jetty being broken rather than the app missing a line.

export async function loadPeer(name, forWhat) {
  try {
    return await import(name)
  } catch (err) {
    // The name, not just the code: vite failing to find ITS OWN dependency is
    // also ERR_MODULE_NOT_FOUND, and that is not something the app can add.
    if (!String(err?.message).includes(`'${name}'`)) throw err
    throw new Error(
      `jetty's ${forWhat} needs "${name}", which the app installs: bun add -d ${name}`,
      { cause: err },
    )
  }
}
