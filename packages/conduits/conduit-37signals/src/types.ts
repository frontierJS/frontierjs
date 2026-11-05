// src/types.ts — Basecamp's shapes, for the calls this connector makes. Field
// names are the API's snake_case. They are Basecamp's answers as they come,
// not rows: a row is the mirror claim's (Phase 6).

/** A refusal's body, when it has one. A 404 is `{ status, error }`; a feed refusal adds `reason` (`invalid_position`); an Agent's 403 and a missing `User-Agent`'s 400 have none, the second answering `text/plain`. The feed's 409 names the two filter digests and its 410 the epoch and a `resume` URL (`event_feed.md`). */
export interface BasecampErrorBody {
  status?:          number
  error?:           string
  reason?:          string
  position_digest?: string
  filters_digest?:  string
  epoch_after_id?:  number
  resume?:          string
}

/** `X-Ratelimit`, JSON on every answer — a `304` and a `400` included. `until` is when `remaining` refills. */
export interface RateLimit {
  name:      string
  period:    number
  limit:     number
  remaining: number
  until:     string
}

/** A person as Basecamp answers one — `my/profile.json`, a recording's `creator`. */
export interface Person {
  id:               number
  attachable_sgid:  string
  name:             string
  email_address:    string
  personable_type:  'User' | 'Agent' | string
  title:            string | null
  admin:            boolean
  owner:            boolean
  client:           boolean
  employee:         boolean
  time_zone:        string
  avatar_url:       string
  company?:         { id: number; name: string }
  created_at:       string
  updated_at:       string
}

/** One tool on a project. `name` is the tool's type key; a project can carry two of one name, one with `enabled: false` (0.4). */
export interface DockEntry {
  id:       number
  title:    string
  name:     'todoset' | 'message_board' | 'chat' | 'schedule' | 'vault' | 'questionnaire' | 'inbox' | 'kanban_board' | string
  enabled:  boolean
  position: number | null
  url:      string
  app_url:  string
}

export interface Project {
  id:          number
  status:      'active' | 'archived' | 'trashed' | string
  name:        string
  description: string | null
  purpose:     string
  url:         string
  app_url:     string
  dock:        DockEntry[]
  created_at:  string
  updated_at:  string
}

/** What every recording carries, and all that `buckets/{b}/recordings/{id}.json` answers: `url` names the typed read, which alone has the rest (measured 2026-10-16). */
export interface Recording {
  id:                 number
  status:             'active' | 'archived' | 'trashed' | string
  type:               'Todo' | 'Todolist' | 'Message' | 'Comment' | string
  title:              string
  url:                string
  app_url:            string
  visible_to_clients: boolean
  inherits_status:    boolean
  parent?:            { id: number; title: string; type: string; url: string; app_url: string }
  bucket:             { id: number; name: string; type: string }
  creator:            Person
  created_at:         string
  updated_at:         string
}

export interface Todolist extends Recording {
  type:            'Todolist'
  name:            string
  description:     string
  completed:       boolean
  completed_ratio: string
  position:        number
  comments_url:    string
  todos_url:       string
  groups_url:      string
}

export interface Todo extends Recording {
  type:           'Todo'
  content:        string
  description:    string
  completed:      boolean
  /** No bucket in it (0.4); 2.3's `completeTodo` follows it whole. */
  completion_url: string
  assignees:      Person[]
  due_on:         string | null
  starts_on:      string | null
  position:       number
  comments_url:   string
}

export interface Message extends Recording {
  type:         'Message'
  subject:      string
  content:      string
  comments_url: string
}

export interface Comment extends Recording {
  type:    'Comment'
  content: string
}

/** A Campfire line. A line posted as plain text answers its text as `content`; a rich one (`Chat::Lines::RichText`) answers HTML. */
export interface ChatLine extends Recording {
  content: string
}

/** One page of `events.json`. `next` is there only while this walk has more; `position` is on every page. */
export interface FeedPage {
  events:   FeedEvent[]
  position: string
  next?:    string
}

/**
 * A pointer, never the recording: the feed carries no content, so whatever an
 * event is about is read again before anything acts on it (3.3).
 * `performed_by_id` is the agent behind a delegated action, else null.
 */
export interface FeedEvent {
  id:              number
  kind:            string
  action:          string
  event_type:      string
  bucket_id:       number
  recording_id:    number
  creator_id:      number
  performed_by_id: number | null
  created_at:      string
  /** Only `boost.created` and `card.moved` carry one. */
  details?:        Record<string, unknown>
}
