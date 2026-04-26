---
title: utils:password
description: Hash a password using Node crypto (scrypt) or generate a random secret
alias: password
examples:
  - fli password mypassword
  - fli password --random
args:
  -
    name: password
    description: Password string to hash
flags:
  random:
    char: r
    type: boolean
    description: Generate a random hex secret instead of hashing
    defaultValue: false
---

<script>
import { scrypt, randomBytes } from 'crypto'
import { promisify } from 'util'

const scryptAsync = promisify(scrypt)

const hashPassword = async (password) => {
  const salt       = randomBytes(16).toString('hex')
  const derivedKey = await scryptAsync(password, salt, 64)
  return `${salt}:${derivedKey.toString('hex')}`
}
</script>

Hash a password with `crypto.scrypt` (Node built-in, no deps).
Output format: `salt:hash` — store the whole string and use
`crypto.scryptSync` with the same salt to verify.

```js
if (flag.random) {
  const secret = randomBytes(32).toString('hex')
  echo(secret)
  return
}

if (!arg.password) {
  log.error('Provide a password to hash, or use --random')
  return
}

const hash = await hashPassword(arg.password)
echo(hash)
```
