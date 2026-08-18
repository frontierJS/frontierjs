// mesa-swap-fallback.js — what `@frontierjs/mesa/vite/swap` resolves to when
// Mesa is not installed.
//
// The dev client imports Mesa's DOM swap unconditionally, because the file it
// lives in is one module and an extension either has Mesa or does not. Without
// this, an extension building in stub mode (no Mesa compiler found — see
// `build/mesa-plugin.js`) would fail to resolve the specifier and the whole dev
// build would die on a feature it is not using.
//
// Returning 0 is not a guess: nothing can register with `__jettyMesa` unless a
// compiled Mesa component called `register`, and stub mode never produces one.
// So the registry is always empty here, and the dev client's own "no live
// instances" warning is the accurate report.

export function swapInstances() {
  return 0
}
