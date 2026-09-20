export interface GeoPoint {
  lat: number
  lng: number
}

/** A prefilter box. `full` means the longitude bound admits every meridian. */
export interface GeoBox {
  south: number
  north: number
  west: number
  east: number
  full: boolean
}

export function isPoint(p: unknown): boolean
export function distance(a: GeoPoint, b: GeoPoint): number
/** One box, or TWO when the radius crosses ±180. Never one inverted box. */
export function boundingBox(center: GeoPoint, metres: number): GeoBox[]
export function inBoxes(p: GeoPoint, boxes: GeoBox[]): boolean
export function isNear(p: unknown, center: GeoPoint, metres: number): boolean
export function pointInPolygon(p: GeoPoint, ring: GeoPoint[]): boolean
export function polygonArea(ring: GeoPoint[]): number
export function centroid(points: GeoPoint[]): GeoPoint | null
