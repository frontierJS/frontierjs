// src/types.ts — Google's shapes, for the three calls this connector makes.
//
// Places (New) and Routes are protobuf APIs served as JSON, so a field is
// present only when the request's field mask asked for it: every property
// below is optional on the wire even where Google always has a value.

export interface LatLng {
  latitude:  number
  longitude: number
}

export interface Place {
  /** `places/ChIJ…` — the resource name. */
  name?:             string
  /** `ChIJ…` — the id a `GET /v1/places/{id}` takes. */
  id?:               string
  formattedAddress?: string
  location?:         LatLng
  displayName?:      { text: string; languageCode?: string }
  types?:            string[]
}

export interface SearchTextResponse {
  /** Absent, not empty, when nothing matched: Google answers `{}`. */
  places?: Place[]
}

export interface Route {
  /** A protobuf Duration: `"1234s"`. */
  duration?:       string
  distanceMeters?: number
  polyline?:       { encodedPolyline: string }
}

export interface ComputeRoutesResponse {
  /** Absent when no route exists between the two points. */
  routes?: Route[]
}

/** One end of a route. A place id is cheapest; an address costs a geocode on Google's side. */
export type Waypoint =
  | { address: string }
  | { placeId: string }
  | { location: LatLng }

/** Google's error envelope, the same for every `googleapis.com` host. */
export interface GoogleErrorBody {
  error?: {
    code?:    number
    status?:  string
    message?: string
    details?: { '@type'?: string; reason?: string; domain?: string; metadata?: Record<string, string> }[]
  }
}
