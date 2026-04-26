---
title: db:schema
description: Append a new Prisma model stub to schema.prisma
alias: make-schema
examples:
  - fli db:schema Client
  - fli db:schema Invoice --open
args:
  -
    name: model
    description: Model name (PascalCase)
    required: true
flags:
  open:
    char: o
    type: boolean
    description: Open schema.prisma in editor after appending
    defaultValue: false
---

<script>
import { appendFileSync, existsSync } from 'fs'
import { resolve } from 'path'

const makeModel = (name) => `

model ${name} {
  id               Int       @id @default(autoincrement())

  type             String?
  meta             String    @default("{}")

  account          Account   @relation(fields: [accountId], references: [id])
  accountId        Int

  createdAt        DateTime  @default(now())
  updatedAt        DateTime?
  deletedAt        DateTime?

  @@index([accountId])
  @@map("${name.toLowerCase()}s")
}
`
</script>

```js
const schemaPath = context.paths.schema
if (!existsSync(schemaPath)) {
  log.error(`schema.prisma not found at ${schemaPath}`)
  return
}

const model = makeModel(arg.model)

if (flag.dry) {
  log.dry(`Would append model ${arg.model} to ${schemaPath}`)
  echo(model)
  return
}

appendFileSync(schemaPath, model, 'utf8')
log.success(`Appended ${arg.model} to ${schemaPath}`)

if (flag.open) {
  const editor = process.env.EDITOR || 'vi'
  context.exec({ command: `${editor} "${schemaPath}"` })
}
```
