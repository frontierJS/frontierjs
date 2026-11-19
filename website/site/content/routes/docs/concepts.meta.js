// site/content/routes/docs/concepts.meta.js — the Concepts page's code samples.
//
// One model, Lead, shown in each realm. LEAD is checked by running it: parsed,
// migrated into :memory: and driven through its gate, row policy, encrypted
// field and transitions. Change a line and run it again, or the page teaches
// syntax that does not parse.

import { block }   from '../../data/code.js'
import { docsNav } from '../../data/docs-nav.js'

const SAMPLES = {
  LEAD: `enum LeadStatus { new  contacted  won  lost }

model Lead {
  id      Int        @id
  name    String     @length(1, 120)
  email   String     @email @unique @lower
  phone   String?    @encrypted
  status  LeadStatus @default(new)
  ownerId Int

  @@gate(2.4.4.5)
  @@allow(read, ownerId == auth().id)

  @@transitions(status,
    contact: new              -> contacted,
    win:     contacted        -> won,
    lose:    [new, contacted] -> lost)
}`,

  SERVICE: `// api/src/services/leads.service.ts
import { createService } from '@frontierjs/junction'

export default createService({})`,

  RESOURCE: `<!-- web/src/resources/Lead.mesa -->
<script module>
  import { createResource } from '@frontierjs/sierra/resource'

  export const leads = createResource('leads')
</script>`,
}

const LANG = { LEAD: 'lite', SERVICE: 'ts', RESOURCE: 'mesa' }

export async function load() {
  return {
    nav:     docsNav(),
    samples: Object.fromEntries(Object.entries(SAMPLES).map(
      ([n, src]) => [n, block(src, LANG[n])])),
  }
}
