// The photographs. A separate service rather than a shape nested inside
// `products` because an image is written on its own — a merchant adds one
// picture, not a whole product — and because `file` is a File column, whose
// write is a multipart upload and the one request the browser client does not
// put down the socket.
import { createService } from '@frontierjs/junction'

export default createService({ model: 'ProductImage', channel: 'product-images' })
