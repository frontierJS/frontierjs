/*
 * command-form.spec.mjs — a command's form sends what the terminal would.
 *
 * `test/runtime.test.js` grades a flag value once it arrives. What is here is
 * the form that builds it: a switch whose flag defaults ON is checked, and
 * turning it off must send `false` — sending nothing, which is what an
 * unchecked box sent, puts the default back, so `--no-push` was a switch that
 * did nothing. The command line the form previews says `--no-push` for the
 * same reason. `git:release` is the command because its `push` is that shape.
 */
export const name = 'a command form sends what the terminal would'

export async function run(t) {
  const read = (checked) => t.evaluate(`
    await selectCommand('git:release');
    const box = document.getElementById('flag-push');
    box.checked = ${checked};
    const { flags, cmd } = collectCurrentArgs();
    return { found: !!box, initially: box.defaultChecked, flags, cmd };
  `)

  const on = await read(true)
  t.ok(on.found, 'the push switch is drawn')
  t.is(on.initially, true, 'checked, because the flag defaults on')
  t.is('push' in on.flags, false, 'left on, nothing is sent — the default already says it')

  const off = await read(false)
  t.is(off.flags.push, false, 'turned off, `push: false` is sent')
  t.ok(/--no-push\b/.test(off.cmd), `and the command line says --no-push — "${off.cmd}"`)
}
