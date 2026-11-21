// A module store: the route writes the server's value, and both carts read and
// write it. Its client default is 0, so a cart reading 0 adopted nothing.
export const cart = { count: 0 }
