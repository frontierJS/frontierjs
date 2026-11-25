// src/types.ts — GitHub's shapes, for the calls this connector makes.

export interface GithubRepo { owner: string; name: string }

export interface GithubRepository { fullName: string; private: boolean; defaultBranch: string }

export interface DeployKey { id: string; title: string; key: string; readOnly: boolean }

export interface PushHook { id: string; url: string; events: string[]; active: boolean }

/** What GitHub answers a refusal with. `errors[]` carries the field-level reason a 422 hangs on. */
export interface GithubErrorBody {
  message?:           string
  documentation_url?: string
  errors?:            { resource?: string; code?: string; field?: string; message?: string }[]
}

/** The fine-grained token grants a call can need, spelled as GitHub's settings page spells them. */
export type Grant = 'Administration' | 'Webhooks' | 'Contents' | 'Metadata'

export interface PushEvent {
  id:      string
  type:    'push'
  payload: {
    ref: string | null, after: string | null, deleted: boolean, defaultBranch: string | null,
    author: string | null, message: string | null,
  }
}
