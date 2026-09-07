// src/notifications/member_joined.notification.ts
//
// The one kind here that is about a PERSON rather than a machine, which is why
// its in-app default is off and its email default is on: somebody gaining sight
// of the fleet is worth an interruption, and it is not something anybody goes
// looking for in a bell menu.

import { defineNotification, inApp, mail } from '@frontierjs/notifications'
import { declaredTransports, appUrl }      from './_shared.ts'

export interface MemberJoinedPayload {
  workspaceId:   string
  workspaceName: string
  personName?:   string
  personEmail:   string
  role:          string
}

const who = (p: MemberJoinedPayload) => p.personName || p.personEmail

export default defineNotification<MemberJoinedPayload>({
  via: declaredTransports,

  inApp: (p) => inApp()
    .title('Somebody joined')
    .body(`${who(p)} joined ${p.workspaceName} as ${p.role}`)
    .action('View members', '/settings/members/')
    .context('Workspace', p.workspaceId)
    .data({ personEmail: p.personEmail, role: p.role, workspaceName: p.workspaceName }),

  email: (p) => mail()
    .subject(`${who(p)} joined ${p.workspaceName}`)
    .line(`${who(p)} (${p.personEmail}) accepted an invitation to ${p.workspaceName} as ${p.role}.`)
    .line('They can see the fleet from now on.')
    .action('View members', appUrl('/settings/members/')),
})
