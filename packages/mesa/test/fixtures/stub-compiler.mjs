/**
 * A compiler the plugin can be pointed at with `compilerPath`, so a test can
 * hand the plugin diagnostics the real compiler has no way to produce today —
 * a warning containing a newline, an error carrying `details`, an extracted
 * stylesheet on `ctx.css.result`.
 *
 * It is NOT a stand-in for the compiler in tests about compiling. Those use the
 * real one (test/vite-plugin.test.js), because a fixture of compiled output goes
 * on passing after the shape it describes stops being emitted.
 *
 * The source it is given IS the instruction: JSON describing what to answer.
 */

export async function compileSource(source, options = {}) {
  const spec = JSON.parse(source)

  if (spec.throw) {
    const e = new Error(spec.throw.message)
    if (spec.throw.details) e.details = spec.throw.details
    throw e
  }

  return {
    result:   spec.result ?? 'export default function Stub() {}',
    css:      { result: spec.css ?? null },
    analysis: { errors: spec.errors ?? [], warnings: spec.warnings ?? [] },
    options,
  }
}
