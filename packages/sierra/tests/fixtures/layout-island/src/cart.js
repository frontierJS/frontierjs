// The hop the real one had: an island does not import junction, a store does.
import { getClient } from '@frontierjs/sierra/junction'

let items = []
export function count()  { return items.length }
export function client() { return getClient() }
