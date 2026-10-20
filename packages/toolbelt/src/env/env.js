/*
 * env.js — where an environment holds one key: the variable itself, or the
 * file `<KEY>_FILE` names.
 *
 * A variable passed with `--env` or `--env-file` sits in a container's
 * Config.Env, which `docker inspect` shows to anyone in the docker group; a
 * file mounted into the container does not. Junction's `defineEnv` and
 * litestone's CLI both read ENCRYPTION_KEY, and litestone may not import
 * junction, so the rule lives below both. The spelling is the Docker official
 * images' (`POSTGRES_PASSWORD_FILE`), and as there, both set is refused: one
 * of the two is stale, and letting either win in silence is how a deploy boots
 * on the old key and cannot read its own encrypted columns.
 *
 * The caller reads the file; this answers what to read and what the bytes mean.
 */

/** `{ value }` for the variable, `{ file, fileKey }` to read, or `{ error }` when both are set. */
export function envSource(key, env) {
  const fileKey = `${key}_FILE`
  const file    = env[fileKey]
  if (file === undefined || file === '') return { value: env[key] }
  if (env[key] !== undefined && env[key] !== '')
    return { error: `${key} and ${fileKey} are both set — unset one (the file is the one docker inspect does not show)` }
  return { file, fileKey }
}

/** A file's text as the key's value. An editor or `echo` ends it in a newline the
 *  value does not have, and a 64-character key read as 65 fails at the first
 *  encrypted write. An empty file is an unset key. */
export function fileValue(text) {
  const v = text.replace(/(\r?\n)+$/, '')
  return v === '' ? undefined : v
}
