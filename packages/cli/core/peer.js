// peer.js — load a package one command family needs and fli does not install.
//
// linkedom and turndown serve only `ksite:fetch`, so they are optional peers:
// every other user of fli would install them for nothing. The app is asked
// first, because a compiled command shim resolves from fliRoot, and under bun's
// isolated linker a package the app added never appears on that path.

export async function loadPeer(name, forWhat) {
  let fromApp = null
  try { fromApp = Bun.resolveSync(name, process.cwd() + '/') } catch {}
  try {
    return await import(fromApp ?? name)
  } catch (err) {
    // The name, not just the code: the peer failing to find ITS OWN dependency
    // is also ERR_MODULE_NOT_FOUND, and that is not something the app can add.
    if (fromApp || !String(err?.message).includes(`'${name}'`)) throw err
    throw new Error(
      `fli ${forWhat} needs "${name}", which is not installed: bun add -d ${name}`,
      { cause: err },
    )
  }
}
