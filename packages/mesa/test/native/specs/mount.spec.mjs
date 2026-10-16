/*
 * mount — every fixture either mounts on the native target or is refused at
 * compile by name. The refused list is written down, so a fixture that starts
 * refusing fails here, and so does one that starts mounting: the second is a
 * lowering landing, and this list moves with it.
 */
export const REFUSED = {
  Bars:     '<progress>',
  Checks:   'type="checkbox" on <input>',
  Dates:    'type="date" on <input>',
  Dialogs:  '<dialog>',
  Disclose: '<details>',
  Enter:    'on:keydown',
  Files:    'type="file" on <input>',
  Haven:    'on:keydown',
  Image:    '<svg>',
  Keys:     'on:keypress',
  Kinds:    'type="checkbox" on <input>',
  Multi:    '<select>',
  Pick:     '<datalist>',
  Press:    'on:touchstart',
  Widget:   'on:keydown',
  Within:   'on:focusin',
}

export async function run(t) {
  for (const [name, f] of Object.entries(t.fixtures)) {
    if (REFUSED[name]) {
      t.match(f.refusal, new RegExp(`^${REFUSED[name].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} at ${name}\\.mesa:\\d+:\\d+ has no native lowering$`), `${name} is refused by name`)
      continue
    }
    if (f.refusal) { t.ok(false, `${name} compiles — refused: ${f.refusal}`); continue }
    const r = await t.open(name)
    t.is(r.phase, 'mounted', `${name} mounts${r.error ? ` — ${r.error}` : ''}`)
  }
}
