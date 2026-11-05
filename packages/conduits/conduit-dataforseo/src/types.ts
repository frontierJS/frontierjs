// src/types.ts — DataForSEO's v3 shapes, for the calls this connector makes.

/** One task inside the envelope. `result` is the endpoint's own shape; `data` echoes what was posted, `tag` included. */
export interface DataforseoTask<R = unknown> {
  id:              string
  status_code:     number
  status_message:  string
  time?:           string
  cost?:           number
  result_count?:   number
  path?:           string[]
  data?:           Record<string, unknown> & { tag?: string }
  result?:         R[] | null
}

/** Every endpoint answers this, HTTP 200 for most refusals too: the top `status_code` is the request's, each task's is its own. */
export interface DataforseoEnvelope<R = unknown> {
  version?:        string
  status_code:     number
  status_message:  string
  time?:           string
  cost?:           number
  tasks_count?:    number
  tasks_error?:    number
  tasks?:          DataforseoTask<R>[]
}

/** A task as this connector hands it over: its own status read, its cost in micros. */
export interface TaskAnswer<R = unknown> {
  id:         string
  tag?:       string
  kind:       'ok' | 'not_ready' | 'no_funds' | 'refused'
  code:       number
  message:    string
  costMicros: number | null
  result:     R[] | null
}
