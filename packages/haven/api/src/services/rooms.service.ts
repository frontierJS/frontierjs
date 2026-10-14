// The scenes — square, tavern. Laid out by the system; a member only reads them.
import { createService } from '@frontierjs/junction'

export function createRoomsService () {
  return createService({ model: 'Room', methods: ['find', 'get'] })
}
