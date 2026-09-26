// ─── effects.js — what a command does to the world, and who must say yes ─────
//
// A leaf with no imports: `--help`, `fli list` and the namespace listing read
// it on the startup path, and `Command()` is the one place it is enforced.
//
//   effects: sends a message to a customer
//   confirm: human
//
// `effects` is shown wherever the command is listed, so an agent reading
// `fli list --json` sees it beside the description. `confirm: human` means a
// person approves each run: at a terminal the person typing the command is
// that approval; anywhere else — an agent's shell, a pipe, `fli gui` — the run
// is refused unless `--approved` is passed, which a person grants by approving
// that exact command line. A command's own `--dry` does not skip it, because
// whether a dry run touches nothing is the command's promise, not fli's.

export const CONFIRMS = ['human']

/** The flag fli adds to a `confirm: human` command. A command never declares it. */
export const APPROVED = {
  type:         'boolean',
  description:  'A person approved this exact run — required without a terminal',
  defaultValue: false,
}

/** What is wrong with a command's `effects`/`confirm`, or null. */
export function effectsProblem(meta = {}) {
  if ('effects' in meta && !(typeof meta.effects === 'string' && meta.effects.trim())) {
    return `\`effects\` is ${JSON.stringify(meta.effects)}. Write what the command does beyond this ` +
           `machine, as one line — \`effects: sends a message to a customer\`.`
  }
  if (!('confirm' in meta)) return null
  if (!CONFIRMS.includes(meta.confirm)) {
    return `\`confirm: ${meta.confirm}\` is not a confirmation. The one there is is \`confirm: human\`.`
  }
  if (!meta.effects) {
    return '`confirm: human` with no `effects`. The refusal and the listings say what is being ' +
           'approved, so write it — `effects: sends a message to a customer`.'
  }
  if (meta.flags && 'approved' in meta.flags) {
    return '`approved` is declared as a flag. fli adds it to a `confirm: human` command; remove the declaration.'
  }
  return null
}

/**
 * The refusal for a `confirm: human` run with no person present, or null when
 * it may run. `interactive` is whether a person is at a terminal typing it.
 */
export function approvalRefusal(meta = {}, { approved = false, interactive = false } = {}) {
  if (meta.confirm !== 'human' || approved || interactive) return null
  return `${meta.title} ${meta.effects}, and a person confirms each run. At a terminal, run it ` +
         `yourself; anywhere else, pass --approved once a person has approved this exact command.`
}
