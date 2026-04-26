---
title: utils:vpn
description: Connect or disconnect WireGuard VPN
alias: vpn
examples:
  - fli vpn
  - fli vpn --kill
  - fli vpn --status
flags:
  kill:
    char: k
    type: boolean
    description: Disconnect the VPN
    defaultValue: false
  status:
    char: s
    type: boolean
    description: Show current WireGuard status
    defaultValue: false
---

<script>
import { existsSync } from 'fs'
import { homedir } from 'os'
import { resolve } from 'path'
</script>

```js
if (flag.status) {
  context.exec({ command: 'sudo wg show', dry: flag.dry })
  return
}

const home = homedir()
const defaultConf = resolve(home, '.kvpn.conf')
const envConf     = process.env.VPN_DEV ? resolve(home, process.env.VPN_DEV) : null
const iface       = existsSync(defaultConf) ? defaultConf
                  : (envConf && existsSync(envConf)) ? envConf
                  : 'wg0'

const cmd = flag.kill
  ? `sudo wg-quick down ${iface}`
  : `sudo wg-quick up ${iface}`

context.exec({ command: cmd, dry: flag.dry })
```
