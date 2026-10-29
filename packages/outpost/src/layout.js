/*
 * layout.js — where an Outpost's files live on a box (FJS-D1544).
 *
 * The real directories follow FHS under Outpost's name and systemd makes them:
 * `ConfigurationDirectory=outpost` is /etc/outpost, `StateDirectory=outpost`
 * is /var/lib/outpost. `/frontier-outpost` holds only links to them, for a
 * person at a shell; nothing here reads through it, because `du` and `tar`
 * do not follow a link and a copy of that folder is a copy of three links.
 *
 * The install script and this process both derive their paths from here. When
 * each restated its own, the unit's `ReadWritePaths` and the process drifted
 * apart with nothing failing, and a write outside the sandbox fails only on a
 * machine.
 */

export const ROOTS = {
  config: '/etc/outpost',
  state:  '/var/lib/outpost',
  /** Caddy writes each app's access log here (`FJS-1928`); Outpost's own log
   *  is journald's (`FJS-D1617`). */
  logs:   '/var/log/caddy',
  links:  '/frontier-outpost',
  /** The Litestream unit's own StateDirectory, kept outside every app's data
   *  so a restore never carries another box's position. */
  litestreamState: '/var/lib/litestream',
}

/**
 * Every path, from systemd's `$CONFIGURATION_DIRECTORY` and `$STATE_DIRECTORY`
 * when the unit sets them, else the FHS roots. The default env is empty so the
 * install script, which runs in Basecamp's process, gets the box's paths and
 * never Basecamp's own.
 */
export function layout(env = {}) {
  const config = env.CONFIGURATION_DIRECTORY || ROOTS.config
  const state  = env.STATE_DIRECTORY || ROOTS.state
  return {
    ...ROOTS, config, state,
    envFile:          `${config}/outpost.env`,
    tlsCert:          `${config}/outpost.crt`,
    tlsKey:           `${config}/outpost.key`,
    litestreamConfig: `${config}/litestream.yml`,
    firewall:         `${config}/firewall.nft`,
    /** `apps/<app>/data/` is each app's data, bind-mounted at its volumePath. */
    apps:             `${state}/apps`,
    builds:           `${state}/builds`,
    static:           `${state}/static`,
    backups:          `${state}/backups`,
    restore:          `${state}/restore`,
    replicaRestore:   `${state}/replica-restore`,
    deployKeys:       `${state}/deploy-keys`,
    uids:             `${state}/uids.json`,
  }
}
