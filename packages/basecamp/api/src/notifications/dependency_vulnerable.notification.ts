// src/notifications/dependency_vulnerable.notification.ts

import { defineNotification, inApp, mail } from '@frontierjs/notifications'
import { declaredTransports, appUrl }      from './_shared.ts'

export interface DependencyVulnerablePayload {
  workspaceId: string
  /** The installed versions that gained an advisory in this check, one entry each. */
  found:       { name: string; version: string; advisories: string[] }[]
}

const line = (f: DependencyVulnerablePayload['found'][number]) =>
  `${f.name}@${f.version}: ${f.advisories.join(', ')}`

export default defineNotification<DependencyVulnerablePayload>({
  via: declaredTransports,

  inApp: (p) => inApp()
    .title('Dependency vulnerable')
    .body(p.found.map(line).join('; '))
    .action('View dependencies', '/dependencies/')
    .context('Workspace', p.workspaceId)
    .data({ found: p.found }),

  email: (p) => mail()
    .subject(`Dependency vulnerable — ${p.found.map(f => `${f.name}@${f.version}`).join(', ')}`)
    .line('A version your projects have installed gained a published advisory:')
    .line(p.found.map(line).join('\n'))
    // Sent when a version first gains an advisory, not on each daily check, so
    // the screen is where the standing list lives.
    .action('View dependencies', appUrl('/dependencies/')),
})
