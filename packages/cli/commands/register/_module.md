---
namespace: register
description: The project's own registers — what is wrong, what is settled, what is not started
---

<script>
import { resolve } from 'path'
</script>

## The registers

Three markdown files answering three different questions, and a project needs
all three to be readable together:

```
ISSUES.md      — what is wrong           (one id per defect, gap or open question)
DECISIONS.md   — what is settled         (dated rulings; do not relitigate)
IDEAS/         — what is not started     (one paper per proposal)
```

```
fli register:check  — grade the registers against their own rules
```

They stay markdown, because a register is argued in prose and reviewed in a
diff. What the check adds is the half prose cannot hold up on its own: that an
id is never reused, that a citation resolves, that a link still points at
something, and that a status is a value somebody chose rather than typed.
