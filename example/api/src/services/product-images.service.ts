// The photographs. A separate service rather than a shape nested inside
// `products` because an image is written on its own — a merchant adds one
// picture, not a whole product — and because `file` is a File column, whose
// write is a multipart upload and the one request the browser client does not
// put down the socket.
import { createBaseService } from '@frontierjs/junction'

export function createProductImagesService() {
  return createBaseService({ model: 'ProductImage', channel: 'product-images' })
}
