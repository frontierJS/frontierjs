---
title: hello:greet
description: Greet someone from the command line
alias: greet
examples:
  - fli hello:greet World
  - fli hello:greet World --shout
  - fli greet World --times 3
args:
  -
    name: name
    description: Name to greet
    required: true
flags:
  shout:
    type: boolean
    char: s
    description: Uppercase the greeting
    defaultValue: false
  times:
    type: number
    char: n
    description: How many times to greet
    defaultValue: 1
---

<script>
const buildGreeting = (name, shout) => {
  const msg = `Hello, ${name}!`
  return shout ? msg.toUpperCase() : msg
}
</script>

Greet someone by name. Pass `--shout` to yell at them.

```js
arg.name ??= await question('Who should I greet? ')

const greeting = buildGreeting(arg.name, flag.shout)

for (let i = 0; i < (flag.times ?? 1); i++) {
  echo(greeting)
}

log.success(`Greeted ${arg.name} ${flag.times} time(s)`)
```
